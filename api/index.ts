import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";

// Vercel's Node runtime hands us a plain (req, res) pair per invocation and
// owns the actual HTTP server -- Fastify never calls .listen() here (that's
// only for src/server.ts's local/long-running mode). Instead we build the
// Fastify instance once per warm lambda (cached in module scope, so it
// survives across invocations on the same instance, not just within one),
// wait for all routes/plugins to finish registering via .ready(), then hand
// each incoming request to Fastify's underlying http.Server by emitting a
// 'request' event on it -- the standard pattern for running Fastify on a
// platform that supplies its own HTTP server instead of owning one.
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
