"""Wording only. Gemini rewrites what an agent already decided into plain sentences.

Hard rule: the model never supplies a number. Every number in its output must already be in the
facts we gave it; if not, we throw its text away and keep the template. No key, a timeout or an
error also means the template stays. The product never depends on this module working.
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
log = logging.getLogger(__name__)

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
_client = None

SYSTEM = (
    "You write short, plain updates for a logistics operations team. Use ONLY the facts given. "
    "Never add, round, convert or estimate any number, date or amount that is not written in the facts. "
    "No markdown, no bullet points, no greetings unless asked."
)

_NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")
_ID = re.compile(r"\b[A-Z]{2,}-[A-Z0-9-]+\b")  # OCN-00062, PRM-000730, EV-SGSIN-1020, DC-VNL


def _numbers(text: str) -> set[str]:
    text = _ID.sub(" ", text)
    return {n.replace(",", "").rstrip("0").rstrip(".") if "." in n else n.replace(",", "")
            for n in _NUM.findall(text)}


def safe(text: str, facts: str) -> bool:
    """True when every number in `text` appears in `facts`."""
    return _numbers(text) <= _numbers(facts)


def _get_client():
    global _client
    if _client is None:
        key = os.getenv("GEMINI_API_KEY")
        if not key:
            return None
        from google import genai
        _client = genai.Client(api_key=key)
    return _client


def available() -> bool:
    return bool(os.getenv("GEMINI_API_KEY"))


def rewrite(instruction: str, facts: str, fallback: str) -> tuple[str, str]:
    """Returns (text, source) where source is 'gemini' or 'template'."""
    client = _get_client()
    if client is None:
        return fallback, "template"
    try:
        from google.genai import types
        resp = client.models.generate_content(
            model=MODEL,
            contents=f"{instruction}\n\nFACTS:\n{facts}",
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM, temperature=0.3, max_output_tokens=400,
                thinking_config=types.ThinkingConfig(thinking_level="low"),
                http_options=types.HttpOptions(timeout=20_000)),
        )
        text = (resp.text or "").strip()
    except Exception as ex:  # network, quota, model errors: keep the template
        log.warning("gemini failed: %s", ex)
        return fallback, "template"
    if not text or not safe(text, facts):
        log.warning("gemini output rejected (new numbers or empty): %r", text[:200])
        return fallback, "template"
    return text, "gemini"
