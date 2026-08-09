# Pincode API

Look up **State, District, and City** for any Indian pincode — plus, separately,
the pincode's actual **statutory local body** (Municipal Corporation /
Municipality / Town Panchayat), when it has one.

Two-tier design, because "City" means two different things depending on who's
asking:

- **Tier 1 — `statutoryLocalBody`**: the postal locality's real, legally
  governing local body. Never overridden or rolled up — a Town Panchayat
  stays a Town Panchayat here even though a bigger town governs its Taluk.
  Use this for anything jurisdiction-sensitive: property tax, voter roll,
  land records, KYC address proof. `null` means the locality isn't in the
  LGD Urban Local Body directory at all (i.e. it's a village/Census Town,
  not an independent statutory body) — 77% of India's pincodes are this.
- **Tier 2 — `city`**: a form-friendly rollup for shipping/checkout/generic
  "City" fields, where a single recognizable town name matters more than
  jurisdictional precision.

Neither is a proxy for the other. Every record carries both, plus enough
metadata (`citySource`, `cityDistanceKm`) to see how each was derived instead
of it being a black box.

**Two datasets are available.** Everything above describes Dataset 1 (one
consolidated record per unique pincode, ~19k rows). Dataset 2 is the
individual post offices behind those pincodes (~155k rows, NOT deduplicated
— see "Two datasets" below for what's different, including how `city` is
derived there).

## Quick start

```bash
npm install
npm run refresh-data   # downloads source data + builds both data/snapshot.json and data/post-offices.json (~1-2 min, needs the `7z` CLI -- see Data sources)
npm run dev            # starts the API on http://localhost:3000
npm test                # smoke-tests both datasets' endpoints (BASE_URL env to override)
npm run validate:data   # data-quality report for both datasets (not a pass/fail gate)
npm run export:all       # writes CSV + XLSX for both datasets to exports/
```

> Note: if port 3000 is already in use on your machine, set `PORT=xxxx` when starting the server.

## API

### `GET /v1/pincode/:code`

```bash
curl http://localhost:3000/v1/pincode/624610
```
```json
{
  "pincode": "624610",
  "state": "Tamil Nadu",
  "district": "Dindigul",
  "subDistrict": "Dindigul",
  "statutoryLocalBody": {
    "name": "Balasamudram",
    "classification": "Town Panchayat",
    "lgdCode": 252694
  },
  "city": "Palani",
  "citySource": "nearest-place",
  "cityDistanceKm": 4.2,
  "latitude": 10.419,
  "longitude": 77.4992,
  "localities": ["Balasamudram (Dindigul)", "Palarparundalar Dam"]
}
```
This is the case that drove the two-tier split: Balasamudram is its own
independent Town Panchayat (Tier 1, preserved exactly), 4.2km from the much
better-known Palani, which is what most shipping/checkout forms should
actually show (Tier 2).

- `404` if the pincode isn't in the dataset.
- `400` if it isn't a valid 6-digit Indian pincode.

### `POST /v1/pincode/batch`

```bash
curl -X POST http://localhost:3000/v1/pincode/batch \
  -H 'content-type: application/json' \
  -d '{"pincodes": ["110001", "400001", "560001"]}'
```
Up to 200 pincodes per request — built for checkout-form-style bulk lookups.

### `GET /v1/meta` / `GET /health`

Dataset generation timestamp, record count, and sources — poll this to confirm which data snapshot is live.

### `GET /v1/pincodes/all`

Every unique-pincode record (Dataset 1), count computed dynamically from the loaded dataset, never hard-coded.

```bash
curl http://localhost:3000/v1/pincodes/all
```
```json
{
  "count": 19238,
  "results": [
    { "pincode": "110001", "state": "Delhi", "district": "Central Delhi", "city": "New Delhi" }
  ]
}
```

`?format=csv` returns the same data as `text/csv` with `Content-Disposition: attachment; filename="india-pincodes.csv"` — identical output to `GET /v1/export/pincodes.csv` below (same underlying function, `buildPincodesCsv()` in `src/csv.ts`).

### `GET /v1/post-offices`

Paginated post-office records (Dataset 2 — see "Two datasets" below for what this is and how `city` is derived).

```bash
curl "http://localhost:3000/v1/post-offices?page=1&limit=1000"
```
```json
{
  "page": 1,
  "limit": 1000,
  "total": 155569,
  "totalPages": 156,
  "results": [
    {
      "officeName": "Balasamudram (Dindigul)",
      "pincode": "624610",
      "state": "Tamil Nadu",
      "district": "Dindigul",
      "city": "Palani",
      "officeType": null,
      "delivery": null,
      "division": null,
      "region": null,
      "circle": null
    }
  ]
}
```

Query parameters (all optional, combine freely):

| Param | Meaning |
|---|---|
| `page` | 1-indexed page number. Default `1`. |
| `limit` | Rows per page. Default `1000`, max `10000` (`400` if exceeded). |
| `pincode` | Exact match, must be a valid 6-digit pincode. Indexed — this is the fast path. |
| `state` | Exact match, case-insensitive. |
| `district` | Exact match, case-insensitive. |
| `city` | Exact match, case-insensitive. |
| `search` | Substring match (case-insensitive) against `officeName`, `pincode`, `city`, `district`, and `state` combined. |

`officeType`/`delivery`/`division`/`region`/`circle` are always `null` — see "Two datasets" below for why, and `GET /v1/post-offices/meta` for the machine-readable version of that explanation (also carries `recordsWithCity`/`recordsWithoutCity` counts).

### Downloadable exports

| Endpoint | Contents |
|---|---|
| `GET /v1/export/pincodes.csv` | Dataset 1, CSV. Same as `GET /v1/pincodes/all?format=csv`. |
| `GET /v1/export/pincodes.xlsx` | Dataset 1, Excel. |
| `GET /v1/export/post-offices.csv` | Dataset 2, CSV — `City` populated, `Office Type`/`Delivery`/`Division`/`Region`/`Circle` blank (see above). |
| `GET /v1/export/post-offices.xlsx` | Dataset 2, Excel. |

All four set `Content-Type` and `Content-Disposition: attachment; filename="..."` correctly. CSV is built fresh from the in-memory dataset per request (cheap — string joins over already-parsed objects, no measurable cost). XLSX is genuinely expensive to build for ~155k rows (~2.6s measured locally) so it's built once per warm Vercel instance and cached in memory, not regenerated on every request or embedded as a pre-built binary in the deployed bundle — see "Performance" below for the full reasoning and the alternative considered.

Offline equivalents: `npm run export:pincodes` / `export:post-offices` / `export:all` write the same CSV/XLSX to `exports/` (gitignored — regenerate locally, don't expect them in a fresh clone). There's also an older, separate `npm run export-data`, predating Dataset 2, which writes a richer 7-column pincode CSV/XLSX (`exports/pincode-india.*`, adding `City Match Type`/`Statutory Local Body`/`Local Body Classification`) — kept as-is since it was an earlier, deliberate ask, not superseded by the 4-column `india-pincodes.*` files above.

## Tier 1: statutoryLocalBody

Sourced from the Ministry of Panchayati Raj's **Local Government
Directory (LGD)**, joined against each pincode's own postal locality names
(never the district — see why below). Resolution logic lives in
`resolveStatutoryLocalBody()` in `scripts/build-snapshot.ts`.

| `classification`         | Meaning | Share of dataset |
|---|---|---|
| `Municipal Corporation`  | Biggest ULB grade (Mumbai, Chennai, Hyderabad, ...) | ~1.3% |
| `Municipality`           | Mid-size ULB (includes state-specific council tiers — see caveat below) | ~11.2% |
| `Town Panchayat`         | Smallest independent ULB grade | ~10.5% |
| `null`                   | No independent local body found — a village or Census Town | ~77.0% |

**Why Tier 1 doesn't fall back to the district name.** A district is a
*revenue* unit that can contain several *separate* local bodies — Dindigul
district alone contains Dindigul Corporation, Palani Municipality, **and**
Balasamudram Town Panchayat as three independent bodies. Assuming "the
district name matches a Corporation somewhere" means "this specific
locality is governed by it" would silently reintroduce exactly the
jurisdiction-conflation bug this two-tier design exists to avoid, just one
level up. The cost: big-metro sub-area pincodes (a Fort/Mumbai or
Connaught Place/Delhi post office) often show `statutoryLocalBody: null`,
because their post office names are neighbourhood names, not the
corporation's own registered name. Tier 2 recovers the right *display*
city for those cases geometrically regardless (see below) — Tier 1 stays
honestly null rather than guess.

**LGD type-code classification is a best-effort mapping, not an official
crosswalk.** LGD's "Localbody Type Code" isn't one clean national enum —
it carries some state-specific grade codes (Karnataka's City/Town
Municipal Council tiers, Haryana's Municipal Committee tier). The mapping
in `LGD_TYPE_CLASSIFICATION` was validated against known examples (4 =
Corporation, confirmed via Greater Mumbai/Coimbatore/Greater
Chennai/Hyderabad/Kolkata/the three Delhi Municipal Corporations; 5 =
Municipality via Palani; 7 = Town Panchayat via Balasamudram) — if you find
a misclassified place, that table is where to fix it.

## Tier 2: city (logistics rollup)

Resolved cheapest/most-confident-first in `resolveLgdRollup()` (LGD-driven)
then `resolveCity()` (geometry-based fallback):

| `citySource`         | Meaning | Share of dataset |
|---|---|---|
| `lgd-self`            | The locality's own LGD entry is already Corporation/Municipality grade — no rollup needed. Display name is cleaned of corporate titles ("Greater Chennai Corporation" → "Chennai") — see `displayCityName()`. | ~12.5% |
| `lgd-taluk-hq`        | Locality is a Town Panchayat (or has no LGD entry) — rolled up to its Taluk/Tehsil HQ, confirmed via LGD to itself be Corporation/Municipality grade **and** geographically sane (see caveat below). | ~20.8% |
| `exact-match`         | [fallback] A populated place shares its name with the district and sits within 5km of the pincode centroid. | ~1.7% |
| `name-match`          | [fallback] A populated place's name matches the district or sub-district within 25km — trusted at that wider radius because it's a name match, not a geometric guess. | ~22.2% |
| `nearest-place`       | [fallback] Gravity-scored nearest populated place (`population / (distance + 3)^1.5`) so a nearby big town outranks a slightly-closer hamlet. | ~42.8% |
| `district-fallback`   | [fallback] Nothing found within 60km — city = district name, explicitly flagged low-confidence. | ~0% (current data) |

Every record carries `cityDistanceKm`, so you can tighten your own
confidence bar (e.g. treat `nearest-place` results over 30km as "unknown"
in a UI) without re-running the pipeline.

## Two datasets: unique pincodes vs. full post-office data

| | Dataset 1 — unique pincodes | Dataset 2 — post offices |
|---|---|---|
| Granularity | One consolidated record per pincode | One record per individual post office/locality — **not** deduplicated by pincode |
| Row count | 19,238 | 155,569 |
| Built by | `scripts/build-snapshot.ts` | `scripts/build-post-office-snapshot.ts` |
| Output file | `data/snapshot.json` | `data/post-offices.json` |
| Served by | `src/dataStore.ts` | `src/postOfficeStore.ts` |
| Fields | pincode, state, district, subDistrict, statutoryLocalBody, city, citySource, cityDistanceKm, lat/lng, localities | officeName, pincode, state, district, city, officeType, delivery, division, region, circle |
| API | `GET /v1/pincode/:code`, `/batch`, `/v1/pincodes/all` | `GET /v1/post-offices` (paginated + filterable) |

**Same source, different granularity.** Both are built from the same file,
`data/raw/postal-codes.txt` (GeoNames' postal export, 155,570 rows before a
single malformed row — literally `"Nil"` as a place name, pincode 847226 —
is dropped). Dataset 1 groups those rows by pincode; Dataset 2 keeps every
row distinct. Multiple post offices legitimately share a pincode (90.2% of
pincodes have more than one — see `npm run validate:data`), and that's
preserved, not collapsed.

**City mapping methodology for Dataset 2.** Every post-office row's `city`
is **inherited** from Dataset 1's already-resolved value for the same
pincode (a join by pincode, not a re-run of the resolution pipeline per
locality) — so `GET /v1/post-offices?pincode=624610` and
`GET /v1/pincode/624610` always agree by construction, and every post
office sharing a pincode currently gets that pincode's one resolved city.
This is a direct consequence of how the underlying pipeline already works
(one centroid per pincode, not per locality), not a new simplification
introduced for Dataset 2. Genuinely resolving a *different* city per
locality within one pincode — where the source data actually supports that
distinction — would be a real expansion of `build-snapshot.ts`'s resolution
logic (running it per-locality instead of per-pincode-centroid), not
attempted here; noted as a follow-up in "Suggested next steps" below.

**Why `officeType`/`delivery`/`division`/`region`/`circle` are always
`null`.** These are official India Post pincode-directory fields — GeoNames'
postal export (this project's source for both datasets) simply doesn't
carry them. They're left as explicit `null`, never fabricated. Three ways
to add them, in ascending effort:
1. Register a free `data.gov.in` API key and switch to the official
   directory, which has this exact schema.
2. Bulk-poll `api.postalpincode.in` (free, no key, returns these fields
   per pincode) — rate-limited to 1000 req/hr, so full coverage of 19,238
   pincodes takes roughly 20 hours, run as an incremental/resumable job.
3. Leave them `null`, documented, as shipped now.

**City coverage: 100%**, but read that number for what it actually means —
every post-office row inherits a city *because* every pincode in Dataset 1
already resolves to one (0% `district-fallback` in the current data — see
Tier 2's table above). It reflects Dataset 1's coverage, not an
independent per-locality verification. `GET /v1/post-offices/meta` (and
`npm run validate:data`) report this transparently rather than implying
more precision than exists.

## Known limitations, found by spot-checking real pincodes against the API

- **The postal file's sub-district field isn't reliably "the taluk".**
  Pincode 624610's only usable sub-district value is literally
  `"Dindigul"` (the district HQ, 62km away) — its real taluk HQ is Palani,
  4.2km away. Blindly trusting that field for `lgd-taluk-hq` rollups once
  regressed this exact case (rolled up to the wrong city). Fixed with
  `TALUK_HQ_SANITY_RADIUS_KM = 50`: an `lgd-taluk-hq` rollup is only
  accepted if the resolved HQ can actually be found in the gazetteer
  within 50km of the pincode's own centroid — otherwise it falls through
  to the geometry-based fallback, which has no such blind spot. Covered by
  a regression case in `scripts/smoke-test.ts`.
- **LGD corporation names are inconsistently decorated, and one metro's
  name has zero textual overlap with what everyone calls it.** "Greater
  Mumbai", "Greater Chennai Corporation", "Kalaburagi City Corporation" all
  need their titles stripped to become a form-friendly city name
  (`stripLgdCorporateTitle()` / `displayCityName()` — Tier 1 keeps the raw
  legal name regardless, only Tier 2 cleans it). Bengaluru's corporation is
  registered in LGD as literally `"Bbmp"` — no amount of stripping recovers
  that, so it's a one-off hardcoded alias
  (`DISTRICT_NAME_TO_LGD_ALIAS`). Known gaps *not* chased down: spelling
  variants like `"Ahmedabad"` (postal file) vs `"Ahmadabad"` (LGD), and
  merged twin-city corporations (`"Kalyan-Dombivli"`, `"Hubballi-Dharwad"`)
  that only match if the district field happens to use the same hyphenated
  name. Extend `DISTRICT_NAME_TO_LGD_ALIAS` as you find more.
- **Phantom near-zero-distance gazetteer entries.** Pincode 624610's own
  centroid (independently of the sub-district issue above) sits ~0km from
  an obscure hamlet ("Balasamudram", pop. 14k) that shares its name with
  the post office locality, while the actual well-known town ("Palani",
  pop. 70k) is 4.2km away. Fixed by widening the gravity formula's
  distance floor (`GRAVITY_DISTANCE_FLOOR_KM = 3`) so a same-point hamlet
  needs a much larger population edge to beat a nearby real town.
- **Distant fallback in sparse/rural areas.** The closest resolvable city
  can be tens of km away and occasionally "feel" wrong (pincode 632317
  resolves to Vellore, 43.6km away). `DISTRICT_SEARCH_RADIUS_KM` is the
  knob to trade off precision vs. coverage.
- **Placeholder text in source data.** The postal file uses literal `"NA"`
  / `"Nil"` strings (not blank) for a missing sub-district in ~8,600 rows
  — normalized to empty in `readPostalRows()`.

## Data sources

- [GeoNames postal code export](https://download.geonames.org/export/zip/IN.zip) — Pincode → place name, state, district, sub-district (taluk), lat/lng. GeoNames' own India-Post-derived dataset; closest thing to an official, no-API-key bulk-downloadable Pincode → State/District source. **Backs both datasets** — Dataset 1 groups it by pincode, Dataset 2 (`data/post-offices.json`) uses it ungrouped, one row per source row. Downloaded: see `data/post-offices.json`'s `meta.downloadDate` (the raw file's own mtime) or re-run `npm run fetch-data` for a fresh copy. 155,570 source rows in, 155,569 retained (1 dropped — literal `"Nil"` as a place name, pincode 847226).
- [GeoNames gazetteer export](https://download.geonames.org/export/dump/IN.zip) — every named place in India with coordinates + population, used as the Tier 2 candidate pool.
- [LGD Urban Local Body directory](https://ramseraph.github.io/opendata/lgd/) — every India place with independent statutory urban local body status, sourced from the Ministry of Panchayati Raj's [Local Government Directory](https://lgdirectory.gov.in/) and re-published as daily CSV dumps by `ramSeraph/opendata`. This is Tier 1 ground truth. Licensed under the [Government Open Data License – India](https://data.gov.in/sites/default/files/Gazette_Notification_OGDL.pdf). Distributed as `.7z` — extraction requires the `7z` CLI (`brew install p7zip` / `apt install p7zip-full`).

GeoNames data is published under **CC BY 4.0** — attribution required if you redistribute derived data. Both licenses (GeoNames CC BY 4.0, LGD's Government Open Data License – India) explicitly permit redistribution with attribution, which is what the CSV/XLSX exports and download endpoints are.

Refresh periodically (`npm run refresh-data`) — GeoNames updates continuously and LGD publishes daily. This rebuilds both datasets (`build-snapshot.ts` then `build-post-office-snapshot.ts`, which reads the former's output to join `city` — run them in that order, which `refresh-data` already does).

### Data providers we deliberately did not use (for `officeType`/`delivery`/`division`/`region`/`circle`)

Dataset 2's five always-`null` fields specifically — see "Two datasets" above for the full reasoning:

- **`api.postalpincode.in`** — free, no key, and *does* return these fields per pincode (confirmed by inspection) — the earlier conclusion in this file that it has "no bulk export" still holds, but it's now the recommended path if you want them without registering anything: bulk-poll it (rate-limited to 1000 req/hr, ~20hr for full coverage, resumable).
- **`data.gov.in`'s official pincode directory CSV** — the actual authoritative India Post source with this exact schema, but direct download is blocked for non-browser requests and the API requires a free registered key (`api.data.gov.in`). Cleanest option if you register a key.
- **Random GitHub "pincode with city" datasets** — several exist (e.g. `dpnkrpl/indian-pincodes-database`) and do carry a `City` column, but spot-checking them against known pincodes turned up wrong answers (e.g. pincode 799001, Agartala's own GPO, mapped to a different town) with no documented provenance.

## Architecture

- **In-memory serving** — `src/dataStore.ts` (Dataset 1, ~19k pincodes / ~6.8MB JSON) and `src/postOfficeStore.ts` (Dataset 2, ~155.6k post offices / ~9.1MB JSON, stored as compact tuples — see `PostOfficeTuple` in `src/types.ts` — not full objects with all 10 field names repeated 155k+ times). Both imported directly into their module (not read from disk at runtime — see below), served from in-memory `Map`s/arrays, no database round trip per request. `src/postOfficeStore.ts` also builds a `pincode -> row indices` index at load time (the hot-path filter); state/district/city/search filters are a linear scan, fast enough at this scale that a second index isn't worth the complexity — see "Performance" below for the measured numbers behind that call.
- **Offline pipeline** — `scripts/fetch-data.ts` → `scripts/build-snapshot.ts` (Dataset 1, all two-tier resolution work happens here, at build time) → `scripts/build-post-office-snapshot.ts` (Dataset 2, joins `city` from Dataset 1's output — must run after it; `npm run refresh-data` and `npm run build-post-office-snapshot`'s own dependency on `data/snapshot.json` both enforce this order). Re-run on a schedule and redeploy both output files.
- **Shared response builders** — `src/csv.ts` (CSV string building) and `src/xlsxBuilder.ts` (ExcelJS workbook building) are used identically by the live `/v1/export/*` routes and the offline `scripts/export-*.ts` scripts, so the two can never silently drift apart.
- **Route definitions** (`src/createApp.ts`): a `buildApp()` factory that configures a Fastify instance and returns it *without* calling `.listen()`, so the exact same routes work in two different runtimes:
  - **`src/server.ts`** — calls `.listen()`, for local dev (`npm run dev`) and any environment where you own the long-running process (a VM, container, etc).
  - **`src/vercelHandler.ts`** — wraps the same app for Vercel (see Deployment below); no `.listen()`, Vercel's Node runtime owns the HTTP server instead. This file is *source*, not what's deployed directly — see Deployment for why.

`data/snapshot.json` and `data/post-offices.json` are both imported (`import x from "../data/*.json" with { type: "json" }`) rather than read via `fs.readFileSync`, specifically so they get bundled directly into the built output in every runtime — no filesystem path assumptions that could quietly break between a local server and a serverless function's filesystem layout.

## Performance

This API runs on Vercel. Adding Dataset 2 grew the deployed function bundle
(`api/index.js`) from **6.9MB to 17.0MB** — measured, not estimated — almost
entirely the compact post-office JSON (9.1MB). That's comfortably inside
Vercel's function size limits, and both datasets are parsed **once per cold
start** (Node's ES module caching means a warm invocation reuses the
already-parsed in-memory data, not a fresh parse per request) — so
`GET /v1/pincode/:code` sees no per-request cost from Dataset 2 existing at
all, only a (still small, sub-100ms-class) increase in cold-start time from
parsing more JSON at boot. Measured, not assumed — this is exactly what
`npm run test:vercel-handler` and `scripts/verify-vercel-handler.ts` are for:
they run the actual bundled artifact, not just the pre-bundle source.

**Why not SQLite / a database instead of JSON-in-memory.** Considered and
rejected specifically for this project: a native dependency (e.g.
`better-sqlite3`) is a materially different risk than a pure-JS one on a
Vercel deployment that has already been through seven rounds of
Node-runtime/bundling surprises over far simpler changes (see git history) —
native modules need a matching build target and have historically been a
common source of "works locally, breaks on Vercel" failures. At this data
size (< 20MB total in memory for both datasets, well within a Node
function's default memory), plain JSON-in-memory is the simplest solution
that's actually proven reliable on this specific deployment, which is what
"choose the simplest reliable Vercel-compatible solution" means in
practice here — not the simplest solution in the abstract.

**XLSX generation: lazy + cached, not pre-bundled.** Building a real
zip-based spreadsheet for ~155k rows is genuinely expensive — **2.6s**
measured locally for `GET /v1/export/post-offices.xlsx`'s first (cold)
request, **8ms** for every request after (cached in a closure variable
inside `buildApp()`, which persists across invocations on the same warm
Vercel instance — the same pattern `src/vercelHandler.ts` already uses to
cache the built app itself). The alternative considered — pre-generating
the `.xlsx` files at build time and embedding them as base64 directly in
`api/index.js`, the same way the JSON data is bundled — was rejected
because base64 inflates binary size by ~33%, on top of a bundle that's
already grown 2.5x for this feature; lazy-build-once-per-warm-instance gets
the "don't regenerate on every request" goal from Part H without that
additional, avoidable bundle growth. `exceljs` itself is kept external
(resolved from `node_modules` at runtime, not bundled by esbuild) for the
same reason `fastify` already is — see Deployment below.

## Deployment

### Vercel (serverless)

1. Push this repo to GitHub (see below).
2. On [vercel.com](https://vercel.com), **Add New → Project → Import** the GitHub repo. No configuration needed — no build command, no framework preset, nothing to set. `vercel.json` just rewrites every path to `api/index.js`, which is committed directly (see below), so Vercel's zero-config Node.js detection has exactly one plain, already-bundled file to deploy.
3. Vercel deploys automatically on every push to the default branch from then on.

**Why `api/index.js` is committed instead of built by Vercel.** Vercel's default Node.js builder transpiles each `.ts` file in a project individually rather than bundling — handing it a multi-file `src/` tree to resolve on its own produced three straight rounds of confusing runtime failures during this project's actual deployment (`Cannot find module '.../src/app.ts'`, then `Cannot find module '.../src/dataStore'`, then `Invalid export found in module '.../src/app.js'`). Configuring a custom `buildCommand` to run our own bundling step was tried next, but that pulls in an unrelated Vercel assumption — with no framework detected and a custom build command, Vercel expects the build to also produce a static site and looks for its output (`Output Directory named "public"`), which this project has no use for at all. Committing the already-bundled artifact sidesteps every one of these: there's no build step for Vercel to misconfigure or second-guess, just one self-contained file.

**How to regenerate it.** `npm run vercel-build` (`scripts/build-vercel-function.mjs`) pre-bundles `src/vercelHandler.ts` with esbuild into `api/index.js` — both datasets inlined directly, `fastify` and `exceljs` kept as normal external imports resolved from `node_modules` at runtime (both are real `package.json` "dependencies", not "devDependencies" — Vercel's `npm install` must see them), zero remaining cross-file imports left for anything else to resolve. **Run this and commit the result whenever you change `src/createApp.ts`, `src/dataStore.ts`, `src/postOfficeStore.ts`, `src/csv.ts`, `src/xlsxBuilder.ts`, `src/types.ts`, `src/vercelHandler.ts`, `data/snapshot.json`, or `data/post-offices.json`** — `api/index.js` is a real build artifact, not auto-generated at deploy time.

How the handler itself works: it builds the same Fastify app as local dev (see Architecture above) and hands each request to it via `app.server.emit("request", req, res)` — the standard pattern for running Fastify under a platform that supplies its own HTTP server rather than letting Fastify own one. Verify this end-to-end anytime with `npm run test:vercel-handler`, which rebuilds the bundle and then drives the *exact* resulting artifact — including the new `/v1/pincodes/all`, `/v1/post-offices`, and `/v1/export/*` routes, and specifically `exceljs` resolving correctly as an external dependency in the bundled context, not just under `tsx` — through a plain Node `http.Server`, the same way Vercel's runtime would. No Vercel CLI or account needed to catch a regression here before pushing.

Cold starts: ~17MB of bundled dataset JSON is parsed once per cold start, then reused across warm invocations via the module-scope cache in `src/vercelHandler.ts` — see "Performance" above for the measured breakdown and the reasoning behind every size/caching tradeoff in this section.

### Anywhere else (long-running process)

`npm run typecheck` checks types; there's no compile step to run since `src/server.ts` is executed directly via `tsx` in both `dev` and `start`. Ship the repo (including `data/snapshot.json` **and** `data/post-offices.json`) and run `npm ci && npm start` behind a process manager (systemd, pm2, a container) with `PORT` set.

### Suggested next steps for production

1. **Curated overrides file** — a small hand-maintained JSON checked before the automated pipeline result, for any city you spot-check and find wrong, or high-traffic pincodes. Cheap, high-leverage.
2. **Switch State/District to data.gov.in** once you have an API key, since it's the actual authoritative source rather than GeoNames' derived copy — this would also unlock `officeType`/`delivery`/`division`/`region`/`circle` for Dataset 2 (see "Two datasets" above).
3. **Extend `DISTRICT_NAME_TO_LGD_ALIAS`** with more metro spelling/naming mismatches as you find them (Ahmedabad/Ahmadabad is a known one).
4. **Feedback loop** — log `citySource`/`cityDistanceKm`/`statutoryLocalBody` per request (or add a "report wrong city" endpoint) to find real-world misses.
5. **Postgres + PostGIS** if you also want geo endpoints (nearest pincode to a lat/lng, radius search) as first-class API features rather than just exact lookup.
6. **True per-locality city resolution for Dataset 2** — currently every post office sharing a pincode inherits that pincode's single resolved city (see "Two datasets" above). Where the source data genuinely distinguishes localities within one pincode, running the resolution pipeline per-locality instead of per-pincode-centroid would recover that distinction — a real expansion of `build-snapshot.ts`'s logic, not a small change.
7. **Object storage for exports** if `exports/*.xlsx` need public, unauthenticated download links independent of the API (e.g. a data-portal page) — Vercel Blob storage, S3, or a GitHub Release asset are all reasonable; simpler than trying to serve large static files through the Node function.
