// Vercel's Node.js zero-config entrypoint detection found this file by
// name (src/server.ts matches its search list) but then rejected it with
// "No entrypoint found which imports fastify" -- it apparently checks the
// entrypoint file's own imports for a recognized server framework, not
// what that file's imports themselves import. The actual `import Fastify
// from "fastify"` lives in createApp.ts (buildApp() constructs the app);
// this side-effect import satisfies Vercel's check without changing how
// the app is actually built.
import "fastify";
import { buildApp } from "./createApp.js";

const app = buildApp();
const port = Number(process.env.PORT) || 3000;

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
