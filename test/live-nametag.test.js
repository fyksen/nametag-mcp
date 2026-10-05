import test from "node:test";
import assert from "node:assert/strict";
import { createNametagApi } from "../src/nametag.js";

const liveEnabled = process.env.NAMETAG_INTEGRATION === "1"
  && Boolean(process.env.NAMETAG_URL)
  && Boolean(process.env.NAMETAG_API_TOKEN);

test("optional live Nametag read-only API smoke test", { skip: !liveEnabled }, async () => {
  const api = createNametagApi(process.env.NAMETAG_URL, process.env.NAMETAG_API_TOKEN);
  const [health, people, relationshipTypes] = await Promise.all([
    api("GET", "/api/health"),
    api("GET", "/api/people", { query: { limit: 1, includeDetails: false } }),
    api("GET", "/api/relationship-types"),
  ]);

  assert.equal(health.status, "healthy", JSON.stringify(health));
  assert.ok(Array.isArray(people.people), JSON.stringify(people));
  assert.ok(Array.isArray(relationshipTypes.relationshipTypes), JSON.stringify(relationshipTypes));
});
