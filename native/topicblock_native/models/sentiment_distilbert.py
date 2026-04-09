"""
WP-8: Sentiment Model v1 (DistilBERT).

Sentiment model using transformers pipeline with distilbert-base-uncased-finetuned-sst-2-english.
"""

from __future__ import annotations

import logging
from typing import Any

try:
    from transformers import pipeline
except ImportError:
    pipeline = None

from topicblock_native.models.base import ISentimentModel

log = logging.getLogger(__name__)


class DistilBertSentimentModel(ISentimentModel):
    name: str = "distilbert-sst2"
    version: str = "1.0.0"

    def __init__(self) -> None:
        if pipeline is None:
            raise RuntimeError("transformers is not installed")
        
        self._model_name = "distilbert-base-uncased-finetuned-sst-2-english"
        self._pipeline: Any = None

    def _ensure_loaded(self) -> Any:
        if self._pipeline is None:
            log.info("Loading transformers pipeline: %s", self._model_name)
            
            # Detect device from pipeline config if available
            try:
                from topicblock_native.pipeline import _DEVICE
                device_str = _DEVICE
            except ImportError:
                device_str = "cpu"
                
            # pipeline() device argument: -1 for CPU, 0 for first GPU, or string aliases in newer versions
            device_arg: int | str = -1
            if device_str in ("cuda", "mps"):
                device_arg = device_str

            self._pipeline = pipeline(
                "sentiment-analysis",
                model=self._model_name,
                device=device_arg
            )
        return self._pipeline

    def score(self, texts: list[str]) -> list[tuple[float, float]]:
        pipe = self._ensure_loaded()
        results: list[tuple[float, float]] = []
        
        if not texts:
            return results
            
        outputs = pipe(texts, truncation=True, max_length=512)
        
        for out in outputs:
            label = out["label"]
            score = out["score"]
            
            # sst2 labels: "POSITIVE" or "NEGATIVE"
            # Return normalized polarity [-1, 1] and magnitude [0, 1]
            polarity = float(score) if label == "POSITIVE" else float(-score)
            magnitude = float(score)
            
            results.append((polarity, magnitude))
            
        return results

    def warmup(self) -> None:
        self._ensure_loaded()
