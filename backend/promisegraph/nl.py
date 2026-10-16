"""From a typed question to (template id, validated slots). Never to a query.

1. A keyword matcher handles the common phrasings instantly and offline.
2. If it cannot, Gemini is asked to PICK a template from the whitelist and fill its slots as JSON.
3. Either way every slot is validated against real values in the tenant graph (events, customer
   cities, place names, customer names, dates). Anything that does not validate is rejected.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date

from . import llm
from .config import TODAY, to_date, to_day
from .questions import TEMPLATES

log = logging.getLogger(__name__)
DEFAULT_DEPTH = 8


class NotUnderstood(Exception):
    pass


MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
_M = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
DATE_RE = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+{_M}|\b{_M}\s+(\d{{1,2}})(?:st|nd|rd|th)?\b", re.I)
KIND_PRIORITY = {"port": 0, "dc_national": 1, "dc_regional": 2, "airport": 3, "zone": 4, "factory": 5, "supplier": 6}


def _date(month: int, day: int) -> date:
    year = TODAY.year + (1 if month < TODAY.month - 6 else 0)
    return date(year, month, day)


def parse_dates(q: str) -> list[date]:
    out = []
    for m in DATE_RE.finditer(q):
        if m.group(1):
            out.append(_date(MONTHS[m.group(2)[:3].lower()], int(m.group(1))))
        else:
            out.append(_date(MONTHS[m.group(3)[:3].lower()], int(m.group(4))))
    return out


def _aliases(name: str) -> set[str]:
    n = name.lower()
    out = {n}
    for prefix in ("port of ", "northwind dc ", "port "):
        if n.startswith(prefix):
            out.add(n[len(prefix):])
    base = re.sub(r"\s*\(.*?\)", "", n).strip()
    out.add(base)
    for inner in re.findall(r"\((.*?)\)", n):
        out.add(inner.strip())
    for suffix in (" international airport", " airport", " international"):
        for a in list(out):
            if a.endswith(suffix):
                out.add(a[: -len(suffix)].strip())
    for a in list(out):
        if a.startswith("port of "):
            out.add(a[8:])
    return {a for a in out if len(a) >= 3}


class Vocabulary:
    """Real values from the tenant graph that slots are validated against."""

    def __init__(self, g, ctx):
        self.g = g
        self.ctx = ctx
        self.events = ctx["events"]
        self.cities = sorted({r[0] for r in g.query("MATCH (c:Customer) RETURN DISTINCT c.city").result_set},
                             key=len, reverse=True)
        hubs = g.query("MATCH (h:Hub) RETURN h.id, h.name, h.kind").result_set
        self.places: dict[str, tuple[int, str]] = {}
        for hid, name, kind in hubs:
            pri = KIND_PRIORITY.get(kind, 9)
            for a in _aliases(name) | {hid.lower()}:
                if a not in self.places or pri < self.places[a][0]:
                    self.places[a] = (pri, hid)
        self.place_names = sorted(self.places, key=len, reverse=True)

    def city(self, text: str | None) -> str | None:
        if not text:
            return None
        t = text.lower()
        for c in self.cities:
            if re.search(rf"\b{re.escape(c.lower())}\b", t):
                return c
        return None

    def place(self, text: str | None) -> str | None:
        if not text:
            return None
        t = text.lower().strip(" ?.!,")
        if t in self.places:
            return self.places[t][1]
        for a in self.place_names:
            if re.search(rf"\b{re.escape(a)}\b", t):
                return self.places[a][1]
        return None

    def event(self, text: str) -> str | None:
        t = text.lower()
        for eid, ev in self.events.items():
            for hub in ev["hubs"]:
                names = _aliases(self.ctx["hubs"][hub])
                if any(re.search(rf"\b{re.escape(n)}\b", t) for n in names):
                    return eid
        if re.search(r"\b(strike|labou?r|west coast|la|l\.a\.)\b", t):
            return next((e for e in self.events if "USWC" in e), None)
        if re.search(r"\b(cyber|hack)\b", t):
            return next((e for e in self.events if "SGSIN" in e), None)
        return None

    def default_event(self) -> str:
        return sorted(self.events)[-1] if not any("SGSIN" in e for e in self.events) else \
            next(e for e in self.events if "SGSIN" in e)

    def customer(self, text: str | None) -> str | None:
        if not text:
            return None
        cand = text.strip(" ?.!,'’").replace("’", "'")
        cand = re.sub(r"'s$", "", cand)
        res = self.g.query("MATCH (c:Customer) WHERE toLower(c.name) = toLower($n) RETURN c.name LIMIT 1",
                           {"n": cand}).result_set
        return res[0][0] if res else None


def _has(q: str, *words: str) -> bool:
    return any(re.search(rf"\b{w}", q) for w in words)


def keywords(question: str, v: Vocabulary) -> tuple[str, dict] | None:
    q = question.lower().replace("’", "'")
    event = v.event(q)

    # reroute: "from X to Y without Z"
    m = re.search(r"\bfrom (.+?) to (.+?)(?:\s+(?:without|avoiding|not via|not through|skipping|bypassing)\s+(.+?))?\s*[?.!]*$", q)
    if m and _has(q, "route", "get ", "move", "ship", "send", "way"):
        src, dst = v.place(m.group(1)), v.place(m.group(2))
        avoid = v.place(m.group(3)) if m.group(3) else None
        if src and dst:
            ev = v.events.get(event or v.default_event())
            return "reroute", {"from_hub": src, "to_hub": dst, "avoid_hub": avoid or ev["hubs"][0]}

    # why_late: "why is <name>'s order late"
    m = re.search(r"(?:why is|why's|why was|what happened to|where is)\s+(.+?)(?:'s)?\s+(?:order|delivery|parcel|package)", q)
    if m:
        cust = v.customer(m.group(1))
        if cust:
            return "why_late", {"customer": cust, "event": event or v.default_event(), "depth": DEFAULT_DEPTH}

    if _has(q, "rescue", "fix first", "save first", "prioriti", "start with", "which shipments should"):
        return "rescue_first", {"event": event or v.default_event(), "depth": DEFAULT_DEPTH}

    if _has(q, "depend", "weak point", "weakest", "single point", "bottleneck", "chokepoint",
            "most important (port|place|hub)", "critical (port|place|hub)", "busiest"):
        return "weak_points", {}

    city = v.city(q)
    dates = parse_dates(question)
    if city and dates and _has(q, "order", "deliver", "due", "show", "list"):
        a, b = dates[0], dates[-1]
        a, b = min(a, b), max(a, b)
        return "orders_window", {"city": city, "from_day": to_day(a), "to_day": to_day(b)}

    if event or _has(q, "risk", "late", "broke", "break", "affected", "hit", "delay", "impact", "miss"):
        return "at_risk", {"event": event or v.default_event(), "city": city, "depth": DEFAULT_DEPTH}
    return None


SCHEMA_PROMPT = """You map a logistics question to ONE template from a fixed list and fill its slots.
Return JSON only. Use null for slots you cannot fill. Never invent values: use the allowed values.

Templates:
- at_risk: which orders will be late because of a disruption (slots: event, optional city)
- orders_window: orders from customers in one city, promised between two dates (slots: city, from_date, to_date)
- why_late: why one named customer's order is late (slots: customer, event)
- rescue_first: which stuck shipments to rescue first (slots: event)
- weak_points: which places/ports everything depends on (no slots)
- reroute: alternative routes from one place to another avoiding a place (slots: from_place, to_place, avoid_place)
- none: the question does not fit any template

Allowed events (id: name): {events}
Allowed cities: {cities}
Today is {today}. Dates as YYYY-MM-DD.
"""


def gemini(question: str, v: Vocabulary) -> tuple[str, dict] | None:
    if not llm.available():
        return None
    from google.genai import types
    events = "; ".join(f"{e}: {ev['name']}" for e, ev in v.events.items())
    prompt = SCHEMA_PROMPT.format(events=events, cities=", ".join(sorted(v.cities)), today=TODAY.isoformat())
    schema = {"type": "object", "properties": {
        "template": {"type": "string", "enum": list(TEMPLATES) + ["none"]},
        **{k: {"type": "string", "nullable": True} for k in
           ("event", "city", "customer", "from_date", "to_date", "from_place", "to_place", "avoid_place")}},
        "required": ["template"]}
    try:
        client = llm._get_client()
        resp = client.models.generate_content(
            model=llm.MODEL, contents=f"{prompt}\nQuestion: {question}",
            config=types.GenerateContentConfig(
                temperature=0, response_mime_type="application/json", response_schema=schema,
                thinking_config=types.ThinkingConfig(thinking_level="low"),
                http_options=types.HttpOptions(timeout=15_000)))
        out = json.loads(resp.text)
    except Exception as ex:
        log.warning("gemini interpret failed: %s", ex)
        return None
    t = out.get("template")
    if t not in TEMPLATES:
        return None
    ev = out.get("event") if out.get("event") in v.events else (v.event(question) or v.default_event())
    if t == "at_risk":
        return t, {"event": ev, "city": v.city(out.get("city")), "depth": DEFAULT_DEPTH}
    if t == "rescue_first":
        return t, {"event": ev, "depth": DEFAULT_DEPTH}
    if t == "weak_points":
        return t, {}
    if t == "why_late":
        cust = v.customer(out.get("customer"))
        return (t, {"customer": cust, "event": ev, "depth": DEFAULT_DEPTH}) if cust else None
    if t == "orders_window":
        city = v.city(out.get("city"))
        try:
            a, b = date.fromisoformat(out["from_date"]), date.fromisoformat(out.get("to_date") or out["from_date"])
        except (KeyError, TypeError, ValueError):
            return None
        return (t, {"city": city, "from_day": to_day(min(a, b)), "to_day": to_day(max(a, b))}) if city else None
    if t == "reroute":
        src, dst = v.place(out.get("from_place")), v.place(out.get("to_place"))
        avoid = v.place(out.get("avoid_place")) or v.events[ev]["hubs"][0]
        return (t, {"from_hub": src, "to_hub": dst, "avoid_hub": avoid}) if src and dst and src != dst else None
    return None


def read_as(template: str, p: dict, ctx: dict) -> str:
    ev = ctx["events"].get(p.get("event", ""), {})
    if template == "at_risk":
        s = f"Orders that will be late because of: {ev.get('name')} ({ev.get('when')})"
        return s + (f", customers in {p['city']}" if p.get("city") else "")
    if template == "orders_window":
        from .questions import _day
        return f"Orders from customers in {p['city']}, promised between {_day(p['from_day'])} and {_day(p['to_day'])}"
    if template == "why_late":
        return f"Why {p['customer']}'s order is late, traced back to: {ev.get('name')}"
    if template == "rescue_first":
        return f"Groups of late orders with the same cause, biggest first: {ev.get('name')}"
    if template == "weak_points":
        return "Places that most of our shortest routes pass through"
    if template == "reroute":
        h = ctx["hubs"]
        return f"Fastest routes from {h[p['from_hub']]} to {h[p['to_hub']]} that avoid {h[p['avoid_hub']]}"
    return template


def interpret(question: str, g, ctx: dict) -> tuple[str, dict, str]:
    question = (question or "").strip()
    if not question or len(question) > 300:
        raise NotUnderstood("Ask a question of up to 300 characters.")
    v = Vocabulary(g, ctx)
    hit = keywords(question, v)
    if hit:
        return hit[0], hit[1], "keywords"
    hit = gemini(question, v)
    if hit:
        return hit[0], hit[1], "gemini"
    raise NotUnderstood("I can answer questions about late orders, why an order is late, what to rescue first, "
                        "which places everything depends on, routes around a closed port, and orders due in a "
                        "date range.")
