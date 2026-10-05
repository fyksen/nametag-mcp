import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createNametagApi } from "../src/nametag.js";
import { createRemoteHttpServer } from "../src/remote.js";

const enabled = process.env.NAMETAG_INTEGRATION_WRITES === "1"
  && Boolean(process.env.NAMETAG_URL)
  && Boolean(process.env.NAMETAG_API_TOKEN);

async function reservePort() {
  const reservation = createNetServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("opt-in authenticated MCP create/update/delete tools against Nametag, then remove test records", { skip: !enabled }, async () => {
  const api = createNametagApi(process.env.NAMETAG_URL, process.env.NAMETAG_API_TOKEN);
  const marker = randomBytes(6).toString("hex");
  const testLabel = `MCP Integration ${marker}`;
  const authToken = randomBytes(32).toString("hex");
  const port = await reservePort();
  const server = createRemoteHttpServer({
    api,
    authToken,
    host: "127.0.0.1",
    port,
    allowedHosts: [`localhost:${port}`],
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");

  const client = new Client({ name: "nametag-write-integration", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
  });
  const personIds = [];
  let groupId;
  let relationshipId;
  const cleanupErrors = [];

  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.find((item) => item.type === "text")?.text ?? "{}";
    assert.notEqual(result.isError, true, `${name} failed: ${text}`);
    return JSON.parse(text);
  }

  async function cleanup(method, path, options) {
    const result = await api(method, path, options);
    if (result?.error && result.status !== 404) cleanupErrors.push(`${method} ${path}: ${result.error}`);
  }

  try {
    await client.connect(transport);
    const relationshipTypes = await call("nametag_list_relationship_types", {});
    const relationshipToUserId = relationshipTypes.relationshipTypes?.[0]?.id;
    assert.ok(relationshipToUserId, "Nametag needs at least one relationship type for people");

    const first = await call("nametag_create_person", {
      person: { name: `${testLabel} A`, relationshipToUserId, notes: `Temporary MCP write test ${marker}` },
    });
    personIds.push(first.person.id);
    const second = await call("nametag_create_person", {
      person: { name: `${testLabel} B`, relationshipToUserId, notes: `Temporary MCP write test ${marker}` },
    });
    personIds.push(second.person.id);

    await call("nametag_update_person", {
      id: personIds[0],
      person: { notes: `Updated temporary MCP write test ${marker}` },
    });
    const updatedPerson = await call("nametag_get_person", { id: personIds[0] });
    assert.equal(updatedPerson.person.notes, `Updated temporary MCP write test ${marker}`);

    const group = await call("nametag_create_group", {
      group: { name: testLabel, description: `Temporary MCP write test ${marker}` },
    });
    groupId = group.group.id;
    await call("nametag_add_group_member", { group_id: groupId, person_id: personIds[0] });
    await call("nametag_remove_group_member", { group_id: groupId, person_id: personIds[0] });

    const relationship = await call("nametag_create_relationship", {
      person_id: personIds[0],
      related_person_id: personIds[1],
      relationship_type_id: relationshipToUserId,
      notes: `Temporary MCP write test ${marker}`,
    });
    relationshipId = relationship.relationship.id;
    await call("nametag_update_relationship", {
      id: relationshipId,
      relationship_type_id: relationshipToUserId,
      notes: `Updated temporary MCP write test ${marker}`,
    });
    await call("nametag_delete_relationship", { id: relationshipId });
    await call("nametag_restore_relationship", { id: relationshipId });

    await call("nametag_delete_group", { id: groupId, delete_people: false });
    for (const id of personIds) await call("nametag_delete_person", { id, delete_orphans: false });
  } finally {
    await client.close().catch(() => {});
    if (relationshipId) {
      await cleanup("DELETE", `/api/relationships/${encodeURIComponent(relationshipId)}`);
      await cleanup("DELETE", `/api/relationships/${encodeURIComponent(relationshipId)}/permanent`);
    }
    if (groupId) {
      await cleanup("DELETE", `/api/groups/${encodeURIComponent(groupId)}`, { query: { deletePeople: false } });
      await cleanup("DELETE", `/api/groups/${encodeURIComponent(groupId)}/permanent`);
    }
    for (const id of personIds) {
      await cleanup("DELETE", `/api/people/${encodeURIComponent(id)}`, { body: { deleteOrphans: false } });
      await cleanup("DELETE", `/api/people/${encodeURIComponent(id)}/permanent`);
    }
    await new Promise((resolve) => server.close(resolve));
    if (cleanupErrors.length) throw new Error(`Test cleanup failed: ${cleanupErrors.join("; ")}`);
  }
});
