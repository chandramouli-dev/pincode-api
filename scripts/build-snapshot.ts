/**
 * Builds data/snapshot.json — the compact, in-memory-ready dataset the API
 * serves from — out of the three raw files fetched by fetch-data.ts.
 *
 * State + District come straight from the postal-code file (GeoNames' own
 * India Post derived dataset): reliable, no resolution needed.
 *
 * Two-tier city resolution (see types.ts for the full rationale):
 *
 *   Tier 1 - statutoryLocalBody: the postal locality's actual LGD Urban
 *   Local Body classification (Municipal Corporation / Municipality / Town
 *   Panchayat), joined in by buildLgdIndex()/resolveStatutoryLocalBody()
 *   below. `null` if the locality isn't in the LGD directory at all (i.e.
 *   it's a village/Census Town, not an independent statutory body). This
 *   is NEVER overridden or rolled up — ground truth for jurisdiction.
 *
 *   Tier 2 - city/citySource/cityDistanceKm: a form-friendly rollup,
 *   resolved cheapest/most-confident-first:
 *
 *     lgd-self       The locality's own LGD entry is already a
 *                     Corporation/Municipality -- no rollup needed.
 *     lgd-taluk-hq    The locality is a smaller Town Panchayat (or has no
 *                     LGD entry at all) -- rolled up to its Taluk/Tehsil
 *                     HQ, which the LGD directory confirms is itself a
 *                     Corporation/Municipality.
 *     exact-match     [fallback, no confident LGD rollup available] a
 *                     populated place shares its name with the pincode's
 *                     district and sits within 5km of the pincode
 *                     centroid (covers metro/city-districts: Mumbai,
 *                     Bengaluru, Chennai, Kolkata, ...).
 *     name-match      [fallback] a populated place's name matches the
 *                     district or sub-district within a wider radius.
 *     nearest-place    [fallback] gravity-scored nearest populated place
 *                     (population / distance^1.5) so a nearby big town
 *                     outranks a slightly-closer hamlet.
 *     district-fallback No populated place found within range -> city =
 *                     district name, flagged low-confidence.
 *
 * Every record carries `citySource` + `cityDistanceKm` so API consumers
 * (and you, monitoring this in prod) can see how confident the city guess
 * is instead of it being a silent black box.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PincodeRecord, Snapshot, CitySource, StatutoryLocalBody, LocalBodyClassification } from "../src/types";

const RAW_DIR = path.resolve(import.meta.dirname, "..", "data", "raw");
const OUT_PATH = path.resolve(import.meta.dirname, "..", "data", "snapshot.json");

const POSTAL_FILE = path.join(RAW_DIR, "postal-codes.txt");
const GAZETTEER_FILE = path.join(RAW_DIR, "gazetteer.txt");
const LGD_URBAN_FILE = path.join(RAW_DIR, "urban-local-bodies.csv");

// Feature codes worth considering as a "city/town" for resolution.
// Excludes: PPLQ (abandoned), PPLX (section/neighbourhood of a place),
// PPLF (farm village), PPLR (religious settlement), PPLS/PPLW/PPLH (spot /
// destroyed / historical) -- these are too granular or defunct to be a
// useful "city" answer.
const CITY_FEATURE_CODES = new Set([
  "PPLC", // capital
  "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLA5", // administrative seats
  "PPL",  // populated place
  "PPLL", // small populated place
]);

const EXACT_MATCH_RADIUS_KM = 5;
const NAME_MATCH_RADIUS_KM = 25;
const DISTRICT_SEARCH_RADIUS_KM = 60; // beyond this, treat as "not found"
const GRAVITY_DISTANCE_FLOOR_KM = 3; // see comment at the gravity score below

interface PostalRow {
  pincode: string;
  place: string;
  state: string;
  admin1Code: string;
  district: string;
  admin2Code: string;
  subDistrict: string;
  lat: number;
  lng: number;
}

interface GazetteerPlace {
  name: string;
  lat: number;
  lng: number;
  population: number;
}

// Spatial grid for candidate lookup. NOTE: we deliberately do NOT bucket by
// admin1/admin2 code. GeoNames' postal-code file and gazetteer file don't
// reliably share district codes for the same place (e.g. Bengaluru pincodes
// carry district code 583, which the gazetteer maps to "Bangalore Rural" --
// not the city point, which lives under a different code; Mumbai's city
// point carries no district code at all). Bucketing by code silently
// dropped the correct city as a candidate. Geography doesn't lie: a plain
// lat/lng grid + haversine distance is slower but correct.
const GRID_CELL_DEG = 0.5;
const GRID_SEARCH_OFFSET = 2; // scan a 5x5 block of cells (~2.5 cells ~137km half-width), safely covering DISTRICT_SEARCH_RADIUS_KM

function gridKey(lat: number, lng: number): string {
  return `${Math.floor(lat / GRID_CELL_DEG)}|${Math.floor(lng / GRID_CELL_DEG)}`;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// The postal file uses literal "NA" / "Nil" as placeholder text for a
// missing sub-district (8,036 and 578 rows respectively) rather than
// leaving the column blank. Left unfiltered, "NA" was showing up as a real
// subDistrict value in API responses and could even be matched against by
// the name-match tier.
function normalizeMissing(value: string): string {
  const v = value.trim();
  return /^(na|n\.a\.?|nil)$/i.test(v) ? "" : v;
}

function readPostalRows(): PostalRow[] {
  const text = readFileSync(POSTAL_FILE, "utf8");
  const rows: PostalRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const [, pincode, place, state, admin1Code, district, admin2Code, subDistrict, , lat, lng] = cols;
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (!pincode || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) continue;
    rows.push({
      pincode: pincode.trim(),
      place: normalizeMissing(place ?? ""),
      state: (state ?? "").trim(),
      admin1Code: (admin1Code ?? "").trim(),
      district: (district ?? "").trim(),
      admin2Code: (admin2Code ?? "").trim(),
      subDistrict: normalizeMissing(subDistrict ?? ""),
      lat: latNum,
      lng: lngNum,
    });
  }
  return rows;
}

function readGazetteerPlaces(): GazetteerPlace[] {
  const text = readFileSync(GAZETTEER_FILE, "utf8");
  const places: GazetteerPlace[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const featureClass = cols[6];
    const featureCode = cols[7];
    if (featureClass !== "P" || !CITY_FEATURE_CODES.has(featureCode)) continue;
    const name = cols[1];
    const lat = Number(cols[4]);
    const lng = Number(cols[5]);
    const population = Number(cols[14]) || 0;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    places.push({ name, lat, lng, population });
  }
  return places;
}

// --- LGD Urban Local Body directory (Tier 1 source) ---------------------

interface LgdEntry {
  name: string;
  classification: LocalBodyClassification;
  lgdCode: number;
}

// The two datasets spell a handful of states/UTs differently. Postal file
// spelling -> LGD spelling. (Lakshadweep has no entry in the LGD urban
// directory at all -- it has no independent statutory towns -- so it's
// deliberately absent here; SLB will correctly resolve to null there.)
const STATE_NAME_TO_LGD: Record<string, string> = {
  "Andaman & Nicobar Islands": "Andaman And Nicobar Islands",
  "Dadra and Nagar Haveli and Daman and Diu": "The Dadra And Nagar Haveli And Daman And Diu",
  "Jammu & Kashmir": "Jammu And Kashmir",
  Pondicherry: "Puducherry",
};

// A handful of the biggest metro corporations are registered in LGD under
// a name with zero textual overlap with the district/city name everyone
// actually uses -- no amount of suffix-stripping recovers these, they're
// just genuine aliases. Keyed by district name (postal file spelling).
// Known gaps NOT covered here (real, just not chased down): spelling
// variants like "Ahmedabad" (postal file) vs "Ahmadabad" (LGD), and
// merged twin-city corporations like "Kalyan-Dombivli"/"Hubballi-Dharwad"
// that only match if the district field happens to use the same
// hyphenated compound name. Extend this table as you find more.
const DISTRICT_NAME_TO_LGD_ALIAS: Record<string, string> = {
  Bengaluru: "Bbmp", // LGD's actual registered name for Bruhat Bengaluru Mahanagara Palike
};

// LGD corporation names are frequently decorated with a title that isn't
// part of the place name itself ("Greater Mumbai", "Greater Chennai
// Corporation", "Kalaburagi City Corporation", "City Corporation Panaji").
// Stripped down, these line up with the plain district/city name. Applied
// as a fallback lookup key, never the primary one, so it can only add
// matches, not silently relabel something a plain name already resolved.
function stripLgdCorporateTitle(name: string): string {
  return name
    .replace(/^City Corporation\s+/i, "")
    .replace(/\s+(Municipal Corporation|Municipal Co-?operation|City Corporation|Corporation)\s*$/i, "")
    .replace(/^Greater\s+/i, "")
    .trim();
}

// Tier 1 (statutoryLocalBody.name) intentionally keeps the exact LGD legal
// name -- that's the point, it's the record of jurisdiction. Tier 2
// (city) exists purely so a form/checkout field shows something a person
// recognizes, so it needs the clean form: "Greater Chennai Corporation" ->
// "Chennai", "Agartala Municipal Corporation" -> "Agartala", and the one
// case stripping can't reach, "Bbmp" -> "Bengaluru" (via the alias table,
// reversed).
function displayCityName(lgdName: string): string {
  const reverseAlias = Object.entries(DISTRICT_NAME_TO_LGD_ALIAS).find(([, aliasTarget]) => aliasTarget === lgdName)?.[0];
  return reverseAlias ?? stripLgdCorporateTitle(lgdName);
}

// LGD's "Localbody Type Code" is not a single clean national enum -- it
// carries some state-specific grade codes (e.g. Karnataka's City/Town
// Municipal Council tiers, Haryana's Municipal Committee tier). This
// mapping is a best-effort classification validated against known
// examples (see README "Local body classification mapping" for the
// worked cross-checks): 4 = Corporation confirmed via Greater Mumbai,
// Coimbatore, Greater Chennai, Hyderabad, Kolkata, and the three Delhi
// Municipal Corporations; 5 = Municipality confirmed via Palani (TN) and
// others; 7 = Town/Nagar Panchayat confirmed via Balasamudram (TN). Codes
// 6/21/24/25 are state-specific council tiers that still carry
// independent elected municipal governance (not village panchayats), so
// they're bucketed as "Municipality" -- self-sufficient, no Taluk-HQ
// rollup needed. If you find a misclassified place, this table is the
// place to add a correction.
const LGD_TYPE_CLASSIFICATION: Record<number, LocalBodyClassification> = {
  4: "Municipal Corporation",
  5: "Municipality",
  6: "Municipality", // Haryana Municipal Committee tier
  7: "Town Panchayat",
  21: "Municipality", // New Delhi Municipal Council (unique, self-sufficient)
  24: "Municipality", // Karnataka City Municipal Council
  25: "Municipality", // Karnataka Town Municipal Council
};

/** Minimal CSV line parser that respects double-quoted fields containing
 *  commas (e.g. `"Nagar Palika, Nainpur"`) -- a plain String.split(",")
 *  would silently misalign columns on those rows. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

// Strips postal-file-specific noise so locality names line up with LGD's
// clean names: trailing office-type tags ("Kochi H.O" -> "Kochi") and
// trailing disambiguating parentheticals ("Balasamudram (Dindigul)" ->
// "Balasamudram").
function normalizeLocalityName(raw: string): string {
  return raw
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\b(G\.?P\.?O\.?|H\.?O\.?|S\.?O\.?|B\.?O\.?)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function lgdIndexKey(state: string, name: string): string {
  return `${state.trim().toLowerCase()}|${normalizeLocalityName(name)}`;
}

function readLgdUrbanLocalBodies(): Array<{ state: string; entry: LgdEntry }> {
  const text = readFileSync(LGD_URBAN_FILE, "utf8");
  const lines = text.split("\n");
  const out: Array<{ state: string; entry: LgdEntry }> = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    const state = (cols[2] ?? "").trim();
    const lgdCode = Number(cols[3]);
    const name = (cols[5] ?? "").trim();
    const typeCode = Number(cols[7]);
    if (!state || !name || !Number.isFinite(lgdCode)) continue;
    const classification = LGD_TYPE_CLASSIFICATION[typeCode];
    if (!classification) continue; // unmapped type code -- skip rather than guess
    out.push({ state, entry: { name, classification, lgdCode } });
  }
  return out;
}

const LGD_CLASSIFICATION_RANK: Record<LocalBodyClassification, number> = {
  "Municipal Corporation": 3,
  Municipality: 2,
  "Town Panchayat": 1,
};

function insertRanked(index: Map<string, LgdEntry>, key: string, entry: LgdEntry) {
  const existing = index.get(key);
  if (!existing || LGD_CLASSIFICATION_RANK[entry.classification] > LGD_CLASSIFICATION_RANK[existing.classification]) {
    index.set(key, entry);
  }
}

interface LgdIndexes {
  exact: Map<string, LgdEntry>;
  // Secondary lookup on the corporate title stripped from the LGD name
  // ("Greater Mumbai" -> "mumbai"). Only consulted when the exact index
  // misses -- see lookupLgd() -- so it can only add matches, never
  // override a direct one.
  core: Map<string, LgdEntry>;
}

/** Keyed by "<lgd state, lowercased>|<normalized locality name>". On a
 *  collision (rare -- e.g. two differently-graded bodies sharing a name in
 *  the same state) keeps whichever has the higher-authority classification,
 *  since that's the safer guess. */
function buildLgdIndex(rows: Array<{ state: string; entry: LgdEntry }>): LgdIndexes {
  const exact = new Map<string, LgdEntry>();
  const core = new Map<string, LgdEntry>();
  for (const { state, entry } of rows) {
    insertRanked(exact, lgdIndexKey(state, entry.name), entry);
    const coreName = stripLgdCorporateTitle(entry.name);
    if (coreName.toLowerCase() !== entry.name.toLowerCase()) {
      insertRanked(core, lgdIndexKey(state, coreName), entry);
    }
  }
  return { exact, core };
}

/** Exact-name match first; falls back to the corporate-title-stripped
 *  index, then to the district-name alias table (for cases stripping
 *  can't fix, e.g. "Bengaluru" -> "Bbmp"). */
function lookupLgd(indexes: LgdIndexes, state: string, name: string): LgdEntry | undefined {
  return (
    indexes.exact.get(lgdIndexKey(state, name)) ??
    indexes.core.get(lgdIndexKey(state, name)) ??
    (DISTRICT_NAME_TO_LGD_ALIAS[name] ? indexes.exact.get(lgdIndexKey(state, DISTRICT_NAME_TO_LGD_ALIAS[name])) : undefined)
  );
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function candidatesNear(grid: Map<string, GazetteerPlace[]>, lat: number, lng: number): GazetteerPlace[] {
  const cellLat = Math.floor(lat / GRID_CELL_DEG);
  const cellLng = Math.floor(lng / GRID_CELL_DEG);
  const out: GazetteerPlace[] = [];
  for (let dLat = -GRID_SEARCH_OFFSET; dLat <= GRID_SEARCH_OFFSET; dLat++) {
    for (let dLng = -GRID_SEARCH_OFFSET; dLng <= GRID_SEARCH_OFFSET; dLng++) {
      const bucket = grid.get(`${cellLat + dLat}|${cellLng + dLng}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

function resolveCity(
  district: string,
  subDistrict: string | null,
  centroidLat: number,
  centroidLng: number,
  candidates: GazetteerPlace[],
): { city: string; source: CitySource; distanceKm: number | null } {
  // Tier 1: a place with the same name as the district, very close by ->
  // the district *is* the city (this is how Indian metro/city-districts
  // work: Mumbai, Bengaluru, Chennai, Kolkata, Hyderabad district == city).
  let best: { place: GazetteerPlace; distance: number } | null = null;
  for (const c of candidates) {
    const d = haversineKm(centroidLat, centroidLng, c.lat, c.lng);
    if (c.name.toLowerCase() === district.toLowerCase() && d <= EXACT_MATCH_RADIUS_KM) {
      if (!best || d < best.distance) best = { place: c, distance: d };
    }
  }
  if (best) {
    return { city: best.place.name, source: "exact-match", distanceKm: Math.round(best.distance * 10) / 10 };
  }

  // Tier 2: name match against district OR sub-district (taluk) within a
  // wider radius. Many Indian pincodes only have an *estimated* centroid
  // in the postal-code file (see readme.txt), so pure nearest-neighbor can
  // pick a geometrically-closer-but-wrong place over the actually-correct
  // one; a name match is strong enough evidence to trust past 5km even
  // when the geocoded point is noisy (e.g. pincode 682001's centroid sits
  // ~19km from the real "Kochi" point, but its sub-district IS "Kochi").
  const names = [district, subDistrict].filter((n): n is string => Boolean(n)).map((n) => n.toLowerCase());
  let nameMatch: { place: GazetteerPlace; distance: number } | null = null;
  for (const c of candidates) {
    if (!names.includes(c.name.toLowerCase())) continue;
    const d = haversineKm(centroidLat, centroidLng, c.lat, c.lng);
    if (d <= NAME_MATCH_RADIUS_KM && (!nameMatch || d < nameMatch.distance)) {
      nameMatch = { place: c, distance: d };
    }
  }
  if (nameMatch) {
    return { city: nameMatch.place.name, source: "name-match", distanceKm: Math.round(nameMatch.distance * 10) / 10 };
  }

  // Tier 3: gravity-scored nearest place (population pulls the choice
  // toward the nearby town people would actually recognise, not just the
  // literal closest dot on the map). GRAVITY_DISTANCE_FLOOR_KM matters more
  // than it looks: some pincode centroids in the source data coincide
  // almost exactly (~0km) with an obscure hamlet that happens to share its
  // name with the post office locality (e.g. pincode 624610's centroid
  // sits exactly on "Balasamudram", pop. 14k, while the actual well-known
  // town "Palani", pop. 70k, is 4.2km away). A distance floor of 1 lets
  // that 0km hamlet's score blow up and beat a 5x-larger town nearby; a
  // floor of 3 requires a genuinely dominant population to win at close
  // range, without materially changing comparisons past a few km.
  let bestScore = -1;
  let bestPlace: GazetteerPlace | null = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = haversineKm(centroidLat, centroidLng, c.lat, c.lng);
    if (d > DISTRICT_SEARCH_RADIUS_KM) continue;
    const score = (c.population + 500) / (d + GRAVITY_DISTANCE_FLOOR_KM) ** 1.5;
    if (score > bestScore) {
      bestScore = score;
      bestPlace = c;
      bestDistance = d;
    }
  }
  if (bestPlace) {
    return { city: bestPlace.name, source: "nearest-place", distanceKm: Math.round(bestDistance * 10) / 10 };
  }

  // Tier 3: nothing nearby in the gazetteer -> fall back to district name,
  // clearly flagged so API consumers know this is a low-confidence guess.
  return { city: district, source: "district-fallback", distanceKm: null };
}

/** Tier 1: look up the pincode's own postal localities in the LGD index.
 *  Checked in the order the postal file lists them (usually head office
 *  first); the first hit wins. Returns null if none of this pincode's
 *  localities carry independent LGD Urban Local Body status -- i.e. it's
 *  a village/Census Town, not a statutory town.
 *
 *  Deliberately NOT falling back to the district name here, even though
 *  that would recover a lot of big-metro nulls (Mumbai/Chennai/Bengaluru
 *  sub-area pincodes whose post office names are neighbourhoods, not the
 *  corporation's own name). A district is a revenue unit that can contain
 *  several *separate* local bodies (Dindigul district alone contains
 *  Dindigul Corporation, Palani Municipality, and Balasamudram Town
 *  Panchayat as three independent bodies) -- assuming "district name
 *  matches a Corporation somewhere" means "this specific locality is
 *  governed by it" would silently reintroduce the exact
 *  jurisdiction-conflation bug this two-tier design exists to avoid, just
 *  one level up. Tier 2's district-name fallback (resolveCity's
 *  exact-match) already recovers the right *display* city for those metro
 *  cases geometrically; Tier 1 stays null rather than guess.
 */
function resolveStatutoryLocalBody(indexes: LgdIndexes, lgdState: string, localityNames: string[]): StatutoryLocalBody | null {
  for (const raw of localityNames) {
    const entry = lookupLgd(indexes, lgdState, raw);
    if (entry) return { name: entry.name, classification: entry.classification, lgdCode: entry.lgdCode };
  }
  return null;
}

// Sanity cap for lgd-taluk-hq rollups (see resolveLgdRollup). The postal
// file's sub-district field is NOT reliably "the taluk" -- e.g. pincode
// 624610's only usable sub-district value is literally "Dindigul" (the
// district HQ, 62km away), when the pincode's real taluk HQ is Palani,
// 4.2km away. Trusting that field blindly once regressed this exact case.
// A plausible-looking-but-wrong administrative name is worse than no
// rollup at all, so lgd-taluk-hq is only accepted if the resolved HQ can
// be found in the gazetteer within this radius of the pincode's own
// centroid -- otherwise we fall through to resolveCity()'s geometry-based
// resolution (R2.3), which has no such blind spot.
const TALUK_HQ_SANITY_RADIUS_KM = 50;

/** Tier 2, LGD-driven step (R2.1/R2.2 from the two-tier ruleset): if the
 *  pincode's own locality is already Corporation/Municipality grade, no
 *  rollup is needed. Otherwise -- it's a Town Panchayat, or has no LGD
 *  entry at all -- try rolling up to its Taluk/Tehsil HQ, but only if (a)
 *  the LGD directory confirms that HQ is *itself* Corporation/Municipality
 *  grade (never roll up to another Town Panchayat -- not a confidence
 *  improvement over the locality itself), AND (b) geography backs up the
 *  claim (see TALUK_HQ_SANITY_RADIUS_KM). Returns null if neither applies,
 *  signalling the caller to fall back to resolveCity().
 */
function resolveLgdRollup(
  indexes: LgdIndexes,
  lgdState: string,
  slb: StatutoryLocalBody | null,
  subDistrict: string | null,
  centroidLat: number,
  centroidLng: number,
  candidates: GazetteerPlace[],
): { city: string; source: CitySource; distanceKm: number } | null {
  if (slb && slb.classification !== "Town Panchayat") {
    return { city: displayCityName(slb.name), source: "lgd-self", distanceKm: 0 };
  }
  if (subDistrict) {
    const hq = lookupLgd(indexes, lgdState, subDistrict);
    if (hq && hq.classification !== "Town Panchayat") {
      // Search the gazetteer by the clean display name, not the raw LGD
      // name -- GeoNames has "Chennai", never "Greater Chennai Corporation".
      const hqDisplayName = displayCityName(hq.name);
      let nearest: { distance: number } | null = null;
      for (const c of candidates) {
        if (c.name.toLowerCase() !== hqDisplayName.toLowerCase()) continue;
        const d = haversineKm(centroidLat, centroidLng, c.lat, c.lng);
        if (!nearest || d < nearest.distance) nearest = { distance: d };
      }
      if (nearest && nearest.distance <= TALUK_HQ_SANITY_RADIUS_KM) {
        return { city: hqDisplayName, source: "lgd-taluk-hq", distanceKm: Math.round(nearest.distance * 10) / 10 };
      }
    }
  }
  return null;
}

function main() {
  console.log("Reading postal codes ...");
  const postalRows = readPostalRows();
  console.log(`  ${postalRows.length} rows`);

  console.log("Reading gazetteer ...");
  const places = readGazetteerPlaces();
  console.log(`  ${places.length} candidate places`);

  console.log("Reading LGD urban local body directory ...");
  const lgdRows = readLgdUrbanLocalBodies();
  const lgdIndexes = buildLgdIndex(lgdRows);
  console.log(`  ${lgdRows.length} urban local bodies (${lgdIndexes.exact.size} exact keys, ${lgdIndexes.core.size} corporate-title-stripped keys)`);

  // Index gazetteer places on a lat/lng grid (see candidatesNear/gridKey
  // comment above for why we don't bucket by admin code instead).
  const grid = new Map<string, GazetteerPlace[]>();
  for (const p of places) {
    const key = gridKey(p.lat, p.lng);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(p);
  }

  // Group postal rows by pincode.
  const byPincode = new Map<string, PostalRow[]>();
  for (const row of postalRows) {
    if (!byPincode.has(row.pincode)) byPincode.set(row.pincode, []);
    byPincode.get(row.pincode)!.push(row);
  }

  console.log(`Resolving city for ${byPincode.size} pincodes ...`);
  const records: PincodeRecord[] = [];
  const sourceCounts: Record<CitySource, number> = {
    "lgd-self": 0,
    "lgd-taluk-hq": 0,
    "exact-match": 0,
    "name-match": 0,
    "nearest-place": 0,
    "district-fallback": 0,
  };
  const slbCounts: Record<LocalBodyClassification, number> = {
    "Municipal Corporation": 0,
    Municipality: 0,
    "Town Panchayat": 0,
  };
  let slbNullCount = 0;

  for (const [pincode, rows] of byPincode) {
    const state = mostCommon(rows.map((r) => r.state));
    const district = mostCommon(rows.map((r) => r.district));
    const subDistricts = [...new Set(rows.map((r) => r.subDistrict).filter(Boolean))];
    const subDistrict = subDistricts[0] ?? null;
    const lat = rows.reduce((s, r) => s + r.lat, 0) / rows.length;
    const lng = rows.reduce((s, r) => s + r.lng, 0) / rows.length;
    const localities = [...new Set(rows.map((r) => r.place).filter(Boolean))].sort();

    const lgdState = STATE_NAME_TO_LGD[state] ?? state;
    const slb = resolveStatutoryLocalBody(
      lgdIndexes,
      lgdState,
      rows.map((r) => r.place).filter(Boolean),
    );
    if (slb) slbCounts[slb.classification]++;
    else slbNullCount++;

    let citySource: CitySource;
    let city: string;
    let cityDistanceKm: number | null;

    const candidates = candidatesNear(grid, lat, lng);
    const rollup = resolveLgdRollup(lgdIndexes, lgdState, slb, subDistrict, lat, lng, candidates);
    if (rollup) {
      citySource = rollup.source;
      city = rollup.city;
      cityDistanceKm = rollup.distanceKm;
    } else {
      const resolved = resolveCity(district, subDistrict, lat, lng, candidates);
      citySource = resolved.source;
      city = resolved.city;
      cityDistanceKm = resolved.distanceKm;
    }
    sourceCounts[citySource]++;

    records.push({
      pincode,
      state,
      district,
      subDistrict,
      statutoryLocalBody: slb,
      city,
      citySource,
      cityDistanceKm,
      latitude: Math.round(lat * 10000) / 10000,
      longitude: Math.round(lng * 10000) / 10000,
      localities,
    });
  }

  records.sort((a, b) => a.pincode.localeCompare(b.pincode));

  const snapshot: Snapshot = {
    meta: {
      generatedAt: new Date().toISOString(),
      pincodeCount: records.length,
      sources: [
        "GeoNames postal code export (CC BY 4.0) - https://download.geonames.org/export/zip/IN.zip",
        "GeoNames gazetteer export (CC BY 4.0) - https://download.geonames.org/export/dump/IN.zip",
        "LGD Urban Local Body directory, via ramSeraph/opendata (Govt Open Data License - India) - https://ramseraph.github.io/opendata/lgd/",
      ],
    },
    records,
  };

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot));

  console.log(`\nWrote ${records.length} records to ${OUT_PATH}`);
  console.log("\nTier 1 (statutoryLocalBody) coverage:");
  for (const [classification, count] of Object.entries(slbCounts)) {
    console.log(`  ${classification}: ${count} (${((count / records.length) * 100).toFixed(1)}%)`);
  }
  console.log(`  null (no independent local body, village/Census Town): ${slbNullCount} (${((slbNullCount / records.length) * 100).toFixed(1)}%)`);
  console.log("\nTier 2 (city) resolution breakdown:");
  for (const [source, count] of Object.entries(sourceCounts)) {
    console.log(`  ${source}: ${count} (${((count / records.length) * 100).toFixed(1)}%)`);
  }
}

main();
