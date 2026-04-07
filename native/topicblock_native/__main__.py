"""
TopicBlock native component entry point.

Reads Native Messaging framed JSON from stdin, dispatches to handlers,
writes framed JSON responses to stdout.

Frame format: little-endian uint32 length prefix followed by UTF-8 JSON.
Max message size: 1 MB (Chrome hard limit).

WP-1 stub: handles `health` and `classify` (keyword matching, no ML).
Real ML pipeline wired in WP-5 / WP-7 / WP-8.
"""

from __future__ import annotations

import json
import logging
import struct
import sys
import time
from dataclasses import asdict
from typing import Any

from topicblock_native import __version__, telemetry
from topicblock_native.telemetry import TelemetryEntry
from topicblock_native.wire import (
    ClassifyRequest,
    ClassifyResponse,
    HealthStatus,
    SegmentInput,
    UserPreferences,
    Verdict,
)

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,  # never touch stdout — it's the Native Messaging pipe
)
log = logging.getLogger("topicblock")

MAX_MSG_BYTES = 1 * 1024 * 1024  # 1 MB Chrome limit

# Current preferences (updated via update_prefs messages)
_current_prefs: UserPreferences | None = None


# ---------------------------------------------------------------------------
# Native Messaging I/O
# ---------------------------------------------------------------------------

def read_message() -> dict[str, Any] | None:
    """Read one length-prefixed JSON message from stdin. Returns None on EOF."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) == 0:
        return None
    if len(raw_len) < 4:
        raise EOFError("Incomplete length prefix")
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len > MAX_MSG_BYTES:
        raise ValueError(f"Message too large: {msg_len} bytes")
    raw = sys.stdin.buffer.read(msg_len)
    return json.loads(raw.decode("utf-8"))


def write_message(msg: dict[str, Any]) -> None:
    """Write one length-prefixed JSON message to stdout."""
    data = json.dumps(msg, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

def handle_health() -> dict[str, Any]:
    return {
        "type": "health_result",
        "payload": asdict(
            HealthStatus(
                ok=True,
                version=__version__,
                loadedTopicModel="stub",
                loadedSentimentModel="stub",
                device="cpu",
                queueDepth=0,
            )
        ),
    }


def _stub_classify_segment(seg: SegmentInput, prefs: UserPreferences) -> Verdict:
    """WP-1 stub: block if any banned topic substring appears in the segment text."""
    text = " ".join(filter(None, [seg.headline, seg.subtitle, seg.body])).lower()
    matched = [t for t in prefs.bannedTopics if t.lower() in text]
    blocked = len(matched) > 0
    return Verdict(
        segmentId=seg.id,
        topics=[{"label": t, "score": 1.0} for t in matched],  # type: ignore[list-item]
        sentiment=None,
        blocked=blocked,
        reasons=[f"keyword match: {t}" for t in matched],
        latencyMs=0.0,
    )


def handle_classify(payload: dict[str, Any]) -> dict[str, Any]:
    global _current_prefs
    t0 = time.perf_counter()

    req = ClassifyRequest(
        requestId=payload["requestId"],
        segments=[
            SegmentInput(
                id=s["id"],
                body=s.get("body", ""),
                site=s.get("site", ""),
                headline=s.get("headline"),
                subtitle=s.get("subtitle"),
                lang=s.get("lang"),
                extractionHint=s.get("extractionHint"),
            )
            for s in payload["segments"]
        ],
        prefsVersion=payload.get("prefsVersion", 0),
    )

    prefs = _current_prefs or UserPreferences(
        bannedTopics=[],
        topicThreshold=0.5,
        sentimentThreshold=-0.6,
        sentimentEnabled=False,
        topicModel="stub",
        sentimentModel="vader",
        action="blur",
        hoverToReveal=True,
        perSiteOverrides={},
    )

    # Instrument per-segment classification with telemetry.measure().
    # Lambda default-captures `s` to avoid the classic loop-variable capture bug.
    verdicts = [
        telemetry.measure(
            "native.segment_classify",
            s.id,
            lambda seg=s: _stub_classify_segment(seg, prefs),
        )
        for s in req.segments
    ]

    engine_latency = (time.perf_counter() - t0) * 1000

    # Record a batch-level entry for the full classify handler.
    telemetry.record(
        TelemetryEntry(
            ts=time.time() * 1000,
            stage="native.classify_total",
            segmentId=req.requestId,
            latencyMs=engine_latency,
        )
    )

    response = ClassifyResponse(
        requestId=req.requestId,
        verdicts=verdicts,
        engineLatencyMs=engine_latency,
    )
    return {"type": "classify_result", "payload": asdict(response)}


def handle_update_prefs(payload: dict[str, Any]) -> dict[str, Any]:
    global _current_prefs
    _current_prefs = UserPreferences(
        bannedTopics=payload.get("bannedTopics", []),
        topicThreshold=payload.get("topicThreshold", 0.5),
        sentimentThreshold=payload.get("sentimentThreshold", -0.6),
        sentimentEnabled=payload.get("sentimentEnabled", False),
        topicModel=payload.get("topicModel", "stub"),
        sentimentModel=payload.get("sentimentModel", "vader"),
        action=payload.get("action", "blur"),
        hoverToReveal=payload.get("hoverToReveal", True),
        perSiteOverrides=payload.get("perSiteOverrides", {}),
    )
    log.debug("Preferences updated: %d banned topics", len(_current_prefs.bannedTopics))
    return {"type": "prefs_ack", "payload": {"version": payload.get("prefsVersion", 0)}}


def handle_list_models() -> dict[str, Any]:
    return {
        "type": "models_list",
        "payload": [
            {
                "kind": "topic",
                "name": "minilm-l6-v2",
                "version": "stub",
                "backbone": "sentence-transformers/all-MiniLM-L6-v2",
                "maxSeqLen": 256,
                "defaultThreshold": 0.5,
                "hwRequirements": {"minRamMb": 512, "needsGpu": False},
            },
            {
                "kind": "sentiment",
                "name": "vader",
                "version": "stub",
                "backbone": "vaderSentiment",
                "maxSeqLen": 512,
                "defaultThreshold": -0.6,
                "hwRequirements": {"minRamMb": 50, "needsGpu": False},
            },
        ],
    }


def handle_telemetry_dump() -> dict[str, Any]:
    """Return the native-side telemetry ring buffer as a wire message."""
    return {
        "type": "telemetry_dump_result",
        "payload": {"entries": telemetry.dump()},
    }


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

HANDLERS = {
    "health": lambda _payload: handle_health(),
    "classify": handle_classify,
    "update_prefs": handle_update_prefs,
    "list_models": lambda _payload: handle_list_models(),
    "telemetry_dump": lambda _payload: handle_telemetry_dump(),
}


def main() -> None:
    log.info("TopicBlock native component started (stub v%s)", __version__)
    while True:
        try:
            msg = read_message()
            if msg is None:
                log.info("stdin closed, exiting")
                break

            msg_type: str = msg.get("type", "")
            payload: dict[str, Any] = msg.get("payload", {})
            log.debug("Received: %s", msg_type)

            handler = HANDLERS.get(msg_type)
            if handler is None:
                write_message(
                    {
                        "type": "error",
                        "payload": {
                            "code": "unknown_message_type",
                            "message": f"Unknown message type: {msg_type}",
                        },
                    }
                )
                continue

            response = handler(payload)
            write_message(response)

        except Exception as exc:
            log.exception("Unhandled error processing message")
            try:
                write_message(
                    {
                        "type": "error",
                        "payload": {"code": "internal_error", "message": str(exc)},
                    }
                )
            except Exception:
                break


if __name__ == "__main__":
    main()
