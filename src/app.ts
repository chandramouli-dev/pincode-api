import Fastify, { type FastifyInstance } from "fastify";
import { getMeta, lookupPincode, lookupPincodes } from "./dataStore.js";

const PINCODE_RE = /^[1-9][0-9]{5}$/;

interface BatchBody {
  pincodes: string[];
}

/** Builds a configured Fastify instance without starting a listener, so the
 *  same route definitions serve two different runtimes unmodified:
 *   - src/server.ts calls .listen() on this for local dev / a long-running server.
 *   - api/index.ts wraps this as a Vercel serverless function (no .listen()
 *     -- Vercel's Node runtime owns the HTTP server; see that file's comment).
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    const meta = getMeta();
    return { status: "ok", ...meta };
  });

  app.get<{ Params: { code: string } }>("/v1/pincode/:code", async (req, reply) => {
    const { code } = req.params;
    if (!PINCODE_RE.test(code)) {
      return reply.code(400).send({ error: "Invalid pincode. Expected a 6-digit Indian pincode." });
    }

    const record = lookupPincode(code);
    if (!record) {
      return reply.code(404).send({ error: `No data found for pincode ${code}.` });
    }

    return record;
  });

  app.post<{ Body: BatchBody }>("/v1/pincode/batch", async (req, reply) => {
    const { pincodes } = req.body ?? {};
    if (!Array.isArray(pincodes) || pincodes.length === 0) {
      return reply.code(400).send({ error: "Body must be { pincodes: string[] }." });
    }
    if (pincodes.length > 200) {
      return reply.code(400).send({ error: "Max 200 pincodes per batch request." });
    }

    const invalid = pincodes.filter((p) => !PINCODE_RE.test(p));
    if (invalid.length > 0) {
      return reply.code(400).send({ error: "Invalid pincode(s).", invalid });
    }

    const results = lookupPincodes(pincodes);
    return {
      results: pincodes.map((p, i) => ({
        pincode: p,
        found: Boolean(results[i]),
        data: results[i] ?? null,
      })),
    };
  });

  app.get("/v1/meta", async () => getMeta());

  return app;
}
