import type { PincodeRecord, Snapshot } from "./types.ts";
import snapshotJson from "../data/snapshot.json" with { type: "json" };

// Imported (not read from disk at runtime) so the ~6MB dataset is bundled
// directly into the built output -- this is what makes the exact same
// dataStore work unmodified both as a long-running local server (src/server.ts)
// and as a Vercel serverless function (api/index.ts), with no filesystem
// path assumptions that could break across those two environments.
const snapshot = snapshotJson as unknown as Snapshot;

const byPincode = new Map<string, PincodeRecord>();
for (const record of snapshot.records) {
  byPincode.set(record.pincode, record);
}

export function getMeta() {
  return snapshot.meta;
}

export function lookupPincode(pincode: string): PincodeRecord | undefined {
  return byPincode.get(pincode);
}

export function lookupPincodes(pincodes: string[]): (PincodeRecord | undefined)[] {
  return pincodes.map((p) => byPincode.get(p));
}
