import ExcelJS from "exceljs";
import type { PincodeRecord, PostOfficeRecord } from "./types.js";
import { PINCODE_CSV_HEADERS, POST_OFFICE_CSV_HEADERS } from "./csv.js";

/** Shared by scripts/export-pincodes.ts (writes to disk) and the
 *  GET /v1/export/pincodes.xlsx route (writes to a buffer, cached in
 *  memory per warm Vercel instance -- see createApp.ts) so the column
 *  definitions and formatting live in exactly one place. */
export function buildPincodesWorkbook(records: PincodeRecord[]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Pincode API";
  const sheet = workbook.addWorksheet("Pincodes", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = PINCODE_CSV_HEADERS.map((header, i) => ({
    header,
    key: `c${i}`,
    width: [12, 22, 22, 22][i],
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: PINCODE_CSV_HEADERS.length } };
  for (const r of records) sheet.addRow([r.pincode, r.state, r.district, r.city]);
  return workbook;
}

export function buildPostOfficesWorkbook(records: PostOfficeRecord[]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Pincode API";
  const sheet = workbook.addWorksheet("Post Offices", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = POST_OFFICE_CSV_HEADERS.map((header, i) => ({
    header,
    key: `c${i}`,
    width: [26, 12, 20, 20, 20, 14, 12, 16, 16, 16][i],
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: POST_OFFICE_CSV_HEADERS.length } };
  for (const r of records) {
    sheet.addRow([r.officeName, r.pincode, r.state, r.district, r.city, r.officeType, r.delivery, r.division, r.region, r.circle]);
  }
  return workbook;
}
