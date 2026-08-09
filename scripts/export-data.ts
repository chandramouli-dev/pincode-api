/**
 * Exports the full pincode dataset (data/snapshot.json) to CSV and Excel
 * for handoff to non-technical consumers (clients, spreadsheets, bulk
 * imports) who don't want to call the API 19k times.
 *
 * Columns match the API's two-tier model (see README.md / the
 * "Resolving City from a Pincode" reference diagram):
 *   - City: the form-friendly display name (Tier 2)
 *   - Statutory Local Body / Local Body Classification: the actual legal
 *     jurisdiction (Tier 1) -- blank for villages/Census Towns with no
 *     independent local body (~77% of rows)
 *   - City Match Type: which rule produced the City value (see README's
 *     citySource table) -- included for transparency, not decoration.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { Snapshot } from "../src/types.js";

const SNAPSHOT_PATH = path.resolve(import.meta.dirname, "..", "data", "snapshot.json");
const OUT_DIR = path.resolve(import.meta.dirname, "..", "exports");

const COLUMNS = [
  { header: "Pincode", key: "pincode", width: 12 },
  { header: "State", key: "state", width: 22 },
  { header: "District", key: "district", width: 22 },
  { header: "City", key: "city", width: 22 },
  { header: "City Match Type", key: "cityMatchType", width: 18 },
  { header: "Statutory Local Body", key: "statutoryLocalBody", width: 26 },
  { header: "Local Body Classification", key: "localBodyClassification", width: 22 },
] as const;

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

async function main() {
  const snapshot: Snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const rows = snapshot.records.map((r) => ({
    pincode: r.pincode,
    state: r.state,
    district: r.district,
    city: r.city,
    cityMatchType: r.citySource,
    statutoryLocalBody: r.statutoryLocalBody?.name ?? "",
    localBodyClassification: r.statutoryLocalBody?.classification ?? "",
  }));

  mkdirSync(OUT_DIR, { recursive: true });

  // --- CSV ---
  const csvPath = path.join(OUT_DIR, "pincode-india.csv");
  const csvLines = [
    COLUMNS.map((c) => csvField(c.header)).join(","),
    ...rows.map((row) => COLUMNS.map((c) => csvField(String(row[c.key as keyof typeof row]))).join(",")),
  ];
  writeFileSync(csvPath, csvLines.join("\n") + "\n", "utf8");

  // --- Excel ---
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Pincode API";
  workbook.created = new Date(snapshot.meta.generatedAt);
  const sheet = workbook.addWorksheet("Pincodes", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE4DFCF" } };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  for (const row of rows) sheet.addRow(row);

  const xlsxPath = path.join(OUT_DIR, "pincode-india.xlsx");
  await workbook.xlsx.writeFile(xlsxPath);

  console.log(`Wrote ${rows.length} rows to:`);
  console.log(`  ${csvPath}`);
  console.log(`  ${xlsxPath}`);
}

await main();
