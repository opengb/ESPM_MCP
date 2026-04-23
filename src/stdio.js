#!/usr/bin/env node

/**
 * ESPM MCP Server — stdio entry.
 * Connects Claude Desktop (or any other stdio MCP client) to Energy Star
 * Portfolio Manager. For HTTP mode see src/http.js.
 *
 * https://github.com/nikmirando1/ESPM_MCP
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEspmServer } from "./server.js";

const server = createEspmServer();
const transport = new StdioServerTransport();
await server.connect(transport);
