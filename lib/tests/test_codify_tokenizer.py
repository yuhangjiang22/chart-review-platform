from chart_review.codify_tokenizer import extract_ngrams


def test_extracts_unigrams():
    ngrams = extract_ngrams("Patient has a biopsy-confirmed mass.")
    assert "biopsy" in ngrams
    assert "confirmed" in ngrams
    assert "mass" in ngrams


def test_drops_stopwords():
    ngrams = extract_ngrams("the patient and a nurse")
    assert "the" not in ngrams
    assert "and" not in ngrams
    assert "a" not in ngrams
    assert "patient" in ngrams


def test_lowercases():
    ngrams = extract_ngrams("Pathology REPORT")
    assert "pathology" in ngrams
    assert "report" in ngrams


def test_extracts_bigrams():
    ngrams = extract_ngrams("biopsy confirmed mass")
    assert "biopsy confirmed" in ngrams
    assert "confirmed mass" in ngrams


def test_extracts_trigrams():
    ngrams = extract_ngrams("ground glass opacity")
    assert "ground glass opacity" in ngrams


def test_drops_pure_numeric():
    ngrams = extract_ngrams("size 2.5 cm")
    # 2.5 is pure-numeric; cm is not
    assert "2.5" not in ngrams
    assert "cm" in ngrams


def test_strips_punctuation():
    ngrams = extract_ngrams("biopsy-confirmed, mass!")
    # hyphenated words split into components; punctuation stripped
    assert "biopsy" in ngrams
    assert "confirmed" in ngrams
    assert "mass" in ngrams
    # exclamation does NOT remain on the token
    assert "mass!" not in ngrams


def test_empty_string():
    assert extract_ngrams("") == []


def test_returns_list_of_str():
    out = extract_ngrams("hello world")
    assert isinstance(out, list)
    assert all(isinstance(t, str) for t in out)
