"""
Model registry for TopicBlock native component.

The registry is the single source of truth for which models are available,
their metadata (served over the wire as ``ModelInfo``), and their Python
implementation classes.

Models are loaded lazily: the first call to ``get_topic_model`` or
``get_sentiment_model`` imports the implementation module and instantiates it.
Subsequent calls return the cached instance.

Adding a new model (e.g. WP-7's ``topic_minilm.py``) requires only:
  1. Create ``topicblock_native/models/topic_minilm.py`` implementing ``ITopicModel``.
  2. Add an entry to ``_TOPIC_REGISTRATIONS`` below.
  3. No other code changes.
"""

from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass
from typing import Any

from topicblock_native.models.base import (
    ITopicModel,
    ISentimentModel,
    NullSentimentModel,
    NullTopicModel,
)
from topicblock_native.wire import ModelInfo

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Registration records — metadata + lazy import path
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _TopicRegistration:
    name: str
    version: str
    backbone: str
    max_seq_len: int
    default_threshold: float
    min_ram_mb: int
    needs_gpu: bool
    module: str        # dotted module path to import
    class_name: str    # class inside that module


@dataclass(frozen=True)
class _SentimentRegistration:
    name: str
    version: str
    backbone: str
    max_seq_len: int
    default_threshold: float
    min_ram_mb: int
    needs_gpu: bool
    module: str
    class_name: str


# ---------------------------------------------------------------------------
# Registry tables
# ---------------------------------------------------------------------------
# WP-7 and WP-8 add entries here.  The ``module`` field is not imported
# at module load time — only when the model is first requested.

_TOPIC_REGISTRATIONS: dict[str, _TopicRegistration] = {
    "minilm-l6-v2": _TopicRegistration(
        name="minilm-l6-v2",
        version="1.0.0",
        backbone="sentence-transformers/all-MiniLM-L6-v2",
        max_seq_len=512,
        default_threshold=0.5,
        min_ram_mb=500,
        needs_gpu=False,
        module="topicblock_native.models.topic_minilm",
        class_name="MiniLMTopicModel",
    ),
    "bge-small-en-v1.5": _TopicRegistration(
        name="bge-small-en-v1.5",
        version="1.0.0",
        backbone="BAAI/bge-small-en-v1.5",
        max_seq_len=512,
        default_threshold=0.5,
        min_ram_mb=500,
        needs_gpu=False,
        module="topicblock_native.models.topic_bge",
        class_name="BGETopicModel",
    ),
}

_SENTIMENT_REGISTRATIONS: dict[str, _SentimentRegistration] = {
    "vader": _SentimentRegistration(
        name="vader",
        version="1.0.0",
        backbone="vaderSentiment",
        max_seq_len=512,
        default_threshold=-0.6,
        min_ram_mb=0,
        needs_gpu=False,
        module="topicblock_native.models.sentiment_vader",
        class_name="VaderSentimentModel",
    ),
    "distilbert-sst2": _SentimentRegistration(
        name="distilbert-sst2",
        version="1.0.0",
        backbone="distilbert-base-uncased-finetuned-sst-2-english",
        max_seq_len=512,
        default_threshold=-0.6,
        min_ram_mb=500,
        needs_gpu=False,
        module="topicblock_native.models.sentiment_distilbert",
        class_name="DistilBertSentimentModel",
    ),
}


# ---------------------------------------------------------------------------
# Registry class
# ---------------------------------------------------------------------------


class ModelRegistry:
    """
    Thread-safe (GIL) lazy model registry.

    Instantiated once by the pipeline at startup.  The ``get_*`` methods
    return the live model instance, loading it the first time.  If loading
    fails (e.g. ``sentence-transformers`` not installed), the corresponding
    Null model is returned and logged at WARNING level.
    """

    def __init__(self) -> None:
        self._topic_instances: dict[str, ITopicModel] = {}
        self._sentiment_instances: dict[str, ISentimentModel] = {}

    # ------------------------------------------------------------------
    # Topic models
    # ------------------------------------------------------------------

    def get_topic_model(self, name: str) -> ITopicModel:
        """
        Return a live topic model by name.

        Falls back to ``NullTopicModel`` if the name is unknown or the
        implementation module cannot be imported.
        """
        if name in self._topic_instances:
            return self._topic_instances[name]

        reg = _TOPIC_REGISTRATIONS.get(name)
        if reg is None:
            log.warning(
                "Unknown topic model %r — falling back to NullTopicModel. "
                "Has WP-7 been installed?",
                name,
            )
            instance: ITopicModel = NullTopicModel()
        else:
            instance = self._load_instance(reg.module, reg.class_name, NullTopicModel)

        self._topic_instances[name] = instance
        return instance

    # ------------------------------------------------------------------
    # Sentiment models
    # ------------------------------------------------------------------

    def get_sentiment_model(self, name: str) -> ISentimentModel:
        """
        Return a live sentiment model by name.

        Falls back to ``NullSentimentModel`` if the name is unknown or the
        implementation module cannot be imported.
        """
        if name in self._sentiment_instances:
            return self._sentiment_instances[name]

        reg = _SENTIMENT_REGISTRATIONS.get(name)
        if reg is None:
            log.warning(
                "Unknown sentiment model %r — falling back to NullSentimentModel. "
                "Has WP-8 been installed?",
                name,
            )
            sentiment_instance: ISentimentModel = NullSentimentModel()
        else:
            sentiment_instance = self._load_instance(
                reg.module, reg.class_name, NullSentimentModel
            )

        self._sentiment_instances[name] = sentiment_instance
        return sentiment_instance

    # ------------------------------------------------------------------
    # Wire: list_models
    # ------------------------------------------------------------------

    def list_models_info(self) -> list[ModelInfo]:
        """Return ``ModelInfo`` records for all registered models."""
        infos: list[ModelInfo] = []

        for reg in _TOPIC_REGISTRATIONS.values():
            infos.append(
                ModelInfo(
                    kind="topic",
                    name=reg.name,
                    version=reg.version,
                    backbone=reg.backbone,
                    maxSeqLen=reg.max_seq_len,
                    defaultThreshold=reg.default_threshold,
                    hwRequirements={
                        "minRamMb": reg.min_ram_mb,
                        "needsGpu": reg.needs_gpu,
                    },
                )
            )

        for reg in _SENTIMENT_REGISTRATIONS.values():
            infos.append(
                ModelInfo(
                    kind="sentiment",
                    name=reg.name,
                    version=reg.version,
                    backbone=reg.backbone,
                    maxSeqLen=reg.max_seq_len,
                    defaultThreshold=reg.default_threshold,
                    hwRequirements={
                        "minRamMb": reg.min_ram_mb,
                        "needsGpu": reg.needs_gpu,
                    },
                )
            )

        # Always include the null models so callers know the fallback exists.
        infos.append(
            ModelInfo(
                kind="topic",
                name="null",
                version="0.0.0",
                backbone="NullTopicModel",
                maxSeqLen=512,
                defaultThreshold=0.5,
                hwRequirements={"minRamMb": 0, "needsGpu": False},
            )
        )
        infos.append(
            ModelInfo(
                kind="sentiment",
                name="null",
                version="0.0.0",
                backbone="NullSentimentModel",
                maxSeqLen=512,
                defaultThreshold=-0.6,
                hwRequirements={"minRamMb": 0, "needsGpu": False},
            )
        )

        return infos

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _load_instance(module_path: str, class_name: str, fallback_cls: Any) -> Any:
        """
        Import ``module_path``, instantiate ``class_name``, and return it.

        On any import or instantiation error, log the traceback at WARNING
        level and return a ``fallback_cls()`` instance.
        """
        try:
            mod = importlib.import_module(module_path)
            cls = getattr(mod, class_name)
            instance = cls()
            log.info("Loaded %s.%s", module_path, class_name)
            return instance
        except Exception:
            log.warning(
                "Failed to load %s.%s — falling back to %s",
                module_path,
                class_name,
                fallback_cls.__name__,
                exc_info=True,
            )
            return fallback_cls()


# Module-level singleton — the pipeline imports this directly.
registry = ModelRegistry()

__all__ = ["ModelRegistry", "registry"]
