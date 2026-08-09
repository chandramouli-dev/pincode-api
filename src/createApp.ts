import Fastify, { type FastifyInstance } from "fastify";
import { getMeta, lookupPincode, lookupPincodes, getAllPincodeRecords } from "./dataStore.js";
import { getPostOfficeMeta, queryPostOffices, getAllPostOffices } from "./postOfficeStore.js";
import { buildPincodesCsv, buildPostOfficesCsv } from "./csv.js";
import { buildPincodesWorkbook, buildPostOfficesWorkbook } from "./xlsxBuilder.js";

const PINCODE_RE = /^[1-9][0-9]{5}$/;
const MAX_POST_OFFICE_LIMIT = 10000;
const DEFAULT_POST_OFFICE_LIMIT = 1000;

interface BatchBody {
  pincodes: string[];
}

interface PincodesAllQuery {
  format?: string;
}

interface PostOfficesQuery {
  page?: string;
  limit?: string;
  pincode?: string;
  state?: string;
  district?: string;
  city?: string;
  search?: string;
}

/** Builds a configured Fastify instance without starting a listener, so the
 *  same route definitions serve two different runtimes unmodified:
 *   - src/server.ts calls .listen() on this for local dev / a long-running server.
 *   - src/vercelHandler.ts wraps this for Vercel (no .listen() -- Vercel's
 *     Node runtime owns the HTTP server; see that file's comment). It's
 *     bundled by scripts/build-vercel-function.mjs into the committed
 *     api/index.js, which is what Vercel actually deploys.
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

  // --- Dataset 1: unique pincodes (~19k), the same records GET
  // /v1/pincode/:code serves individually -- see README.md "Unique
  // pincode dataset". ---
  app.get<{ Querystring: PincodesAllQuery }>("/v1/pincodes/all", async (req, reply) => {
    const format = (req.query.format ?? "json").toLowerCase();
    const records = getAllPincodeRecords();

    if (format === "csv") {
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", 'attachment; filename="india-pincodes.csv"');
      return reply.send(buildPincodesCsv(records));
    }
    if (format !== "json") {
      return reply.code(400).send({ error: `Unsupported format '${format}'. Use 'json' or 'csv'.` });
    }

    return {
      count: records.length,
      results: records.map((r) => ({ pincode: r.pincode, state: r.state, district: r.district, city: r.city })),
    };
  });

  // --- Dataset 2: full post-office data (~155k rows, NOT deduplicated by
  // pincode) -- see README.md "Full post-office dataset". city is
  // inherited from Dataset 1's already-resolved value for the same
  // pincode (postOfficeStore.ts); officeType/delivery/division/region/
  // circle are always null -- this project's data source doesn't carry
  // them (see getPostOfficeMeta().fieldsNotAvailableReason / GET /health
  // -style meta). ---
  app.get<{ Querystring: PostOfficesQuery }>("/v1/post-offices", async (req, reply) => {
    const q = req.query;

    let page = parseInt(q.page ?? "1", 10);
    if (!Number.isFinite(page) || page < 1) page = 1;

    let limit = parseInt(q.limit ?? String(DEFAULT_POST_OFFICE_LIMIT), 10);
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_POST_OFFICE_LIMIT;
    if (limit > MAX_POST_OFFICE_LIMIT) {
      return reply.code(400).send({ error: `Max limit is ${MAX_POST_OFFICE_LIMIT}.` });
    }

    if (q.pincode && !PINCODE_RE.test(q.pincode)) {
      return reply.code(400).send({ error: "Invalid pincode. Expected a 6-digit Indian pincode." });
    }

    return queryPostOffices({
      page,
      limit,
      pincode: q.pincode,
      state: q.state,
      district: q.district,
      city: q.city,
      search: q.search,
    });
  });

  app.get("/v1/post-offices/meta", async () => getPostOfficeMeta());

  // --- Downloadable exports (Dataset 1 & 2, CSV + XLSX). CSV is built
  // fresh from the in-memory dataset per request -- cheap (string joins
  // over already-parsed objects). XLSX is genuinely expensive to build
  // (exceljs constructing a real zip-based spreadsheet for up to ~155k
  // rows), so it's built once per warm Vercel instance and cached in this
  // closure, not regenerated on every request -- see README.md
  // "Performance" for the measured cost and why this was chosen over
  // embedding a pre-built binary in the deployed bundle. ---
  let cachedPincodesXlsx: Buffer | null = null;
  let cachedPostOfficesXlsx: Buffer | null = null;

  app.get("/v1/export/pincodes.csv", async (req, reply) => {
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="india-pincodes.csv"');
    return reply.send(buildPincodesCsv(getAllPincodeRecords()));
  });

  app.get("/v1/export/post-offices.csv", async (req, reply) => {
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="india-post-offices.csv"');
    return reply.send(buildPostOfficesCsv(getAllPostOffices()));
  });

  app.get("/v1/export/pincodes.xlsx", async (req, reply) => {
    if (!cachedPincodesXlsx) {
      const workbook = buildPincodesWorkbook(getAllPincodeRecords());
      cachedPincodesXlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    }
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", 'attachment; filename="india-pincodes.xlsx"');
    return reply.send(cachedPincodesXlsx);
  });

  app.get("/v1/export/post-offices.xlsx", async (req, reply) => {
    if (!cachedPostOfficesXlsx) {
      const workbook = buildPostOfficesWorkbook(getAllPostOffices());
      cachedPostOfficesXlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    }
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", 'attachment; filename="india-post-offices.xlsx"');
    return reply.send(cachedPostOfficesXlsx);
  });

  return app;
}
