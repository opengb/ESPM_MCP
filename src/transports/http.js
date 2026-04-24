/**
 * HTTP transport factory for the ESPM MCP server.
 *
 * Starts a Streamable HTTP endpoint at POST /mcp. Runs stateless: one fresh
 * MCP server + transport per request, no session IDs.
 *
 * Binds to 127.0.0.1 by default. Optional auth: either HTTP Basic
 * (`basicAuth: { user, pass }`) or OAuth 2.0 bearer tokens verified as JWTs
 * against a remote JWKS (`oauth: { jwksUrl, issuer, audience, ... }`).
 * At most one of the two may be enabled; omit both for an unauthed endpoint.
 * For TLS, still put a reverse proxy in front — Basic auth alone is cleartext.
 */

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
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

async function verifyJwt(req, config, jwks) {
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

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: 30,
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid) {
      console.error("ESPM MCP JWKS unavailable:", err);
      return {
        ok: false,
        status: 503,
        challenge: bearerChallenge({ error: "temporarily_unavailable", description: "JWKS unavailable" }),
      };
    }
    if (err instanceof joseErrors.JOSEError) {
      return {
        ok: false,
        status: 401,
        challenge: bearerChallenge({ error: "invalid_token", description: err.message }),
      };
    }
    console.error("ESPM MCP JWT verification failed:", err);
    return {
      ok: false,
      status: 503,
      challenge: bearerChallenge({ error: "temporarily_unavailable", description: "JWT verification failed" }),
    };
  }

  if (config.requiredScope) {
    const scopes = typeof payload.scope === "string"
      ? payload.scope.split(/\s+/).filter(Boolean)
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
  const jwks = oauth ? createRemoteJWKSet(new URL(oauth.jwksUrl)) : null;
  const protectedResourceMetadata = oauth
    ? JSON.stringify({
        resource: oauth.resourceUrl,
        authorization_servers: oauth.authorizationServers,
        scopes_supported: oauth.scopes,
        bearer_methods_supported: ["header"],
      })
    : null;

  const httpServer = createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];

    if (url === "/.well-known/oauth-protected-resource" && oauth) {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(protectedResourceMetadata);
      return;
    }

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
      const result = await verifyJwt(req, oauth, jwks);
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
