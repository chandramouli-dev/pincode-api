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

## Quick start

```bash
npm install
npm run refresh-data   # downloads source data + builds data/snapshot.json (~1-2 min, needs the `7z` CLI -- see Data sources)
npm run dev            # starts the API on http://localhost:3000
npm test                # smoke-tests a handful of known pincodes (BASE_URL env to override)
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

- [GeoNames postal code export](https://download.geonames.org/export/zip/IN.zip) — Pincode → place name, state, district, sub-district (taluk), lat/lng. GeoNames' own India-Post-derived dataset; closest thing to an official, no-API-key bulk-downloadable Pincode → State/District source.
- [GeoNames gazetteer export](https://download.geonames.org/export/dump/IN.zip) — every named place in India with coordinates + population, used as the Tier 2 candidate pool.
- [LGD Urban Local Body directory](https://ramseraph.github.io/opendata/lgd/) — every India place with independent statutory urban local body status, sourced from the Ministry of Panchayati Raj's [Local Government Directory](https://lgdirectory.gov.in/) and re-published as daily CSV dumps by `ramSeraph/opendata`. This is Tier 1 ground truth. Licensed under the [Government Open Data License – India](https://data.gov.in/sites/default/files/Gazette_Notification_OGDL.pdf). Distributed as `.7z` — extraction requires the `7z` CLI (`brew install p7zip` / `apt install p7zip-full`).

GeoNames data is published under **CC BY 4.0** — attribution required if you redistribute derived data.

Refresh periodically (`npm run refresh-data`) — GeoNames updates continuously and LGD publishes daily.

### Data providers we deliberately did not use

- **`api.postalpincode.in`** — free, no key, but no bulk export and no `City` field (confirmed by inspection); fine as a live secondary lookup, not as the primary data source.
- **`data.gov.in`'s official pincode directory CSV** — the actual authoritative India Post source, but direct download is blocked for non-browser requests and the API requires a free registered key (`api.data.gov.in`). Worth switching to as the State/District source of truth if you register a key.
- **Random GitHub "pincode with city" datasets** — several exist (e.g. `dpnkrpl/indian-pincodes-database`) and do carry a `City` column, but spot-checking them against known pincodes turned up wrong answers (e.g. pincode 799001, Agartala's own GPO, mapped to a different town) with no documented provenance.

## Architecture

- **In-memory serving** (`src/dataStore.ts`): ~19k pincodes / ~6MB JSON, imported directly into the module (not read from disk at runtime — see below) and served straight from a `Map`, no database round trip per request.
- **Offline pipeline** (`scripts/fetch-data.ts` → `scripts/build-snapshot.ts`): all resolution work (both tiers) happens at build time, not per-request. Re-run on a schedule and redeploy `data/snapshot.json`.
- **Route definitions** (`src/createApp.ts`): a `buildApp()` factory that configures a Fastify instance and returns it *without* calling `.listen()`, so the exact same routes work in two different runtimes:
  - **`src/server.ts`** — calls `.listen()`, for local dev (`npm run dev`) and any environment where you own the long-running process (a VM, container, etc).
  - **`src/vercelHandler.ts`** — wraps the same app for Vercel (see Deployment below); no `.listen()`, Vercel's Node runtime owns the HTTP server instead. This file is *source*, not what's deployed directly — see Deployment for why.

`data/snapshot.json` is imported (`import snapshotJson from "../data/snapshot.json" with { type: "json" }`) rather than read via `fs.readFileSync`, specifically so it gets bundled directly into the built output in every runtime — no filesystem path assumptions that could quietly break between a local server and a serverless function's filesystem layout.

## Deployment

### Vercel (serverless)

1. Push this repo to GitHub (see below).
2. On [vercel.com](https://vercel.com), **Add New → Project → Import** the GitHub repo. No configuration needed — no build command, no framework preset, nothing to set. `vercel.json` just rewrites every path to `api/index.js`, which is committed directly (see below), so Vercel's zero-config Node.js detection has exactly one plain, already-bundled file to deploy.
3. Vercel deploys automatically on every push to the default branch from then on.

**Why `api/index.js` is committed instead of built by Vercel.** Vercel's default Node.js builder transpiles each `.ts` file in a project individually rather than bundling — handing it a multi-file `src/` tree to resolve on its own produced three straight rounds of confusing runtime failures during this project's actual deployment (`Cannot find module '.../src/app.ts'`, then `Cannot find module '.../src/dataStore'`, then `Invalid export found in module '.../src/app.js'`). Configuring a custom `buildCommand` to run our own bundling step was tried next, but that pulls in an unrelated Vercel assumption — with no framework detected and a custom build command, Vercel expects the build to also produce a static site and looks for its output (`Output Directory named "public"`), which this project has no use for at all. Committing the already-bundled artifact sidesteps every one of these: there's no build step for Vercel to misconfigure or second-guess, just one self-contained file.

**How to regenerate it.** `npm run vercel-build` (`scripts/build-vercel-function.mjs`) pre-bundles `src/vercelHandler.ts` with esbuild into `api/index.js` — the dataset inlined directly, `fastify` kept as a normal external import resolved from `node_modules` at runtime, zero remaining cross-file imports left for anything else to resolve. **Run this and commit the result whenever you change `src/createApp.ts`, `src/dataStore.ts`, `src/types.ts`, `src/vercelHandler.ts`, or `data/snapshot.json`** — `api/index.js` is a real build artifact, not auto-generated at deploy time.

How the handler itself works: it builds the same Fastify app as local dev (see Architecture above) and hands each request to it via `app.server.emit("request", req, res)` — the standard pattern for running Fastify under a platform that supplies its own HTTP server rather than letting Fastify own one. Verify this end-to-end anytime with `npm run test:vercel-handler`, which rebuilds the bundle and then drives the *exact* resulting artifact through a plain Node `http.Server`, the same way Vercel's runtime would — no Vercel CLI or account needed to catch a regression here before pushing.

Cold starts: the ~6MB dataset is bundled into the function and parsed once per cold start (a few hundred ms), then reused across warm invocations via the module-scope cache in `src/vercelHandler.ts`.

### Anywhere else (long-running process)

`npm run typecheck` checks types; there's no compile step to run since `src/server.ts` is executed directly via `tsx` in both `dev` and `start`. Ship the repo (including `data/snapshot.json`) and run `npm ci && npm start` behind a process manager (systemd, pm2, a container) with `PORT` set.

### Suggested next steps for production

1. **Curated overrides file** — a small hand-maintained JSON checked before the automated pipeline result, for any city you spot-check and find wrong, or high-traffic pincodes. Cheap, high-leverage.
2. **Switch State/District to data.gov.in** once you have an API key, since it's the actual authoritative source rather than GeoNames' derived copy.
3. **Extend `DISTRICT_NAME_TO_LGD_ALIAS`** with more metro spelling/naming mismatches as you find them (Ahmedabad/Ahmadabad is a known one).
4. **Feedback loop** — log `citySource`/`cityDistanceKm`/`statutoryLocalBody` per request (or add a "report wrong city" endpoint) to find real-world misses.
5. **Postgres + PostGIS** if you also want geo endpoints (nearest pincode to a lat/lng, radius search) as first-class API features rather than just exact lookup.
