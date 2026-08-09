/**
 * Downloads the three public datasets this project builds its snapshot from:
 *
 *  1. Postal code file (IN.txt from export/zip/IN.zip)
 *     Pincode -> place name, state, district, sub-district, lat/lng.
 *     GeoNames' own India-Post-derived dataset; closest thing to an
 *     official, no-API-key-needed Pincode -> State/District bulk download.
 *
 *  2. Gazetteer dump (IN.txt from export/dump/IN.zip)
 *     All named places in India with coordinates + population.
 *     Used as the Tier-2 (logistics rollup) candidate pool -- see
 *     resolveCity() in build-snapshot.ts.
 *
 *  Both (1) and (2) are published by GeoNames under CC BY 4.0:
 *  https://www.geonames.org/ -- attribution required if you redistribute
 *  derived data; see README.md.
 *
 *  3. LGD Urban Local Body directory (urban_local_bodies.<date>.csv.7z)
 *     Every India place with independent statutory urban local body status
 *     (Municipal Corporation / Municipality / Town Panchayat), sourced from
 *     the Ministry of Panchayati Raj's Local Government Directory
 *     (lgdirectory.gov.in) and re-published as daily CSV dumps by
 *     ramSeraph/opendata: https://ramseraph.github.io/opendata/lgd/
 *     This is Tier-1 (statutory local body) ground truth -- see
 *     buildLgdIndex() in build-snapshot.ts. Requires the `7z` CLI
 *     (`brew install p7zip` / `apt install p7zip-full`) to extract.
 *
 * Run this every 1-3 months to pick up changes (new pincodes, renamed
 * places, newly notified local bodies).
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const RAW_DIR = path.resolve(import.meta.dirname, "..", "data", "raw");

const GEONAMES_SOURCES = [
  {
    name: "postal codes (pincode -> place/state/district)",
    url: "https://download.geonames.org/export/zip/IN.zip",
    zipPath: path.join(RAW_DIR, "IN_postal.zip"),
    extractedName: "IN.txt",
    finalName: "postal-codes.txt",
  },
  {
    name: "gazetteer (all named places, for city resolution)",
    url: "https://download.geonames.org/export/dump/IN.zip",
    zipPath: path.join(RAW_DIR, "IN_gazetteer.zip"),
    extractedName: "IN.txt",
    finalName: "gazetteer.txt",
  },
];

async function download(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath));
}

async function fetchGeonamesSources() {
  for (const src of GEONAMES_SOURCES) {
    const finalPath = path.join(RAW_DIR, src.finalName);
    console.log(`Downloading ${src.name} ...`);
    await download(src.url, src.zipPath);

    console.log(`Extracting ${src.extractedName} ...`);
    await execFileAsync("unzip", ["-o", "-q", src.zipPath, src.extractedName, "-d", RAW_DIR]);

    const extractedPath = path.join(RAW_DIR, src.extractedName);
    // Rename to a stable, source-specific name (both zips extract to IN.txt).
    await execFileAsync("mv", ["-f", extractedPath, finalPath]);
    await execFileAsync("rm", ["-f", src.zipPath]);

    console.log(`  -> ${finalPath}`);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parses "30Apr2026" -> a comparable number (20260430). */
function parseDdMonYyyy(s: string): number {
  const m = s.match(/^(\d{2})([A-Za-z]{3})(\d{4})$/);
  if (!m) return -1;
  const [, dd, mon, yyyy] = m;
  const monthIdx = MONTHS.indexOf(mon);
  if (monthIdx === -1) return -1;
  return Number(yyyy) * 10000 + (monthIdx + 1) * 100 + Number(dd);
}

async function fetchLgdUrbanLocalBodies() {
  console.log("Finding latest LGD urban_local_bodies dump ...");
  const res = await fetch("https://api.github.com/repos/ramSeraph/opendata/releases/tags/lgd-latest");
  if (!res.ok) throw new Error(`Failed to list LGD release assets: HTTP ${res.status}`);
  const release = (await res.json()) as { assets: Array<{ name: string; browser_download_url: string }> };

  const candidates = release.assets
    .filter((a) => a.name.startsWith("urban_local_bodies.") && a.name.endsWith(".csv.7z"))
    .map((a) => {
      const dateStr = a.name.replace("urban_local_bodies.", "").replace(".csv.7z", "");
      return { ...a, sortKey: parseDdMonYyyy(dateStr) };
    })
    .filter((a) => a.sortKey !== -1)
    .sort((a, b) => b.sortKey - a.sortKey);

  const latest = candidates[0];
  if (!latest) throw new Error("No urban_local_bodies.*.csv.7z asset found in the lgd-latest release.");

  const archivePath = path.join(RAW_DIR, "urban-local-bodies.csv.7z");
  const finalPath = path.join(RAW_DIR, "urban-local-bodies.csv");

  console.log(`Downloading ${latest.name} ...`);
  await download(latest.browser_download_url, archivePath);

  console.log("Extracting (requires the `7z` CLI -- brew install p7zip / apt install p7zip-full) ...");
  try {
    await execFileAsync("7z", ["x", "-y", `-o${RAW_DIR}`, archivePath]);
  } catch (err) {
    throw new Error(
      `Failed to extract ${archivePath} with \`7z\`. Install it first: brew install p7zip (macOS) or apt install p7zip-full (Debian/Ubuntu).\nOriginal error: ${err}`,
    );
  }
  await execFileAsync("mv", ["-f", path.join(RAW_DIR, latest.name.replace(".7z", "")), finalPath]);
  await execFileAsync("rm", ["-f", archivePath]);

  console.log(`  -> ${finalPath}`);
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  await fetchGeonamesSources();
  await fetchLgdUrbanLocalBodies();
  console.log("\nDone. Run `npm run build-snapshot` next.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
