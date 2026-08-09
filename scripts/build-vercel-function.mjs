/**
 * Pre-bundles src/vercelHandler.ts into a single, self-contained api/index.js
 * BEFORE Vercel's own build step runs (this is invoked as the "vercel-build"
 * npm script, which Vercel runs automatically).
 *
 * Why: Vercel's default Node.js builder transpiles each .ts file in the
 * dependency graph individually rather than bundling, and handing it a
 * multi-file src/ tree to resolve on its own produced two rounds of
 * confusing runtime failures in this project:
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
 * api/index.js is gitignored (generated, not committed) -- Vercel produces
 * it fresh on every deploy via this script. Run `npm run vercel-build`
 * locally any time you want to test the exact artifact Vercel will run;
 * scripts/verify-vercel-handler.ts then exercises it end-to-end.
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
