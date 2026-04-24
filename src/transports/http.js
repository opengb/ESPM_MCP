/**
 * HTTP transport factory for the ESPM MCP server.
 *
 * Starts a Streamable HTTP endpoint at POST /mcp. Runs stateless: one fresh
 * MCP server + transport per request, no session IDs.
 *
 * Binds to 127.0.0.1 by default. Optional auth: either HTTP Basic
 * (`basicAuth: { user, pass }`) or OAuth 2.0 bearer tokens validated via
 * RFC 7662 introspection (`oauth: { introspectionUrl, clientId, ... }`).
 * At most one of the two may be enabled; omit both for an unauthed endpoint.
 * For TLS, still put a reverse proxy in front — Basic auth alone is cleartext.
 */

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createEspmServer } from "../server.js";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function writeJsonRpcError(res, status, code, message, extraHeaders) {
  const headers = { "Content-Type": "application/json", ...(extraHeaders || {}) };
  res.writeHead(status, headers);
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function checkBasicAuth(req, expectedDigest) {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return false;
  const [scheme, encoded] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) return false;
  let submitted;
  try {
    submitted = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }
  const submittedDigest = sha256(submitted);
  if (submittedDigest.length !== expectedDigest.length) return false;
  return timingSafeEqual(submittedDigest, expectedDigest);
}

const REALM = "ESPM MCP";

function bearerChallenge({ error, description, scope } = {}) {
  const parts = [`realm="${REALM}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  if (scope) parts.push(`scope="${scope}"`);
  return `Bearer ${parts.join(", ")}`;
}

async function introspectToken(token, config) {
  const body = new URLSearchParams({ token, token_type_hint: "access_token" });
  const creds = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await fetch(config.introspectionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${creds}`,
    },
    body,
    signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
  });
  if (!res.ok) {
    throw new Error(`introspection endpoint returned ${res.status}`);
  }
  return res.json();
}

async function checkBearerAuth(req, config) {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") {
    return { ok: false, status: 401, challenge: bearerChallenge() };
  }
  const [scheme, token] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
    return {
      ok: false,
      status: 401,
      challenge: bearerChallenge({ error: "invalid_request", description: "Expected Bearer scheme" }),
    };
  }

  let introspection;
  try {
    introspection = await introspectToken(token, config);
  } catch (err) {
    console.error("ESPM MCP OAuth introspection failed:", err);
    return {
      ok: false,
      status: 503,
      challenge: bearerChallenge({ error: "temporarily_unavailable", description: "Token introspection failed" }),
    };
  }

  if (!introspection || introspection.active !== true) {
    return {
      ok: false,
      status: 401,
      challenge: bearerChallenge({ error: "invalid_token", description: "Token is not active" }),
    };
  }

  if (config.requiredAudience) {
    const aud = introspection.aud;
    const auds = Array.isArray(aud) ? aud : aud ? [aud] : [];
    if (!auds.includes(config.requiredAudience)) {
      return {
        ok: false,
        status: 401,
        challenge: bearerChallenge({ error: "invalid_token", description: "Audience mismatch" }),
      };
    }
  }

  if (config.requiredScope) {
    const scopes = typeof introspection.scope === "string"
      ? introspection.scope.split(/\s+/).filter(Boolean)
      : [];
    if (!scopes.includes(config.requiredScope)) {
      return {
        ok: false,
        status: 403,
        challenge: bearerChallenge({
          error: "insufficient_scope",
          description: "Missing required scope",
          scope: config.requiredScope,
        }),
      };
    }
  }

  return { ok: true };
}

export function createHttpTransport({
  port = 3000,
  host = "127.0.0.1",
  basicAuth = null,
  oauth = null,
} = {}) {
  if (basicAuth && oauth) {
    throw new Error("createHttpTransport: basicAuth and oauth cannot both be configured");
  }
  const expectedDigest = basicAuth ? sha256(`${basicAuth.user}:${basicAuth.pass}`) : null;
  const basicRealm = `Basic realm="${REALM}"`;

  const httpServer = createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url !== "/mcp") {
      writeJsonRpcError(res, 404, -32601, "Not found");
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      writeJsonRpcError(res, 405, -32000, "Method not allowed");
      return;
    }
    if (expectedDigest && !checkBasicAuth(req, expectedDigest)) {
      writeJsonRpcError(res, 401, -32001, "Unauthorized", { "WWW-Authenticate": basicRealm });
      return;
    }
    if (oauth) {
      const result = await checkBearerAuth(req, oauth);
      if (!result.ok) {
        writeJsonRpcError(res, result.status, -32001, "Unauthorized", {
          "WWW-Authenticate": result.challenge,
        });
        return;
      }
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      writeJsonRpcError(res, 400, -32700, "Parse error");
      return;
    }

    const server = createEspmServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("ESPM MCP HTTP request failed:", err);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, "Internal error");
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      const authNote = expectedDigest
        ? " (Basic auth enabled)"
        : oauth
          ? " (OAuth enabled)"
          : "";
      console.error(`ESPM MCP HTTP server listening on http://${host}:${port}/mcp${authNote}`);
      resolve(httpServer);
    });
  });
}
