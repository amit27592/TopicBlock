"""
Text normalisation for TopicBlock extraction pipeline.

Applied to *all* segments after cleaning (HTML or plain), before language
detection and model inference.

Steps (in order)
----------------
1. Unicode NFKC normalisation — collapses compatibility characters
   (ligatures, fullwidth, superscripts, etc.) to their base forms.
2. Whitespace collapse — tabs, newlines, and runs of spaces → single space;
   leading/trailing whitespace stripped.
3. Emoji stripping — emoji codepoints are removed from the main text and
   collected in a separate list so the UI can display them if desired.
4. Truncation — the text is hard-truncated to ``max_seq_len`` characters.
   This keeps inference payloads within the model's context window.
   Token-level truncation is handled by the HuggingFace tokeniser later;
   this character-level cut is an inexpensive first pass.

The function returns ``(cleaned_text, emojis)`` as a two-tuple so callers
can preserve the emoji shadow copy without a second pass.
"""

from __future__ import annotations

import re
import unicodedata

# ---------------------------------------------------------------------------
# Emoji detection
# ---------------------------------------------------------------------------
# Build a regex that matches any single character in a Unicode emoji category.
# We use the ``\p{Emoji}`` equivalent by targeting common emoji Unicode ranges.
# This is intentionally broad — it will catch all standard emoji blocks.
#
# Ranges covered:
#   U+2600–U+26FF  Miscellaneous Symbols
#   U+2700–U+27BF  Dingbats
#   U+FE00–U+FE0F  Variation Selectors (emoji vs text presentation)
#   U+1F300–U+1FBFF  Emoji block (most emoji live here)
#   U+200D         Zero Width Joiner (part of emoji sequences)
#   U+20E3         Combining Enclosing Keycap
#   U+FE0F         Variation selector-16 (emoji presentation)
#
# The regex is compiled once at module load.
_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001FBFF"  # Emoticons, symbols, pictographs, etc.
    "\U00002600-\U000027BF"  # Misc symbols + dingbats
    "\U0000FE00-\U0000FE0F"  # Variation selectors
    "\U0001F004"             # Mahjong tile (miscellaneous)
    "\U0001F0CF"             # Playing card black joker
    "\U000020E3"             # Combining enclosing keycap
    "\U0000200D"             # ZWJ (zero-width joiner in emoji sequences)
    "]",
    flags=re.UNICODE,
)

# Whitespace normalisation: any sequence of whitespace chars → single space.
_WS_RE = re.compile(r"\s+")


def normalise(text: str, max_seq_len: int = 512) -> tuple[str, list[str]]:
    """
    Normalise a cleaned text string for ML inference.

    Parameters
    ----------
    text:
        Input text, already HTML-cleaned (no raw tags).
    max_seq_len:
        Maximum character length of the returned string.  Text longer than
        this is hard-truncated.  Default is 512, matching the default context
        window of most sentence-transformer models.

    Returns
    -------
    (normalised_text, emojis)
        ``normalised_text``: NFKC-normalised, whitespace-collapsed,
        emoji-stripped, truncated string.
        ``emojis``: list of emoji characters removed, in order of appearance.
    """
    if not text:
        return "", []

    # Step 1: Unicode NFKC
    text = unicodedata.normalize("NFKC", text)

    # Step 2: Whitespace collapse (do before emoji strip so \n inside emoji
    # sequences doesn't leave orphaned spaces)
    text = _WS_RE.sub(" ", text).strip()

    # Step 3: Emoji extraction
    emojis: list[str] = _EMOJI_RE.findall(text)
    text = _EMOJI_RE.sub("", text)

    # A second whitespace pass to clean up gaps left by removed emoji.
    text = _WS_RE.sub(" ", text).strip()

    # Step 4: Truncation
    if len(text) > max_seq_len:
        # Truncate at a word boundary where possible to avoid splitting tokens.
        truncated = text[:max_seq_len]
        last_space = truncated.rfind(" ")
        if last_space > max_seq_len // 2:
            # There is a reasonable word boundary — use it.
            truncated = truncated[:last_space]
        text = truncated.strip()

    return text, emojis


__all__ = ["normalise"]
