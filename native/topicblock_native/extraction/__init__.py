"""
Text extraction and preprocessing package for TopicBlock native component.

Public API
----------
    from topicblock_native.extraction import preprocess, CleanedSegment

    cleaned = preprocess(segments, max_seq_len=512)

The `preprocess` function accepts a list of ``SegmentInput`` wire objects and
returns a hydrated list of ``CleanedSegment`` dataclasses ready for inference.

Pipeline per segment
--------------------
1. Clean — strip HTML (via readability-lxml) or fast-path for plain_text.
2. Normalise — NFKC, whitespace collapse, emoji strip (shadow copy), truncate.
3. Detect language — fasttext lid.176.ftz; undetermined / low-confidence → ``und``.
4. Mark `supported` — only ``en`` today; non-supported segments short-circuit
   in WP-6 to a pass-through verdict with reason ``unsupported_language``.
"""

from __future__ import annotations

from topicblock_native.extraction.cleaner import clean_html, clean_plain
from topicblock_native.extraction.langdetect import detect_language
from topicblock_native.extraction.models import CleanedSegment
from topicblock_native.extraction.normaliser import normalise
from topicblock_native.wire import SegmentInput

# Languages for which ML inference is supported.
# Only "en" for the initial release; extend as multilingual models are added.
SUPPORTED_LANGS: frozenset[str] = frozenset({"en"})


def preprocess(
    segments: list[SegmentInput],
    max_seq_len: int = 512,
    supported_langs: frozenset[str] = SUPPORTED_LANGS,
) -> list[CleanedSegment]:
    """
    Clean, normalise, and language-tag a batch of SegmentInput objects.

    Parameters
    ----------
    segments:
        Wire-protocol segment objects from a ClassifyRequest.
    max_seq_len:
        Character-level truncation limit applied after cleaning and normalisation.
        Keeps payloads inside the tokeniser's window without requiring a tokeniser
        import here; the model's tokeniser will further truncate by token count.
    supported_langs:
        Set of ISO-639-1 codes that the ML pipeline handles.  Segments outside
        this set receive ``supported=False`` and will skip inference in WP-6.

    Returns
    -------
    list[CleanedSegment]
        One entry per input segment, in the same order.
    """
    results: list[CleanedSegment] = []

    for seg in segments:
        # ------------------------------------------------------------------
        # Step 1: clean
        # ------------------------------------------------------------------
        hint = seg.extractionHint  # "raw_html" | "plain_text" | None
        raw_body = seg.body or ""
        raw_headline = seg.headline or ""

        if hint == "raw_html":
            body = clean_html(raw_body)
            headline = clean_html(raw_headline) if raw_headline else ""
        else:
            body = clean_plain(raw_body)
            headline = clean_plain(raw_headline) if raw_headline else ""

        # Combine headline and body into one string for normalisation.
        # The headline is prepended so it influences both language detection
        # and (later) embedding, where the first tokens carry more weight.
        combined = f"{headline} {body}".strip() if headline else body

        # ------------------------------------------------------------------
        # Step 2: normalise
        # ------------------------------------------------------------------
        cleaned_text, emojis = normalise(combined, max_seq_len=max_seq_len)

        # ------------------------------------------------------------------
        # Step 3: language detection
        # ------------------------------------------------------------------
        # Use the caller-supplied lang hint if available (extension adapter may
        # have already detected the page language); otherwise detect from text.
        if seg.lang and len(seg.lang) == 2:
            lang = seg.lang.lower()
            lang_confidence = 1.0
        else:
            lang, lang_confidence = detect_language(cleaned_text)

        supported = lang in supported_langs

        results.append(
            CleanedSegment(
                id=seg.id,
                headline=headline if headline else None,
                body=cleaned_text,
                site=seg.site,
                lang=lang,
                lang_confidence=lang_confidence,
                supported=supported,
                emojis=emojis,
                extraction_hint=hint,
            )
        )

    return results


__all__ = ["CleanedSegment", "SUPPORTED_LANGS", "preprocess"]
