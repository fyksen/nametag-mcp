import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRemoteHttpServer } from "../src/remote.js";

const AUTH_TOKEN = "test-only-mcp-token-long-enough-for-validation-123456";

async function reservePort() {
  const reservation = createNetServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer(options = {}) {
  const port = await reservePort();
  const server = createRemoteHttpServer({
    api: async (method, path, request) => ({ method, path, query: request?.query ?? {}, people: [{ id: "p1", name: "Ada" }] }),
    authToken: AUTH_TOKEN,
    host: "127.0.0.1",
    port,
    allowedHosts: [`localhost:${port}`],
    ...options,
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return { server, port, url: `http://localhost:${port}/mcp` };
}

test("remote HTTP endpoint requires bearer auth and rejects unapproved origins", async (t) => {
  const { server, port } = await startServer({ allowedOrigins: ["https://hermes.example.test"] });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://localhost:${port}/mcp`;

  const missing = await fetch(url, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), "Bearer");

  const invalidOrigin = await fetch(url, {
    method: "POST",
    body: "{}",
    headers: { Authorization: `Bearer ${AUTH_TOKEN}`, Origin: "https://attacker.example", "Content-Type": "application/json" },
  });
  assert.equal(invalidOrigin.status, 403);
});

test("remote Streamable HTTP exposes tools and dispatches tool calls to Nametag API", async (t) => {
  const calls = [];
  const port = await reservePort();
  const server = createRemoteHttpServer({
    api: async (method, path, request) => {
      calls.push({ method, path, request });
      return { people: [{ id: "p1", name: "Ada" }] };
    },
    authToken: AUTH_TOKEN,
    host: "127.0.0.1",
    port,
    allowedHosts: [`localhost:${port}`],
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = new Client({ name: "nametag-mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
  });
  t.after(() => client.close().catch(() => {}));
  await client.connect(transport);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "nametag_list_people"));
  const result = await client.callTool({ name: "nametag_list_people", arguments: { limit: 25, group_ids: ["g1", "g2"] } });
  assert.match(result.content[0].text, /Ada/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/people");
  assert.equal(calls[0].request.query.limit, 25);
  assert.deepEqual(calls[0].request.query.groupIds, ["g1", "g2"]);
});

test("HTTP mode refuses cleartext exposure on a non-loopback interface by default", () => {
  assert.throws(() => createRemoteHttpServer({
    api: async () => ({}),
    authToken: AUTH_TOKEN,
    host: "0.0.0.0",
    port: 8765,
    allowedHosts: ["mcp.lan:8765"],
  }), /requires TLS certificates/);
});

test("remote endpoint rejects an unexpected Host header", async (t) => {
  const { server, port } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    headers: {
      Host: "evil.example",
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
  });
  assert.equal(response.status, 403);
});
