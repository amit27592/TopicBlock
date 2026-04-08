"""
Language detection for TopicBlock extraction pipeline.

Uses ``fasttext-langdetect`` with the compact ``lid.176.ftz`` model (~900 KB),
which covers 176 languages and runs in microseconds per call.

Model loading
-------------
The model is loaded **eagerly at import time** (module-level singleton).
This trades a one-time ~50 ms cold-start cost for zero per-call latency.
If the model file is missing, a ``RuntimeError`` is raised immediately so
failures surface at startup rather than on the first classify request.

Confidence threshold
--------------------
Predictions below ``MIN_CONFIDENCE`` (default 0.7) are reported as ``"und"``
(undetermined).  Very short strings (< ``MIN_TEXT_LEN`` characters) skip
detection entirely and also return ``"und"`` — fasttext results on tiny
inputs are unreliable.

Thread safety
-------------
``fasttext-langdetect`` uses a C++ fasttext model object internally.
The ``detect()`` call is thread-safe after loading as long as the model
object is not mutated (it isn't).
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MIN_CONFIDENCE: float = 0.7
"""Minimum fasttext confidence to accept a predicted language label."""

MIN_TEXT_LEN: int = 10
"""Minimum character count required to attempt language detection.
Strings shorter than this always return ("und", 0.0)."""

_UNDETERMINED = ("und", 0.0)

# ---------------------------------------------------------------------------
# Eager model load
# ---------------------------------------------------------------------------

try:
    import fasttext_langdetect as _ftld  # type: ignore[import-untyped]

    _MODEL_AVAILABLE = True
    log.info("fasttext-langdetect loaded successfully")
except ImportError:
    _ftld = None  # type: ignore[assignment]
    _MODEL_AVAILABLE = False
    log.warning(
        "fasttext-langdetect not installed; language detection disabled. "
        "Install with: pip install fasttext-langdetect"
    )


def detect_language(text: str) -> tuple[str, float]:
    """
    Detect the ISO-639-1 language of a preprocessed text string.

    Parameters
    ----------
    text:
        Cleaned, normalised text.  Should have whitespace collapsed and
        HTML tags removed before calling this function.

    Returns
    -------
    (lang, confidence)
        ``lang``: ISO-639-1 code (e.g. ``"en"``, ``"de"``), or ``"und"``
        if detection is unavailable or below the confidence threshold.
        ``confidence``: float in [0, 1]; set to 0.0 for ``"und"`` results.
    """
    if not _MODEL_AVAILABLE:
        # Graceful degradation: treat everything as English so the pipeline
        # continues without crashing when the ml extras are absent.
        return "en", 1.0

    if not text or len(text) < MIN_TEXT_LEN:
        return _UNDETERMINED

    try:
        result = _ftld.detect(text, low_memory=False)
        # ``result`` is a dict: {"lang": "en", "score": 0.99}
        lang: str = result.get("lang", "und")
        score: float = float(result.get("score", 0.0))

        # fasttext returns __label__xx prefixed labels in some versions.
        if lang.startswith("__label__"):
            lang = lang[len("__label__"):]

        # Normalise to lowercase ISO-639-1 (fasttext returns lowercase already,
        # but be defensive).
        lang = lang.lower()

        if score < MIN_CONFIDENCE:
            return _UNDETERMINED

        return lang, score

    except Exception as exc:
        log.debug("Language detection failed for text snippet (%s); returning und", exc)
        return _UNDETERMINED


__all__ = ["MIN_CONFIDENCE", "MIN_TEXT_LEN", "detect_language"]
