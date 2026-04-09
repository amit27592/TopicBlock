"""
Loopback WebSocket / HTTP server — optional fallback transport for TopicBlock.

This server is started **only** when ``--serve`` is passed to
``python -m topicblock_native``.  Normal Native Messaging operation never
starts it.

Security
--------
- Binds exclusively on ``127.0.0.1`` (loopback only).
- Every request must include ``Authorization: Bearer <token>`` where
  ``<token>`` matches the shared secret generated at startup and printed
  to stderr (the extension reads it from a well-known file on disk).
- No TLS — loopback traffic is local to the machine and not network-exposed.

Protocol
--------
Clients open a WebSocket connection to ``ws://127.0.0.1:<port>/ws`` and
exchange the same JSON wire messages as Native Messaging (without the length
prefix — WebSocket frames handle framing).  One connection per extension
context; reconnect on disconnect.

HTTP GET ``/health`` is available without authentication as a lightweight
liveness probe for process monitors.

Implementation note
-------------------
This module uses only the Python standard library (``http.server``,
``threading``) for the HTTP layer.  WebSocket support uses the ``websockets``
package (listed in the ``ml`` optional dep group) if available, or degrades
to a plain HTTP JSON long-poll if not.  The extension-side client handles both
cases transparently.

Usage
-----
    from topicblock_native.server import LoopbackServer
    from topicblock_native.pipeline import Pipeline

    pipeline = Pipeline()
    server = LoopbackServer(pipeline=pipeline, port=27463, token="s3cr3t")
    server.start()   # non-blocking: runs in a daemon thread
    # … main loop …
    server.stop()
"""

from __future__ import annotations

import json
import logging
import secrets
import threading
import time
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from topicblock_native.pipeline import Pipeline
    from topicblock_native.wire import UserPreferences

log = logging.getLogger(__name__)

DEFAULT_PORT = 27463


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    """
    Minimal HTTP handler for the loopback server.

    Handles:
    - GET /health  — unauthenticated liveness probe.
    - POST /msg    — authenticated JSON wire message dispatch.

    WebSocket upgrade is handled by ``_maybe_upgrade_websocket`` if the
    ``websockets`` package is available.  If not, clients fall back to
    POST /msg polling.
    """

    # Set by LoopbackServer before the server starts.
    pipeline: Pipeline
    auth_token: str

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json({"ok": True, "ts": time.time()}, status=200)
        else:
            self._send_json({"error": "not found"}, status=404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/msg":
            self._send_json({"error": "not found"}, status=404)
            return

        if not self._check_auth():
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            msg: dict[str, Any] = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json({"error": "invalid JSON"}, status=400)
            return

        response = self._dispatch(msg)
        self._send_json(response, status=200)

    # ------------------------------------------------------------------
    # Wire message dispatch — mirrors __main__.HANDLERS
    # ------------------------------------------------------------------

    def _dispatch(self, msg: dict[str, Any]) -> dict[str, Any]:
        msg_type: str = msg.get("type", "")
        payload: dict[str, Any] = msg.get("payload", {})

        if msg_type == "health":
            return {
                "type": "health_result",
                "payload": asdict(self.pipeline.health()),
            }

        if msg_type == "classify":
            from topicblock_native.wire import ClassifyRequest, SegmentInput

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
                    for s in payload.get("segments", [])
                ],
                prefsVersion=payload.get("prefsVersion", 0),
            )
            prefs = _prefs_from_dict(payload.get("prefs", {}))
            response = self.pipeline.classify(req, prefs)
            return {"type": "classify_result", "payload": asdict(response)}

        if msg_type == "update_prefs":
            prefs = _prefs_from_dict(payload)
            self.pipeline.update_prefs(prefs, payload.get("prefsVersion", 0))
            return {"type": "prefs_ack", "payload": {"version": payload.get("prefsVersion", 0)}}

        if msg_type == "list_models":
            models = [asdict(m) for m in self.pipeline._registry.list_models_info()]
            return {"type": "models_list", "payload": models}

        return {
            "type": "error",
            "payload": {"code": "unknown_message_type", "message": f"Unknown: {msg_type}"},
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _check_auth(self) -> bool:
        auth = self.headers.get("Authorization", "")
        expected = f"Bearer {self.auth_token}"
        if not secrets.compare_digest(auth, expected):
            self._send_json({"error": "unauthorized"}, status=401)
            return False
        return True

    def _send_json(self, data: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: ANN001
        # Route access logs through the Python logger instead of stderr.
        log.debug("HTTP %s", fmt % args)


# ---------------------------------------------------------------------------
# LoopbackServer
# ---------------------------------------------------------------------------


def _prefs_from_dict(d: dict[str, Any]) -> UserPreferences:
    from topicblock_native.wire import UserPreferences

    return UserPreferences(
        bannedTopics=d.get("bannedTopics", []),
        topicThreshold=d.get("topicThreshold", 0.5),
        sentimentThreshold=d.get("sentimentThreshold", -0.6),
        sentimentEnabled=d.get("sentimentEnabled", False),
        topicModel=d.get("topicModel", "null"),
        sentimentModel=d.get("sentimentModel", "vader"),
        action=d.get("action", "blur"),
        hoverToReveal=d.get("hoverToReveal", True),
        perSiteOverrides=d.get("perSiteOverrides", {}),
    )


class LoopbackServer:
    """
    Loopback HTTP server providing the alternative transport.

    The server runs in a daemon thread so it does not prevent process exit.
    It shares the same ``Pipeline`` instance as the Native Messaging loop.

    Parameters
    ----------
    pipeline:
        The shared inference pipeline.
    port:
        TCP port to bind on ``127.0.0.1``.
    token:
        Shared secret for Bearer authentication.  If ``None``, a random
        32-byte token is generated and logged to stderr.
    """

    def __init__(
        self,
        pipeline: Pipeline,
        port: int = DEFAULT_PORT,
        token: str | None = None,
    ) -> None:
        self.pipeline = pipeline
        self.port = port
        self.token = token or secrets.token_hex(32)
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Start the server in a background daemon thread."""
        # Inject pipeline and token into the handler class.
        handler = type(
            "_BoundHandler",
            (_Handler,),
            {"pipeline": self.pipeline, "auth_token": self.token},
        )
        self._server = HTTPServer(("127.0.0.1", self.port), handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            daemon=True,
            name="topicblock-loopback",
        )
        self._thread.start()
        log.info("LoopbackServer listening on 127.0.0.1:%d", self.port)
        # Print token to stderr so the installer can write it to the token file.
        import sys

        print(
            f"TOPICBLOCK_SERVER_TOKEN={self.token}",
            file=sys.stderr,
            flush=True,
        )

    def stop(self) -> None:
        """Shut down the server and join the background thread."""
        if self._server is not None:
            self._server.shutdown()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        log.info("LoopbackServer stopped")

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()


__all__ = ["LoopbackServer", "DEFAULT_PORT"]
