# Nametag MCP

A stdio or remote Streamable HTTP MCP server that connects assistants to a Nametag instance through its REST API. It does not connect directly to PostgreSQL; Nametag remains responsible for data validation, permissions, and API-token scopes.

## Local Nametag stack

From this directory, create `.env` from `.env.example`, replace the secrets, and set `NAMETAG_API_TOKEN` after creating a personal token in **Settings → API Tokens**:

```sh
cp .env.example .env
# Edit .env and replace all placeholder values.
docker compose up -d
```

The Compose file runs PostgreSQL 16 Alpine and `ghcr.io/mattogodoy/nametag:0.63.0`. Nametag is available at `http://localhost:3000`; ports bind to localhost. Register the first Nametag account in the browser, then create an API token. API tokens are bearer credentials and should be kept private.

## Run the MCP server

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

The server reads `NAMETAG_URL` (defaults to `http://localhost:3000`) and `NAMETAG_API_TOKEN` from its environment. For a local stdio MCP client, configure command `node`, args `["--env-file=/absolute/path/to/nametag-mcp/.env", "/absolute/path/to/nametag-mcp/src/index.js"]`.

Alternatively, run the MCP server in Docker after adding your token to `.env`:

```sh
docker compose --profile mcp build mcp
docker compose --profile mcp run --rm --no-deps mcp
```

For an MCP client using the Docker option, use command `docker` and args `["compose", "--profile", "mcp", "run", "--rm", "--no-deps", "-T", "mcp"]` from this directory.

## Remote MCP over the LAN

For Hermes on a different host, run the MCP in **HTTP mode** on the MCP host. Do not expose plain HTTP directly to the LAN. Use HTTPS from Hermes to a TLS reverse proxy, keep the MCP listener bound to loopback, and retain the MCP bearer-token check as a second layer. A VPN/private firewall is also recommended.

Generate a separate high-entropy `MCP_AUTH_TOKEN` for Hermes (the Nametag API token is a different credential), and set these in `.env` on the MCP host:

```dotenv
MCP_TRANSPORT=http
MCP_HOST=127.0.0.1
MCP_PORT=8765
MCP_AUTH_TOKEN=<at-least-32-random-characters>
MCP_ALLOWED_HOSTS=mcp.example.lan
MCP_TRUSTED_PROXY=true
NAMETAG_URL=https://your-nametag-host.example.lan
NAMETAG_API_TOKEN=ntag_<your-nametag-token>
```

`MCP_TRUSTED_PROXY=true` is only for a TLS-terminating proxy on the same host. Keep the MCP port private; the supplied Compose configuration binds its published MCP port to `127.0.0.1` only. For example, Caddy can terminate TLS and forward requests:

```caddyfile
mcp.example.lan {
    tls internal
    reverse_proxy 127.0.0.1:8765
}
```

Configure Hermes with the MCP URL `https://mcp.example.lan/mcp` and `Authorization: Bearer <MCP_AUTH_TOKEN>`. Install/trust the reverse proxy's certificate authority on the Hermes host. `MCP_ALLOWED_HOSTS` is an exact Host-header allowlist; include the external hostname (and port if non-standard). Browser-based clients that send an `Origin` header must also be listed in `MCP_ALLOWED_ORIGINS`; requests with no Origin, as sent by native clients, are allowed.

For the Compose MCP service, set `MCP_TRANSPORT=http`, `MCP_AUTH_TOKEN`, and `MCP_ALLOWED_HOSTS` in `.env`, set `MCP_NAMETAG_URL` to the Nametag URL reachable from that container, then start only the MCP service with `docker compose --profile mcp up -d mcp`. The host-side MCP listener remains on `127.0.0.1:8765` for the reverse proxy. This service no longer requires the local test Nametag/Postgres containers.

If you bind the HTTP server directly to a LAN interface instead of using a proxy, configure `MCP_TLS_CERT` and `MCP_TLS_KEY` for direct HTTPS. Cleartext non-loopback binding is refused unless `MCP_ALLOW_INSECURE_HTTP=true` is explicitly set; do not use that override for a real deployment.

Nametag tokens support `READ` and `READ_WRITE` scopes. Use `READ` when the assistant only needs to view/search data; it prevents the write tools from changing contacts. Store both tokens in a secret manager or permissions-restricted environment file and rotate/revoke them if exposed.

## Tools

- **People:** list, search, read, create, update, soft-delete, restore.
- **Groups:** list, read, create, update, soft-delete/restore, add/remove members.
- **Relationships:** list/create/update/soft-delete/restore relationships and list/create/update/soft-delete/restore relationship types.
- **Journal:** list/search, read, create, update, and soft-delete entries.
- **Dashboard and map:** health check, stats, graph, and map markers.

Writes follow Nametag's API semantics. Deletion tools use Nametag's reversible soft-delete endpoints. Updates to array-valued person fields replace that field's existing collection. The tested Nametag 0.63 instance requires `relationshipToUserId` when creating a person and a relationship type when updating a relationship; list relationship types before those operations. Do not pass untrusted text as tool instructions; MCP responses are data from the configured Nametag server.

## Tests

The tests use a mock Nametag API and an MCP client to verify request authentication, tool registration, data forwarding, Host/Origin checks, and secure HTTP defaults. They do not need a live Nametag API token. An optional, read-only smoke test can be enabled against a non-production Nametag instance:

```sh
npm test
NAMETAG_INTEGRATION=1 npm run test:live
```

The integration run requires `NAMETAG_URL` and a valid `NAMETAG_API_TOKEN`; otherwise that one test is skipped. It only reads health, one page of people, and relationship types.

An opt-in write integration test creates two uniquely marked people, a group, and a relationship through the remote MCP transport, exercises update/member/delete/restore tools, then permanently removes only those test records. Run it only against a non-production instance with a `READ_WRITE` token:

```sh
NAMETAG_INTEGRATION_WRITES=1 npm run test:write
```

To run them in Docker without installing Node.js on the host:

```sh
docker build -f Dockerfile.test -t nametag-mcp-test .
docker run --rm nametag-mcp-test
```

For a real Nametag integration check, set `NAMETAG_URL` and a dedicated test `NAMETAG_API_TOKEN`, then run the MCP tools against a non-production instance. Never point write tests at personal/production data without explicitly intending the changes.
