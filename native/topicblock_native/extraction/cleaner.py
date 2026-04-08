"""
HTML and plain-text cleaning for TopicBlock extraction pipeline.

Two paths
---------
``clean_html(raw_html)``
    Uses ``readability-lxml`` to extract the main content block (Readability
    algorithm, same as Firefox Reader View), then strips all remaining HTML
    tags with lxml to produce plain text.  Falls back gracefully on parse
    errors: if readability fails, lxml tag-stripping is applied directly to
    the raw input.

``clean_plain(text)``
    Fast path for segments already delivered as ``plain_text``.  Decodes
    any residual HTML entities (e.g. ``&amp;`` → ``&``) via the stdlib
    ``html`` module, then returns the text unchanged — normalisation is
    applied downstream in ``normaliser.py``.

Neither function applies unicode normalisation or whitespace collapse; those
are the responsibility of ``normaliser.normalise()``.
"""

from __future__ import annotations

import html
import logging
import re

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional imports — guard so the module is importable even without the
# ml extras installed (e.g. in a thin CI environment running only unit tests
# that mock the cleaner).
# ---------------------------------------------------------------------------
try:
    from lxml import etree  # type: ignore[import-untyped]
    from readability import Document  # type: ignore[import-untyped]

    _LXML_AVAILABLE = True
except ImportError:  # pragma: no cover
    _LXML_AVAILABLE = False
    log.warning("lxml / readability-lxml not installed; clean_html will strip tags naively")

# Regex to strip any remaining HTML tags after lxml processing.
_TAG_RE = re.compile(r"<[^>]+>")
# Multiple consecutive whitespace (including newlines) → single space.
_WS_RE = re.compile(r"\s+")


def clean_html(raw_html: str) -> str:
    """Extract and clean main content from an HTML snippet or full page.

    Parameters
    ----------
    raw_html:
        Raw ``outerHTML`` of a content segment, or a full page document.

    Returns
    -------
    str
        Plain text with boilerplate (navigation, ads, sidebars) removed.
        HTML entities are decoded.  Whitespace is *not* collapsed here —
        that happens in ``normaliser.normalise()``.
    """
    if not raw_html or not raw_html.strip():
        return ""

    if not _LXML_AVAILABLE:
        # Fallback: strip tags with a regex (good enough for tests without ml extras).
        text = _TAG_RE.sub(" ", raw_html)
        return html.unescape(text)

    try:
        doc = Document(raw_html)
        # ``summary()`` returns the Readability-extracted content as HTML.
        readable_html = doc.summary(html_partial=True)
    except Exception as exc:
        log.debug("readability failed (%s); falling back to raw tag-strip", exc)
        readable_html = raw_html

    def _extract_text(source_html: str) -> str:
        """Extract plain text from an HTML string using lxml."""
        try:
            root = etree.fromstring(  # noqa: S320
                source_html.encode("utf-8"),
                parser=etree.HTMLParser(recover=True, encoding="utf-8"),
            )
            parts = list(root.itertext())
            return " ".join(p for p in parts if p and p.strip())
        except Exception as exc2:
            log.debug("lxml text extraction failed (%s); using regex fallback", exc2)
            return _TAG_RE.sub(" ", source_html)

    text = _extract_text(readable_html)

    # If Readability produced an effectively empty result (e.g. it discarded a
    # nav-heavy fragment entirely), fall back to extracting text from the raw
    # HTML so we never silently drop content-bearing inputs.
    if len(text.strip()) < 20 and readable_html is not raw_html:
        log.debug(
            "Readability output too short (%d chars); using raw tag-strip fallback",
            len(text.strip()),
        )
        text = _extract_text(raw_html)

    # Decode residual entities (e.g. ``&amp;``, ``&lt;``) that lxml may leave.
    return html.unescape(text)


def clean_plain(text: str) -> str:
    """Minimal cleaning for already-plain text segments.

    Decodes HTML entities that the browser adapter may have left in the
    extracted text (e.g. ``&amp;`` from ``textContent``).  Does not strip
    tags or alter whitespace.

    Parameters
    ----------
    text:
        Plain-text string from the browser adapter.

    Returns
    -------
    str
        Entity-decoded string, ready for ``normaliser.normalise()``.
    """
    if not text:
        return ""
    return html.unescape(text)


__all__ = ["clean_html", "clean_plain"]
