import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./createApp.js";

// Vercel's Node runtime hands us a plain (req, res) pair per invocation and
// owns the actual HTTP server -- Fastify never calls .listen() here (that's
// only for src/localServer.ts's local/long-running mode). Instead we build the
// Fastify instance once per warm lambda (cached in module scope, so it
// survives across invocations on the same instance, not just within one),
// wait for all routes/plugins to finish registering via .ready(), then hand
// each incoming request to Fastify's underlying http.Server by emitting a
// 'request' event on it -- the standard pattern for running Fastify on a
// platform that supplies its own HTTP server instead of owning one.
//
// This file is NOT deployed as-is. It's the source that scripts/build-vercel-function.mjs
// bundles (via esbuild) into the single, dependency-free api/index.js that
// actually ships -- see that script's comment for why: Vercel's own
// per-file TypeScript compilation of a multi-file src/ tree produced two
// rounds of confusing runtime errors (missing .ts/.js modules, then a
// misdetected function entry point) before pre-bundling sidestepped the
// whole class of problems by leaving nothing else for Vercel to resolve.
let appPromise: Promise<FastifyInstance> | null = null;

function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    const app = buildApp();
    appPromise = Promise.resolve(app.ready()).then(() => app);
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  app.server.emit("request", req, res);
}
