"""
WP-8: Sentiment Model v1 (VADER).

Sentiment model using vaderSentiment library.
"""

from __future__ import annotations

import logging

try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
except ImportError:
    SentimentIntensityAnalyzer = None

from topicblock_native.models.base import ISentimentModel

log = logging.getLogger(__name__)


class VaderSentimentModel(ISentimentModel):
    name: str = "vader"
    version: str = "1.0.0"

    def __init__(self) -> None:
        if SentimentIntensityAnalyzer is None:
            raise RuntimeError("vaderSentiment is not installed")
        self._analyzer: "SentimentIntensityAnalyzer" | None = None

    def _ensure_loaded(self) -> "SentimentIntensityAnalyzer":
        if self._analyzer is None:
            log.info("Loading VADER sentiment analyzer")
            self._analyzer = SentimentIntensityAnalyzer()
        return self._analyzer

    def score(self, texts: list[str]) -> list[tuple[float, float]]:
        analyzer = self._ensure_loaded()
        results: list[tuple[float, float]] = []
        
        for text in texts:
            scores = analyzer.polarity_scores(text)
            # Polarity: [-1.0, 1.0] (VADER compound score)
            polarity = float(scores["compound"])
            
            # Magnitude: [0.0, 1.0] (We use 1.0 - neutral score, because pos + neg + neu = 1.0)
            magnitude = float(1.0 - scores["neu"])
            
            results.append((polarity, magnitude))
            
        return results

    def warmup(self) -> None:
        self._ensure_loaded()
