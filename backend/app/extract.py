"""Read a discharge summary (pasted text or a photo) into a structured plan.

The AI step only extracts. The family always reviews and edits the result before it is saved,
and every warning limit that was not found in the summary is marked as a default.
Set ANTHROPIC_API_KEY to enable it. Optional: ANTHROPIC_MODEL.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from .trend import DEFAULT_FEVER_LIMIT_F, DEFAULT_PAIN_LIMIT

API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-sonnet-5-5"
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

SYSTEM_PROMPT = """You read hospital discharge summaries for a family caregiver app.
Return ONLY a JSON object, no prose and no code fences, with this shape:
{
  "patient_name": string or null,
  "procedure": string or null,
  "doctor_phone": string or null,
  "medicines": [{"name": string, "dose": string, "times": ["HH:MM", ...], "notes": string}],
  "red_flag_text": [string, ...],
  "fever_limit_f": number or null,
  "pain_limit": integer 1-10 or null,
  "restrictions": [string, ...],
  "appointments": [{"date": string, "note": string}]
}
Rules:
- Copy only what the document says. Never invent medicines, doses, limits or phone numbers.
- Use null (or empty lists) when something is not written in the document.
- Convert 'twice daily' style frequencies to sensible clock times: once 08:00; twice 08:00 and 20:00;
  three times 08:00, 14:00 and 20:00; four times 06:00, 12:00, 18:00 and 22:00.
- red_flag_text holds the warning signs the doctor lists, in plain short sentences.
- If a fever limit is given in Celsius, convert it to Fahrenheit."""

_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


class ExtractionUnavailable(Exception):
    """No API key configured."""


class ExtractionFailed(Exception):
    """The AI call or its answer could not be used."""


def _clean_str(value: Any, limit: int = 300) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _clean_list(value: Any, limit: int = 20) -> List[str]:
    if not isinstance(value, list):
        return []
    return [s for s in (_clean_str(v) for v in value[:limit]) if s]


def normalize_plan(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Turn whatever the AI returned into the plan shape the app stores. Never raises on bad data."""
    if not isinstance(raw, dict):
        raw = {}

    medicines = []
    for m in (raw.get("medicines") or [])[:30] if isinstance(raw.get("medicines"), list) else []:
        if not isinstance(m, dict) or not _clean_str(m.get("name"), 80):
            continue
        times = []
        for t in (m.get("times") or [])[:6] if isinstance(m.get("times"), list) else []:
            if isinstance(t, str) and _TIME_RE.match(t.strip()):
                h, mm = t.strip().split(":")
                times.append(f"{int(h):02d}:{mm}")
        medicines.append({
            "name": _clean_str(m.get("name"), 80),
            "dose": _clean_str(m.get("dose"), 80),
            "times": sorted(set(times)) or ["08:00"],
            "notes": _clean_str(m.get("notes"), 200),
            "times_guessed": not times,
        })

    fever = raw.get("fever_limit_f")
    fever_ok = isinstance(fever, (int, float)) and not isinstance(fever, bool) and 95 <= fever <= 106
    pain = raw.get("pain_limit")
    pain_ok = isinstance(pain, int) and not isinstance(pain, bool) and 1 <= pain <= 10

    appointments = []
    for a in (raw.get("appointments") or [])[:10] if isinstance(raw.get("appointments"), list) else []:
        if isinstance(a, dict) and (_clean_str(a.get("date"), 60) or _clean_str(a.get("note"), 120)):
            appointments.append({"date": _clean_str(a.get("date"), 60), "note": _clean_str(a.get("note"), 120)})

    return {
        "patient_name": _clean_str(raw.get("patient_name"), 80),
        "procedure": _clean_str(raw.get("procedure"), 120),
        "doctor_phone": re.sub(r"[^\d+ ]", "", _clean_str(raw.get("doctor_phone"), 30)),
        "medicines": medicines,
        "red_flag_text": _clean_list(raw.get("red_flag_text")),
        "restrictions": _clean_list(raw.get("restrictions")),
        "appointments": appointments,
        "red_flags": {
            "fever_limit_f": float(fever) if fever_ok else DEFAULT_FEVER_LIMIT_F,
            "pain_limit": pain if pain_ok else DEFAULT_PAIN_LIMIT,
            # The family must confirm any limit that was not found in the summary.
            "fever_from_summary": bool(fever_ok),
            "pain_from_summary": bool(pain_ok),
        },
    }


def parse_json_answer(text: str) -> Dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ExtractionFailed("The AI answer did not contain a JSON object")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as exc:
        raise ExtractionFailed(f"The AI answer was not valid JSON: {exc}") from exc


def call_claude(content: List[Dict[str, Any]]) -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise ExtractionUnavailable("ANTHROPIC_API_KEY is not set")
    body = json.dumps({
        "model": os.environ.get("ANTHROPIC_MODEL", DEFAULT_MODEL),
        "max_tokens": 2000,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": content}],
    }).encode()
    req = urllib.request.Request(
        API_URL, data=body, method="POST",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise ExtractionFailed(f"AI service returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise ExtractionFailed("Could not reach the AI service") from exc
    return "".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text")


def extract_plan(text: Optional[str] = None, image_base64: Optional[str] = None,
                 media_type: Optional[str] = None) -> Dict[str, Any]:
    content: List[Dict[str, Any]] = []
    if image_base64:
        if media_type not in ALLOWED_IMAGE_TYPES:
            raise ExtractionFailed("Unsupported image type")
        content.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_base64}})
    if text and text.strip():
        content.append({"type": "text", "text": "Discharge summary text:\n\n" + text.strip()[:20000]})
    if not content:
        raise ExtractionFailed("Send a photo or the text of the summary")
    content.append({"type": "text", "text": "Extract the plan as JSON."})
    return normalize_plan(parse_json_answer(call_claude(content)))
