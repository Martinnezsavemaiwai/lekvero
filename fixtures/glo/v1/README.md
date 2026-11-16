# GLO API fixtures (v1)

These are recorded responses from the Government Lottery Office (GLO) API. Tests use them so they never call the live service.

| Directory | Contents | Kind |
|---|---|---|
| `live/latest/` | `getLatestLottery`: the draw of 2026-11-16, with the modern prize structure and an `n3` block | live |
| `live/result-by-date/*.json` | `getLotteryResult`: 2011-02-01, 2013-02-01 and 2015-01-16 (**legacy** structure: 4 × last-3, no front-3), and 2020-01-17, 2024-03-01, 2024-12-16 and 2025-01-17 (**modern** structure) | live |
| `live/result-by-date/*.null.json` | `getLotteryResult` returned `"response": null`. Covers pre-coverage dates, a non-draw date and a holiday-shifted date. A null response does **not** prove there was no draw | live |
| `live/check/` | `getcheckLotteryResult`: GLO's own checker verdicts for the 2024-03-01 draw | live |
| `synthetic/malformed/` | Deliberately broken copies of the 2024-03-01 fixture, used to test schema failure paths. **Not GLO data.** Each file says what was mutated in a `_synthetic` key | synthetic |

## Provenance

- **When captured:** all live files come from the Phase 1 research run on **2026-11-16**, between about 16:31 and 16:35 UTC. See `docs/research/data-sources.md`.
- **What `manifest.json` records:** the endpoint, the exact request body, the retrieval time and the SHA-256 hash of each file.
- **How the files were stored:** bodies are byte-identical to what GLO returned. Raw response headers were not stored because they carried WAF/session cookies. The useful headers (Date, Cache-Control, X-Cache) are copied into the manifest. The bodies hold no personal data.
- **New live requests:** none were made to build this fixture set.

## Rules

- **Never edit a live fixture.** To update, add a new versioned set (`v2/`) and keep `v1/` unchanged.
- **Regenerate synthetic files and the manifest with the scripts:**
  ```
  python3 -I scripts/make-synthetic-fixtures.py fixtures/glo/v1
  python3 -I scripts/build-fixture-manifest.py fixtures/glo/v1
  ```
- **Licence:** the GLO catalogue labels this dataset *Creative Commons Non-Commercial (Any)*. These files are kept for local development and testing only. Do not publish or redistribute them, or anything derived from them, until GLO answers the inquiry in `docs/legal/`.

## Known gaps (not fabricated, still open)

- **Earliest covered draw:** somewhere between 2008-02 and 2011-02. Not pinned down.
- **First draw with the modern structure:** somewhere between 2015-01-16 and 2020-01-17. Not pinned down.
- **Historical prize amounts:** GLO reports today's amounts even for 2011. Treat them as unverified.
- **Partial results:** there is no fixture of a draw-day response captured while results were only partly published.
