/** Quick sanity check against a handful of known pincodes, run against a
 *  live server (npm run dev in another terminal, or set BASE_URL). */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

const CASES: Array<{
  pincode: string;
  expectState: string;
  expectCity?: string;
  expectSlbName?: string | null;
  note: string;
}> = [
  { pincode: "110001", expectState: "Delhi", note: "Connaught Place, New Delhi" },
  {
    pincode: "400001",
    expectState: "Maharashtra",
    expectCity: "Mumbai",
    expectSlbName: "Greater Mumbai",
    note: "regression test: Tier 1 keeps the exact legal name (Greater Mumbai) while Tier 2 shows the clean form (Mumbai) -- a shipping form should never see 'Greater Mumbai'",
  },
  { pincode: "560001", expectState: "Karnataka", note: "Bengaluru GPO" },
  {
    pincode: "600001",
    expectState: "Tamil Nadu",
    expectCity: "Chennai",
    expectSlbName: "Greater Chennai Corporation",
    note: "same legal-name-vs-clean-name split as Mumbai, different suffix shape ('X Corporation' vs 'Greater X')",
  },
  { pincode: "700001", expectState: "West Bengal", note: "Kolkata GPO" },
  { pincode: "500001", expectState: "Telangana", note: "Hyderabad GPO" },
  { pincode: "302001", expectState: "Rajasthan", note: "Jaipur GPO" },
  {
    pincode: "682001",
    expectState: "Kerala",
    expectCity: "Kochi",
    expectSlbName: "Kochi",
    note: "Kochi -- locality itself is a Municipal Corporation (lgd-self)",
  },
  { pincode: "799001", expectState: "Tripura", note: "Agartala" },
  { pincode: "190001", expectState: "Jammu & Kashmir", note: "Srinagar" },
  {
    pincode: "624610",
    expectState: "Tamil Nadu",
    expectCity: "Palani",
    expectSlbName: "Balasamudram",
    note: "regression test: Tier 1 must preserve Balasamudram's own Town Panchayat status even though Tier 2 rolls up to Palani; also regression-tests the taluk-HQ sanity check (postal file's subDistrict field wrongly says 'Dindigul', 62km away -- must not be trusted blindly)",
  },
];

async function main() {
  let failures = 0;
  for (const c of CASES) {
    const res = await fetch(`${BASE_URL}/v1/pincode/${c.pincode}`);
    const body = await res.json();
    const ok =
      res.ok &&
      body.state === c.expectState &&
      (!c.expectCity || body.city === c.expectCity) &&
      (c.expectSlbName === undefined || body.statutoryLocalBody?.name === c.expectSlbName);
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${c.pincode} (${c.note}) -> ${JSON.stringify({
        state: body.state,
        district: body.district,
        statutoryLocalBody: body.statutoryLocalBody,
        city: body.city,
        citySource: body.citySource,
      })}`,
    );
    if (!ok) failures++;
  }

  const badRes = await fetch(`${BASE_URL}/v1/pincode/abc123`);
  console.log(`${badRes.status === 400 ? "PASS" : "FAIL"}  invalid pincode -> HTTP ${badRes.status}`);
  if (badRes.status !== 400) failures++;

  const missingRes = await fetch(`${BASE_URL}/v1/pincode/999999`);
  console.log(`${missingRes.status === 404 ? "PASS" : "FAIL"}  unknown pincode -> HTTP ${missingRes.status}`);
  if (missingRes.status !== 404) failures++;

  const batchRes = await fetch(`${BASE_URL}/v1/pincode/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pincodes: ["110001", "400001", "999999"] }),
  });
  const batchBody = await batchRes.json();
  const batchOk = batchRes.ok && batchBody.results.length === 3 && batchBody.results[2].found === false;
  console.log(`${batchOk ? "PASS" : "FAIL"}  batch lookup -> ${JSON.stringify(batchBody.results.map((r: any) => [r.pincode, r.found]))}`);
  if (!batchOk) failures++;

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
