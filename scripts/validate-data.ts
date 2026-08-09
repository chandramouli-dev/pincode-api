/**
 * npm run validate:data -- a reporting script, not a pass/fail gate. Per
 * the brief this was built against: "Do NOT automatically fail validation
 * merely because some records have no city. Instead, report the
 * missing-city count clearly." Always exits 0; it's meant to be read, not
 * to break a CI pipeline on data characteristics that are honestly
 * expected (e.g. some post offices legitimately having no clean city
 * match).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Snapshot, PostOfficeSnapshot } from "../src/types.js";

const SNAPSHOT_PATH = path.resolve(import.meta.dirname, "..", "data", "snapshot.json");
const POST_OFFICE_PATH = path.resolve(import.meta.dirname, "..", "data", "post-offices.json");

const PINCODE_RE = /^[1-9][0-9]{5}$/;

function pct(n: number, total: number): string {
  return total === 0 ? "0.0%" : `${((n / total) * 100).toFixed(1)}%`;
}

function line(label: string, value: string | number) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

function main() {
  const snapshot: Snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const postOffices: PostOfficeSnapshot = JSON.parse(readFileSync(POST_OFFICE_PATH, "utf8"));

  // ---------------- UNIQUE PINCODES ----------------
  console.log("\nUNIQUE PINCODES");
  console.log("----------------");
  const pRecords = snapshot.records;
  const pincodeSet = new Set(pRecords.map((r) => r.pincode));
  const invalidPincodes = pRecords.filter((r) => !PINCODE_RE.test(r.pincode));
  const missingState = pRecords.filter((r) => !r.state?.trim());
  const missingDistrict = pRecords.filter((r) => !r.district?.trim());
  const missingCity = pRecords.filter((r) => !r.city?.trim());

  line("Total records", pRecords.length);
  line("Unique pincodes", pincodeSet.size);
  line("Invalid pincodes", invalidPincodes.length);
  line("Missing state", missingState.length);
  line("Missing district", missingDistrict.length);
  line("Missing city", missingCity.length);

  // ---------------- POST OFFICES ----------------
  console.log("\nPOST OFFICES");
  console.log("------------");
  const poRows = postOffices.records; // [officeName, pincode, state, district, city]
  const poPincodeSet = new Set(poRows.map((r) => r[1]));
  const withCity = poRows.filter((r) => r[4]?.trim()).length;
  const withoutCity = poRows.length - withCity;
  const missingPoState = poRows.filter((r) => !r[2]?.trim()).length;
  const missingPoDistrict = poRows.filter((r) => !r[3]?.trim()).length;

  const exactRowCounts = new Map<string, number>();
  for (const r of poRows) {
    const key = r.join("");
    exactRowCounts.set(key, (exactRowCounts.get(key) ?? 0) + 1);
  }
  let duplicateExactRecords = 0;
  for (const count of exactRowCounts.values()) {
    if (count > 1) duplicateExactRecords += count - 1;
  }

  const countByPincode = new Map<string, number>();
  for (const r of poRows) countByPincode.set(r[1], (countByPincode.get(r[1]) ?? 0) + 1);
  const pincodesWithMultiple = [...countByPincode.values()].filter((c) => c > 1).length;

  line("Total records", poRows.length);
  line("Unique pincodes represented", poPincodeSet.size);
  line("Post offices with city", `${withCity} (${pct(withCity, poRows.length)})`);
  line("Post offices without city", `${withoutCity} (${pct(withoutCity, poRows.length)})`);
  line("City coverage percentage", pct(withCity, poRows.length));
  line("Missing state", missingPoState);
  line("Missing district", missingPoDistrict);
  line("Duplicate exact records", duplicateExactRecords);
  line("Pincodes with multiple post offices", `${pincodesWithMultiple} (${pct(pincodesWithMultiple, poPincodeSet.size)} of pincodes)`);

  // ---------------- CITY QUALITY ----------------
  console.log("\nCITY QUALITY");
  console.log("------------");
  const uniqueCities = new Set(poRows.map((r) => r[4]).filter(Boolean));
  const citiesByState = new Map<string, Set<string>>();
  for (const r of poRows) {
    const [, , state, , city] = r;
    if (!city) continue;
    if (!citiesByState.has(state)) citiesByState.set(state, new Set());
    citiesByState.get(state)!.add(city);
  }
  const cityEqualsDistrict = poRows.filter((r) => r[4] && r[4] === r[3]).length;
  const cityEqualsOfficeName = poRows.filter((r) => r[4] && r[4] === r[0]).length;
  const blankCity = poRows.filter((r) => !r[4]?.trim()).length;

  line("Unique cities", uniqueCities.size);
  line("Records where city == district", `${cityEqualsDistrict} (${pct(cityEqualsDistrict, poRows.length)})`);
  line("Records where city == office_name", `${cityEqualsOfficeName} (${pct(cityEqualsOfficeName, poRows.length)})`);
  line("Records with blank city", blankCity);

  console.log("\n  Cities by state (unique city count per state, top 15 by count):");
  const sortedStates = [...citiesByState.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [state, cities] of sortedStates.slice(0, 15)) {
    console.log(`    ${state.padEnd(30)} ${cities.size}`);
  }
  if (sortedStates.length > 15) console.log(`    ... and ${sortedStates.length - 15} more states/UTs`);

  console.log("\nNote: missing-city and low-confidence-city counts are reported, not treated as");
  console.log("failures -- see data/post-offices.json meta.fieldsNotAvailableReason and");
  console.log("README.md 'Full post-office dataset' for what's genuinely unavailable vs. derived.");
}

main();
