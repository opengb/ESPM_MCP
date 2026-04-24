/**
 * HTTP transport factory for the ESPM MCP server.
 *
 * Starts a Streamable HTTP endpoint at POST /mcp. Runs stateless: one fresh
 * MCP server + transport per request, no session IDs.
 *
 * Binds to 127.0.0.1 by default. Optional HTTP Basic auth can be enabled by
 * passing `basicAuth: { user, pass }`; if omitted the endpoint is unauthed.
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

export function createHttpTransport({ port = 3000, host = "127.0.0.1", basicAuth = null } = {}) {
  const expectedDigest = basicAuth ? sha256(`${basicAuth.user}:${basicAuth.pass}`) : null;
  const authRealm = 'Basic realm="ESPM MCP"';

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
      writeJsonRpcError(res, 401, -32001, "Unauthorized", { "WWW-Authenticate": authRealm });
      return;
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
      const authNote = expectedDigest ? " (Basic auth enabled)" : "";
      console.error(`ESPM MCP HTTP server listening on http://${host}:${port}/mcp${authNote}`);
      resolve(httpServer);
    });
  });
}
