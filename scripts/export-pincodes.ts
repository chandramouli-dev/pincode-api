/**
 * npm run export:pincodes -- writes exports/india-pincodes.csv and
 * exports/india-pincodes.xlsx (Pincode, State, District, City -- the
 * Dataset 1 columns). Same column builders as GET /v1/export/pincodes.csv
 * and .xlsx (src/csv.ts, src/xlsxBuilder.ts) -- one definition, used by
 * both the live API and this offline export.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getAllPincodeRecords } from "../src/dataStore.js";
import { buildPincodesCsv } from "../src/csv.js";
import { buildPincodesWorkbook } from "../src/xlsxBuilder.js";

const OUT_DIR = path.resolve(import.meta.dirname, "..", "exports");

async function main() {
  const records = getAllPincodeRecords();
  mkdirSync(OUT_DIR, { recursive: true });

  const csvPath = path.join(OUT_DIR, "india-pincodes.csv");
  writeFileSync(csvPath, buildPincodesCsv(records), "utf8");

  const xlsxPath = path.join(OUT_DIR, "india-pincodes.xlsx");
  const workbook = buildPincodesWorkbook(records);
  await workbook.xlsx.writeFile(xlsxPath);

  console.log(`Wrote ${records.length} pincode rows to:`);
  console.log(`  ${csvPath}`);
  console.log(`  ${xlsxPath}`);
}

await main();
