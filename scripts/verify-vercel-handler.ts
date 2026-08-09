/** One-off local check that api/index.ts's handler works when driven by a
 *  plain Node http.Server the way Vercel's Node runtime would -- i.e.
 *  without Fastify ever calling .listen() itself. Not part of the regular
 *  test suite; just a sanity check for the serverless wiring. */
import { createServer } from "node:http";
import handler from "../api/index";

const server = createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error(err);
    res.statusCode = 500;
    res.end("error");
  });
});

server.listen(0, async () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected address");
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`);
  console.log("GET /health ->", health.status, await health.json());

  const lookup = await fetch(`${base}/v1/pincode/624610`);
  console.log("GET /v1/pincode/624610 ->", lookup.status, await lookup.json());

  const notFound = await fetch(`${base}/v1/pincode/999999`);
  console.log("GET /v1/pincode/999999 ->", notFound.status);

  server.close();
});
