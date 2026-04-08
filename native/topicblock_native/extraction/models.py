"""
CleanedSegment — the internal representation that travels from extraction
into the ML pipeline (WP-6 / WP-7 / WP-8).

This dataclass is *not* a wire type; it never crosses the Native-Messaging
boundary.  It is consumed exclusively by the Python pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class CleanedSegment:
    """A preprocessed content segment ready for ML inference.

    Fields
    ------
    id:
        Stable segment identifier (sha1-based hex, 16 chars) inherited from
        the browser-side adapter.
    headline:
        Cleaned headline text, or ``None`` if the adapter did not supply one.
    body:
        Cleaned, NFKC-normalised, whitespace-collapsed, emoji-stripped,
        and truncated segment text.  This is the primary inference input.
    site:
        Site identifier string (e.g. ``"hackernews"``, ``"reddit"``).
    lang:
        ISO-639-1 language code detected from ``body``, or ``"und"`` when
        detection confidence is below threshold or text is too short.
    lang_confidence:
        fasttext confidence score in [0, 1].  Set to 1.0 when the browser
        adapter supplied an explicit ``lang`` hint.
    supported:
        ``True`` when ``lang`` is in ``SUPPORTED_LANGS`` (currently only
        ``"en"``).  Unsupported segments skip topic/sentiment inference and
        receive a pass-through verdict with ``reasons: ["unsupported_language"]``.
    emojis:
        List of emoji characters that were removed from ``body`` during
        normalisation, preserved for potential UI display.
    extraction_hint:
        Forwarded from the wire segment (``"raw_html"``, ``"plain_text"``, or
        ``None``).  Useful for telemetry and debugging.
    """

    id: str
    headline: str | None
    body: str
    site: str
    lang: str
    lang_confidence: float
    supported: bool
    emojis: list[str] = field(default_factory=list)
    extraction_hint: str | None = None


__all__ = ["CleanedSegment"]
