"""
Tests for topicblock_native.cache.EmbeddingCache

All tests avoid numpy where possible so they pass with dev extras only.
Numpy-dependent tests are skipped if numpy is not installed.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from topicblock_native.cache import EmbeddingCache, _text_key

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

np = pytest.importorskip("numpy", reason="numpy required for cache tests")


def _rand_vec(dim: int = 16) -> "np.ndarray":
    return np.random.default_rng(42).random(dim).astype("float32")


def _rand_mat(n: int, dim: int = 16) -> "np.ndarray":
    return np.random.default_rng(0).random((n, dim)).astype("float32")


@pytest.fixture()
def cache(tmp_path: Path) -> EmbeddingCache:
    return EmbeddingCache(path=tmp_path / "test.db", capacity=10)


# ---------------------------------------------------------------------------
# Key hashing
# ---------------------------------------------------------------------------


class TestTextKey:
    def test_same_text_same_key(self) -> None:
        assert _text_key("hello") == _text_key("hello")

    def test_different_text_different_key(self) -> None:
        assert _text_key("hello") != _text_key("world")

    def test_key_is_hex_string(self) -> None:
        key = _text_key("test")
        assert all(c in "0123456789abcdef" for c in key)

    def test_key_length_is_64(self) -> None:
        # SHA-256 hex digest is always 64 characters.
        assert len(_text_key("anything")) == 64


# ---------------------------------------------------------------------------
# Segment embedding round-trip
# ---------------------------------------------------------------------------


class TestEmbeddingRoundTrip:
    def test_put_then_get_returns_same_values(self, cache: EmbeddingCache) -> None:
        text = "Hello world"
        vec = _rand_vec(16)
        cache.put(text, vec)
        result = cache.get(text)
        assert result is not None
        np.testing.assert_array_almost_equal(result, vec, decimal=5)

    def test_get_unknown_returns_none(self, cache: EmbeddingCache) -> None:
        assert cache.get("not in cache") is None

    def test_put_overwrites_existing(self, cache: EmbeddingCache) -> None:
        text = "sentence"
        vec1 = _rand_vec(16)
        vec2 = _rand_vec(16) * 2
        cache.put(text, vec1)
        cache.put(text, vec2)
        result = cache.get(text)
        assert result is not None
        np.testing.assert_array_almost_equal(result, vec2, decimal=5)

    def test_high_dimensional_embedding(self, cache: EmbeddingCache) -> None:
        """Cache must handle 384-dimensional vectors (MiniLM default)."""
        vec = _rand_vec(384)
        cache.put("high dim", vec)
        result = cache.get("high dim")
        assert result is not None
        assert result.shape == (384,)

    def test_dtype_preserved_as_float32(self, cache: EmbeddingCache) -> None:
        vec = _rand_vec(16)
        cache.put("dtype test", vec)
        result = cache.get("dtype test")
        assert result is not None
        assert result.dtype == np.float32


# ---------------------------------------------------------------------------
# Size and eviction
# ---------------------------------------------------------------------------


class TestSizeAndEviction:
    def test_size_increases_with_puts(self, cache: EmbeddingCache) -> None:
        assert cache.size() == 0
        for i in range(3):
            cache.put(f"text-{i}", _rand_vec())
        assert cache.size() == 3

    def test_eviction_keeps_size_at_or_below_capacity(self, cache: EmbeddingCache) -> None:
        """Inserting 15 items into a capacity-10 cache should trigger eviction."""
        for i in range(15):
            cache.put(f"unique text number {i} with extra padding", _rand_vec())
        # After eviction, size must be ≤ capacity.
        assert cache.size() <= 10

    def test_clear_removes_all_embeddings(self, cache: EmbeddingCache) -> None:
        for i in range(5):
            cache.put(f"t{i}", _rand_vec())
        assert cache.size() == 5
        cache.clear()
        assert cache.size() == 0

    def test_clear_does_not_remove_topic_vectors(self, cache: EmbeddingCache) -> None:
        """cache.clear() only removes segment embeddings, not topic vectors."""
        mat = _rand_mat(3, 16)
        cache.put_topic_vectors(1, mat, ["a", "b", "c"])
        cache.clear()
        # Topic vectors must survive clear().
        assert cache.get_topic_vectors(1) is not None


# ---------------------------------------------------------------------------
# Topic vector round-trip
# ---------------------------------------------------------------------------


class TestTopicVectorRoundTrip:
    def test_put_and_get_topic_vectors(self, cache: EmbeddingCache) -> None:
        mat = _rand_mat(4, 16)
        cache.put_topic_vectors(42, mat, ["sports", "politics", "tech", "climate"])
        result = cache.get_topic_vectors(42)
        assert result is not None
        assert result.shape == (4, 16)
        np.testing.assert_array_almost_equal(result, mat, decimal=5)

    def test_get_topic_vectors_unknown_version_returns_none(
        self, cache: EmbeddingCache
    ) -> None:
        assert cache.get_topic_vectors(999) is None

    def test_put_and_get_topic_labels(self, cache: EmbeddingCache) -> None:
        labels = ["AI", "cryptocurrency", "elections"]
        mat = _rand_mat(3, 16)
        cache.put_topic_vectors(10, mat, labels)
        result = cache.get_topic_labels(10)
        assert result == labels

    def test_get_topic_labels_unknown_version_returns_none(
        self, cache: EmbeddingCache
    ) -> None:
        assert cache.get_topic_labels(9999) is None

    def test_topic_vectors_overwrite_on_same_version(self, cache: EmbeddingCache) -> None:
        mat1 = _rand_mat(2, 16)
        mat2 = _rand_mat(3, 16)
        cache.put_topic_vectors(5, mat1, ["a", "b"])
        cache.put_topic_vectors(5, mat2, ["x", "y", "z"])
        result = cache.get_topic_vectors(5)
        assert result is not None
        assert result.shape == (3, 16)
        labels = cache.get_topic_labels(5)
        assert labels == ["x", "y", "z"]

    def test_different_versions_coexist(self, cache: EmbeddingCache) -> None:
        mat1 = _rand_mat(2, 16)
        mat2 = _rand_mat(3, 16)
        cache.put_topic_vectors(1, mat1, ["a", "b"])
        cache.put_topic_vectors(2, mat2, ["x", "y", "z"])
        assert cache.get_topic_vectors(1) is not None
        assert cache.get_topic_vectors(2) is not None
        assert cache.get_topic_labels(1) == ["a", "b"]
        assert cache.get_topic_labels(2) == ["x", "y", "z"]


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


class TestPersistence:
    def test_data_persists_across_instances(self, tmp_path: Path) -> None:
        """Data written by one EmbeddingCache instance must survive in a new one."""
        db_path = tmp_path / "persist.db"
        vec = _rand_vec(32)
        c1 = EmbeddingCache(path=db_path, capacity=100)
        c1.put("persistent text", vec)
        c1.close()

        c2 = EmbeddingCache(path=db_path, capacity=100)
        result = c2.get("persistent text")
        c2.close()

        assert result is not None
        np.testing.assert_array_almost_equal(result, vec, decimal=5)

    def test_topic_vectors_persist_across_instances(self, tmp_path: Path) -> None:
        db_path = tmp_path / "persist2.db"
        mat = _rand_mat(2, 16)
        labels = ["topic1", "topic2"]

        c1 = EmbeddingCache(path=db_path)
        c1.put_topic_vectors(99, mat, labels)
        c1.close()

        c2 = EmbeddingCache(path=db_path)
        result = c2.get_topic_vectors(99)
        result_labels = c2.get_topic_labels(99)
        c2.close()

        assert result is not None
        np.testing.assert_array_almost_equal(result, mat, decimal=5)
        assert result_labels == labels
