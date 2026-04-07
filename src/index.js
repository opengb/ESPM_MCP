#!/usr/bin/env node

/**
 * ESPM MCP Server
 * Connects Claude to Energy Star Portfolio Manager
 * https://github.com/YOUR_USERNAME/espm-mcp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { parseStringPromise } from "xml2js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env manually (lightweight, no external dep needed beyond dotenv)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "../.env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join("=").trim();
    }
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

const USERNAME = process.env.ESPM_USERNAME;
const PASSWORD = process.env.ESPM_PASSWORD;
const ENV = process.env.ESPM_ENV || "test";

const BASE_URL =
  ENV === "live"
    ? "https://portfoliomanager.energystar.gov/ws"
    : "https://portfoliomanager.energystar.gov/wstest";

// ─── ESPM API Client ─────────────────────────────────────────────────────────

function authHeader() {
  const encoded = Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");
  return `Basic ${encoded}`;
}

async function espmGet(path) {
  if (!USERNAME || !PASSWORD) {
    throw new Error(
      "ESPM credentials not configured. Copy .env.example to .env and add your username and password."
    );
  }

  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: authHeader(),
      Accept: "application/xml",
      "Content-Type": "application/xml",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ESPM API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const xml = await response.text();
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    ignoreAttrs: false,
    mergeAttrs: true,
  });
  return parsed;
}

// ─── Data Helpers ────────────────────────────────────────────────────────────

function safeNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function extractProperties(data) {
  // Handle both single property and array
  const links = data?.response?.links?.link;
  if (!links) return [];
  return Array.isArray(links) ? links : [links];
}

function formatProperty(prop) {
  return {
    id: prop?.id || prop?.["$"]?.id,
    name: prop?.name || prop?.["$"]?.name || "Unknown",
    address: prop?.address
      ? `${prop.address?.address1 || ""}, ${prop.address?.city || ""}, ${prop.address?.state || ""}`
      : null,
    grossFloorArea: prop?.grossFloorArea?.value || prop?.grossFloorArea || null,
    primaryFunction: prop?.primaryFunction || null,
    yearBuilt: prop?.yearBuilt || null,
    constructionStatus: prop?.constructionStatus || null,
  };
}

// ─── Tool Implementations ────────────────────────────────────────────────────

async function getAccount() {
  const data = await espmGet("/account");
  const account = data?.account;
  return {
    id: account?.id,
    username: account?.username,
    name: `${account?.contact?.firstName} ${account?.contact?.lastName}`,
    organization: account?.organization?.name,
    email: account?.contact?.email,
    environment: ENV,
  };
}

async function listProperties() {
  const data = await espmGet("/account/properties");
  const links = data?.response?.links?.link;
  if (!links) return [];

  const propertyLinks = Array.isArray(links) ? links : [links];

  // Extract IDs from the href links
  const properties = propertyLinks.map((link) => {
    const href = link?._ || link?.href || (typeof link === "string" ? link : "");
    const id = href.split("/").pop();
    return { id, href };
  });

  return properties;
}

async function getProperty(propertyId) {
  const data = await espmGet(`/property/${propertyId}`);
  return formatProperty(data?.property);
}

async function getPropertyMetrics(propertyId, year, month) {
  const y = year || new Date().getFullYear() - 1;
  const m = month || 12;
  const data = await espmGet(
    `/property/${propertyId}/metrics?year=${y}&month=${m}&measurementSystem=EPA`
  );

  const metrics = data?.propertyMetrics?.metric;
  if (!metrics) return { propertyId, year: y, month: m, metrics: {} };

  const metricList = Array.isArray(metrics) ? metrics : [metrics];
  const result = {};
  for (const metric of metricList) {
    const name = metric?.name || metric?.["$"]?.name;
    const value = metric?.value || metric?.value?._ || null;
    if (name) result[name] = safeNum(value) ?? value;
  }

  return { propertyId, year: y, month: m, metrics: result };
}

async function listPropertyGroups() {
  const data = await espmGet("/account/propertyGroups");
  const groups = data?.response?.links?.link;
  if (!groups) return [];
  const groupList = Array.isArray(groups) ? groups : [groups];
  return groupList.map((g) => {
    const href = g?._ || g?.href || (typeof g === "string" ? g : "");
    const id = href.split("/").pop();
    return { id, href };
  });
}

async function getPropertyGroup(groupId) {
  const data = await espmGet(`/propertyGroup/${groupId}`);
  const group = data?.propertyGroup;
  return {
    id: group?.id,
    name: group?.name,
    description: group?.description || null,
  };
}

async function getGroupProperties(groupId) {
  const data = await espmGet(`/propertyGroup/${groupId}/properties`);
  const links = data?.response?.links?.link;
  if (!links) return [];
  const list = Array.isArray(links) ? links : [links];
  return list.map((l) => {
    const href = l?._ || l?.href || (typeof l === "string" ? l : "");
    return href.split("/").pop();
  });
}

async function getPortfolioSummary() {
  // Get all properties and pull metrics for each — builds a portfolio-level view
  const props = await listProperties();
  const year = new Date().getFullYear() - 1;

  const summaries = [];
  // Limit to first 50 to avoid very long runtime on huge portfolios
  const sample = props.slice(0, 50);

  for (const p of sample) {
    try {
      const [details, metricsData] = await Promise.all([
        getProperty(p.id),
        getPropertyMetrics(p.id, year, 12),
      ]);
      summaries.push({
        id: p.id,
        name: details.name,
        address: details.address,
        primaryFunction: details.primaryFunction,
        grossFloorArea: details.grossFloorArea,
        score: metricsData.metrics?.score ?? null,
        siteEUI: metricsData.metrics?.siteIntensity ?? null,
        sourceEUI: metricsData.metrics?.sourceIntensity ?? null,
        ghgEmissions: metricsData.metrics?.totalGHGEmissions ?? null,
      });
    } catch {
      summaries.push({ id: p.id, error: "Could not retrieve data" });
    }
  }

  return {
    totalPropertiesInAccount: props.length,
    sampledCount: sample.length,
    year,
    properties: summaries,
  };
}

async function getGroupScoreSummary(groupId) {
  const [groupInfo, propertyIds] = await Promise.all([
    getPropertyGroup(groupId),
    getGroupProperties(groupId),
  ]);

  const year = new Date().getFullYear() - 1;
  const scores = [];

  for (const id of propertyIds) {
    try {
      const [details, metricsData] = await Promise.all([
        getProperty(id),
        getPropertyMetrics(id, year, 12),
      ]);
      scores.push({
        id,
        name: details.name,
        score: metricsData.metrics?.score ?? null,
        siteEUI: metricsData.metrics?.siteIntensity ?? null,
        primaryFunction: details.primaryFunction,
      });
    } catch {
      scores.push({ id, error: "Could not retrieve" });
    }
  }

  const validScores = scores.filter((s) => s.score !== null).map((s) => s.score);
  const avg =
    validScores.length > 0
      ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
      : null;

  return {
    group: groupInfo,
    year,
    totalProperties: propertyIds.length,
    propertiesWithScores: validScores.length,
    averageScore: avg,
    minScore: validScores.length ? Math.min(...validScores) : null,
    maxScore: validScores.length ? Math.max(...validScores) : null,
    properties: scores.sort((a, b) => (a.score ?? 0) - (b.score ?? 0)),
  };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "espm-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_account",
      description:
        "Get your ESPM account info — name, organization, and which environment you're connected to (test vs live).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_properties",
      description:
        "List all property IDs in your ESPM account. Use this to discover what properties you have, then call get_property for details.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_property",
      description:
        "Get details for a specific property by ID: name, address, gross floor area, primary function, year built.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: {
            type: "string",
            description: "The ESPM property ID",
          },
        },
        required: ["property_id"],
      },
    },
    {
      name: "get_property_metrics",
      description:
        "Get energy metrics for a specific property: ENERGY STAR score, site EUI, source EUI, GHG emissions. Defaults to the most recent full year.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: {
            type: "string",
            description: "The ESPM property ID",
          },
          year: {
            type: "number",
            description: "Year to retrieve metrics for (defaults to last full year)",
          },
          month: {
            type: "number",
            description: "Month to retrieve metrics for (defaults to 12)",
          },
        },
        required: ["property_id"],
      },
    },
    {
      name: "list_property_groups",
      description:
        "List all property groups in your account (e.g. APG, IMPACT Fund, asset type groups). Returns group IDs you can use with other tools.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_property_group",
      description: "Get the name and details of a specific property group by ID.",
      inputSchema: {
        type: "object",
        properties: {
          group_id: {
            type: "string",
            description: "The ESPM property group ID",
          },
        },
        required: ["group_id"],
      },
    },
    {
      name: "get_group_score_summary",
      description:
        "Get a full score summary for a property group — average ENERGY STAR score, min/max, and per-property breakdown. Perfect for questions like 'what is the average score for my IMPACT Fund properties?'",
      inputSchema: {
        type: "object",
        properties: {
          group_id: {
            type: "string",
            description: "The ESPM property group ID",
          },
        },
        required: ["group_id"],
      },
    },
    {
      name: "get_portfolio_summary",
      description:
        "Get a high-level summary of your entire portfolio — scores, EUI, and property details across all properties (samples up to 50). Good for 'what does my portfolio look like overall?' questions.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "get_account":
        result = await getAccount();
        break;
      case "list_properties":
        result = await listProperties();
        break;
      case "get_property":
        result = await getProperty(args.property_id);
        break;
      case "get_property_metrics":
        result = await getPropertyMetrics(args.property_id, args.year, args.month);
        break;
      case "list_property_groups":
        result = await listPropertyGroups();
        break;
      case "get_property_group":
        result = await getPropertyGroup(args.group_id);
        break;
      case "get_group_score_summary":
        result = await getGroupScoreSummary(args.group_id);
        break;
      case "get_portfolio_summary":
        result = await getPortfolioSummary();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
