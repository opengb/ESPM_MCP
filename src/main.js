#!/usr/bin/env node

/**
 * ESPM MCP Server — unified entry point.
 *
 * Usage:
 *   node src/main.js [stdio|http] [--port <n>] [--host <h>]
 *
 * Transport defaults to `stdio` when omitted.
 * --port and --host are only used for the http transport.
 *
 * https://github.com/nikmirando1/ESPM_MCP
 */

import { createEspmServer } from "./server.js";

const args = process.argv.slice(2);
const transport = args.find((a) => !a.startsWith("--")) ?? "stdio";

function flag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

if (transport === "stdio") {
  const { createStdioTransport } = await import("./transports/stdio.js");
  const server = createEspmServer();
  await server.connect(createStdioTransport());
} else if (transport === "http") {
  const { createHttpTransport } = await import("./transports/http.js");
  const port = Number(flag("port", process.env.MCP_HTTP_PORT ?? "3000"));
  const host = flag("host", process.env.MCP_HTTP_HOST ?? "127.0.0.1");
  const authUser = process.env.MCP_HTTP_BASIC_AUTH_USER;
  const authPass = process.env.MCP_HTTP_BASIC_AUTH_PASS;
  if ((authUser && !authPass) || (!authUser && authPass)) {
    console.error(
      "MCP_HTTP_BASIC_AUTH_USER and MCP_HTTP_BASIC_AUTH_PASS must both be set to enable Basic auth, or both left unset to disable it."
    );
    process.exit(1);
  }
  const basicAuth = authUser && authPass ? { user: authUser, pass: authPass } : null;

  const oauthIntrospectionUrl = process.env.MCP_HTTP_OAUTH_INTROSPECTION_URL;
  const oauthClientId = process.env.MCP_HTTP_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.MCP_HTTP_OAUTH_CLIENT_SECRET;
  const oauthRequiredScope = process.env.MCP_HTTP_OAUTH_REQUIRED_SCOPE;
  const oauthRequiredAudience = process.env.MCP_HTTP_OAUTH_REQUIRED_AUDIENCE;
  if (oauthIntrospectionUrl && (!oauthClientId || !oauthClientSecret)) {
    console.error(
      "MCP_HTTP_OAUTH_INTROSPECTION_URL requires MCP_HTTP_OAUTH_CLIENT_ID and MCP_HTTP_OAUTH_CLIENT_SECRET to authenticate to the introspection endpoint."
    );
    process.exit(1);
  }
  if (!oauthIntrospectionUrl && (oauthClientId || oauthClientSecret || oauthRequiredScope || oauthRequiredAudience)) {
    console.error(
      "MCP_HTTP_OAUTH_* options require MCP_HTTP_OAUTH_INTROSPECTION_URL to be set."
    );
    process.exit(1);
  }
  const oauth = oauthIntrospectionUrl
    ? {
        introspectionUrl: oauthIntrospectionUrl,
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        requiredScope: oauthRequiredScope,
        requiredAudience: oauthRequiredAudience,
      }
    : null;

  if (basicAuth && oauth) {
    console.error(
      "HTTP Basic auth and OAuth cannot both be enabled. Configure either MCP_HTTP_BASIC_AUTH_* or MCP_HTTP_OAUTH_*, not both."
    );
    process.exit(1);
  }

  await createHttpTransport({ port, host, basicAuth, oauth });
} else {
  console.error(`Unknown transport "${transport}". Choose: stdio, http`);
  process.exit(1);
}
