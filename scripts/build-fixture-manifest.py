"""Build fixtures/glo/v1/manifest.json (provenance + SHA-256 for every fixture).

Live-request metadata (endpoint, request body, retrieval time) is recorded in
LIVE below from the Phase 1 research log; it is not re-fetched.
Usage: python3 -I scripts/build-fixture-manifest.py fixtures/glo/v1
"""
import hashlib, json, os, sys

root = sys.argv[1]
API = "https://www.glo.or.th/api"
BY_DATE = f"{API}/checking/getLotteryResult"

def by_date(d, t):
    y, m, dd = d.split("-")
    return {"endpoint": BY_DATE, "request": {"date": dd, "month": m, "year": y}, "retrieved_at": t}

LIVE = {
    "live/latest/2026-11-16.json": {"endpoint": f"{API}/lottery/getLatestLottery", "request": None,
        "retrieved_at": "2026-11-16T16:32:05Z",
        "response_headers": {"Date": "Mon, 16 Nov 2026 16:27:14 GMT", "Cache-Control": "must-revalidate, private, max-age=1800", "X-Cache": "HIT"}},
    "live/check/2024-03-01_nonwinner.json": {"endpoint": f"{API}/checking/getcheckLotteryResult",
        "request": {"number": [{"lottery_num": "123456"}], "period_date": "2024-03-01"}, "retrieved_at": "2026-11-16T16:32:25Z"},
    "live/check/2024-03-01_winners.json": {"endpoint": f"{API}/checking/getcheckLotteryResult",
        "request": {"number": [{"lottery_num": "253603"}, {"lottery_num": "000079"}, {"lottery_num": "253602"}], "period_date": "2024-03-01"},
        "retrieved_at": "2026-11-16T16:33:22Z"},
}
times = {"2011-02-01": "16:34:34", "2013-02-01": "16:34:44", "2015-01-16": "16:33:40", "2020-01-17": "16:34:52",
         "2024-03-01": "16:32:19", "2024-12-16": "16:33:54", "2025-01-17": "16:34:02",
         "1995-01-16": "16:32:56", "2006-02-01": "16:34:18", "2007-01-16": "16:32:49", "2008-02-01": "16:34:26",
         "2010-01-16": "16:33:47", "2020-01-16": "16:33:33", "2024-12-30": "16:33:14", "2024-03-05": "16:33:06"}
for d, t in times.items():
    name = f"live/result-by-date/{d}.json"
    if not os.path.exists(os.path.join(root, name)):
        name = f"live/result-by-date/{d}.null.json"
    LIVE[name] = by_date(d, f"2026-11-16T{t}Z")

entries = []
for dirpath, _, files in os.walk(root):
    for fn in sorted(files):
        if fn == "manifest.json": continue
        full = os.path.join(dirpath, fn); rel = os.path.relpath(full, root)
        sha = hashlib.sha256(open(full, "rb").read()).hexdigest()
        e = {"path": rel, "sha256": sha}
        if rel.startswith("live/"):
            e.update({"kind": "live", "source": "Government Lottery Office (GLO)", "http_status": 200}, **LIVE[rel])
        else:
            e.update({"kind": "synthetic", "note": "Deliberately malformed; derived by scripts/make-synthetic-fixtures.py. NOT GLO data."})
        entries.append(e)
entries.sort(key=lambda e: e["path"])
manifest = {
    "fixture_set": "glo", "version": 1,
    "licence_note": "Live responses come from GLO; catalogue licence is 'Creative Commons Non-Commercial (Any)' "
                    "(gdcatalog dataset_c4-9_01). Stored for local development and testing only. "
                    "Public redistribution is blocked pending GLO clarification (see docs/legal/).",
    "retrieval_clock_note": "retrieved_at = sandbox file mtime (UTC). The one captured server Date header is ~5 min "
                            "earlier than the sandbox clock; treat times as approximate (±10 min).",
    "redactions": "Response bodies contained no personal data or credentials and are byte-identical to what was "
                  "received. Raw response headers (which carried WAF/session cookies) were NOT stored.",
    "files": entries,
}
with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2); f.write("\n")
print(len(entries), "entries")
