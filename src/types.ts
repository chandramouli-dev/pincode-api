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
