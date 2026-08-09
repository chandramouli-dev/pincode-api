/**
 * Two-tier city resolution:
 *
 *   Tier 1 - statutoryLocalBody: the actual, legally-governing local body
 *   of the postal locality (from the LGD Urban Local Body directory).
 *   Never overridden or rolled up -- a Town Panchayat stays a Town
 *   Panchayat here even though a bigger town governs the Taluk. Use this
 *   for anything jurisdiction-sensitive: property tax, voter roll, land
 *   records, KYC address proof. `null` means the locality isn't in the
 *   LGD Urban Local Body directory at all (i.e. it's a village / Census
 *   Town, not an independent statutory urban body).
 *
 *   Tier 2 - city/citySource/cityDistanceKm: a form-friendly rollup used
 *   for shipping/checkout/generic "City" fields, where a single
 *   recognizable town name is more useful than jurisdictional precision.
 */

export type LocalBodyClassification = "Municipal Corporation" | "Municipality" | "Town Panchayat";

export interface StatutoryLocalBody {
  name: string;
  classification: LocalBodyClassification;
  lgdCode: number;
}

export type CitySource =
  // Tier 2 resolved directly from the LGD directory (preferred -- see build-snapshot.ts):
  | "lgd-self" // the pincode's own locality is a Corporation/Municipality -- no rollup needed
  | "lgd-taluk-hq" // locality is a smaller Town Panchayat -- rolled up to its Taluk/Tehsil HQ, which is itself a recognized Municipality+
  // Tier 2 fallback when the LGD directory can't resolve a confident rollup (see resolveCity in build-snapshot.ts):
  | "exact-match"
  | "name-match"
  | "nearest-place"
  | "district-fallback";

export interface PincodeRecord {
  pincode: string;
  state: string;
  district: string;
  subDistrict: string | null;
  statutoryLocalBody: StatutoryLocalBody | null;
  city: string;
  citySource: CitySource;
  cityDistanceKm: number | null;
  latitude: number;
  longitude: number;
  localities: string[];
}

export interface SnapshotMeta {
  generatedAt: string;
  pincodeCount: number;
  sources: string[];
}

export interface Snapshot {
  meta: SnapshotMeta;
  records: PincodeRecord[];
}

/**
 * Post-office-level dataset (one row per individual post office/locality,
 * NOT deduplicated by pincode -- see data/post-offices.json).
 *
 * `city` is inherited from the pincode-level Snapshot above (a join by
 * pincode against the already-resolved Tier 2 city), not re-resolved per
 * locality -- every post office sharing a pincode currently gets the same
 * city. See README.md "Full post-office dataset" for why, and for the
 * documented follow-up if true per-locality resolution is ever needed.
 *
 * officeType/delivery/division/region/circle are always null: this
 * project's data sources (GeoNames) don't carry those fields at all --
 * they're specific to the official India Post pincode directory schema,
 * which isn't currently fetched (see README.md "Data source" for why, and
 * the options for adding it). Left as explicit nulls, never fabricated.
 */
export interface PostOfficeRecord {
  officeName: string;
  pincode: string;
  state: string;
  district: string;
  city: string;
  officeType: string | null;
  delivery: string | null;
  division: string | null;
  region: string | null;
  circle: string | null;
}

/** Compact on-disk/bundled tuple form of PostOfficeRecord -- only the 5
 *  fields that actually vary per row are stored; the 5 always-null fields
 *  are added back at the API layer (see postOfficeStore.ts) rather than
 *  repeated 155,000+ times in the bundled JSON. */
export type PostOfficeTuple = [officeName: string, pincode: string, state: string, district: string, city: string];

export interface PostOfficeSnapshotMeta {
  generatedAt: string;
  recordCount: number;
  uniquePincodeCount: number;
  source: string;
  sourceUrl: string;
  downloadDate: string;
  fieldsNotAvailable: string[];
  fieldsNotAvailableReason: string;
  cityDerivation: string;
  recordsWithCity: number;
  recordsWithoutCity: number;
}

export interface PostOfficeSnapshot {
  meta: PostOfficeSnapshotMeta;
  records: PostOfficeTuple[];
}
