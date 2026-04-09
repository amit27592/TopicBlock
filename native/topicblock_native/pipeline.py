"""
Inference pipeline for TopicBlock native component.

The ``Pipeline`` class is the single object that the main loop talks to.  It
orchestrates:

    ClassifyRequest
        → extraction.preprocess()    — clean + normalise + lang-detect
        → EmbeddingCache.get()       — skip embed for known segments
        → ITopicModel.embed()        — (N, D) sentence embeddings
        → cosine_similarity()        — against banned-topic vectors
        → ISentimentModel.score()    — polarity + magnitude (if enabled)
        → threshold logic            → list[Verdict]
        → ClassifyResponse

Topic vectors for a given ``prefsVersion`` are embedded once (on the first
``classify`` or ``update_prefs`` for that version) and then loaded from the
SQLite cache on every subsequent call.

Model hot-swap
--------------
When ``update_prefs`` arrives with a different ``topicModel`` or
``sentimentModel`` name, the pipeline swaps models without restarting.
The ``registry`` handles lazy loading.

Device selection
----------------
Automatic: CUDA > MPS > CPU, determined once at startup and reported in
the ``health`` response.
"""

from __future__ import annotations

import logging
import time
from dataclasses import asdict
from pathlib import Path

from topicblock_native import __version__
from topicblock_native.cache import EmbeddingCache
from topicblock_native.extraction import preprocess
from topicblock_native.models import (
    ITopicModel,
    ISentimentModel,
    NullSentimentModel,
    NullTopicModel,
    registry as _global_registry,
)
from topicblock_native.models.registry import ModelRegistry
from topicblock_native.wire import (
    ClassifyRequest,
    ClassifyResponse,
    HealthStatus,
    UserPreferences,
    Verdict,
)

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Device detection (optional — only meaningful when torch is available)
# ---------------------------------------------------------------------------

_DEVICE: str = "cpu"


def _detect_device() -> str:
    """Return 'cuda', 'mps', or 'cpu' based on available hardware."""
    try:
        import torch  # type: ignore[import-untyped]

        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


# ---------------------------------------------------------------------------
# Cosine similarity helper — dependency-free fallback path included
# ---------------------------------------------------------------------------


def _cosine_similarity_batch(
    embedding: object,  # (D,) float32 ndarray
    topic_matrix: object,  # (N, D) float32 ndarray
) -> list[float]:
    """
    Compute cosine similarity between a single embedding and each row of
    ``topic_matrix``.

    Both inputs are assumed to be L2-normalised (which sentence-transformers
    guarantees), so the result is just the dot product per row.

    Returns an empty list when ``topic_matrix`` is ``None`` or empty.
    """
    try:
        import numpy as np

        emb = np.array(embedding, dtype="float32")
        mat = np.array(topic_matrix, dtype="float32")
        if mat.ndim < 2 or mat.shape[0] == 0:
            return []
        # Dot product of normalised vectors == cosine similarity.
        scores = mat @ emb
        return scores.tolist()
    except Exception:
        log.debug("cosine_similarity_batch failed — returning empty scores", exc_info=True)
        return []


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


class Pipeline:
    """
    Full inference pipeline.

    Parameters
    ----------
    cache_path:
        SQLite file for the embedding + topic-vector cache.
    registry:
        Model registry instance.  Defaults to the module-level singleton.
    """

    def __init__(
        self,
        cache_path: Path = Path("~/.topicblock/cache.db").expanduser(),
        registry: ModelRegistry | None = None,
    ) -> None:
        global _DEVICE
        _DEVICE = _detect_device()
        log.info("Pipeline initialising on device=%s", _DEVICE)

        self._registry: ModelRegistry = registry or _global_registry
        self._cache = EmbeddingCache(cache_path)

        # Active models — start with null models until prefs arrive.
        self._topic_model: ITopicModel = NullTopicModel()
        self._sentiment_model: ISentimentModel = NullSentimentModel()

        # Track the active prefs to detect model swaps.
        self._active_topic_model_name: str = "null"
        self._active_sentiment_model_name: str = "null"
        self._queue_depth: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def warmup(self) -> None:
        """
        Call after construction to pre-load model weights.

        Safe to call multiple times (idempotent per model contract).
        """
        log.info("Warming up topic model: %s", self._topic_model.name)
        self._topic_model.warmup()
        log.info("Warming up sentiment model: %s", self._sentiment_model.name)
        self._sentiment_model.warmup()

    def health(self) -> HealthStatus:
        """Return the current health status for the wire ``health_result`` response."""
        return HealthStatus(
            ok=True,
            version=__version__,
            loadedTopicModel=self._topic_model.name,
            loadedSentimentModel=self._sentiment_model.name,
            device=_DEVICE,  # type: ignore[arg-type]
            queueDepth=self._queue_depth,
        )

    def update_prefs(self, prefs: UserPreferences, prefs_version: int) -> None:
        """
        Apply new user preferences.

        - Hot-swaps topic / sentiment model if the names changed.
        - Pre-embeds banned topics and caches the result under ``prefs_version``.
        """
        self._swap_models_if_needed(prefs)
        self._ensure_topic_vectors(prefs, prefs_version)

    def classify(
        self, req: ClassifyRequest, prefs: UserPreferences
    ) -> ClassifyResponse:
        """
        Classify a batch of segments and return verdicts.

        Steps per segment:
            1. Preprocess (extract.preprocess)
            2. Skip unsupported-language segments
            3. Cache lookup for embedding
            4. Batch-embed cache misses
            5. Cosine similarity vs topic vectors
            6. Sentiment scoring (if prefs.sentimentEnabled)
            7. Build Verdict
        """
        t0 = time.perf_counter()
        self._queue_depth = len(req.segments)

        # Ensure models reflect current prefs (prefs may have changed since
        # the last update_prefs call if the extension sends classify first).
        self._swap_models_if_needed(prefs)
        self._ensure_topic_vectors(prefs, req.prefsVersion)

        # Step 1: preprocess all segments.
        cleaned = preprocess(
            req.segments,
            max_seq_len=getattr(self._topic_model, "max_seq_len", 512),
        )

        # Step 2: separate supported vs unsupported.
        supported = [s for s in cleaned if s.supported]
        unsupported = [s for s in cleaned if not s.supported]

        # Step 3 & 4: resolve embeddings (cache + model).
        embeddings = self._resolve_embeddings(supported)

        # Step 5 & 6: load topic vectors + score.
        topic_vectors = self._cache.get_topic_vectors(req.prefsVersion)
        topic_labels = self._cache.get_topic_labels(req.prefsVersion) or []

        # Sentiment batch.
        supported_texts = [s.body for s in supported]
        sentiment_scores: list[tuple[float, float]] = []
        if prefs.sentimentEnabled and supported_texts:
            try:
                sentiment_scores = self._sentiment_model.score(supported_texts)
            except Exception:
                log.warning("Sentiment scoring failed — returning neutral", exc_info=True)
                sentiment_scores = [(0.0, 0.0)] * len(supported_texts)
        else:
            sentiment_scores = [(0.0, 0.0)] * len(supported_texts)

        # Step 7: build verdicts for supported segments.
        verdicts: list[Verdict] = []

        for i, seg in enumerate(supported):
            seg_t0 = time.perf_counter()
            embedding = embeddings[i] if i < len(embeddings) else None
            cos_scores = (
                _cosine_similarity_batch(embedding, topic_vectors)
                if embedding is not None and topic_vectors is not None
                else []
            )

            polarity, magnitude = sentiment_scores[i]
            topics_out = []
            reasons: list[str] = []
            blocked = False

            # Topic matching.
            for label, score in zip(topic_labels, cos_scores):
                topics_out.append({"label": label, "score": float(score)})
                if score >= prefs.topicThreshold:
                    blocked = True
                    reasons.append(f"topic match: {label} ({score:.2f})")

            # Sentiment gating.
            if prefs.sentimentEnabled and magnitude > 0.3:
                sentiment_dict = {
                    "polarity": round(polarity, 4),
                    "magnitude": round(magnitude, 4),
                }
                if polarity < prefs.sentimentThreshold:
                    blocked = True
                    reasons.append(
                        f"negative sentiment: polarity={polarity:.2f}"
                    )
            else:
                sentiment_dict = None

            seg_latency = (time.perf_counter() - seg_t0) * 1000
            verdicts.append(
                Verdict(
                    segmentId=seg.id,
                    topics=topics_out,
                    sentiment=sentiment_dict,
                    blocked=blocked,
                    reasons=reasons,
                    latencyMs=round(seg_latency, 3),
                )
            )

        # Pass-through verdicts for unsupported segments.
        for seg in unsupported:
            verdicts.append(
                Verdict(
                    segmentId=seg.id,
                    topics=[],
                    sentiment=None,
                    blocked=False,
                    reasons=["unsupported_language"],
                    latencyMs=0.0,
                )
            )

        # Re-order verdicts to match the original request order.
        id_order = {s.id: i for i, s in enumerate(req.segments)}
        verdicts.sort(key=lambda v: id_order.get(v.segmentId, 999))

        engine_latency = (time.perf_counter() - t0) * 1000
        self._queue_depth = 0

        return ClassifyResponse(
            requestId=req.requestId,
            verdicts=verdicts,
            engineLatencyMs=round(engine_latency, 3),
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _swap_models_if_needed(self, prefs: UserPreferences) -> None:
        """Hot-swap topic or sentiment model if prefs changed."""
        if prefs.topicModel != self._active_topic_model_name:
            log.info(
                "Switching topic model: %s → %s",
                self._active_topic_model_name,
                prefs.topicModel,
            )
            self._topic_model = self._registry.get_topic_model(prefs.topicModel)
            self._active_topic_model_name = prefs.topicModel

        if prefs.sentimentModel != self._active_sentiment_model_name:
            log.info(
                "Switching sentiment model: %s → %s",
                self._active_sentiment_model_name,
                prefs.sentimentModel,
            )
            self._sentiment_model = self._registry.get_sentiment_model(prefs.sentimentModel)
            self._active_sentiment_model_name = prefs.sentimentModel

    def _ensure_topic_vectors(self, prefs: UserPreferences, prefs_version: int) -> None:
        """
        Embed banned topics and cache them under ``prefs_version`` if not
        already cached.

        No-op when ``bannedTopics`` is empty or the cache already has vectors
        for this version.
        """
        if not prefs.bannedTopics:
            return
        if self._cache.get_topic_vectors(prefs_version) is not None:
            return

        log.info(
            "Embedding %d banned topics for prefs_version=%d",
            len(prefs.bannedTopics),
            prefs_version,
        )
        try:
            vectors = self._topic_model.embed(prefs.bannedTopics)
            self._cache.put_topic_vectors(
                prefs_version, vectors, prefs.bannedTopics
            )
        except Exception:
            log.warning(
                "Failed to embed banned topics — topic matching disabled for this session",
                exc_info=True,
            )

    def _resolve_embeddings(self, segments: list) -> list:
        """
        Return an embedding for each segment in ``segments``.

        Cache hits are returned directly; misses are batched and embedded,
        then stored back.  Returns an empty list if the model or numpy is
        unavailable.
        """
        try:
            import numpy as np
        except ImportError:
            return []

        results: list = [None] * len(segments)
        miss_indices: list[int] = []
        miss_texts: list[str] = []

        for i, seg in enumerate(segments):
            cached = self._cache.get(seg.body)
            if cached is not None:
                results[i] = cached
            else:
                miss_indices.append(i)
                miss_texts.append(seg.body)

        if miss_texts:
            try:
                batch_embeddings = self._topic_model.embed(miss_texts)
                for j, idx in enumerate(miss_indices):
                    emb = np.array(batch_embeddings[j], dtype="float32")
                    results[idx] = emb
                    self._cache.put(miss_texts[j], emb)
            except Exception:
                log.warning("Embedding batch failed — skipping topic scoring", exc_info=True)

        return results

    def close(self) -> None:
        """Release resources (close SQLite connection)."""
        self._cache.close()


__all__ = ["Pipeline"]
