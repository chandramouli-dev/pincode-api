import type { PostOfficeRecord, PostOfficeSnapshot, PostOfficeSnapshotMeta, PostOfficeTuple } from "./types.js";
import postOfficeJson from "../data/post-offices.json" with { type: "json" };

// Same rationale as dataStore.ts: imported (not read from disk at
// runtime) so this bundles directly into the Vercel function -- see
// README.md "Performance" for the size tradeoff this creates and why it
// was accepted. Stored as compact tuples on disk/in the bundle (see
// PostOfficeTuple's doc comment in types.ts); expanded to full objects
// only when actually returned from an endpoint, not held twice in memory.
const snapshot = postOfficeJson as unknown as PostOfficeSnapshot;
const records: PostOfficeTuple[] = snapshot.records;

// Index only what's worth indexing: pincode lookups are the hot path
// (mirrors GET /v1/pincode/:code's usage pattern). State/district/city
// filters and free-text search are linear scans over ~155k simple string
// comparisons -- fast enough at this scale (single-digit-to-low-tens of
// ms) that a second index isn't worth the memory/complexity; see
// README.md "Performance" for the measured tradeoff.
const indicesByPincode = new Map<string, number[]>();
records.forEach((row, i) => {
  const pincode = row[1];
  if (!indicesByPincode.has(pincode)) indicesByPincode.set(pincode, []);
  indicesByPincode.get(pincode)!.push(i);
});

function toRecord([officeName, pincode, state, district, city]: PostOfficeTuple): PostOfficeRecord {
  return {
    officeName,
    pincode,
    state,
    district,
    city,
    officeType: null,
    delivery: null,
    division: null,
    region: null,
    circle: null,
  };
}

export function getPostOfficeMeta(): PostOfficeSnapshotMeta {
  return snapshot.meta;
}

export function lookupPostOfficesByPincode(pincode: string): PostOfficeRecord[] {
  const idx = indicesByPincode.get(pincode);
  if (!idx) return [];
  return idx.map((i) => toRecord(records[i]));
}

export interface PostOfficeQuery {
  pincode?: string;
  state?: string;
  district?: string;
  city?: string;
  search?: string;
  page: number;
  limit: number;
}

export interface PostOfficeQueryResult {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  results: PostOfficeRecord[];
}

function matches(row: PostOfficeTuple, q: PostOfficeQuery): boolean {
  const [officeName, pincode, state, district, city] = row;
  if (q.pincode && pincode !== q.pincode) return false;
  if (q.state && state.toLowerCase() !== q.state.toLowerCase()) return false;
  if (q.district && district.toLowerCase() !== q.district.toLowerCase()) return false;
  if (q.city && city.toLowerCase() !== q.city.toLowerCase()) return false;
  if (q.search) {
    const needle = q.search.toLowerCase();
    const haystack = `${officeName} ${pincode} ${city} ${district} ${state}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function queryPostOffices(q: PostOfficeQuery): PostOfficeQueryResult {
  // Pincode filter has an index -- use it as the base set instead of a
  // full scan when present, since it's the hot path.
  const candidateIndices = q.pincode ? (indicesByPincode.get(q.pincode) ?? []) : null;

  const matched: PostOfficeTuple[] = [];
  if (candidateIndices) {
    for (const i of candidateIndices) {
      if (matches(records[i], q)) matched.push(records[i]);
    }
  } else {
    for (const row of records) {
      if (matches(row, q)) matched.push(row);
    }
  }

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / q.limit));
  const start = (q.page - 1) * q.limit;
  const pageRows = matched.slice(start, start + q.limit);

  return {
    page: q.page,
    limit: q.limit,
    total,
    totalPages,
    results: pageRows.map(toRecord),
  };
}

/** All records, expanded -- for CSV/XLSX export. Not used per-request by
 *  the paginated /v1/post-offices endpoint. */
export function getAllPostOffices(): PostOfficeRecord[] {
  return records.map(toRecord);
}

export function getPostOfficeCount(): number {
  return records.length;
}
