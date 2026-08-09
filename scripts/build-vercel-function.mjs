/**
 * Pre-bundles src/vercelHandler.ts into a single, self-contained api/index.js.
 * Run this locally and commit the result -- Vercel does NOT run this
 * automatically (see the "api/index.js is committed" note below for why).
 *
 * Why bundling is necessary at all: Vercel's default Node.js builder
 * transpiles each .ts file in the dependency graph individually rather
 * than bundling, and handing it a multi-file src/ tree to resolve on its
 * own produced three rounds of confusing runtime failures in this project:
 *
 *   1. Cannot find module '/var/task/src/app.ts' (literal .ts import
 *      specifier left unresolved by native Node ESM)
 *   2. Cannot find module '/var/task/src/dataStore' (extensionless import
 *      not auto-resolved by native ESM either)
 *   3. "Invalid export found in module /var/task/src/app.js" -- Vercel's
 *      own function-entry detection got confused by the multi-file output.
 *
 * Bundling ourselves removes the entire class of problem: after this runs,
 * api/index.js is the ONLY file in api/ -- one file, no further module
 * resolution for Vercel to get right, `fastify` resolved normally from
 * node_modules (kept external, not bundled -- no reason to inline a real
 * npm dependency), and the ~6MB snapshot JSON inlined directly into the
 * bundle.
 *
 * api/index.js is committed to git, not generated at deploy time -- a
 * fourth round of Vercel-side surprises (a custom buildCommand pulled in
 * an unrelated "where's your static site's public/ directory" requirement
 * this project has no use for) made a build artifact we fully control more
 * predictable than continuing to configure around Vercel's own build step.
 * Run `npm run vercel-build` and commit the result whenever
 * src/createApp.ts, src/dataStore.ts, src/types.ts, src/vercelHandler.ts,
 * or data/snapshot.json change. scripts/verify-vercel-handler.ts then
 * exercises the regenerated artifact end-to-end.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";

const outfile = path.resolve(import.meta.dirname, "..", "api", "index.js");
mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.resolve(import.meta.dirname, "..", "src", "vercelHandler.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["fastify"],
});

console.log(`Bundled -> ${outfile}`);
