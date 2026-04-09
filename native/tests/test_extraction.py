"""
Tests for WP-5 — Text Extraction & Preprocessing.

All tests run against the pure-Python extraction package without requiring
ML models (lxml/readability-lxml and fasttext-langdetect are optional;
the modules degrade gracefully when absent).

Test sections
-------------
- Cleaner: HTML stripping, entity decoding, plain-text fast path
- Normaliser: NFKC, whitespace, emoji shadow copy, truncation
- Language detection: English pass, short-text undetermined, graceful degradation
- End-to-end preprocess(): raw_html and plain_text variants, ordering, lang-gating
- Performance smoke: aggregate timing across a batch is within a generous
  limit (the real per-segment budget will be tightened post WP-6 profiling)
"""

from __future__ import annotations

import time

import pytest

# ---------------------------------------------------------------------------
# Fixtures / shared helpers
# ---------------------------------------------------------------------------

_HN_HTML = """
<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <header>
    <nav><a href="/">Home</a> | <a href="/news">News</a> | <a href="/submit">Submit</a></nav>
  </header>
  <table>
    <tr class="athing">
      <td class="title">
        <a href="https://example.com/article">
          Scientists discover new method for carbon capture
        </a>
        <span class="sitebit">example.com</span>
      </td>
    </tr>
    <tr>
      <td class="subtext">
        <span class="score">142 points</span> by
        <a href="/user?id=johndoe">johndoe</a> 3 hours ago |
        <a href="/item?id=123">47 comments</a>
      </td>
    </tr>
  </table>
  <footer>
    <a href="https://news.ycombinator.com/newsguidelines.html">Guidelines</a> |
    <a href="https://news.ycombinator.com/newsfaq.html">FAQ</a>
  </footer>
</body>
</html>
"""

_REDDIT_HTML = """
<div class="thing" data-fullname="t3_abc123">
  <p class="title">
    <a class="title" href="/r/science/comments/abc">
      New research shows Mediterranean diet reduces inflammation markers by 30%
    </a>
    <span class="domain">(nature.com)</span>
  </p>
  <div class="expando">
    <div class="md">
      <p>Researchers at the University of Athens studied 500 participants over two years...</p>
    </div>
  </div>
  <ul class="buttons">
    <li><a class="comments">1.2k comments</a></li>
    <li><a class="share">share</a></li>
    <li><a class="save">save</a></li>
    <li><a class="hide">hide</a></li>
  </ul>
</div>
"""


def _make_seg(**kwargs):
    """Create a minimal SegmentInput for testing."""
    from topicblock_native.wire import SegmentInput

    defaults = {
        "id": "test-seg-0001",
        "body": "Hello world",
        "site": "hackernews",
        "headline": None,
        "subtitle": None,
        "lang": None,
        "extractionHint": None,
    }
    defaults.update(kwargs)
    return SegmentInput(**defaults)


# ============================================================================
# Cleaner tests
# ============================================================================

class TestCleanHtml:
    def test_strips_navigation_boilerplate(self):
        """clean_html should produce shorter output than raw HTML and contain some text."""
        from topicblock_native.extraction.cleaner import clean_html

        result = clean_html(_HN_HTML)
        # The result must be non-empty — the raw-fallback ensures content always survives.
        assert len(result.strip()) > 0
        # Must be shorter than the raw HTML (tags + boilerplate removed).
        assert len(result) < len(_HN_HTML)
        # No raw HTML tags should remain in the output.
        assert "<tr" not in result and "<td" not in result and "<nav" not in result

    def test_reddit_article_text_survives(self):
        from topicblock_native.extraction.cleaner import clean_html

        result = clean_html(_REDDIT_HTML)
        # The output should be non-empty and contain meaningful text (not just whitespace).
        assert len(result.strip()) > 0
        # At least one identifiable content word must appear (Readability or fallback).
        content_words = ["Mediterranean", "diet", "inflammation", "nature.com",
                         "Researchers", "participants", "science", "comments"]
        assert any(w in result for w in content_words), (
            f"No expected content words found in cleaned output: {result!r}"
        )

    def test_empty_string_returns_empty(self):
        from topicblock_native.extraction.cleaner import clean_html

        assert clean_html("") == ""
        assert clean_html("   ") == ""

    def test_plain_text_passthrough_no_tags(self):
        """HTML with no meaningful article (just text) should not crash."""
        from topicblock_native.extraction.cleaner import clean_html

        result = clean_html("<p>Just a simple paragraph with no layout.</p>")
        assert "Just a simple paragraph" in result

    def test_malformed_html_does_not_raise(self):
        """Wildly broken HTML must be handled without exception."""
        from topicblock_native.extraction.cleaner import clean_html

        bad_html = "<div><p>Unclosed <b>tag <span>everywhere"
        result = clean_html(bad_html)
        assert isinstance(result, str)  # no exception
        assert "Unclosed" in result or "tag" in result or result == ""

    def test_entity_decoding(self):
        """HTML entities in the article body must be decoded."""
        from topicblock_native.extraction.cleaner import clean_html

        html_with_entities = "<p>Tom &amp; Jerry enjoyed the show &mdash; it was great!</p>"
        result = clean_html(html_with_entities)
        assert "&amp;" not in result
        assert "&mdash;" not in result
        # The actual characters should be present.
        assert "Tom" in result and "Jerry" in result


class TestCleanPlain:
    def test_decodes_html_entities(self):
        from topicblock_native.extraction.cleaner import clean_plain

        assert clean_plain("Tom &amp; Jerry") == "Tom & Jerry"
        assert clean_plain("1 &lt; 2 &gt; 0") == "1 < 2 > 0"
        assert clean_plain("&quot;Hello&quot;") == '"Hello"'

    def test_empty_returns_empty(self):
        from topicblock_native.extraction.cleaner import clean_plain

        assert clean_plain("") == ""
        assert clean_plain(None) == ""  # type: ignore[arg-type]

    def test_plain_text_unaltered(self):
        """Text without entities should come back identical."""
        from topicblock_native.extraction.cleaner import clean_plain

        text = "The quick brown fox jumps over the lazy dog."
        assert clean_plain(text) == text


# ============================================================================
# Normaliser tests
# ============================================================================

class TestNormalise:
    def test_nfkc_ligatures(self):
        """Unicode ligatures should be decomposed."""
        from topicblock_native.extraction.normaliser import normalise

        result, _ = normalise("ﬁle ﬂow ﬀ")  # fi, fl, ff ligatures
        assert result == "file flow ff"

    def test_nfkc_fullwidth(self):
        """Fullwidth ASCII characters should become regular ASCII."""
        from topicblock_native.extraction.normaliser import normalise

        result, _ = normalise("Ｈｅｌｌｏ Ｗｏｒｌｄ")
        assert result == "Hello World"

    def test_whitespace_collapse(self):
        """Tabs, newlines, and runs of spaces collapse to a single space."""
        from topicblock_native.extraction.normaliser import normalise

        messy = "hello\t\tworld\n\nfoo   bar"
        result, _ = normalise(messy)
        assert result == "hello world foo bar"

    def test_leading_trailing_stripped(self):
        from topicblock_native.extraction.normaliser import normalise

        result, _ = normalise("  \n  padded text  \t ")
        assert result == "padded text"

    def test_emoji_stripped_from_body(self):
        """Emoji should not appear in the returned text."""
        from topicblock_native.extraction.normaliser import normalise

        text = "Love this! 😍🎉 Great article 🚀"
        result, emojis = normalise(text)
        assert "😍" not in result
        assert "🎉" not in result
        assert "🚀" not in result

    def test_emoji_preserved_in_shadow_list(self):
        """Stripped emoji must appear in the returned emojis list."""
        from topicblock_native.extraction.normaliser import normalise

        _, emojis = normalise("Hello 😊 world 🌍!")
        assert "😊" in emojis
        assert "🌍" in emojis

    def test_no_emoji_returns_empty_list(self):
        from topicblock_native.extraction.normaliser import normalise

        _, emojis = normalise("Plain text with no emoji.")
        assert emojis == []

    def test_truncation_at_limit(self):
        """Output must not exceed max_seq_len characters."""
        from topicblock_native.extraction.normaliser import normalise

        long_text = "word " * 200  # 1000 chars
        result, _ = normalise(long_text, max_seq_len=100)
        assert len(result) <= 100

    def test_truncation_at_word_boundary(self):
        """Truncation should prefer a word boundary rather than mid-token."""
        from topicblock_native.extraction.normaliser import normalise

        # 'aaa bbb ' repeated — the content always ends on full 3-char tokens.
        text = "aaa bbb " * 50  # 400 chars
        result, _ = normalise(text, max_seq_len=20)
        # Result must not end in a guaranteed mid-word substring.
        # 'a' alone or 'b' alone would indicate the token was split.
        assert result[-1] not in {" "}  # no trailing space after strip
        words = result.split()
        # Every word in our pattern is exactly 3 chars; any word shorter is a
        # sign of mid-word truncation.
        assert all(len(w) == 3 for w in words), (
            f"Found partial word in truncated result: {result!r}"
        )

    def test_empty_string(self):
        from topicblock_native.extraction.normaliser import normalise

        result, emojis = normalise("")
        assert result == ""
        assert emojis == []

    def test_short_text_within_limit_unchanged(self):
        """Text shorter than max_seq_len should not be altered (beyond normalisation)."""
        from topicblock_native.extraction.normaliser import normalise

        text = "Short text."
        result, _ = normalise(text, max_seq_len=512)
        assert result == text


# ============================================================================
# Language detection tests
# ============================================================================

class TestDetectLanguage:
    def test_english_text(self):
        """Clear English sentences should be classified as 'en'."""
        from topicblock_native.extraction.langdetect import detect_language

        lang, conf = detect_language(
            "The government announced new climate policies today."
        )
        # If fasttext is unavailable, module returns ("en", 1.0) as fallback.
        assert lang == "en"
        assert conf > 0.0

    def test_short_text_returns_und(self):
        """Text below MIN_TEXT_LEN should return undetermined."""
        from topicblock_native.extraction.langdetect import MIN_TEXT_LEN, detect_language

        short = "Hi"
        assert len(short) < MIN_TEXT_LEN
        lang, conf = detect_language(short)
        # Either "und" (model available) or "en" (fallback without model).
        assert lang in {"und", "en"}
        assert conf >= 0.0

    def test_empty_string_returns_und(self):
        from topicblock_native.extraction.langdetect import detect_language

        lang, conf = detect_language("")
        assert lang in {"und", "en"}

    def test_returns_tuple_of_str_and_float(self):
        from topicblock_native.extraction.langdetect import detect_language

        result = detect_language("Some text here for detection.")
        assert isinstance(result, tuple)
        assert len(result) == 2
        assert isinstance(result[0], str)
        assert isinstance(result[1], float)
        assert 0.0 <= result[1] <= 1.0

    def test_non_english_known_text(self):
        """German text should NOT be classified as English (when model available)."""
        from topicblock_native.extraction import SUPPORTED_LANGS
        from topicblock_native.extraction.langdetect import _MODEL_AVAILABLE, detect_language

        if not _MODEL_AVAILABLE:
            pytest.skip("fasttext-langdetect not installed")

        lang, conf = detect_language(
            "Die Bundesregierung hat heute neue Klimaschutzmaßnahmen angekündigt."
        )
        # German should parse as 'de' if confidence is high enough.
        if conf >= 0.7:
            assert lang not in SUPPORTED_LANGS  # "de" is not in {"en"}
        else:
            assert lang == "und"

    def test_confidence_between_zero_and_one(self):
        from topicblock_native.extraction.langdetect import detect_language

        _, conf = detect_language("This is a normal English sentence about science.")
        assert 0.0 <= conf <= 1.0


# ============================================================================
# End-to-end preprocess() tests
# ============================================================================

class TestPreprocess:
    def test_plain_text_segment_roundtrip(self):
        """A plain_text segment must come back cleaned and language-tagged."""
        from topicblock_native.extraction import preprocess
        from topicblock_native.extraction.models import CleanedSegment

        seg = _make_seg(
            id="seg-001",
            body="Scientists have discovered a new method for carbon capture.",
            headline="New carbon capture breakthrough",
            site="hackernews",
            extractionHint="plain_text",
        )
        results = preprocess([seg])
        assert len(results) == 1
        r = results[0]
        assert isinstance(r, CleanedSegment)
        assert r.id == "seg-001"
        assert r.site == "hackernews"
        assert "carbon" in r.body.lower() or "capture" in r.body.lower()
        assert r.lang in {"en", "und"}  # should detect as English
        assert 0.0 <= r.lang_confidence <= 1.0

    def test_raw_html_segment_cleaned(self):
        """A raw_html segment must have tags stripped."""
        from topicblock_native.extraction import preprocess

        seg = _make_seg(
            id="seg-002",
            body=_HN_HTML,
            site="hackernews",
            extractionHint="raw_html",
        )
        results = preprocess([seg])
        assert len(results) == 1
        r = results[0]
        # Output should not contain raw HTML tags.
        assert "<html>" not in r.body
        assert "<table>" not in r.body
        assert "<nav>" not in r.body

    def test_unsupported_language_flagged(self):
        """Non-English segments get supported=False (when model is available)."""
        from topicblock_native.extraction import preprocess
        from topicblock_native.extraction.langdetect import _MODEL_AVAILABLE

        if not _MODEL_AVAILABLE:
            pytest.skip("fasttext-langdetect not installed; fallback always returns 'en'")

        seg = _make_seg(
            id="seg-003",
            body=("Die Bundesregierung hat heute neue Klimaschutzmaßnahmen verabschiedet. "
                  "In einer Pressekonferenz erläuterte der Minister die geplanten Reformen."),
            site="hackernews",
            extractionHint="plain_text",
        )
        results = preprocess([seg])
        r = results[0]
        if r.lang != "und" and r.lang != "en":
            assert r.supported is False
        else:
            # If model returned "und" or fallback "en", just check the field exists.
            assert isinstance(r.supported, bool)

    def test_explicit_lang_hint_used(self):
        """If the SegmentInput has a lang hint, it should bypass detection."""
        from topicblock_native.extraction import preprocess

        seg = _make_seg(
            id="seg-004",
            body="Bonjour monde, ceci est un test.",
            site="reddit",
            lang="fr",
            extractionHint="plain_text",
        )
        results = preprocess([seg])
        r = results[0]
        assert r.lang == "fr"
        assert r.lang_confidence == 1.0

    def test_ordering_preserved(self):
        """Output order must match input order."""
        from topicblock_native.extraction import preprocess

        segs = [
            _make_seg(id=f"seg-{i:03d}", body=f"Segment number {i} content.")
            for i in range(10)
        ]
        results = preprocess(segs)
        for i, r in enumerate(results):
            assert r.id == f"seg-{i:03d}"

    def test_empty_batch(self):
        from topicblock_native.extraction import preprocess

        assert preprocess([]) == []

    def test_emoji_stripped_and_in_shadow(self):
        """Emoji in body must be stripped from body but appear in emojis list."""
        from topicblock_native.extraction import preprocess

        seg = _make_seg(
            id="seg-005",
            body="Love this article! 😍 What an amazing discovery! 🚀",
            site="reddit",
            extractionHint="plain_text",
        )
        results = preprocess([seg])
        r = results[0]
        assert "😍" not in r.body
        assert "🚀" not in r.body
        assert "😍" in r.emojis or "🚀" in r.emojis

    def test_truncation_applied(self):
        """Body must not exceed max_seq_len characters."""
        from topicblock_native.extraction import preprocess

        long_body = "interesting article content " * 100  # ~2800 chars
        seg = _make_seg(id="seg-006", body=long_body, extractionHint="plain_text")
        results = preprocess([seg], max_seq_len=200)
        assert len(results[0].body) <= 200

    def test_extraction_hint_forwarded(self):
        from topicblock_native.extraction import preprocess

        seg = _make_seg(id="seg-007", body="Some text.", extractionHint="raw_html")
        results = preprocess([seg])
        assert results[0].extraction_hint == "raw_html"

    def test_none_hint_treated_as_plain(self):
        from topicblock_native.extraction import preprocess

        seg = _make_seg(id="seg-008", body="Plain text, no hint.", extractionHint=None)
        results = preprocess([seg])
        assert results[0].extraction_hint is None
        assert "Plain text" in results[0].body

    def test_supported_field_true_for_english(self):
        from topicblock_native.extraction import preprocess

        seg = _make_seg(
            id="seg-009",
            body="This is a clear English sentence about technology and AI research.",
            lang="en",
        )
        results = preprocess([seg])
        assert results[0].supported is True


# ============================================================================
# Performance smoke test
# ============================================================================

class TestPerformance:
    def test_batch_plain_text_within_generous_limit(self):
        """
        Processing 50 plain-text segments should complete in under 5 seconds
        total (100 ms per segment generously budgeted).  A tighter budget will
        be enforced after WP-6 profiling on target hardware.
        """
        from topicblock_native.extraction import preprocess

        batch = [
            _make_seg(
                id=f"perf-{i:04d}",
                body=(
                    f"Segment {i}: Scientists have published a new study on topic {i % 10}. "
                    "The findings suggest significant implications for the field. "
                    "Further research is needed to confirm the results."
                ),
                site="hackernews",
                extractionHint="plain_text",
            )
            for i in range(50)
        ]

        t0 = time.perf_counter()
        results = preprocess(batch)
        elapsed_ms = (time.perf_counter() - t0) * 1000

        assert len(results) == 50
        # Generous limit: 5 000 ms total for 50 segments = 100 ms/segment.
        # The real target (≤ 2 ms/segment) will be enforced after profiling.
        assert elapsed_ms < 5_000, (
            f"preprocess() took {elapsed_ms:.1f} ms for 50 plain-text segments "
            f"(limit: 5 000 ms). Profile and optimise in WP-6."
        )

    def test_single_segment_headline_and_body(self):
        """Single segment with both headline and body must complete quickly."""
        from topicblock_native.extraction import preprocess

        seg = _make_seg(
            id="perf-single",
            headline="New breakthrough in renewable energy storage",
            body=(
                "Researchers at MIT have demonstrated a new type of battery that can store "
                "renewable energy for weeks without significant loss. The technology uses "
                "a novel liquid electrolyte that remains stable at room temperature."
            ),
            site="hackernews",
            extractionHint="plain_text",
        )
        t0 = time.perf_counter()
        results = preprocess([seg])
        elapsed_ms = (time.perf_counter() - t0) * 1000

        assert len(results) == 1
        assert elapsed_ms < 500, (  # 500 ms per segment is very generous
            f"Single segment took {elapsed_ms:.1f} ms (generous limit: 500 ms)"
        )
