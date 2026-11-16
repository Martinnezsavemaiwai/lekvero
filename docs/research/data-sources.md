# Phase 1 — Data Source Research

Research date: 2026-11-16. All connectivity tests were run from a cloud sandbox on that date.

**Legend**

- **[VERIFIED]**: observed directly in a live response during this research.
- **[DOCUMENTED]**: stated by the source owner, but not independently confirmed.
- **[ASSUMPTION]**: an inference that has not been confirmed.
- **[RECOMMENDATION]**: a suggested course of action.

---

## 1. Summary

| Source | Owner | Programmatic | Licence | Suitability |
|---|---|---|---|---|
| GLO JSON API (`www.glo.or.th/api/...`) | Government Lottery Office (GLO) | Yes: 3 documented POST endpoints, no auth | CC Non-Commercial (from the catalogue entry) | **Primary source** |
| GLO Data Catalog (`gdcatalog.glo.or.th`) | GLO (CKAN) | Metadata only. `/api/` is disallowed in robots.txt | Same as above | Documentation/discovery only |
| GLO per-draw PDF (`api.glo.or.th/utility/file/download/<uuid>`) | GLO | URL is returned by the API | Same as above | **Verification/evidence artefact** |
| GLO web pages (`/mission/awarding/...`) | GLO | Nuxt SPA, HTML | "สงวนลิขสิทธิ์" (all rights reserved) | Do not scrape. Use the API |
| data.go.th national portal | DGA | Not tested (HTTP 403 to our client) | Unknown | No lottery-result dataset found |
| Media sites (Thairath, Daily News, PPTV, …) | Private media | HTML scraping only | Proprietary | **Not suitable** (unauthorised, secondary) |

---

## 2. Government Lottery Office Data Catalog: `gdcatalog.glo.or.th`

### 2.1 Platform [VERIFIED]

- CKAN **2.10.7** with the `thai_gdc` extension (Thai Government Data Catalog), version 3.0.0. Confirmed via `status_show`.
- `robots.txt` [VERIFIED] contains:
  ```
  User-agent: *
  Disallow: /dataset/rate/
  Disallow: /revision/
  Disallow: /dataset/*/history
  Disallow: /api/
  Crawl-Delay: 10
  ```
  > **Compliance note:** this research made three requests to `/api/3/action/*` (`package_list`, `status_show`, `package_search`) before robots.txt was read. No further catalogue API calls were made, and the platform must **not** call the CKAN API. The catalogue is used only as human-readable documentation.
- The catalogue lists 19 datasets in total. Exactly one is about lottery results.

### 2.2 Dataset `dataset_c4-9_01`: "ข้อมูลผลการออกรางวัลสลากกินแบ่งรัฐบาล" (Lottery Draw Results)

| Field | Value [VERIFIED from catalogue metadata] |
|---|---|
| Publisher org | กองออกรางวัล (Draw Department), GLO |
| Maintainer | สำนักเทคโนโลยีสารสนเทศ (IT Bureau), contact `callcenter@glo.or.th` |
| Licence | **Creative Commons Non-Commercial (Any)**, `isopen: false` |
| Data category | ข้อมูลสาธารณะ (public data), ข้อมูลระเบียน (record data) |
| Stated purpose | Open data so the public can trust the draw is transparent |
| Update frequency | Every 16 days |
| Format | "Text". All resources are links to `www.glo.or.th` pages or APIs, with no downloadable files and no CKAN datastore |
| Metadata last modified | 2024-03-07 |

Resources listed:

1. Results by draw (web page) `https://www.glo.or.th/mission/awarding/orderby-time`
2. Draw committee per draw (web page)
3. Check a ticket number (web page) `.../mission/reward-payment/check-reward`
4. Historical draw statistics (web page) `.../mission/awarding/stat-previous`
5. Statistics on how many people checked results (web page)
6. Printable latest result (web page)
7. **API: latest draw**: `POST https://www.glo.or.th/api/lottery/getLatestLottery`
8. **API: check numbers against a draw**: `POST https://www.glo.or.th/api/checking/getcheckLotteryResult`
9. **API: result by draw date**: `POST https://www.glo.or.th/api/checking/getLotteryResult`

The endpoint URLs and request bodies above are copied verbatim from the catalogue's resource descriptions.

### 2.3 Licensing interpretation

- [VERIFIED] The catalogue labels the dataset **CC Non-Commercial**. No specific CC version (BY-NC 4.0 etc.) is given. "(Any)" is a CKAN licence ID, not a formal CC licence.
- [VERIFIED] The GLO website footer says "สงวนลิขสิทธิ์ พ.ศ.2562" ("All rights reserved", 2019). No API-specific terms of use, rate limits or attribution rules were found.
- [ASSUMPTION] Facts such as winning numbers are probably not copyrightable on their own, but the curated dataset and the PDFs may be.
- [RECOMMENDATION] Run the platform as **non-commercial**: no ads, no paid tiers, and no lottery sales or affiliates. Attribute GLO on every page and API response. **Before any public launch, email GLO (`callcenter@glo.or.th`) and ask for written confirmation** of acceptable use, rate limits, and whether the platform can re-serve the data through its own public API. This is the main open legal question.

---

## 3. GLO JSON API: `www.glo.or.th/api/...`

### 3.1 Access characteristics [VERIFIED]

- HTTPS POST with `Content-Type: application/json`. **No API key or authentication.**
- The response sets F5/BIG-IP-style cookies (`TS01…`, `mba-session`, `inb-session`), which points to a WAF or load balancer in front of the API.
- `getLatestLottery` returned `Cache-Control: must-revalidate, private, max-age=1800` and `X-Cache: HIT`, so it is served from a cache with a 30-minute window.
- **Reliability:** from the sandbox, roughly 1 in 3 TLS handshakes was reset (`Connection reset by peer`). Retries with a few seconds of backoff always succeeded. Part of this may come from the sandbox proxy, but the client must still retry with exponential backoff.
- Latency: about 0.9–2.5 s per request.
- `www.glo.or.th/robots.txt` returns 404, so no robots policy applies.
- No rate limit is documented. [RECOMMENDATION] Make at most 1 request every 5 s, send a descriptive User-Agent with a contact address, and run backfills once, off-peak.

### 3.2 `getLatestLottery`: latest draw [VERIFIED]

```
curl -X POST -H "Content-Type: application/json" https://www.glo.or.th/api/lottery/getLatestLottery
```

Observed envelope (values abbreviated; key names exact):

```jsonc
{
  "statusMessage": "getLatestLottery - Success", "statusCode": 200, "message": null, "status": true,
  "response": {
    "youtube_url": "https://www.youtube.com/watch?v=…",
    "pdf_url": "https://api.glo.or.th/utility/file/download/<uuid>",
    "date": "2026-11-16",
    "period": [43, 44],
    "remark": null,
    "status": 1,
    "sheetId": "<uuid>",
    "displayDate": {"date": "16", "month": "11", "year": "2026"},
    "data": {
      "first":  {"price": "6000000.00", "number": [{"round": 1, "value": "645654"}]},
      "second": {"price": "200000.00",  "number": [ /* 5 items */ ]},
      "third":  {"price": "80000.00",   "number": [ /* 10 */ ]},
      "fourth": {"price": "40000.00",   "number": [ /* 50 */ ]},
      "fifth":  {"price": "20000.00",   "number": [ /* 100 */ ]},
      "last2":  {"price": "2000.00",    "number": [ /* 1, 2 digits */ ]},
      "last3f": {"price": "4000.00",    "number": [ /* 2, 3 digits */ ]},
      "last3b": {"price": "4000.00",    "number": [ /* 2, 3 digits */ ]},
      "near1":  {"price": "100000.00",  "number": [ /* 2, first±1 */ ]}
    },
    "n3": { "straight3": {…}, "shuffle3": {…}, "straight2": {…}, "special": {…} }
  }
}
```

Observations:
- `number[].round` is the order in which the number was drawn. The array itself is **not** sorted by `round`.
- `near1` held first − 1 and first + 1 in the observed draws.
- `price` is a decimal string giving baht per ticket.
- `n3` holds the separate **N3 3-digit lottery** product. News sources say its first draw was 2024-11-01 (Thairath). It is `null` on older draws.

### 3.3 `getLotteryResult`: result by draw date [VERIFIED]

```
curl -X POST -H "Content-Type: application/json" \
  -d '{"date":"01","month":"03","year":"2024"}' \
  https://www.glo.or.th/api/checking/getLotteryResult
```

- **The envelope differs from `getLatestLottery`:** data sits under `response.result`, and there is an extra `response.responseStatus` (`{"operation":"getLotteryResult","status":"Success","code":"00000",…}`). The `result` object has the same shape as above, without `displayDate`.
- **A date with no draw returns HTTP 200 with `"response": null`.** This looks the same as a date GLO simply has no data for, so the platform needs its **own draw calendar**.
- Year is Gregorian (CE), not Buddhist Era.

Coverage probes:

| Requested date | Result |
|---|---|
| 1995-01-16, 2006-02-01, 2007-01-16, 2008-02-01, 2010-01-16 | `null` |
| 2011-02-01, 2013-02-01, 2015-01-16 | Data. `last3f` has **0** numbers and `last3b` has **4** (older prize structure) |
| 2020-01-16 | `null`. The draw moved to **2020-01-17** (Teachers' Day), which returned data |
| 2020-01-17, 2024-03-01, 2024-12-16, 2025-01-17, 2026-11-16 | Data, with the modern structure: `last3f`=2, `last3b`=2 |
| 2024-12-30 | `null`. Whether a draw happened that day was not confirmed |
| 2024-03-05 (no draw) | `null` |

Conclusions:
- [VERIFIED] Coverage goes back to **at least 2011-02-01**. The earliest available draw falls between 2008-02 and 2011-02 and was **not pinned down**, to keep request volume low.
- [VERIFIED] **The prize structure changed between 2015-01-16 and 2020-01-17.** The old structure had 4 × "last 3 digits" prizes; the new one has 2 × front-3 + 2 × back-3. News sources put the change in 2015 [ASSUMPTION: exact first draw not confirmed].
- [VERIFIED] **Draw dates are not always the 1st and 16th.** Holidays move them (for example 2020-01-17 and 2025-01-17).
- [CONCERN] Every historical response, including 2011, shows today's prize amounts (6,000,000 / 200,000 / …). [ASSUMPTION] These amounts may not be what was actually paid at the time. Do not present historical prize amounts as authoritative until they have been checked against the draw PDFs.
- `youtube_url` is empty for older draws, while `pdf_url` was present for every draw probed.
- `period` holds a single integer for older draws (`[26]`, `[27]`) and two integers for newer ones (`[3,4]`, `[43,44]`). The catalogue calls it "ชุดที่" (series number). [ASSUMPTION] It identifies the ticket series sold for that draw. Store it raw and do not interpret it.

### 3.4 `getcheckLotteryResult`: check numbers [VERIFIED]

```
curl -X POST -H "Content-Type: application/json" \
  -d '{"number":[{"lottery_num":"253603"},{"lottery_num":"000079"},{"lottery_num":"253602"}],"period_date":"2024-03-01"}' \
  https://www.glo.or.th/api/checking/getcheckLotteryResult
```

Observed result items:
```json
{"date":"2024-03-01","number":"253603","statusType":1,"status_data":[{"reward":"รางวัลที่ 1"}]}
{"date":"2024-03-01","number":"000079","statusType":1,"status_data":[{"reward":"รางวัลเลขท้าย 2 ตัว"}]}
{"date":"2024-03-01","number":"253602","statusType":1,"status_data":[{"reward":"รางวัลข้างเคียงรางวัลที่ 1"}]}
{"date":"2024-03-01","number":"123456","statusType":2,"status_data":[]}
```
- `statusType` 1 means a win and 2 means no win [VERIFIED by example]. Prize names come back as Thai text.
- The documentation allows up to 10 numbers per call.
- [RECOMMENDATION] **Do not proxy user checks to this endpoint.** Doing so would push our traffic onto GLO's servers. Run checks locally, and call this endpoint only from the ingestion validator to **cross-verify** a few sample numbers per draw (first prize, a near1, a last-2 match, a known loser). This gives an independent check of our matching logic against GLO's own.

### 3.5 Per-draw PDF [DOCUMENTED, not fetched]

- `pdf_url` points to `api.glo.or.th`. That host was not on this session's network allowlist, so the PDF was not downloaded.
- [RECOMMENDATION] Download and archive the PDF for each draw (store a SHA-256 hash and keep the file in object storage) as evidence of provenance. Parsing PDFs is **out of scope for the MVP**; at most, a later milestone could use them as a third cross-check.

---

## 4. Other sources

### 4.1 GLO website HTML pages
- [VERIFIED] The site is a Nuxt (Vue) SSR application of about 680 KB, with the footer "สงวนลิขสิทธิ์ พ.ศ.2562".
- [RECOMMENDATION] **Do not scrape.** The documented API returns the same data in structured form.

### 4.2 data.go.th (national open data portal)
- [VERIFIED] It returned HTTP 403 to the sandbox client, probably from a WAF or bot filter. No lottery-results dataset turned up in search results.
- [ASSUMPTION] Any dataset there would be harvested from gdcatalog (which has `allow_harvest: True`), so it would add nothing new.

### 4.3 Third-party media and aggregators
- Examples include Thairath, Daily News, PPTV, and LINE pages run by commercial "lottery check" services.
- **Not suitable.** They are secondary, their terms do not allow re-use, and their accuracy is unverified. At most they could serve as an unofficial manual sanity check, and they must never be an ingestion source.

---

## 5. Suitability decision

| Use | Source |
|---|---|
| Ingest the latest draw | `getLatestLottery`, polled in the draw-day window |
| Backfill history and re-verify past draws | `getLotteryResult`, one request per known draw date |
| Cross-verify our matching logic | `getcheckLotteryResult`, a few samples per draw, ingestion only |
| Evidence and provenance | `pdf_url` PDF, archived with a hash |
| Discovery and licence reference | gdcatalog dataset page (HTML only) |

## 6. Open questions and risks

1. **Licence and terms of use.** CC Non-Commercial with no version given and no API terms. Ask GLO for written permission before launch.
2. **No SLA or versioning on the API.** The schema could change without notice (it already has: `n3` was added and the envelopes differ). Mitigations: archive every raw payload, validate against a strict schema, and alert on drift.
3. **Draw calendar.** There is no endpoint that lists draws. The platform needs a curated calendar, which can be seeded by probing candidate dates (the 1st, 2nd, 16th, 17th, 30th, …) once during backfill.
4. **Earliest coverage** lies somewhere between 2008 and 2011.
5. **Accuracy of historical prize amounts** is doubtful (see §3.3).
6. **Exact draw on which the prize structure changed** is not confirmed (expected 2015).
7. **Corrections.** No mechanism was observed for how GLO publishes errata. Mitigation: re-fetch recent draws on a schedule and diff them.
8. **N3 product.** It is a separate game. It is out of scope for the MVP, but its raw payload should still be stored.
9. **WAF connection resets.** Need retry/backoff and alerting.
10. **Timing of results on draw day.** Not measured. The draw is televised in the afternoon (ICT). Polling cadence must be tuned empirically, and partial results while the draw is in progress are possible [ASSUMPTION].

## 7. Reproducing the tests

The test environment needs outbound access to `www.glo.or.th` and `gdcatalog.glo.or.th`. To fetch PDFs it also needs `api.glo.or.th`. Every call above is a read-only POST or GET, each request was spaced 5–6 s apart, and the whole research run made about 25 requests to GLO.
