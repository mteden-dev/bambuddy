"""The OctoPrint-compatible upload's parsing and its Device-tab middleware (fork).

See ``backend/app/api/routes/octoprint_compat.py`` and ORCA_SLICER_UPLOAD.md.
"""

from __future__ import annotations

import pytest

from backend.app.api.routes.octoprint_compat import (
    PreferSessionOverInjectedApiKey,
    parse_plate_index,
    parse_print_flag,
)


class TestPlateIndex:
    @pytest.mark.parametrize(("raw", "expected"), [("1", 1), ("2", 2), (" 12 ", 12), ("999", 999)])
    def test_a_plate_number(self, raw, expected):
        assert parse_plate_index(raw) == expected

    @pytest.mark.parametrize("raw", [None, "", "0", "-1", "1.5", "abc", "1000", "２"])
    def test_anything_else_is_no_plate(self, raw):
        assert parse_plate_index(raw) is None


class TestPrintFlag:
    @pytest.mark.parametrize("raw", ["true", "True", "1", "yes", "on"])
    def test_true(self, raw):
        assert parse_print_flag(raw) is True

    @pytest.mark.parametrize("raw", [None, "", "false", "0", "no", "print"])
    def test_false(self, raw):
        assert parse_print_flag(raw) is False


async def _headers_seen(path: str, headers: list[tuple[bytes, bytes]], scope_type: str = "http"):
    seen: dict = {}

    async def app(scope, receive, send):
        seen["headers"] = scope.get("headers")

    middleware = PreferSessionOverInjectedApiKey(app)
    await middleware({"type": scope_type, "path": path, "headers": headers}, None, None)
    return seen["headers"]


class TestPreferSessionOverInjectedApiKey:
    @pytest.mark.asyncio
    async def test_drops_the_key_when_a_session_comes_with_it(self):
        headers = [(b"authorization", b"Bearer eyJhbGciOi.jwt"), (b"x-api-key", b"bb_key"), (b"accept", b"*/*")]
        assert await _headers_seen("/api/v1/printers/", headers) == [
            (b"authorization", b"Bearer eyJhbGciOi.jwt"),
            (b"accept", b"*/*"),
        ]

    @pytest.mark.asyncio
    async def test_keeps_a_key_on_its_own(self):
        headers = [(b"x-api-key", b"bb_key")]
        assert await _headers_seen("/api/v1/printers/", headers) == headers

    @pytest.mark.asyncio
    async def test_keeps_both_when_the_bearer_is_itself_a_key(self):
        headers = [(b"authorization", b"Bearer bb_other"), (b"x-api-key", b"bb_key")]
        assert await _headers_seen("/api/v1/printers/", headers) == headers

    @pytest.mark.asyncio
    async def test_keeps_the_key_without_a_bearer_token(self):
        headers = [(b"authorization", b"Basic dXNlcjpwYXNz"), (b"x-api-key", b"bb_key")]
        assert await _headers_seen("/api/v1/printers/", headers) == headers
        empty = [(b"authorization", b"Bearer "), (b"x-api-key", b"bb_key")]
        assert await _headers_seen("/api/v1/printers/", empty) == empty

    @pytest.mark.asyncio
    @pytest.mark.parametrize("path", ["/api/version", "/api/files/local"])
    async def test_leaves_the_octoprint_routes_alone(self, path):
        headers = [(b"authorization", b"Bearer eyJ.jwt"), (b"x-api-key", b"bb_key")]
        assert await _headers_seen(path, headers) == headers

    @pytest.mark.asyncio
    async def test_leaves_websockets_alone(self):
        headers = [(b"authorization", b"Bearer eyJ.jwt"), (b"x-api-key", b"bb_key")]
        assert await _headers_seen("/api/v1/ws", headers, scope_type="websocket") == headers
