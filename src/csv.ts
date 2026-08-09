import type { PincodeRecord, PostOfficeRecord } from "./types.js";

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(",");
}

export const PINCODE_CSV_HEADERS = ["Pincode", "State", "District", "City"];

export function buildPincodesCsv(records: PincodeRecord[]): string {
  const lines = [csvRow(PINCODE_CSV_HEADERS)];
  for (const r of records) lines.push(csvRow([r.pincode, r.state, r.district, r.city]));
  return lines.join("\n") + "\n";
}

export const POST_OFFICE_CSV_HEADERS = [
  "Office Name",
  "Pincode",
  "State",
  "District",
  "City",
  "Office Type",
  "Delivery",
  "Division",
  "Region",
  "Circle",
];

export function buildPostOfficesCsv(records: PostOfficeRecord[]): string {
  const lines = [csvRow(POST_OFFICE_CSV_HEADERS)];
  for (const r of records) {
    lines.push(
      csvRow([
        r.officeName,
        r.pincode,
        r.state,
        r.district,
        r.city,
        r.officeType ?? "",
        r.delivery ?? "",
        r.division ?? "",
        r.region ?? "",
        r.circle ?? "",
      ]),
    );
  }
  return lines.join("\n") + "\n";
}
