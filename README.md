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

### Step 4 — Connect to Claude Desktop

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

### Step 5 — Restart Claude Desktop and start asking

Restart Claude Desktop. You'll see the ESPM tools available. Start asking questions about your portfolio.

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

Env vars (both optional, see `env.example`):

- `MCP_HTTP_PORT` — port to listen on (default `3000`)
- `MCP_HTTP_HOST` — interface to bind (default `127.0.0.1`)

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

### Security

There is **no built-in auth** on the HTTP endpoint. By default it binds to
`127.0.0.1`, so only processes on the same machine can reach it. If you want
to expose it more broadly, put it behind a reverse proxy (nginx, Caddy,
Cloudflare Tunnel, etc.) that handles TLS and authentication for you. Don't
bind to a public interface without one.

Credentials still come from `accounts.csv` the same way they do in stdio mode.

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
