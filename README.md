# ESPM MCP — Energy Star Portfolio Manager for Claude

An open-source MCP (Model Context Protocol) server that connects Claude directly to your Energy Star Portfolio Manager account. Explore what's possible when AI meets sustainability data in plain language instead of exporting spreadsheets.

> Built by Nikolas Mirando as an independent prototype exploring AI + sustainability data infrastructure in CRE.

---

## What you can ask Claude

Once connected, you can ask things like:

- *"What is the average ENERGY STAR score for my office properties?"*
- *"Which of my properties are below a score of 50?"*
- *"Show me energy use intensity across my multifamily assets, ranked worst to best."*
- *"How many of my properties have ENERGY STAR certification?"*
- *"Give me a portfolio summary — scores and EUI across all my properties."*

---

## How it works

Your credentials stay **on your machine**. The MCP server runs locally, calls the ESPM API using your credentials, and returns your data to Claude. Nothing touches any third-party server.
For demonstration and educational purposes only. This is not an official ENERGY STAR, EPA, or employer-sponsored system. Users authenticate with their own ENERGY STAR credentials locally; no data is stored or transmitted by this project.

```
Claude (your question)
  → MCP server (runs locally on your machine)
    → ESPM API (using your credentials from accounts.csv)
      → Your portfolio data only
        → Claude answers your question
```

---

## Requirements

- [Node.js](https://nodejs.org) v18 or higher
- [Claude Desktop](https://claude.ai/download)
- An Energy Star Portfolio Manager account with API access enabled (see below)

---

## Setup

### Step 1 — Enable API access in ESPM

You need to enable web services on your ESPM account before the API will work.

**For the test environment (try it immediately with sample data):**
1. Log in to the [ESPM Test environment](https://portfoliomanager.energystar.gov/pm/login_test.html)
2. Go to **Account Settings** → **Software Development** tab
3. Select **"Yes"** for *"Will this account be used to test web services?"*
4. Click **Start Using the Test Environment**

**For your live portfolio (requires EPA approval):**
1. Log in to [Portfolio Manager](https://portfoliomanager.energystar.gov)
2. Go to **Account Settings** → **Software Development** tab
3. Fill out the registration form to request live API access
4. EPA will review and approve — typically within a few business days

### Step 2 — Clone and install

```bash
git clone https://github.com/nikmirando1/ESPM_MCP.git
cd ESPM_MCP
npm install
```

### Step 3 — Add your credentials

Credentials live in a read-only CSV file.

1. Copy the example:

   ```bash
   cp accounts.csv.example accounts.csv
   ```

2. Edit `accounts.csv`. Columns are `username,password,env` (set `env` to
   `test` or `live` per row):

   ```csv
   username,password,env
   alice@example.com,pass1,test
   bob@example.com,pass2,live
   ```

3. By default the server looks for `accounts.csv` in the repo root. Override
   with the `ESPM_ACCOUNTS_CSV` env var if you'd rather keep it elsewhere
   (e.g. in `.env`, see `env.example`).

4. Every tool accepts an `account_name` parameter — pass the `username` value
   from the CSV to pick which account to use. If the CSV contains exactly one
   account, you can omit `account_name` and the server uses that account;
   otherwise `account_name` is required.

The CSV is only ever read; the server never writes to it. Restart the server
after editing it.

### Step 4 — Connect to Claude

**Option A: Claude Code (CLI)**

If you use [Claude Code](https://claude.ai/code), register the server with one
command (update the path to where you cloned the repo):

```bash
claude mcp add espm -- node /absolute/path/to/ESPM_MCP/src/main.js
```

Add `-s user` to make it available across all projects, or `-s project` to
share it with collaborators via a checked-in `.mcp.json`. Verify with
`claude mcp list`.

**Option B: Claude Desktop**

Open your Claude Desktop config file:

- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this entry (update the path to where you cloned the repo):

```json
{
  "mcpServers": {
    "espm": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/ESPM_MCP/src/main.js"]
    }
  }
}
```

### Step 5 — Restart Claude and start asking

Restart Claude Desktop (or reload your Claude Code session). You'll see the
ESPM tools available. Start asking questions about your portfolio.

---

## Running as an HTTP MCP server

The server also speaks the MCP **Streamable HTTP** transport, so you can run it
as a long-lived process and point any HTTP-capable MCP client (hosted Claude,
custom clients, etc.) at it instead of spawning a stdio subprocess.

### Start it

```bash
npm run start:http
# ESPM MCP HTTP server listening on http://127.0.0.1:3000/mcp
```

Or directly: `node src/main.js http`

Env vars (all optional, see `env.example`):

- `MCP_HTTP_PORT` — port to listen on (default `3000`)
- `MCP_HTTP_HOST` — interface to bind (default `127.0.0.1`)
- `MCP_HTTP_BASIC_AUTH_USER` / `MCP_HTTP_BASIC_AUTH_PASS` — enable HTTP Basic auth on `/mcp` (must be set together; see "Enable HTTP Basic auth" below)
- `MCP_HTTP_OAUTH_JWKS_URL` / `MCP_HTTP_OAUTH_ISSUER` / `MCP_HTTP_OAUTH_AUDIENCE` — enable OAuth 2.0 Bearer auth on `/mcp` via local JWT verification (see "Enable OAuth" below). Mutually exclusive with Basic auth.

The endpoint is `POST /mcp`. The server runs **stateless** — no session IDs,
one request/response per call — which keeps things simple and works for every
ESPM tool this server exposes.

### Smoke-test with curl

```bash
curl -sS -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should get back the list of all ESPM tools.

### Enable HTTP Basic auth

The `/mcp` endpoint is unauthed by default. To require HTTP Basic auth, set
both `MCP_HTTP_BASIC_AUTH_USER` and `MCP_HTTP_BASIC_AUTH_PASS` before starting
the server. They can be exported, passed inline, or put in `.env`
(see `env.example`). Setting only one of them fails fast at startup.

```bash
MCP_HTTP_BASIC_AUTH_USER=alice MCP_HTTP_BASIC_AUTH_PASS=secret npm run start:http
# ESPM MCP HTTP server listening on http://127.0.0.1:3000/mcp (Basic auth enabled)
```

Hit the protected endpoint with `curl -u`:

```bash
curl -sS -u alice:secret -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Missing or wrong credentials return `401` with a
`WWW-Authenticate: Basic realm="ESPM MCP"` challenge. Basic auth is cleartext
over HTTP, so if you're exposing the server beyond localhost put it behind a
reverse proxy that terminates TLS.

### Enable OAuth

Instead of Basic auth, the `/mcp` endpoint can require OAuth 2.0 Bearer
tokens, verified locally as JWTs against the identity provider's JWKS. On
each request the server checks the token's signature, `iss`, `aud`, and `exp`
(with 30s clock tolerance) against the configured JWKS, issuer, and audience.

All four settings below must be set together:

- `MCP_HTTP_PUBLIC_URL` — the server's public HTTPS base URL (no trailing slash), e.g. `https://your-server.com`. Used to serve `/.well-known/oauth-protected-resource` so MCP clients can discover the authorization server automatically.
- `MCP_HTTP_OAUTH_JWKS_URL` — the IdP's JWKS endpoint
- `MCP_HTTP_OAUTH_ISSUER` — expected `iss` claim; comma-separated list if the IdP emits more than one
- `MCP_HTTP_OAUTH_AUDIENCE` — expected `aud` claim (typically your OAuth client ID)

Optionally:

- `MCP_HTTP_OAUTH_REQUIRED_SCOPE` — require a specific value in the token's `scope` claim (ignored for token types that omit `scope`, such as Google ID tokens)

**Google Auth Platform example** — verify Google-issued ID tokens intended for
your OAuth 2.0 Web Client:

```bash
MCP_HTTP_PUBLIC_URL=https://your-server.com \
MCP_HTTP_OAUTH_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs \
MCP_HTTP_OAUTH_ISSUER="https://accounts.google.com,accounts.google.com" \
MCP_HTTP_OAUTH_AUDIENCE=1234567890-abc.apps.googleusercontent.com \
npm run start:http
# ESPM MCP HTTP server listening on http://127.0.0.1:3000/mcp (OAuth enabled)
```

The `AUDIENCE` value is the OAuth 2.0 Client ID from your Google Cloud Auth
Platform credentials (looks like `<number>-<hash>.apps.googleusercontent.com`).
Google emits both `https://accounts.google.com` and `accounts.google.com` as
the `iss` claim depending on the flow, so list both.

The server automatically exposes `GET /.well-known/oauth-protected-resource`
pointing at `https://accounts.google.com` as the authorization server. MCP
clients (including Claude's custom connector UI) fetch this on first connection
to discover where to get a token — you don't need to configure it separately in
the client.

Hit the protected endpoint with the ID token as a Bearer credential:

```bash
curl -sS -X POST http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Failures return a `WWW-Authenticate: Bearer ...` challenge per
[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750): `invalid_request` (missing
or malformed Authorization header), `invalid_token` (bad signature, expired,
wrong issuer/audience), `insufficient_scope` (required scope missing), or
`temporarily_unavailable` (`503`) when the JWKS endpoint itself is unreachable.

OAuth and Basic auth are mutually exclusive — configuring both fails at
startup. JWTs are verified locally against a cached JWKS, so there's no
network call on the hot path after the first fetch. Access tokens are not
revocation-checked — they remain accepted until `exp`. If you need faster
revocation, keep token lifetimes short at the IdP.

The server still accepts cleartext HTTP, so terminate TLS at a reverse proxy
in front of it when exposing the endpoint beyond localhost.

Register it with Claude Code using the `http` transport and a Bearer header:

```bash
claude mcp add --transport http espm http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $ID_TOKEN"
```

### Connect Claude Code to the HTTP server

With the HTTP server running, register it with Claude Code using the `http`
transport:

```bash
claude mcp add --transport http espm http://127.0.0.1:3000/mcp
```

If you enabled Basic auth, pass the credentials as a header:

```bash
claude mcp add --transport http espm http://127.0.0.1:3000/mcp \
  --header "Authorization: Basic $(printf '%s:%s' alice secret | base64)"
```

Add `-s user` or `-s project` to change the scope. Verify with
`claude mcp list`.

### Security

There is **no built-in auth unless you opt in** via `MCP_HTTP_BASIC_AUTH_USER`
/ `MCP_HTTP_BASIC_AUTH_PASS` (see above). By default the server binds to
`127.0.0.1`, so only processes on the same machine can reach it. If you want
to expose it more broadly, enable Basic auth **and** put it behind a reverse
proxy (nginx, Caddy, Cloudflare Tunnel, etc.) that terminates TLS — Basic auth
alone is cleartext and offers no protection in transit. Don't bind to a public
interface without a proxy.

Credentials still come from `accounts.csv` the same way they do in stdio mode.

### Run in Docker

A `Dockerfile` is included that runs the server in HTTP mode.

```bash
docker build -t espm-mcp .
docker run --rm -p 3000:3000 \
  -v "$(pwd)/accounts.csv:/app/accounts.csv:ro" \
  espm-mcp
```

The container binds to `0.0.0.0:3000` inside the container (published on the
host via `-p`). `accounts.csv` is mounted read-only so credentials aren't baked
into the image. Override port/host with `-e MCP_HTTP_PORT=...` /
`-e MCP_HTTP_HOST=...`, and enable Basic auth with
`-e MCP_HTTP_BASIC_AUTH_USER=... -e MCP_HTTP_BASIC_AUTH_PASS=...` if needed.

Basic auth alone is cleartext, so don't publish the port to a public interface
without a reverse proxy terminating TLS in front.

---

## Available tools

| Tool | What it does |
|------|-------------|
| `list_accounts` | List the ESPM accounts configured in `accounts.csv` (does not hit the API) |
| `get_account` | Confirm you're connected and see your account info |
| `list_properties` | List all property IDs in your account |
| `get_property` | Get details for a specific property |
| `get_property_metrics` | Get score, EUI, and GHG emissions for a property |
| `list_property_groups` | List all your property groups |
| `get_property_group` | Get details for a specific group |
| `get_group_score_summary` | Average score, min/max, and full breakdown for a group |
| `get_portfolio_summary` | Portfolio-wide summary across all properties |
| `get_energy_star_certification_summary` | Count properties certified in a specific year using ESPM certification metrics |

---

## Cost

- **This repo:** Free
- **ESPM API:** Free
- **Claude Desktop:** Requires a Claude subscription (Pro or above)
- **Hosting:** None — runs entirely on your machine

---

## Privacy

Your ESPM credentials are stored only in the `accounts.csv` file on your local machine. They are never transmitted to any server other than the official ESPM API (`portfoliomanager.energystar.gov`). This MCP has no backend, no telemetry, and no external dependencies beyond the ESPM API itself.

---

## A note on ESPM's future

As of early 2026, there is ongoing uncertainty around federal funding for the ENERGY STAR program. This MCP was partly built to illustrate a broader point: the AI tooling is ready, but the data access layer is often the bottleneck. Whether ESPM continues as-is or evolves, the pattern demonstrated here, connecting sustainability data to conversational AI, is one the CRE industry should be building toward.

---

## Contributing

PRs welcome. Particularly interested in:
- Additional metrics endpoints (water, waste, carbon)
- Support for sharing/connection workflows
- Better error handling for large portfolios

---

## License

MIT
