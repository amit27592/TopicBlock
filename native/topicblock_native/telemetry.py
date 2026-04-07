"""
Native-side telemetry ring buffer.

Captures per-segment stage timings from the native pipeline.
Entries use a 'native.' stage prefix to distinguish them from browser-side
entries in combined exports.

Exported via the `telemetry_dump` wire message so the browser can merge
both sides into a single JSON log for offline evaluation.

Usage:
    from topicblock_native import telemetry

    # Wrap a per-segment step:
    verdict = telemetry.measure('native.segment_classify', segment_id,
                                lambda: _classify_segment(seg, prefs))

    # Record manually (e.g. for batch totals):
    telemetry.record(telemetry.TelemetryEntry(
        ts=time.time() * 1000,
        stage='native.classify_total',
        segmentId=request_id,
        latencyMs=elapsed_ms,
    ))
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Any, TypeVar

T = TypeVar("T")

DEFAULT_MAX = 500

_buffer: deque[TelemetryEntry]


@dataclass
class TelemetryEntry:
    ts: float           # Unix ms at entry recording
    stage: str          # e.g. 'native.segment_classify', 'native.classify_total'
    segmentId: str      # segment ID (or request ID for batch-level entries)
    latencyMs: float
    source: str = "native"  # constant — makes browser/native boundary explicit in exports


def _init() -> None:
    global _buffer
    _buffer = deque(maxlen=DEFAULT_MAX)


_init()


def configure(max_size: int) -> None:
    """Resize the ring buffer. Existing entries are preserved up to the new limit."""
    global _buffer
    _buffer = deque(_buffer, maxlen=max_size)


def record(entry: TelemetryEntry) -> None:
    """Append an entry to the ring buffer."""
    _buffer.append(entry)


def measure(stage: str, segment_id: str, fn: Callable[[], T]) -> T:
    """
    Time `fn`, record one TelemetryEntry, and return the result.
    Uses perf_counter for sub-millisecond precision.
    """
    t0 = time.perf_counter()
    result = fn()
    elapsed_ms = (time.perf_counter() - t0) * 1000
    _buffer.append(
        TelemetryEntry(
            ts=time.time() * 1000,
            stage=stage,
            segmentId=segment_id,
            latencyMs=elapsed_ms,
        )
    )
    return result


def dump() -> list[dict[str, Any]]:
    """Return all buffered entries as plain dicts, newest last."""
    return [asdict(e) for e in _buffer]


def clear() -> None:
    """Empty the ring buffer."""
    _buffer.clear()


def size() -> int:
    return len(_buffer)
