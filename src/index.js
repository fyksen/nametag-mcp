import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNametagApi, createNametagMcpServer } from "./nametag.js";
import { createRemoteHttpServer } from "./remote.js";

async function main() {
  const api = createNametagApi(
    process.env.NAMETAG_URL ?? "http://localhost:3000",
    process.env.NAMETAG_API_TOKEN,
  );
  const mode = process.env.MCP_TRANSPORT ?? "stdio";

  if (mode === "stdio") {
    const mcpServer = createNametagMcpServer(api);
    await mcpServer.connect(new StdioServerTransport());
    return;
  }
  if (mode !== "http") throw new Error("MCP_TRANSPORT must be either 'stdio' or 'http'");

  const host = process.env.MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.MCP_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MCP_PORT must be an integer from 0 to 65535");
  const readOptionalFile = async (path) => path ? readFile(path) : undefined;
  const [tlsKey, tlsCert] = await Promise.all([
    readOptionalFile(process.env.MCP_TLS_KEY),
    readOptionalFile(process.env.MCP_TLS_CERT),
  ]);
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const httpServer = createRemoteHttpServer({
    api,
    authToken: process.env.MCP_AUTH_TOKEN,
    host,
    port,
    allowedHosts,
    allowedOrigins,
    tlsKey,
    tlsCert,
    trustedProxy: process.env.MCP_TRUSTED_PROXY === "true",
    allowInsecureHttp: process.env.MCP_ALLOW_INSECURE_HTTP === "true",
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const address = httpServer.address();
  console.error(`Nametag MCP listening on ${tlsCert ? "https" : "http"}://${host}:${address.port}/mcp`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
