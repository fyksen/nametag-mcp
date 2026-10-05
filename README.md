# Nametag MCP

An MCP server for Nametag. The recommended setup runs the MCP and a TLS reverse proxy in Docker Compose on one LAN computer; Hermes connects to it over HTTPS from another computer. The MCP talks to an **existing** Nametag instance over its REST API—it does not install Nametag or PostgreSQL.

## Recommended: Docker Compose on the MCP host, Hermes on the LAN

This example uses Caddy to terminate HTTPS with its local CA. Only Caddy's HTTPS port is published to the LAN; the MCP's plain HTTP port is private inside the Compose network. Nametag can be on another machine.

### 1. Prepare the MCP host

Install Docker Engine and the Compose plugin on the computer that will run the MCP. Clone this repository there, then create its MCP-only environment file:

```sh
cp .env.example .env
```

Edit `.env` on that host. At minimum, set:

```dotenv
NAMETAG_URL=https://nametag.home.arpa
NAMETAG_API_TOKEN=ntag_<token-created-in-Nametag>
MCP_AUTH_TOKEN=<a-different-random-secret-of-at-least-32-characters>
MCP_ALLOWED_HOSTS=nametag-mcp.home.arpa
```

Create the Nametag token under **Settings → API Tokens**. Use `READ` scope if Hermes only needs to view/search; use `READ_WRITE` if it must create or change records. Generate a separate MCP access secret, for example with `openssl rand -hex 32`. Never reuse the Nametag token as `MCP_AUTH_TOKEN`.

`NAMETAG_URL` must be reachable and trusted from the MCP container. For a private/self-signed HTTPS certificate, configure Node's trust store on the MCP host/container; do not disable TLS verification.

### 2. Give the MCP host a LAN name

Make `nametag-mcp.home.arpa` resolve to the MCP host's LAN IP using your router/local DNS, or add a hosts-file entry on the Hermes computer. The supplied `Caddyfile` uses that hostname; if you change it, update `Caddyfile` and `MCP_ALLOWED_HOSTS` to match exactly.

### 3. Start the Compose services

From the repository directory on the MCP host:

```sh
docker compose up -d --build
docker compose ps
```

The stack contains only the MCP and Caddy—no Nametag app or database. Caddy publishes HTTPS on port 443. The MCP service has no host-published port and accepts traffic only from Caddy inside the Compose network.

The first run creates Caddy's private local certificate authority. Export **only the public root certificate**:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Transfer `caddy-root.crt` securely to Hermes and trust it on the machine/container that runs Hermes. On Debian/Ubuntu Linux:

```sh
sudo install -m 0644 caddy-root.crt /usr/local/share/ca-certificates/nametag-mcp-local.crt
sudo update-ca-certificates
```

For other operating systems or a containerized Hermes, add the certificate to that environment's trusted CA store. Do **not** copy Caddy's private CA key. `caddy-root.crt` is ignored by Git.

### 4. Connect Hermes

Configure Hermes to use the remote **Streamable HTTP** MCP endpoint:

```text
URL: https://nametag-mcp.home.arpa/mcp
Header: Authorization: Bearer <the-MCP_AUTH_TOKEN-value>
```

Keep the MCP token in Hermes' secret store/configuration, not in a checked-in file. Native MCP clients normally omit an `Origin` header and work with the default empty `MCP_ALLOWED_ORIGINS`; if a browser-based client sends one, list its exact origin in `.env` and restart Compose.

## What runs where

```text
Hermes computer --HTTPS + MCP bearer token--> MCP host:443 (Caddy)
                                                  |
                                                  +-- private Compose network --> Nametag MCP
                                                                                    |
                                                                                    +-- REST + Nametag API token --> existing Nametag
```

Use a firewall/VPN so port 443 is reachable only from trusted LAN clients. HTTPS protects both the MCP bearer token and personal contact data in transit. `MCP_TRUSTED_PROXY=true` is set by Compose only because Caddy is the sole route to the MCP container.

## Other run modes

### Local stdio MCP client

Requires Node.js 20 or newer. With `.env` configured as above:

```sh
npm ci
npm start
```

Configure a local MCP client with command `node` and args `--env-file=/absolute/path/to/nametag-mcp/.env` and `/absolute/path/to/nametag-mcp/src/index.js`, or use Docker stdio:

```sh
docker build -t nametag-mcp .
docker run --rm -i --env-file .env nametag-mcp
```

In Docker, `localhost` means the container itself. Point `NAMETAG_URL` at the Nametag host's reachable DNS name or LAN address.

### Direct HTTPS without Caddy

The HTTP server defaults to loopback and requires `MCP_AUTH_TOKEN`. If binding directly to a LAN interface, provide both `MCP_TLS_CERT` and `MCP_TLS_KEY` for a certificate trusted by Hermes, and set `MCP_ALLOWED_HOSTS`. Cleartext non-loopback binding is refused unless `MCP_ALLOW_INSECURE_HTTP=true` is explicitly enabled; do not use that override for a LAN/production deployment.

## MCP tools

- **People:** list, search, read, create, update, soft-delete, restore.
- **Groups:** list, read, create, update, soft-delete/restore, add/remove members.
- **Relationships:** list/create/update/soft-delete/restore relationships and list/create/update/soft-delete/restore relationship types.
- **Journal:** list/search, read, create, update, and soft-delete entries.
- **Dashboard and map:** health check, stats, graph, and map markers.

Writes follow Nametag's API semantics. Deletes use reversible soft-delete endpoints. Updates to array-valued person fields replace that field's collection. The tested Nametag 0.63 instance requires `relationshipToUserId` when creating a person and a relationship type when updating a relationship; list relationship types before those operations.

## Tests

The default test suite uses a mock Nametag API and MCP client to verify tool registration, request forwarding, HTTP authentication, Host/Origin checks, and secure binding defaults:

```sh
npm test
```

To run tests in Docker without installing Node.js on the host:

```sh
docker build -f Dockerfile.test -t nametag-mcp-test .
docker run --rm nametag-mcp-test
```

Optional live read-only checks use `NAMETAG_URL` and a test `NAMETAG_API_TOKEN`:

```sh
NAMETAG_INTEGRATION=1 npm run test:live
```

An opt-in write test creates uniquely marked people, a group, and a relationship through remote MCP, then permanently removes only the test records. Run only against a non-production instance with a `READ_WRITE` token:

```sh
NAMETAG_INTEGRATION_WRITES=1 npm run test:write
```

## Dependency updates and releases

Renovate is configured in `renovate.json` for npm packages, Dockerfile/Compose images, and GitHub Actions. Install the Renovate GitHub App for this repository to enable its grouped, CI-gated dependency PRs.

Push a version tag matching `package.json` (for example `v0.2.0`) to create a GitHub Release. After publication, `.github/workflows/container.yml` builds `linux/amd64` and `linux/arm64` images and pushes `ghcr.io/fyksen/nametag-mcp:<version>` and `:latest`. The `v0.1.0` release was published before container publishing was added; run **Actions → Publish container → Run workflow** with tag `v0.1.0` once to publish that image. Set the GHCR package to Public in its **Package settings** if anonymous pulls are desired.
