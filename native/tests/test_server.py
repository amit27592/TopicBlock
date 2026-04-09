"""
Tests for topicblock_native.server.LoopbackServer

These are lightweight unit tests that avoid real socket operations.
They verify:
- LoopbackServer can be instantiated without error.
- The HTTP handler rejects requests with missing / wrong tokens.
- The HTTP handler dispatches health messages correctly.
- The HTTP handler returns 404 for unknown paths.

Socket-level integration tests (binding a real port) are kept minimal and
are skipped if 127.0.0.1 is unreachable.
"""

from __future__ import annotations

import json
import time
import urllib.request
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock
from urllib.error import HTTPError

import pytest

from topicblock_native.models.registry import ModelRegistry
from topicblock_native.pipeline import Pipeline
from topicblock_native.server import DEFAULT_PORT, LoopbackServer

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def pipeline(tmp_path: Path) -> Pipeline:
    """Minimal pipeline with no ML deps."""
    return Pipeline(cache_path=tmp_path / "cache.db", registry=ModelRegistry())


@pytest.fixture()
def server(pipeline: Pipeline) -> LoopbackServer:
    """LoopbackServer that has NOT been started."""
    return LoopbackServer(pipeline=pipeline, port=0, token="test-secret")


# ---------------------------------------------------------------------------
# Instantiation
# ---------------------------------------------------------------------------


class TestInstantiation:
    def test_server_can_be_instantiated(self, server: LoopbackServer) -> None:
        assert server is not None

    def test_default_port_constant(self) -> None:
        assert DEFAULT_PORT == 27463

    def test_auto_token_generated_if_none(self, pipeline: Pipeline) -> None:
        s = LoopbackServer(pipeline=pipeline, port=0, token=None)
        assert len(s.token) == 64  # secrets.token_hex(32) → 64 hex chars

    def test_explicit_token_preserved(self, pipeline: Pipeline) -> None:
        s = LoopbackServer(pipeline=pipeline, port=0, token="my-token")
        assert s.token == "my-token"

    def test_not_running_before_start(self, server: LoopbackServer) -> None:
        assert not server.is_running


# ---------------------------------------------------------------------------
# Handler unit tests (no real socket)
# ---------------------------------------------------------------------------


def _make_handler(pipeline: Pipeline, token: str):
    """
    Create an instance of the internal _Handler class bound to a pipeline/token
    without going through a real HTTP connection.
    """
    from topicblock_native.server import _Handler

    BoundHandler = type(
        "_BoundHandler",
        (_Handler,),
        {"pipeline": pipeline, "auth_token": token},
    )
    return BoundHandler


class _FakeRequest:
    """Minimal file-like object mimicking a socket for BaseHTTPRequestHandler."""

    def __init__(self, raw: bytes) -> None:
        self._data = raw
        self.output = BytesIO()

    def makefile(self, mode: str, *args, **kwargs):
        if "r" in mode:
            return BytesIO(self._data)
        return self.output

    def sendall(self, data: bytes) -> None:
        self.output.write(data)


class TestHandlerAuth:
    def _make_raw_post(self, body: bytes, token: str = "test-secret") -> bytes:
        """Build a minimal HTTP/1.1 POST request bytestring."""
        headers = (
            f"POST /msg HTTP/1.1\r\n"
            f"Host: 127.0.0.1\r\n"
            f"Authorization: Bearer {token}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"\r\n"
        ).encode("ascii")
        return headers + body

    def test_correct_token_accepted(self, pipeline: Pipeline) -> None:
        HandlerCls = _make_handler(pipeline, "my-token")
        payload = json.dumps({"type": "health"}).encode()
        raw = self._make_raw_post(payload, token="my-token")
        req = _FakeRequest(raw)
        HandlerCls(request=req, client_address=("127.0.0.1", 9999), server=MagicMock())
        resp = req.output.getvalue()
        # Should not contain "unauthorized".
        assert b"unauthorized" not in resp

    def test_wrong_token_rejected(self, pipeline: Pipeline) -> None:
        HandlerCls = _make_handler(pipeline, "correct-token")
        payload = json.dumps({"type": "health"}).encode()
        raw = self._make_raw_post(payload, token="wrong-token")
        req = _FakeRequest(raw)
        HandlerCls(request=req, client_address=("127.0.0.1", 9999), server=MagicMock())
        resp = req.output.getvalue()
        assert b"401" in resp or b"unauthorized" in resp

    def test_missing_token_rejected(self, pipeline: Pipeline) -> None:
        HandlerCls = _make_handler(pipeline, "secret")
        payload = json.dumps({"type": "health"}).encode()
        # Build POST without Authorization header.
        headers = (
            "POST /msg HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\n"
            "\r\n"
        ).encode("ascii")
        raw = headers + payload
        req = _FakeRequest(raw)
        HandlerCls(request=req, client_address=("127.0.0.1", 9999), server=MagicMock())
        resp = req.output.getvalue()
        assert b"401" in resp or b"unauthorized" in resp


class TestHandlerDispatch:
    def _make_get(self, path: str) -> bytes:
        return (
            f"GET {path} HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            "\r\n"
        ).encode("ascii")

    def test_health_get_returns_200(self, pipeline: Pipeline) -> None:
        HandlerCls = _make_handler(pipeline, "tok")
        raw = self._make_get("/health")
        req = _FakeRequest(raw)
        HandlerCls(request=req, client_address=("127.0.0.1", 9999), server=MagicMock())
        resp = req.output.getvalue()
        assert b"200" in resp
        assert b"ok" in resp

    def test_unknown_get_returns_404(self, pipeline: Pipeline) -> None:
        HandlerCls = _make_handler(pipeline, "tok")
        raw = self._make_get("/unknown")
        req = _FakeRequest(raw)
        HandlerCls(request=req, client_address=("127.0.0.1", 9999), server=MagicMock())
        resp = req.output.getvalue()
        assert b"404" in resp


# ---------------------------------------------------------------------------
# Integration: start / stop (uses a real OS port)
# ---------------------------------------------------------------------------


class TestServerLifecycle:
    def test_start_and_stop(self, pipeline: Pipeline) -> None:
        """Server must start (binding a random free port) and stop cleanly."""
        import socket

        # Find a free port.
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            free_port = s.getsockname()[1]

        server = LoopbackServer(pipeline=pipeline, port=free_port, token="tok")
        server.start()
        assert server.is_running

        server.stop()
        assert not server.is_running

    def test_health_endpoint_reachable(self, pipeline: Pipeline) -> None:
        """GET /health on a live server must return JSON with ok=True."""
        import socket

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            free_port = s.getsockname()[1]

        server = LoopbackServer(pipeline=pipeline, port=free_port, token="tok")
        server.start()
        try:
            time.sleep(0.05)  # give the daemon thread a moment
            url = f"http://127.0.0.1:{free_port}/health"
            with urllib.request.urlopen(url, timeout=2) as resp:
                data = json.loads(resp.read())
            assert data["ok"] is True
        finally:
            server.stop()

    def test_post_without_token_returns_401(self, pipeline: Pipeline) -> None:
        import socket

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            free_port = s.getsockname()[1]

        server = LoopbackServer(pipeline=pipeline, port=free_port, token="tok")
        server.start()
        try:
            time.sleep(0.05)
            body = json.dumps({"type": "health"}).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:{free_port}/msg",
                data=body,
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with pytest.raises(HTTPError) as exc_info:
                urllib.request.urlopen(req, timeout=2)
            assert exc_info.value.code == 401
        finally:
            server.stop()
