import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNametagMcpServer } from "./nametag.js";

const MAX_BODY_BYTES = 1024 * 1024;

function bearerMatches(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

function responseJson(response, status, payload, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large"), { status: 413 });

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw Object.assign(new Error("Request body is too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

function isLoopback(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

export function createRemoteHttpServer({
  api,
  authToken,
  host = "127.0.0.1",
  port = 8765,
  allowedHosts,
  allowedOrigins = [],
  tlsKey,
  tlsCert,
  trustedProxy = false,
  allowInsecureHttp = false,
}) {
  if (typeof authToken !== "string" || authToken.length < 32) {
    throw new Error("MCP_AUTH_TOKEN must be at least 32 characters for HTTP mode");
  }
  if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error("Set both MCP_TLS_KEY and MCP_TLS_CERT, or neither");
  if (!tlsCert && !isLoopback(host) && !trustedProxy && !allowInsecureHttp) {
    throw new Error("HTTP mode on a non-loopback interface requires TLS certificates or an explicitly trusted TLS-terminating proxy");
  }
  if (!isLoopback(host) && !allowedHosts?.length) {
    throw new Error("Set MCP_ALLOWED_HOSTS to the exact HTTP Host values accepted by this server");
  }

  const safeHosts = allowedHosts?.length
    ? allowedHosts.map((value) => value.toLowerCase())
    : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  const origins = allowedOrigins ?? [];

  const handler = async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const hostHeader = request.headers.host?.toLowerCase();
    if (!hostHeader || !safeHosts.includes(hostHeader)) return responseJson(response, 403, { error: "Host not allowed" });
    const origin = request.headers.origin;
    if (origin && !origins.includes(origin)) return responseJson(response, 403, { error: "Origin not allowed" });
    if (requestUrl.pathname === "/health" && request.method === "GET") {
      return responseJson(response, 200, { status: "ok" });
    }
    if (requestUrl.pathname !== "/mcp") return responseJson(response, 404, { error: "Not found" });
    if (!bearerMatches(request.headers.authorization, authToken)) {
      return responseJson(response, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
    }
    if (request.method === "GET") {
      response.writeHead(405, { Allow: "POST", "Content-Type": "application/json; charset=utf-8" });
      return response.end(JSON.stringify({ error: "Server-initiated SSE is not supported" }));
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Content-Type": "application/json; charset=utf-8" });
      return response.end(JSON.stringify({ error: "Method not allowed" }));
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return responseJson(response, error.status ?? 400, { error: error.message });
    }

    const mcpServer = createNametagMcpServer(api);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: safeHosts,
      allowedOrigins: origins,
    });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) responseJson(response, 500, { error: "MCP request failed" });
      else response.destroy(error);
      console.error(`MCP HTTP request failed: ${error.message}`);
    } finally {
      if (response.writableEnded || response.destroyed) {
        await mcpServer.close().catch(() => {});
      } else {
        response.once("finish", () => mcpServer.close().catch(() => {}));
        response.once("close", () => mcpServer.close().catch(() => {}));
      }
    }
  };

  if (tlsCert) {
    return createHttpsServer({ key: tlsKey, cert: tlsCert }, handler);
  }
  return createHttpServer(handler);
}
