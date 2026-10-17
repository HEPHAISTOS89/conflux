"""Analyst Q&A: Bedrock Converse with tool use over the curated store, plus a deterministic fallback."""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Any, Callable

from . import queries, store

log = logging.getLogger("roadscope.ask")
MAX_TOOL_ROUNDS = 4
MAX_QUESTION_CHARS = 500
FALLBACK_MODEL = "deterministic-fallback"

SYSTEM_PROMPT = (
    "You are a transportation-safety analyst for Lubbock, Texas (TxDOT Lubbock District), supporting the "
    "Texas Tech TransTech Lab. Answer only from the tool results: HSM Part B network screening (crash frequency, "
    "rate per 100 MVMT, critical-rate ratio, EPDO, Empirical Bayes excess), corridor straight-line data, "
    "vulnerable-road-user crashes (KABCO, PBCAT), NGSIM surrogate safety measures (TTC, PET, DRAC) and the "
    "Negative Binomial SPF. For every number, cite the table/tool it came from in brackets, e.g. "
    "[query_screening: network.geojson]. Use US units (miles, mph, vehicles/day). State limitations explicitly "
    "(reporting years, informational TxDOT data, NGSIM sites are Los Angeles/Atlanta not Lubbock, screening "
    "ranks indicate where to investigate, not causation). Be concise; never invent values."
)

CITATION = {
    "query_screening": "network.geojson (HSM Part B screening, TxDOT Roadway Inventory/AADT/crash segments)",
    "get_corridor": "corridors.json (TxDOT inventory, AADT, 2024 statewide speed)",
    "vru_summary": "vru_crashes.geojson (TxDOT Active Transportation Crashes)",
    "intersection_conflicts": "intersections/<id>_conflicts.json (NGSIM trajectories, SSM)",
    "get_spf": "spf.json (Negative Binomial SPF fit)",
    "get_manifest": "manifest.json (sources, licences, fetch times)",
}


# ---------- tools ----------
def t_query_screening(method: str = "eb_excess", limit: int = 10, f_system: int | None = None) -> dict[str, Any]:
    if method not in queries.METHOD_FIELD:
        method = "eb_excess"
    res = queries.screening(method, max(1, min(int(limit), 20)), f_system)
    keep = ("seg_id", "route", "name", "f_system", "aadt", "len_mi", "crashes_total", "crash_years",
            "rate_100mvmt", "crit_ratio", "epdo", "spf_pred", "eb_expected", "eb_excess", "screen_rank")
    return {**res, "items": [{k: r.get(k) for k in keep} for r in res["items"]]}


def t_get_corridor(corridor_id: str | None = None) -> dict[str, Any]:
    rows = store.load("corridors.json")
    if corridor_id:
        c = queries.corridor(corridor_id)
        if c:
            return {k: v for k, v in c.items() if k != "stations"} | {"n_stations": len(c["stations"])}
    return {"error": f"unknown corridor '{corridor_id}'" if corridor_id else None,
            "corridors": [{"id": c["id"], "name": c["name"], "routes": c["routes"], "len_mi": c["len_mi"],
                           "summary": c.get("summary", {})} for c in rows]}


def t_vru_summary() -> dict[str, Any]:
    s = queries.vru_summary()
    s.pop("hour_dow")
    return s


def t_intersection_conflicts(intersection_id: str | None = None, type: str | None = None,
                             max_ttc: float | None = None) -> dict[str, Any]:
    ids = store.intersection_ids()
    iid = intersection_id if intersection_id in ids else (ids[0] if ids else None)
    if iid is None:
        return {"error": "no intersections available"}
    rows = queries.conflicts(iid, type, max_ttc)
    by_type: dict[str, int] = {}
    for r in rows:
        by_type[r["type"]] = by_type.get(r["type"], 0) + 1
    worst = sorted((r for r in rows if isinstance(r.get("ttc_min"), (int, float))), key=lambda r: r["ttc_min"])[:5]
    return {"intersection_id": iid, "available": ids, "count": len(rows), "by_type": by_type, "lowest_ttc": worst}


def t_get_spf() -> dict[str, Any]:
    return store.load("spf.json")


def t_get_manifest() -> dict[str, Any]:
    return store.load("manifest.json")


TOOLS: dict[str, Callable[..., dict[str, Any]]] = {
    "query_screening": t_query_screening,
    "get_corridor": t_get_corridor,
    "vru_summary": t_vru_summary,
    "intersection_conflicts": t_intersection_conflicts,
    "get_spf": t_get_spf,
    "get_manifest": t_get_manifest,
}

_S = {"type": "object", "properties": {}}
TOOL_SPECS: list[dict[str, Any]] = [
    {"toolSpec": {"name": "query_screening", "description": "Rank one-mile Lubbock County segments by an HSM screening method.",
                  "inputSchema": {"json": {"type": "object", "properties": {
                      "method": {"type": "string", "enum": list(queries.METHOD_FIELD)},
                      "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                      "f_system": {"type": "integer", "description": "FHWA functional class 1-7"}}}}}},
    {"toolSpec": {"name": "get_corridor", "description": "Corridor profile summary by id; omit id to list corridors.",
                  "inputSchema": {"json": {"type": "object", "properties": {"corridor_id": {"type": "string"}}}}}},
    {"toolSpec": {"name": "vru_summary", "description": "Pedestrian/bicycle crash summary (KABCO, PBCAT, light, streets).",
                  "inputSchema": {"json": _S}}},
    {"toolSpec": {"name": "intersection_conflicts", "description": "Surrogate-safety conflicts (TTC/PET/DRAC) at an NGSIM intersection.",
                  "inputSchema": {"json": {"type": "object", "properties": {
                      "intersection_id": {"type": "string"},
                      "type": {"type": "string", "enum": ["rear_end", "crossing", "lane_change"]},
                      "max_ttc": {"type": "number"}}}}}},
    {"toolSpec": {"name": "get_spf", "description": "Negative Binomial safety performance function coefficients.",
                  "inputSchema": {"json": _S}}},
    {"toolSpec": {"name": "get_manifest", "description": "Data sources, licences, record counts and fetch times.",
                  "inputSchema": {"json": _S}}},
]


def run_tool(name: str, args: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    fn = TOOLS.get(name)
    if fn is None:
        return {"error": f"unknown tool {name}"}, False
    try:
        return fn(**args), True
    except store.MissingData as exc:
        return {"error": f"data file missing: {exc.args[0]}"}, False
    except (TypeError, ValueError, KeyError) as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}, False


# ---------- Bedrock ----------
def _bedrock() -> Any:
    import boto3

    return boto3.client("bedrock-runtime")


def ask_bedrock(question: str) -> dict[str, Any]:
    model_id = os.environ.get("BEDROCK_MODEL_ID")
    if not model_id:
        raise RuntimeError("BEDROCK_MODEL_ID not set")
    client = _bedrock()
    messages: list[dict[str, Any]] = [{"role": "user", "content": [{"text": question}]}]
    calls: list[dict[str, Any]] = []
    for round_no in range(MAX_TOOL_ROUNDS + 1):
        resp = client.converse(modelId=model_id, system=[{"text": SYSTEM_PROMPT}], messages=messages,
                               toolConfig={"tools": TOOL_SPECS}, inferenceConfig={"maxTokens": 900, "temperature": 0.2})
        msg = resp["output"]["message"]
        messages.append(msg)
        uses = [b["toolUse"] for b in msg["content"] if "toolUse" in b]
        if resp.get("stopReason") != "tool_use" or not uses or round_no == MAX_TOOL_ROUNDS:
            text = "\n".join(b["text"] for b in msg["content"] if "text" in b).strip()
            if not text:
                raise RuntimeError("model returned no text")
            names = list(dict.fromkeys(c["name"] for c in calls if c["ok"]))
            return {"answer": text, "citations": [CITATION[n] for n in names], "tool_calls": calls,
                    "model": model_id, "fallback": False}
        results = []
        for u in uses:
            out, ok = run_tool(u["name"], u.get("input") or {})
            calls.append({"name": u["name"], "input": u.get("input") or {}, "ok": ok})
            results.append({"toolResult": {"toolUseId": u["toolUseId"], "content": [{"json": json.loads(json.dumps(out, default=str))}],
                                           "status": "success" if ok else "error"}})
        messages.append({"role": "user", "content": results})
    raise RuntimeError("unreachable")


# ---------- deterministic fallback ----------
def _f(v: Any, nd: int = 2) -> str:
    if isinstance(v, bool) or v is None:
        return "n/a"
    if isinstance(v, int) or (isinstance(v, float) and v.is_integer() and abs(v) >= 100):
        return f"{int(v):,}"
    return f"{v:,.{nd}f}" if isinstance(v, float) else str(v)


def _route(q: str) -> list[tuple[str, dict[str, Any]]]:
    ql = q.lower()
    plan: list[tuple[str, dict[str, Any]]] = []
    try:
        for c in store.load("corridors.json"):
            keys = [str(c["id"]), c["name"], *c.get("routes", [])]
            if any(k and re.search(r"\b" + re.escape(k.lower()) + r"\b", ql) for k in keys):
                plan.append(("get_corridor", {"corridor_id": c["id"]}))
                break
    except store.MissingData:
        pass
    if re.search(r"\b(ped|peds|pedestrian|bike|bicycl|cyclist|vru|vulnerable|yield)", ql):
        plan.append(("vru_summary", {}))
    if re.search(r"\b(conflict|ttc|pet|drac|near.?(crash|miss)|intersection|ngsim|trajector)", ql):
        ids = store.intersection_ids()
        iid = next((i for i in ids if i.lower() in ql), None)
        args: dict[str, Any] = {"intersection_id": iid} if iid else {}
        ctype = next((t for t in ("rear_end", "crossing", "lane_change") if re.search(t.replace("_", "[ _-]?"), ql)), None)
        if ctype:
            args["type"] = ctype
        plan.append(("intersection_conflicts", args))
    if re.search(r"\b(spf|safety performance|overdispersion|negative binomial|coefficient)", ql):
        plan.append(("get_spf", {}))
    if re.search(r"\b(sources?|licen[cs]e|provenance|manifest|fresh|updated|fetched|come from|dataset)", ql):
        plan.append(("get_manifest", {}))
    if not plan or re.search(r"\b(rank|worst|hotspot|top|segment|screen|epdo|eb|empirical|critical|rate)\b", ql):
        method = ("epdo" if "epdo" in ql else "critical_ratio" if "critical" in ql
                  else "rate" if re.search(r"\brate\b", ql) else "frequency" if re.search(r"frequen|most crash", ql)
                  else "eb_excess")
        plan.append(("query_screening", {"method": method, "limit": 5}))
    return plan


def _compose(name: str, d: dict[str, Any]) -> str:
    cite = f"[{name}: {CITATION[name].split(' ')[0]}]"
    if "error" in d and d["error"] and name != "get_corridor":
        return f"{name} could not answer: {d['error']}."
    if name == "query_screening":
        lines = [f"Top {len(d['items'])} of {d['total']} screened segments by {d['method']} ({d['field']}) {cite}:"]
        for r in d["items"]:
            lines.append(f"{r['screen_rank']}. {r.get('name') or r.get('route')} (seg {r['seg_id']}, {_f(r.get('len_mi'))} mi, "
                         f"AADT {_f(r.get('aadt'))}): {_f(r.get('crashes_total'))} crashes, rate {_f(r.get('rate_100mvmt'))}/100 MVMT, "
                         f"crit. ratio {_f(r.get('crit_ratio'))}, EPDO {_f(r.get('epdo'))}, EB excess {_f(r.get('eb_excess'))}.")
        return "\n".join(lines)
    if name == "get_corridor":
        if "corridors" in d:
            return f"Available corridors {cite}: " + "; ".join(f"{c['id']} ({c['name']}, {_f(c['len_mi'])} mi)" for c in d["corridors"]) + "."
        summ = ", ".join(f"{k.replace('_', ' ')} {_f(v)}" for k, v in d.get("summary", {}).items() if not isinstance(v, (dict, list)))
        return f"{d['name']} ({'/'.join(d['routes'])}): {_f(d['len_mi'])} mi, {d['n_stations']} stations" + (f"; {summ}" if summ else "") + f" {cite}."
    if name == "vru_summary":
        sev = ", ".join(f"{k} {v}" for k, v in d["by_severity"].items())
        streets = ", ".join(f"{k} ({v})" for k, v in list(d["top_streets"].items())[:3])
        yrs = f"{d['years'][0]}-{d['years'][1]}" if d["years"] else "n/a"
        return (f"{d['total']} pedestrian/bicycle crashes ({yrs}); KABCO: {sev}; {d['ka_total']} fatal or "
                f"suspected-serious (K+A). By mode: {', '.join(f'{k} {v}' for k, v in d['by_mode'].items())}. "
                f"Most frequent streets: {streets} {cite}.")
    if name == "intersection_conflicts":
        types = ", ".join(f"{k.replace('_', '-')} {v}" for k, v in d["by_type"].items()) or "none"
        worst = d["lowest_ttc"][0] if d["lowest_ttc"] else None
        tail = f" Lowest TTC {_f(worst['ttc_min'])} s ({worst['type'].replace('_', '-')}, t={_f(worst['t'], 1)} s)." if worst else ""
        return f"{d['count']} conflicts at NGSIM site '{d['intersection_id']}' ({types}).{tail} {cite}"
    if name == "get_spf":
        return (f"SPF {d['form']}: b0={_f(d['b0'], 3)}, b1={_f(d['b1'], 3)}, overdispersion k={_f(d['k'], 3)}, "
                f"n={d['n']} segments, AIC {_f(d.get('aic'), 1)} {cite}.")
    if name == "get_manifest":
        src = "; ".join(f"{s['id']} ({_f(s.get('records'))} records, {s.get('licence') or s.get('license') or 'licence n/a'})" for s in d["sources"])
        return f"Curated data generated {d['generated_at']}. Sources: {src} {cite}."
    return json.dumps(d, default=str)[:400]


LIMITATIONS = ("Limitations: TxDOT data are informational and crash counts cover the reporting years in the source; "
               "screening ranks flag sites for investigation, not causation; NGSIM conflict sites are Los Angeles/Atlanta "
               "arterials used as method demonstrations, not Lubbock locations.")


def ask_fallback(question: str) -> dict[str, Any]:
    parts, calls, names = [], [], []
    for name, args in _route(question):
        out, ok = run_tool(name, args)
        calls.append({"name": name, "input": args, "ok": ok})
        if ok:
            names.append(name)
        parts.append(_compose(name, out))
    answer = "\n\n".join(parts + [LIMITATIONS])
    return {"answer": answer, "citations": [CITATION[n] for n in dict.fromkeys(names)], "tool_calls": calls,
            "model": FALLBACK_MODEL, "fallback": True}


def answer(question: str) -> dict[str, Any]:
    try:
        return ask_bedrock(question)
    except Exception as exc:  # noqa: BLE001 - any Bedrock failure degrades to the deterministic answerer
        log.warning(json.dumps({"event": "bedrock_fallback", "error": f"{type(exc).__name__}: {exc}"[:300]}))
        return ask_fallback(question)


# ---------- rate limiting ----------
class TokenBucket:
    """Per-key token bucket: `capacity` requests, refilled continuously over `per_seconds`."""

    def __init__(self, capacity: int = 10, per_seconds: float = 60.0) -> None:
        self.capacity, self.rate = capacity, capacity / per_seconds
        self._state: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._state.get(key, (float(self.capacity), now))
            tokens = min(self.capacity, tokens + (now - last) * self.rate)
            ok = tokens >= 1
            self._state[key] = (tokens - 1 if ok else tokens, now)
            if len(self._state) > 10_000:
                self._state = {k: v for k, v in self._state.items() if now - v[1] < 120}
            return ok


bucket = TokenBucket()
