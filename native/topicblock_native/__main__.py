"""
TopicBlock native component entry point.

Reads Native Messaging framed JSON from stdin, dispatches to handlers,
writes framed JSON responses to stdout.

Frame format: little-endian uint32 length prefix followed by UTF-8 JSON.
Max message size: 1 MB (Chrome hard limit).

WP-6: Stub handlers replaced with the real Pipeline.  ML model loading is
lazy — models are resolved by the registry on first use.  When ML extras
are not installed, NullTopicModel / NullSentimentModel provide fail-open
pass-through verdicts.

Optional loopback server transport: run with ``--serve [--port N] [--token T]``
"""

from __future__ import annotations

import argparse
import json
import logging
import struct
import sys
import tempfile
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from topicblock_native import __version__, telemetry
from topicblock_native.pipeline import Pipeline
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

# ---------------------------------------------------------------------------
# Shared pipeline instance — initialised in main()
# ---------------------------------------------------------------------------

_pipeline: Pipeline | None = None

# Current preferences (updated via update_prefs messages)
_current_prefs: UserPreferences | None = None


def _get_pipeline() -> Pipeline:
    """Return the pipeline, creating it on first use (lazy init)."""
    global _pipeline
    if _pipeline is None:
        _pipeline = Pipeline()
    return _pipeline


def _default_prefs() -> UserPreferences:
    """Return sane defaults when no update_prefs message has arrived yet."""
    return UserPreferences(
        bannedTopics=[],
        topicThreshold=0.5,
        sentimentThreshold=-0.6,
        sentimentEnabled=False,
        topicModel="null",
        sentimentModel="vader",
        action="blur",
        hoverToReveal=True,
        perSiteOverrides={},
    )


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
        "payload": asdict(_get_pipeline().health()),
    }


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

    prefs = _current_prefs or _default_prefs()

    # Delegate to the real pipeline.
    response = telemetry.measure(
        "native.classify_total",
        req.requestId,
        lambda: _get_pipeline().classify(req, prefs),
    )

    # Record individual segment latencies in telemetry.
    for verdict in response.verdicts:
        telemetry.record(
            TelemetryEntry(
                ts=time.time() * 1000,
                stage="native.segment_classify",
                segmentId=verdict.segmentId,
                latencyMs=verdict.latencyMs,
            )
        )

    return {"type": "classify_result", "payload": asdict(response)}


def handle_update_prefs(payload: dict[str, Any]) -> dict[str, Any]:
    global _current_prefs
    _current_prefs = UserPreferences(
        bannedTopics=payload.get("bannedTopics", []),
        topicThreshold=payload.get("topicThreshold", 0.5),
        sentimentThreshold=payload.get("sentimentThreshold", -0.6),
        sentimentEnabled=payload.get("sentimentEnabled", False),
        topicModel=payload.get("topicModel", "null"),
        sentimentModel=payload.get("sentimentModel", "vader"),
        action=payload.get("action", "blur"),
        hoverToReveal=payload.get("hoverToReveal", True),
        perSiteOverrides=payload.get("perSiteOverrides", {}),
    )
    log.debug("Preferences updated: %d banned topics", len(_current_prefs.bannedTopics))

    # Pre-embed banned topics while the user isn't waiting for a classify.
    try:
        _get_pipeline().update_prefs(_current_prefs, payload.get("prefsVersion", 0))
    except Exception:
        log.warning("update_prefs: pipeline update failed", exc_info=True)

    return {"type": "prefs_ack", "payload": {"version": payload.get("prefsVersion", 0)}}


def handle_list_models() -> dict[str, Any]:
    models = [asdict(m) for m in _get_pipeline()._registry.list_models_info()]
    return {"type": "models_list", "payload": models}


def handle_telemetry_dump() -> dict[str, Any]:
    """Return the native-side telemetry ring buffer as a wire message."""
    return {
        "type": "telemetry_dump_result",
        "payload": {"entries": telemetry.dump()},
    }


# ---------------------------------------------------------------------------
# Main loop — Native Messaging
# ---------------------------------------------------------------------------

HANDLERS = {
    "health": lambda _payload: handle_health(),
    "classify": handle_classify,
    "update_prefs": handle_update_prefs,
    "list_models": lambda _payload: handle_list_models(),
    "telemetry_dump": lambda _payload: handle_telemetry_dump(),
}


def run_native_messaging() -> None:
    """Read–dispatch–write loop over stdin/stdout (Native Messaging)."""
    log.info("TopicBlock native component started v%s (Native Messaging mode)", __version__)

    # Eagerly create pipeline at startup so the first classify is not slow.
    pipeline = _get_pipeline()
    pipeline.warmup()

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


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="topicblock-native",
        description="TopicBlock native inference component",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        default=False,
        help="Start the loopback HTTP server instead of Native Messaging mode",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=27463,
        help="Port for the loopback server (default: 27463)",
    )
    parser.add_argument(
        "--token",
        type=str,
        default=None,
        help="Bearer token for loopback server auth (auto-generated if omitted)",
    )
    parser.add_argument(
        "--cache-path",
        type=Path,
        default=Path("~/.topicblock/cache.db").expanduser(),
        help="Path to the SQLite embedding cache",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()

    if args.serve:
        from topicblock_native.server import LoopbackServer

        log.info("TopicBlock native component starting in loopback server mode")
        pipeline = _get_pipeline()
        pipeline.warmup()

        server = LoopbackServer(
            pipeline=pipeline,
            port=args.port,
            token=args.token,
        )
        server.start()

        # Block the main thread indefinitely; the server runs in a daemon thread.
        log.info("Loopback server running — press Ctrl-C to stop")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            log.info("Interrupted — shutting down")
        finally:
            server.stop()
            pipeline.close()
    else:
        try:
            run_native_messaging()
        finally:
            if _pipeline is not None:
                _pipeline.close()


if __name__ == "__main__":
    main()
