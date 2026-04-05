"""
Smoke tests for the WP-1 native stub.
Exercises the message handlers directly (bypasses stdio framing).
"""

import json
import struct
import subprocess
import sys
from pathlib import Path

import pytest

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
