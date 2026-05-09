"""N-gram tokenizer for the codify skill.

Extracts unigrams, bigrams, and trigrams from verbatim evidence quotes.
Lowercases, strips punctuation, drops stopwords + pure-numeric tokens.
Pure function — no I/O, no global state.
"""

from __future__ import annotations

import re

# A small clinical-prose-aware stopword list. Not exhaustive — codify is a
# coverage-biased extractor; the agent filters noise at runtime.
_STOPWORDS = frozenset({
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at",
    "for", "with", "by", "from", "as", "is", "are", "was", "were", "be",
    "been", "being", "has", "have", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "this", "that", "these",
    "those", "it", "its", "if", "than", "then", "so",
})

# Word boundary: split on whitespace and any non-word/non-hyphen punctuation.
# Then strip leading/trailing hyphens. Hyphenated words ("biopsy-confirmed")
# split into separate tokens.
_TOKEN_SPLIT_RE = re.compile(r"[^\w-]+")
_NUMERIC_RE = re.compile(r"^[\d.,]+$")


def _tokenize(text: str) -> list[str]:
    """Lowercase + split + filter stopwords/numerics. Returns unigrams."""
    if not text:
        return []
    pieces = _TOKEN_SPLIT_RE.split(text.lower())
    out = []
    for p in pieces:
        # Hyphenated words: split further.
        for word in p.split("-"):
            word = word.strip()
            if not word:
                continue
            if word in _STOPWORDS:
                continue
            if _NUMERIC_RE.match(word):
                continue
            out.append(word)
    return out


def extract_ngrams(text: str) -> list[str]:
    """Return all unigrams + bigrams + trigrams from `text`.

    Bigrams and trigrams are formed from adjacent unigrams (post-stopword
    removal), so "the patient with mass" produces "patient mass" if "with"
    drops out — that's intentional, the trigram captures the clinical phrase.
    """
    unigrams = _tokenize(text)
    if not unigrams:
        return []
    bigrams = [
        f"{unigrams[i]} {unigrams[i + 1]}"
        for i in range(len(unigrams) - 1)
    ]
    trigrams = [
        f"{unigrams[i]} {unigrams[i + 1]} {unigrams[i + 2]}"
        for i in range(len(unigrams) - 2)
    ]
    return unigrams + bigrams + trigrams
