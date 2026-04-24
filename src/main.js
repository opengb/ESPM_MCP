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
  await createHttpTransport({ port, host });
} else {
  console.error(`Unknown transport "${transport}". Choose: stdio, http`);
  process.exit(1);
}
