/**
 * Builds data/post-offices.json — one row per individual post office /
 * locality from data/raw/postal-codes.txt, NOT deduplicated by pincode
 * (155,570 rows in, ~155,570 rows out, minus a handful of malformed rows
 * -- see the skip-count logged below).
 *
 * Source: GeoNames postal code export (CC BY 4.0) --
 * https://download.geonames.org/export/zip/IN.zip -- the same file
 * scripts/build-snapshot.ts groups into the pincode-level snapshot. This
 * script reads it WITHOUT grouping, keeping every locality distinct.
 *
 * Columns NOT populated (office_type, delivery, division, region,
 * circle): this data source doesn't carry them at all -- they're specific
 * to the official India Post pincode directory schema (data.gov.in),
 * which this project doesn't currently fetch (direct download is blocked
 * for non-browser requests; the API needs a registered key). Left as
 * explicit null on every row rather than fabricated -- see
 * PostOfficeRecord's doc comment in src/types.ts and README.md's "Full
 * post-office dataset" section for the options to add them later.
 *
 * city: inherited from data/snapshot.json's already-resolved per-pincode
 * Tier 2 city (a join by pincode), NOT re-resolved per locality. Every
 * post office sharing a pincode currently gets the same city -- this is
 * how the existing resolution pipeline works (one centroid per pincode),
 * not a new simplification introduced here. True per-locality resolution
 * would be a real expansion of build-snapshot.ts, documented as a
 * follow-up rather than attempted here.
 *
 * Stored as compact tuples (PostOfficeTuple), not full objects with all
 * 10 field names repeated 155,570 times -- see PostOfficeSnapshot's doc
 * comment in src/types.ts.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Snapshot, PostOfficeSnapshot, PostOfficeTuple } from "../src/types.js";

const RAW_DIR = path.resolve(import.meta.dirname, "..", "data", "raw");
const POSTAL_FILE = path.join(RAW_DIR, "postal-codes.txt");
const SNAPSHOT_PATH = path.resolve(import.meta.dirname, "..", "data", "snapshot.json");
const OUT_PATH = path.resolve(import.meta.dirname, "..", "data", "post-offices.json");

function normalizeMissing(value: string): string {
  const v = value.trim();
  return /^(na|n\.a\.?|nil)$/i.test(v) ? "" : v;
}

function main() {
  console.log("Reading pincode-level snapshot (for city join) ...");
  const snapshot: Snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const cityByPincode = new Map<string, string>();
  for (const r of snapshot.records) cityByPincode.set(r.pincode, r.city);
  console.log(`  ${cityByPincode.size} pincodes with a resolved city`);

  console.log("Reading raw postal codes (post-office granularity) ...");
  const text = readFileSync(POSTAL_FILE, "utf8");
  const lines = text.split("\n");

  const records: PostOfficeTuple[] = [];
  let skipped = 0;
  let withCity = 0;
  let withoutCity = 0;
  const pincodesSeen = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const [, pincode, place, state, , district] = cols;
    const officeName = normalizeMissing(place ?? "");
    const cleanPincode = (pincode ?? "").trim();
    const cleanState = (state ?? "").trim();
    const cleanDistrict = normalizeMissing(district ?? "");

    if (!cleanPincode || !officeName) {
      skipped++;
      continue;
    }

    const city = cityByPincode.get(cleanPincode) ?? "";
    if (city) withCity++;
    else withoutCity++;
    pincodesSeen.add(cleanPincode);

    records.push([officeName, cleanPincode, cleanState, cleanDistrict, city]);
  }

  const out: PostOfficeSnapshot = {
    meta: {
      generatedAt: new Date().toISOString(),
      recordCount: records.length,
      uniquePincodeCount: pincodesSeen.size,
      source: "GeoNames postal code export",
      sourceUrl: "https://download.geonames.org/export/zip/IN.zip",
      downloadDate: statSync(POSTAL_FILE).mtime.toISOString(),
      fieldsNotAvailable: ["officeType", "delivery", "division", "region", "circle"],
      fieldsNotAvailableReason:
        "Not present in the GeoNames postal export (this project's current source). These are official India Post pincode directory fields (data.gov.in) -- that source isn't currently fetched because direct CSV download is blocked for non-browser requests and the API requires a registered key. See README.md 'Full post-office dataset' for the options to add them.",
      cityDerivation:
        "Joined by pincode from data/snapshot.json's already-resolved Tier 2 city (see build-snapshot.ts's two-tier resolution: LGD Urban Local Body join, then a geometric fallback cascade). NOT re-resolved per locality -- every post office sharing a pincode gets that pincode's single resolved city, consistent with how the existing GET /v1/pincode/:code endpoint already works.",
      recordsWithCity: withCity,
      recordsWithoutCity: withoutCity,
    },
    records,
  };

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out));

  console.log(`\nWrote ${records.length} post-office records to ${OUT_PATH}`);
  console.log(`  skipped (missing pincode or office name): ${skipped}`);
  console.log(`  unique pincodes represented: ${pincodesSeen.size}`);
  console.log(`  with city: ${withCity} (${((withCity / records.length) * 100).toFixed(1)}%)`);
  console.log(`  without city: ${withoutCity} (${((withoutCity / records.length) * 100).toFixed(1)}%)`);
}

main();
