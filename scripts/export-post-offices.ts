/**
 * npm run export:post-offices -- writes exports/india-post-offices.csv
 * and exports/india-post-offices.xlsx (Office Name, Pincode, State,
 * District, City, Office Type, Delivery, Division, Region, Circle -- the
 * Dataset 2 columns; the last five are always blank, see
 * data/post-offices.json's meta.fieldsNotAvailableReason). Same column
 * builders as GET /v1/export/post-offices.csv and .xlsx.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getAllPostOffices } from "../src/postOfficeStore.js";
import { buildPostOfficesCsv } from "../src/csv.js";
import { buildPostOfficesWorkbook } from "../src/xlsxBuilder.js";

const OUT_DIR = path.resolve(import.meta.dirname, "..", "exports");

async function main() {
  const records = getAllPostOffices();
  mkdirSync(OUT_DIR, { recursive: true });

  const csvPath = path.join(OUT_DIR, "india-post-offices.csv");
  writeFileSync(csvPath, buildPostOfficesCsv(records), "utf8");

  const xlsxPath = path.join(OUT_DIR, "india-post-offices.xlsx");
  const workbook = buildPostOfficesWorkbook(records);
  await workbook.xlsx.writeFile(xlsxPath);

  console.log(`Wrote ${records.length} post-office rows to:`);
  console.log(`  ${csvPath}`);
  console.log(`  ${xlsxPath}`);
}

await main();
