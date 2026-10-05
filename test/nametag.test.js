import test from "node:test";
import assert from "node:assert/strict";
import { createNametagApi } from "../src/nametag.js";

test("Nametag API client sends bearer auth, joins array filters, and posts JSON", async () => {
  let received;
  const api = createNametagApi("https://nametag.example.test/prefix/", "ntag-test-token", async (url, options) => {
    received = { url: new URL(url), options };
    return new Response(JSON.stringify({ people: [{ id: "p1", name: "Ada" }] }), { status: 200 });
  });

  const result = await api("POST", "/api/people", {
    query: { groupIds: ["g1", "g2"], includeDetails: false },
    body: { name: "Ada" },
  });

  assert.equal(received.url.href, "https://nametag.example.test/prefix/api/people?groupIds=g1%2Cg2&includeDetails=false");
  assert.equal(received.options.headers.Authorization, "Bearer ntag-test-token");
  assert.equal(received.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(received.options.body), { name: "Ada" });
  assert.deepEqual(result, { people: [{ id: "p1", name: "Ada" }] });
});

test("Nametag API client preserves API error status and validation details", async () => {
  const api = createNametagApi("http://nametag.test", "ntag-test-token", async () => new Response(
    JSON.stringify({ error: "Validation failed", details: [{ field: "name", message: "Required" }] }),
    { status: 400 },
  ));

  assert.deepEqual(await api("POST", "/api/people", { body: {} }), {
    error: "Validation failed",
    status: 400,
    details: [{ field: "name", message: "Required" }],
  });
});

test("Nametag API client rejects missing token and invalid URL schemes", () => {
  assert.throws(() => createNametagApi("http://nametag.test", ""), /NAMETAG_API_TOKEN/);
  assert.throws(() => createNametagApi("file:///tmp/nametag", "ntag-test-token"), /HTTP or HTTPS/);
});
