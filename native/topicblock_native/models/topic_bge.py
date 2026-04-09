"""
WP-7: Topic Model v1 (Zero-Shot Embedding Classifier) - Alternative Backbone.

Topic model using BAAI/bge-small-en-v1.5.
"""

from __future__ import annotations

import logging

try:
    import numpy as np
except ImportError:
    np = None

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    SentenceTransformer = None

from topicblock_native.models.base import ITopicModel

log = logging.getLogger(__name__)


class BGETopicModel(ITopicModel):
    name: str = "bge-small-en-v1.5"
    version: str = "1.0.0"
    max_seq_len: int = 512

    def __init__(self) -> None:
        if SentenceTransformer is None:
            raise RuntimeError("sentence-transformers is not installed")
        if np is None:
            raise RuntimeError("numpy is not installed")
            
        self._model_name = "BAAI/bge-small-en-v1.5"
        self._model: SentenceTransformer | None = None

    def _ensure_loaded(self) -> SentenceTransformer:
        if self._model is None:
            log.info("Loading topic model: %s", self._model_name)
            self._model = SentenceTransformer(self._model_name)
        return self._model

    def embed(self, texts: list[str]) -> np.ndarray: # type: ignore
        model = self._ensure_loaded()
        
        # sentence-transformers bge models need a prompt for queries usually
        # but since we compare embeddings via cosine similarity, simple encode is fine
        embeddings = model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)
        return embeddings # type: ignore

    def warmup(self) -> None:
        self._ensure_loaded()
