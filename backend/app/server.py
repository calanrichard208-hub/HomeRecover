"""HomeRecover server: JSON API + the web app, using only the Python standard library.

Run from the backend folder:  python -m app.server --port 8000
Use --host 0.0.0.0 to open it from a phone on the same Wi-Fi.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from . import db
from .extract import ExtractionFailed, ExtractionUnavailable, extract_plan
from .trend import DEFAULT_FEVER_LIMIT_F, DEFAULT_PAIN_LIMIT, RedFlagLimits, assess, daily_checkins

FRONTEND_DIR = os.path.abspath(
    os.environ.get("HOMERECOVER_FRONTEND", os.path.join(os.path.dirname(__file__), "..", "..", "frontend"))
)
MAX_BODY = 1_000_000
MAX_BODY_EXTRACT = 8_000_000
MAX_EVENTS_PER_REQUEST = 200

CODE_RE = r"([A-Z0-9]{8})"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------- validation ----------

def _str(value: Any, field: str, limit: int, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > limit:
        raise ApiError(400, f"'{field}' must be text of at most {limit} characters")
    return value.strip()


def validate_event(ev: Any) -> Dict[str, Any]:
    if not isinstance(ev, dict):
        raise ApiError(400, "Each event must be an object")
    ev_id = ev.get("id")
    if not isinstance(ev_id, str) or not ID_RE.match(ev_id):
        raise ApiError(400, "Event 'id' must be 1-64 letters, digits, '-' or '_'")
    kind = ev.get("kind")
    if kind not in ("checkin", "dose"):
        raise ApiError(400, "Event 'kind' must be 'checkin' or 'dose'")
    created_at = _str(ev.get("created_at"), "created_at", 40)
    data = ev.get("data")
    if not isinstance(data, dict):
        raise ApiError(400, "Event 'data' must be an object")

    if kind == "checkin":
        d = _str(data.get("date"), "date", 10)
        try:
            if not DATE_RE.match(d):
                raise ValueError
            date.fromisoformat(d)
        except ValueError:
            raise ApiError(400, "Check-in 'date' must be YYYY-MM-DD")
        pain = data.get("pain")
        if isinstance(pain, bool) or not isinstance(pain, int) or not 0 <= pain <= 10:
            raise ApiError(400, "Check-in 'pain' must be a whole number from 0 to 10")
        fever = data.get("fever_f")
        if fever is not None and (isinstance(fever, bool) or not isinstance(fever, (int, float)) or not 90 <= fever <= 110):
            raise ApiError(400, "Check-in 'fever_f' must be a temperature in Fahrenheit between 90 and 110")
        clean = {
            "date": d, "pain": pain, "fever_f": float(fever) if fever is not None else None,
            "wound_discharge": bool(data.get("wound_discharge", False)),
            "by": _str(data.get("by"), "by", 40, required=False),
        }
    else:
        clean = {
            "slot": _str(data.get("slot"), "slot", 160),
            "medicine": _str(data.get("medicine"), "medicine", 80),
            "by": _str(data.get("by"), "by", 40, required=False),
            "taken_at": _str(data.get("taken_at"), "taken_at", 40),
        }
    return {"id": ev_id, "kind": kind, "data": clean, "created_at": created_at}


# ---------- route handlers ----------

def route_create_family(body: Dict[str, Any], **_) -> Tuple[int, Any]:
    name = _str(body.get("name"), "name", 80)
    return 201, {"code": db.create_family(name)}


def route_get_family(code: str, **_) -> Tuple[int, Any]:
    fam = db.get_family(code)
    if fam is None:
        raise ApiError(404, "No family with that code")
    return 200, fam


def route_put_plan(code: str, body: Dict[str, Any], **_) -> Tuple[int, Any]:
    plan = body.get("plan")
    if not isinstance(plan, dict):
        raise ApiError(400, "'plan' must be an object")
    updated_at = _str(body.get("updated_at"), "updated_at", 40)
    if db.get_family(code) is None:
        raise ApiError(404, "No family with that code")
    return 200, {"replaced": db.save_plan(code, plan, updated_at)}


def route_post_events(code: str, body: Dict[str, Any], **_) -> Tuple[int, Any]:
    events = body.get("events")
    if not isinstance(events, list) or len(events) > MAX_EVENTS_PER_REQUEST:
        raise ApiError(400, f"'events' must be a list of at most {MAX_EVENTS_PER_REQUEST}")
    if db.get_family(code) is None:
        raise ApiError(404, "No family with that code")
    clean = [validate_event(e) for e in events]
    return 200, {"accepted": db.add_events(code, clean)}


def route_get_events(code: str, query: Dict[str, Any], **_) -> Tuple[int, Any]:
    if db.get_family(code) is None:
        raise ApiError(404, "No family with that code")
    try:
        since = int(query.get("since", ["0"])[0])
    except ValueError:
        raise ApiError(400, "'since' must be a number")
    events, latest = db.list_events(code, max(since, 0))
    return 200, {"events": events, "latest_seq": latest}


def route_status(code: str, **_) -> Tuple[int, Any]:
    fam = db.get_family(code)
    if fam is None:
        raise ApiError(404, "No family with that code")
    plan = fam["plan"] or {}
    flags = plan.get("red_flags") or {}
    try:
        limits = RedFlagLimits(
            fever_limit_f=float(flags.get("fever_limit_f", DEFAULT_FEVER_LIMIT_F)),
            pain_limit=int(flags.get("pain_limit", DEFAULT_PAIN_LIMIT)),
        )
    except (TypeError, ValueError):
        limits = RedFlagLimits()
    events, _ = db.list_events(code)
    checkins = daily_checkins([e for e in events if e["kind"] == "checkin"], plan.get("discharge_date", ""))
    result = assess(checkins, limits)
    return 200, {"status": result.status, "findings": result.findings, "reasons": result.reasons,
                 "days_logged": len(checkins)}


def route_extract(body: Dict[str, Any], **_) -> Tuple[int, Any]:
    try:
        plan = extract_plan(body.get("text"), body.get("image_base64"), body.get("media_type"))
    except ExtractionUnavailable:
        raise ApiError(503, "AI reading is not switched on for this server. Enter the plan by hand or paste it.")
    except ExtractionFailed as exc:
        raise ApiError(502, str(exc))
    return 200, {"plan": plan}


ROUTES = [
    ("POST", re.compile(r"^/api/families$"), route_create_family, MAX_BODY),
    ("GET", re.compile(rf"^/api/families/{CODE_RE}$"), route_get_family, MAX_BODY),
    ("PUT", re.compile(rf"^/api/families/{CODE_RE}/plan$"), route_put_plan, MAX_BODY),
    ("POST", re.compile(rf"^/api/families/{CODE_RE}/events$"), route_post_events, MAX_BODY),
    ("GET", re.compile(rf"^/api/families/{CODE_RE}/events$"), route_get_events, MAX_BODY),
    ("GET", re.compile(rf"^/api/families/{CODE_RE}/status$"), route_status, MAX_BODY),
    ("POST", re.compile(r"^/api/extract$"), route_extract, MAX_BODY_EXTRACT),
    ("GET", re.compile(r"^/api/health$"), lambda **_: (200, {"ok": True}), MAX_BODY),
]


# ---------- HTTP plumbing ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "HomeRecover/1.0"

    def log_message(self, fmt, *args):  # keep the console quiet
        if os.environ.get("HOMERECOVER_LOG"):
            super().log_message(fmt, *args)

    def _send_json(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self, limit: int) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "Bad Content-Length")
        if length > limit:
            raise ApiError(413, "Request is too large")
        if length == 0:
            return {}
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "Body must be valid JSON")
        if not isinstance(body, dict):
            raise ApiError(400, "Body must be a JSON object")
        return body

    def _api(self, method: str, path: str, query: Dict[str, Any]) -> None:
        path_matched = False
        for m, pattern, fn, limit in ROUTES:
            match = pattern.match(path)
            if not match:
                continue
            path_matched = True
            if m != method:
                continue
            try:
                body = self._read_body(limit) if method in ("POST", "PUT") else {}
                status, payload = _call(fn, match, body, query)
                self._send_json(status, payload)
            except ApiError as exc:
                self._send_json(exc.status, {"error": exc.message})
            except Exception:  # never leak internals
                self._send_json(500, {"error": "Something went wrong on the server"})
            return
        self._send_json(405 if path_matched else 404, {"error": "Not found"})

    def _static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        full = os.path.abspath(os.path.join(FRONTEND_DIR, rel))
        if os.path.commonpath([full, FRONTEND_DIR]) != FRONTEND_DIR or not os.path.isfile(full):
            full = os.path.join(FRONTEND_DIR, "index.html")  # single-page app fallback
            if not os.path.isfile(full):
                self._send_json(404, {"error": "Frontend not found"})
                return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js") or full.endswith(".mjs"):
            ctype = "text/javascript"
        with open(full, "rb") as f:
            raw = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith("json") else ""))
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(raw)

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._api(method, parsed.path, parse_qs(parsed.query))
        elif method == "GET":
            self._static(parsed.path)
        else:
            self._send_json(405, {"error": "Method not allowed"})

    def do_GET(self): self._dispatch("GET")
    def do_POST(self): self._dispatch("POST")
    def do_PUT(self): self._dispatch("PUT")
    def do_DELETE(self): self._dispatch("DELETE")
    def do_PATCH(self): self._dispatch("PATCH")


def _call(fn, match, body, query):
    return fn(*match.groups(), body=body, query=query)


def make_server(host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="HomeRecover server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    args = parser.parse_args()
    server = make_server(args.host, args.port)
    print(f"HomeRecover running at http://{args.host}:{args.port}  (Ctrl+C to stop)")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Note: ANTHROPIC_API_KEY is not set, so reading a summary photo with AI is off. Manual entry still works.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
