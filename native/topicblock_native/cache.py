"""
SQLite-backed LRU embedding cache for TopicBlock native component.

Two kinds of storage are managed here:

1. **Segment embedding cache** — maps ``sha256(text)`` → ``numpy.ndarray``
   (float32, shape ``(D,)``).  Avoids re-embedding segments seen before on a
   scrolling page.  Capacity-capped (default 10 000 rows); oldest rows are
   evicted when the cap is reached.

2. **Topic vector tables** — maps ``prefsVersion`` → ``(N, D)`` float32 array
   of per-banned-topic embeddings plus the list of topic label strings.  When
   the user edits their banned topics, the pipeline embeds them once and stores
   them here keyed by ``prefsVersion``.  Subsequent classify calls just look up
   the cached matrix.

All I/O is synchronous (no async).  The main loop is single-threaded so no
locking is required beyond SQLite's built-in serialisation.

Usage
-----
    from pathlib import Path
    from topicblock_native.cache import EmbeddingCache

    cache = EmbeddingCache(Path("~/.topicblock/cache.db").expanduser())
    cache.put("hello world", embedding)
    vec = cache.get("hello world")  # returns ndarray or None
"""

from __future__ import annotations

import hashlib
import logging
import sqlite3
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

log = logging.getLogger(__name__)

_DEFAULT_CAPACITY = 10_000
_DEFAULT_PATH = Path("~/.topicblock/cache.db").expanduser()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS embeddings (
    key        TEXT PRIMARY KEY,
    embedding  BLOB NOT NULL,
    dim        INTEGER NOT NULL,
    last_used  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_vectors (
    prefs_version  INTEGER PRIMARY KEY,
    vectors        BLOB NOT NULL,
    n_topics       INTEGER NOT NULL,
    dim            INTEGER NOT NULL,
    labels_json    TEXT NOT NULL,
    stored_at      REAL NOT NULL
);
"""


def _text_key(text: str) -> str:
    """SHA-256 hex digest of the UTF-8 text, used as the cache key."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _pack(array: np.ndarray) -> bytes:
    """Serialise a float32 ndarray to raw bytes."""
    return array.astype("float32").tobytes()


def _unpack(blob: bytes, dim: int) -> np.ndarray:
    """Deserialise raw bytes back to a 1-D float32 ndarray of length ``dim``."""
    import numpy as np  # local import — optional dep

    return np.frombuffer(blob, dtype="float32").reshape(dim)


def _unpack_2d(blob: bytes, n: int, dim: int) -> np.ndarray:
    """Deserialise raw bytes back to a (n, dim) float32 ndarray."""
    import numpy as np

    return np.frombuffer(blob, dtype="float32").reshape(n, dim)


class EmbeddingCache:
    """
    SQLite-backed LRU cache for sentence embeddings and topic vectors.

    Parameters
    ----------
    path:
        Path to the SQLite database file.  Created (including parent dirs)
        if it does not exist.
    capacity:
        Maximum number of segment embeddings to store.  When exceeded, the
        ``capacity // 10`` least-recently-used rows are purged.
    """

    def __init__(
        self,
        path: Path = _DEFAULT_PATH,
        capacity: int = _DEFAULT_CAPACITY,
    ) -> None:
        self._capacity = capacity
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        log.debug("EmbeddingCache opened at %s (capacity=%d)", path, capacity)

    # ------------------------------------------------------------------
    # Segment embedding cache
    # ------------------------------------------------------------------

    def get(self, text: str) -> np.ndarray | None:
        """
        Return the cached embedding for ``text``, or ``None`` if absent.

        Updates ``last_used`` timestamp on hit (LRU tracking).
        """
        key = _text_key(text)
        row = self._conn.execute(
            "SELECT embedding, dim FROM embeddings WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            return None

        # Touch last_used for LRU tracking.
        self._conn.execute(
            "UPDATE embeddings SET last_used = ? WHERE key = ?",
            (time.time(), key),
        )
        self._conn.commit()
        return _unpack(row[0], row[1])

    def put(self, text: str, embedding: np.ndarray) -> None:
        """
        Store an embedding in the cache, evicting old entries if at capacity.
        """
        key = _text_key(text)
        dim = int(embedding.shape[-1])
        blob = _pack(embedding.reshape(-1))  # flatten to 1-D before packing
        now = time.time()

        self._conn.execute(
            """
            INSERT INTO embeddings(key, embedding, dim, last_used)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                embedding = excluded.embedding,
                last_used = excluded.last_used
            """,
            (key, blob, dim, now),
        )
        self._conn.commit()
        self._maybe_evict()

    def _maybe_evict(self) -> None:
        """Purge the oldest rows when over capacity."""
        count: int = self._conn.execute(
            "SELECT COUNT(*) FROM embeddings"
        ).fetchone()[0]
        if count <= self._capacity:
            return

        evict_n = max(1, self._capacity // 10)
        self._conn.execute(
            """
            DELETE FROM embeddings
            WHERE key IN (
                SELECT key FROM embeddings
                ORDER BY last_used ASC
                LIMIT ?
            )
            """,
            (evict_n,),
        )
        self._conn.commit()
        log.debug("EmbeddingCache evicted %d old entries (was at %d)", evict_n, count)

    # ------------------------------------------------------------------
    # Topic vector cache (per preferences version)
    # ------------------------------------------------------------------

    def get_topic_vectors(self, prefs_version: int) -> np.ndarray | None:
        """
        Return the ``(N, D)`` float32 topic-embedding matrix for
        ``prefs_version``, or ``None`` if not cached.
        """
        row = self._conn.execute(
            "SELECT vectors, n_topics, dim FROM topic_vectors WHERE prefs_version = ?",
            (prefs_version,),
        ).fetchone()
        if row is None:
            return None
        return _unpack_2d(row[0], row[1], row[2])

    def get_topic_labels(self, prefs_version: int) -> list[str] | None:
        """
        Return the list of banned-topic label strings for ``prefs_version``,
        or ``None`` if not cached.
        """
        import json

        row = self._conn.execute(
            "SELECT labels_json FROM topic_vectors WHERE prefs_version = ?",
            (prefs_version,),
        ).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def put_topic_vectors(
        self,
        prefs_version: int,
        vectors: np.ndarray,
        topics: list[str],
    ) -> None:
        """
        Store a ``(N, D)`` float32 topic-embedding matrix and its label strings
        keyed by ``prefs_version``.  Overwrites any existing entry for the same
        version.
        """
        import json

        n, dim = vectors.shape
        blob = _pack(vectors)
        labels_json = json.dumps(topics)
        self._conn.execute(
            """
            INSERT INTO topic_vectors(prefs_version, vectors, n_topics, dim, labels_json, stored_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(prefs_version) DO UPDATE SET
                vectors      = excluded.vectors,
                n_topics     = excluded.n_topics,
                dim          = excluded.dim,
                labels_json  = excluded.labels_json,
                stored_at    = excluded.stored_at
            """,
            (prefs_version, blob, n, dim, labels_json, time.time()),
        )
        self._conn.commit()
        log.debug(
            "Cached %d topic vectors for prefs_version=%d", n, prefs_version
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the underlying SQLite connection."""
        self._conn.close()

    def size(self) -> int:
        """Return the current number of cached segment embeddings."""
        return self._conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]

    def get_topic_vector_versions(self) -> list[int]:
        """Return a list of prefs_version values that have cached topic vectors."""
        rows = self._conn.execute(
            "SELECT prefs_version FROM topic_vectors ORDER BY prefs_version"
        ).fetchall()
        return [r[0] for r in rows]

    def clear(self) -> None:
        """Remove all cached segment embeddings (does not touch topic vectors)."""
        self._conn.execute("DELETE FROM embeddings")
        self._conn.commit()


__all__ = ["EmbeddingCache"]
