"""
Model protocols for TopicBlock native component.

Defines ``ITopicModel`` and ``ISentimentModel`` as ``typing.Protocol`` classes
matching §2.3 of TopicBlock_Implementation_Plan.md.

Also provides dependency-free null implementations (``NullTopicModel``,
``NullSentimentModel``) that the pipeline uses as fallbacks when the ``ml``
extras are not installed, preserving the fail-open guarantee.
"""

from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Numpy type alias — imported lazily so the null models work without numpy.
# ---------------------------------------------------------------------------

try:
    import numpy as np

    _NdArray = np.ndarray
except ImportError:  # pragma: no cover
    np = None  # type: ignore[assignment]
    _NdArray = object  # type: ignore[assignment,misc]


# ---------------------------------------------------------------------------
# Protocols
# ---------------------------------------------------------------------------


@runtime_checkable
class ITopicModel(Protocol):
    """
    Zero-shot topic model interface.

    ``embed`` returns a (N, D) float32 array of sentence embeddings for a
    batch of *N* input texts.  The embeddings are L2-normalised so that
    cosine similarity reduces to a dot product.

    ``warmup`` is called once at startup to pre-load weights into memory / onto
    the target device so that the first real request is not penalised.
    """

    name: str
    version: str
    max_seq_len: int

    def embed(self, texts: list[str]) -> _NdArray:  # type: ignore[type-arg]
        """Return (N, D) float32 normalised embeddings."""
        ...

    def warmup(self) -> None:
        """Pre-load model weights; must be idempotent."""
        ...


@runtime_checkable
class ISentimentModel(Protocol):
    """
    Sentiment model interface.

    ``score`` returns a list of ``(polarity, magnitude)`` tuples, one per text:
    - polarity is normalised to ``[-1, 1]`` (negative → positive).
    - magnitude is normalised to ``[0, 1]`` (calm → intense).
    """

    name: str
    version: str

    def score(self, texts: list[str]) -> list[tuple[float, float]]:
        """Return [(polarity, magnitude), ...] for each text."""
        ...

    def warmup(self) -> None:
        """Pre-load model weights; must be idempotent."""
        ...


# ---------------------------------------------------------------------------
# Null / no-op implementations (dependency-free fallbacks)
# ---------------------------------------------------------------------------


class NullTopicModel:
    """
    No-op topic model used when ML extras are not installed.

    ``embed`` always returns a zero matrix — cosine similarity against any
    topic vector will be 0.0, so no segment is ever blocked by topic.
    This preserves the fail-open guarantee: missing deps → pass-through.
    """

    name: str = "null"
    version: str = "0.0.0"
    max_seq_len: int = 512

    def embed(self, texts: list[str]) -> _NdArray:  # type: ignore[type-arg]
        if np is None:
            # Return a plain list of zero-vectors as a minimal fallback.
            return [[0.0] * 384] * len(texts)  # type: ignore[return-value]
        return np.zeros((len(texts), 384), dtype=np.float32)

    def warmup(self) -> None:
        log.debug("NullTopicModel.warmup() — no-op (ML extras not installed)")


class NullSentimentModel:
    """
    No-op sentiment model used when ML extras are not installed.

    ``score`` always returns neutral ``(0.0, 0.0)`` tuples — no segment is
    ever blocked by sentiment, honouring the fail-open guarantee.
    """

    name: str = "null"
    version: str = "0.0.0"

    def score(self, texts: list[str]) -> list[tuple[float, float]]:
        return [(0.0, 0.0)] * len(texts)

    def warmup(self) -> None:
        log.debug("NullSentimentModel.warmup() — no-op (ML extras not installed)")


__all__ = [
    "ITopicModel",
    "ISentimentModel",
    "NullTopicModel",
    "NullSentimentModel",
]
