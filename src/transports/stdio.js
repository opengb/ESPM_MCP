/**
 * stdio transport factory for the ESPM MCP server.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function createStdioTransport() {
  return new StdioServerTransport();
}
