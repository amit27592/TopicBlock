"""
Smoke tests for the WP-1 native stub and WP-3 telemetry hooks.
Exercises the message handlers directly (bypasses stdio framing).
"""

import json
import struct
import subprocess
import sys
from pathlib import Path

NATIVE_PKG = Path(__file__).parent.parent

# ---------------------------------------------------------------------------
# Direct handler tests (no subprocess)
# ---------------------------------------------------------------------------

def test_health_handler():
    from topicblock_native.__main__ import handle_health
    res = handle_health()
    assert res["type"] == "health_result"
    payload = res["payload"]
    assert payload["ok"] is True
    assert payload["device"] == "cpu"


def test_classify_no_prefs_no_match():
    from topicblock_native.__main__ import handle_classify
    req = {
        "requestId": "r1",
        "segments": [{"id": "s1", "body": "hello world", "site": "hackernews"}],
        "prefsVersion": 0,
    }
    res = handle_classify(req)
    assert res["type"] == "classify_result"
    assert res["payload"]["requestId"] == "r1"
    verdict = res["payload"]["verdicts"][0]
    assert verdict["blocked"] is False


def test_classify_keyword_match():
    from topicblock_native.__main__ import handle_classify, handle_update_prefs
    handle_update_prefs({"bannedTopics": ["politics"], "topicThreshold": 0.5,
                          "sentimentThreshold": -0.6, "sentimentEnabled": False,
                          "topicModel": "stub", "sentimentModel": "vader",
                          "action": "blur", "hoverToReveal": True, "prefsVersion": 1})
    req = {
        "requestId": "r2",
        "segments": [{"id": "s2", "body": "Breaking news in politics today", "site": "reddit"}],
        "prefsVersion": 1,
    }
    res = handle_classify(req)
    verdict = res["payload"]["verdicts"][0]
    assert verdict["blocked"] is True
    assert any("politics" in r for r in verdict["reasons"])


def test_classify_no_match_after_prefs():
    from topicblock_native.__main__ import handle_classify, handle_update_prefs
    handle_update_prefs({"bannedTopics": ["sports"], "topicThreshold": 0.5,
                          "sentimentThreshold": -0.6, "sentimentEnabled": False,
                          "topicModel": "stub", "sentimentModel": "vader",
                          "action": "blur", "hoverToReveal": True, "prefsVersion": 2})
    req = {
        "requestId": "r3",
        "segments": [{"id": "s3", "body": "A recipe for chocolate cake", "site": "reddit"}],
        "prefsVersion": 2,
    }
    res = handle_classify(req)
    verdict = res["payload"]["verdicts"][0]
    assert verdict["blocked"] is False


# ---------------------------------------------------------------------------
# WP-3: Telemetry
# ---------------------------------------------------------------------------

def test_telemetry_measure_records_entry():
    from topicblock_native import telemetry
    telemetry.clear()
    result = telemetry.measure("test.stage", "seg-1", lambda: 42)
    assert result == 42
    entries = telemetry.dump()
    assert len(entries) == 1
    e = entries[0]
    assert e["stage"] == "test.stage"
    assert e["segmentId"] == "seg-1"
    assert e["latencyMs"] >= 0.0
    assert e["source"] == "native"
    assert "ts" in e


def test_telemetry_ring_buffer_caps_at_max():
    from topicblock_native import telemetry
    telemetry.clear()
    telemetry.configure(10)
    for i in range(15):
        telemetry.record(telemetry.TelemetryEntry(
            ts=0.0, stage="s", segmentId=f"seg-{i}", latencyMs=0.0
        ))
    assert telemetry.size() == 10
    # Oldest entries were dropped; most recent 10 remain
    ids = [e["segmentId"] for e in telemetry.dump()]
    assert "seg-14" in ids
    assert "seg-4" not in ids
    # Restore default
    telemetry.configure(500)
    telemetry.clear()


def test_telemetry_clear():
    from topicblock_native import telemetry
    telemetry.record(telemetry.TelemetryEntry(ts=0.0, stage="s", segmentId="x", latencyMs=0.0))
    assert telemetry.size() > 0
    telemetry.clear()
    assert telemetry.size() == 0


def test_classify_records_telemetry():
    """classify handler must record one native.segment_classify entry per segment."""
    from topicblock_native import telemetry
    from topicblock_native.__main__ import handle_classify, handle_update_prefs
    telemetry.clear()
    handle_update_prefs({
        "bannedTopics": ["politics"], "topicThreshold": 0.5,
        "sentimentThreshold": -0.6, "sentimentEnabled": False,
        "topicModel": "stub", "sentimentModel": "vader",
        "action": "blur", "hoverToReveal": True, "prefsVersion": 1,
    })
    req = {
        "requestId": "req-tel-1",
        "segments": [
            {"id": "s1", "body": "politics today", "site": "hn"},
            {"id": "s2", "body": "recipe for cake", "site": "hn"},
        ],
        "prefsVersion": 1,
    }
    handle_classify(req)
    entries = telemetry.dump()
    stages = [e["stage"] for e in entries]
    segment_ids = [e["segmentId"] for e in entries if e["stage"] == "native.segment_classify"]
    assert "native.segment_classify" in stages, "must record per-segment entries"
    assert "native.classify_total" in stages, "must record batch total entry"
    assert set(segment_ids) == {"s1", "s2"}, "one entry per segment"
    # Each entry must have monotonic timing
    for e in entries:
        assert e["latencyMs"] >= 0.0
        assert e["ts"] > 0.0


def test_telemetry_dump_handler():
    """telemetry_dump wire handler returns entries with correct shape."""
    from topicblock_native import telemetry
    from topicblock_native.__main__ import handle_telemetry_dump
    telemetry.clear()
    telemetry.record(telemetry.TelemetryEntry(
        ts=1234.0, stage="native.test", segmentId="abc", latencyMs=1.5
    ))
    res = handle_telemetry_dump()
    assert res["type"] == "telemetry_dump_result"
    entries = res["payload"]["entries"]
    assert len(entries) == 1
    e = entries[0]
    assert e["stage"] == "native.test"
    assert e["segmentId"] == "abc"
    assert e["latencyMs"] == 1.5
    assert e["source"] == "native"


def test_telemetry_dump_subprocess_roundtrip():
    """telemetry_dump round-trips correctly over Native Messaging framing."""
    proc = subprocess.Popen(
        [sys.executable, "-m", "topicblock_native"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        cwd=str(NATIVE_PKG),
    )
    try:
        # First classify to populate the buffer
        classify_msg = {
            "type": "classify",
            "payload": {
                "requestId": "r-tel",
                "segments": [{"id": "seg-x", "body": "hello", "site": "hn"}],
                "prefsVersion": 0,
            },
        }
        proc.stdin.write(_frame(classify_msg))  # type: ignore[union-attr]
        proc.stdin.flush()  # type: ignore[union-attr]
        _read_frame(proc)  # discard classify_result

        # Now dump telemetry
        proc.stdin.write(_frame({"type": "telemetry_dump"}))  # type: ignore[union-attr]
        proc.stdin.flush()  # type: ignore[union-attr]
        response = _read_frame(proc)
        assert response["type"] == "telemetry_dump_result"
        entries = response["payload"]["entries"]
        stages = {e["stage"] for e in entries}
        assert "native.segment_classify" in stages
        assert "native.classify_total" in stages
        for e in entries:
            assert e["source"] == "native"
            assert e["latencyMs"] >= 0.0
    finally:
        proc.stdin.close()  # type: ignore[union-attr]
        proc.wait(timeout=5)


# ---------------------------------------------------------------------------
# Subprocess round-trip: health ping over actual Native Messaging framing
# ---------------------------------------------------------------------------

def _frame(msg: dict) -> bytes:
    data = json.dumps(msg).encode("utf-8")
    return struct.pack("<I", len(data)) + data


def _read_frame(proc: subprocess.Popen) -> dict:
    raw_len = proc.stdout.read(4)  # type: ignore[union-attr]
    length = struct.unpack("<I", raw_len)[0]
    raw = proc.stdout.read(length)  # type: ignore[union-attr]
    return json.loads(raw.decode("utf-8"))


def test_health_subprocess_roundtrip():
    proc = subprocess.Popen(
        [sys.executable, "-m", "topicblock_native"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        cwd=str(NATIVE_PKG),
    )
    try:
        proc.stdin.write(_frame({"type": "health"}))  # type: ignore[union-attr]
        proc.stdin.flush()  # type: ignore[union-attr]
        response = _read_frame(proc)
        assert response["type"] == "health_result"
        assert response["payload"]["ok"] is True
    finally:
        proc.stdin.close()  # type: ignore[union-attr]
        proc.wait(timeout=5)
