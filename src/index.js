#!/usr/bin/env node

/**
 * ESPM MCP Server
 * Connects Claude to Energy Star Portfolio Manager
 * https://github.com/nikmirando1/ESPM_MCP
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
      let val = valueParts.join("=").replace(/\s+#.*$/, "").trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key.trim()] = val;
    }
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

const csvPath = process.env.ESPM_ACCOUNTS_CSV
  ? process.env.ESPM_ACCOUNTS_CSV
  : join(__dirname, "../accounts.csv");

// Parse a CSV string into an array of records. Handles quoted fields and
// escaped double quotes (""). Strict enough for a credentials file; not a
// full RFC 4180 parser.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.length > 0)) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((v) => v.length > 0)) rows.push(row);
  }
  return rows;
}

function loadAccounts(path) {
  const map = new Map();
  if (!existsSync(path)) return map;

  const records = parseCsv(readFileSync(path, "utf8"));
  if (records.length === 0) return map;

  const header = records[0].map((h) => h.trim().toLowerCase());
  const required = ["username", "password", "env"];
  for (const col of required) {
    if (!header.includes(col)) {
      throw new Error(
        `Accounts CSV at ${path} is missing required column "${col}". Expected columns: username,password,env.`
      );
    }
  }
  const userIdx = header.indexOf("username");
  const passIdx = header.indexOf("password");
  const envIdx = header.indexOf("env");

  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const username = (row[userIdx] || "").trim();
    const password = row[passIdx] || "";
    const env = (row[envIdx] || "").trim() || "test";
    if (!username) continue;
    if (map.has(username)) {
      throw new Error(
        `Accounts CSV at ${path} contains duplicate username "${username}".`
      );
    }
    map.set(username, { username, password, env });
  }
  return map;
}

const accounts = loadAccounts(csvPath);

function resolveCredentials(accountName) {
  if (accountName) {
    const acct = accounts.get(accountName);
    if (!acct) {
      throw new Error(
        `Unknown ESPM account "${accountName}". Check ${csvPath}.`
      );
    }
    return acct;
  }
  if (accounts.size === 0) {
    throw new Error(
      `No ESPM accounts configured. Add at least one row to ${csvPath} (columns: username,password,env).`
    );
  }
  if (accounts.size > 1) {
    const names = Array.from(accounts.keys()).join(", ");
    throw new Error(
      `Multiple ESPM accounts configured; pass account_name. Available: ${names}.`
    );
  }
  return accounts.values().next().value;
}

function baseUrlFor(env) {
  return env === "live"
    ? "https://portfoliomanager.energystar.gov/ws"
    : "https://portfoliomanager.energystar.gov/wstest";
}

// ─── ESPM API Client ─────────────────────────────────────────────────────────

async function espmGet(path, options = {}, accountName) {
  const { username, password, env } = resolveCredentials(accountName);
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  const url = `${baseUrlFor(env)}${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: authHeader,
      Accept: "application/xml",
      "Content-Type": "application/xml",
      ...(options.headers || {}),
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

function arrayify(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function safeNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function extractText(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    if (value.nil === "true") return null;
    if (typeof value._ === "string" || typeof value._ === "number") {
      return String(value._);
    }
  }
  return null;
}

function extractLinkHref(link) {
  if (!link) return "";
  if (typeof link === "string") return link;
  return link.link || link.href || link._ || "";
}

function extractLinkId(link) {
  if (!link) return null;
  if (link.id) return String(link.id);
  const href = extractLinkHref(link);
  return href ? href.split("/").pop() : null;
}

function extractProperties(data) {
  // Handle both single property and array
  return arrayify(data?.response?.links?.link);
}

function collectMetrics(node, metrics = []) {
  if (!node || typeof node !== "object") return metrics;
  if (Array.isArray(node)) {
    for (const item of node) collectMetrics(item, metrics);
    return metrics;
  }

  if (
    typeof node.name === "string" &&
    typeof node.description === "string" &&
    typeof node.dataType === "string"
  ) {
    metrics.push(node);
  }

  for (const value of Object.values(node)) {
    collectMetrics(value, metrics);
  }

  return metrics;
}

async function getAccountId(accountName) {
  const data = await espmGet("/account", {}, accountName);
  const accountId = data?.account?.id;
  if (!accountId) {
    throw new Error("Could not determine your ESPM account ID.");
  }
  return String(accountId);
}

async function getMetricCatalog(accountName) {
  const data = await espmGet("/reports/metrics", {}, accountName);
  return collectMetrics(data);
}

function findMetricName(metrics, matcher, fallback = null) {
  const match = metrics.find(
    (metric) =>
      matcher(metric.description?.toLowerCase?.() || "", metric.name?.toLowerCase?.() || "")
  );
  return match?.name || fallback;
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

function listAccounts() {
  const configured = Array.from(accounts.values()).map(({ username, env }) => ({
    name: username,
    env,
  }));
  return {
    source: existsSync(csvPath) ? csvPath : null,
    accounts: configured,
  };
}

async function getAccount(accountName) {
  const data = await espmGet("/account", {}, accountName);
  const account = data?.account;
  const { env } = resolveCredentials(accountName);
  return {
    id: account?.id,
    username: account?.username,
    name: `${account?.contact?.firstName} ${account?.contact?.lastName}`,
    organization: account?.organization?.name,
    email: account?.contact?.email,
    environment: env,
  };
}

async function listProperties(accountName) {
  const accountId = await getAccountId(accountName);
  const data = await espmGet(`/account/${accountId}/property/list`, {}, accountName);
  const propertyLinks = extractProperties(data);

  // Extract IDs from the href links
  const properties = propertyLinks.map((link) => {
    const href = extractLinkHref(link);
    const id = extractLinkId(link);
    return { id, name: link?.hint || null, href };
  });

  return properties.filter((property) => property.id);
}

async function getProperty(propertyId, accountName) {
  const data = await espmGet(`/property/${propertyId}`, {}, accountName);
  return formatProperty(data?.property);
}

async function getPropertyMetrics(propertyId, year, month, metricNames = null, accountName) {
  const y = year || new Date().getFullYear() - 1;
  const m = month || 12;
  const requestedMetrics =
    metricNames && metricNames.length > 0
      ? metricNames
      : ["score", "siteIntensity", "sourceIntensity", "totalLocationBasedGHGEmissions"];
  const data = await espmGet(
    `/property/${propertyId}/metrics?year=${y}&month=${m}&measurementSystem=EPA`,
    {
      headers: {
        "PM-Metrics": requestedMetrics.join(","),
      },
    },
    accountName
  );

  const metrics = data?.propertyMetrics?.metric;
  if (!metrics) return { propertyId, year: y, month: m, metrics: {} };

  const metricList = Array.isArray(metrics) ? metrics : [metrics];
  const result = {};
  for (const metric of metricList) {
    const name = metric?.name || metric?.["$"]?.name;
    const value = extractText(metric?.value);
    const dataType = metric?.dataType || metric?.["$"]?.dataType;
    if (name) {
      result[name] = dataType === "numeric" ? safeNum(value) : value;
    }
  }

  return { propertyId, year: y, month: m, requestedMetrics, metrics: result };
}

async function listPropertyGroups(accountName) {
  const data = await espmGet("/account/propertyGroups", {}, accountName);
  const groups = data?.response?.links?.link;
  if (!groups) return [];
  const groupList = Array.isArray(groups) ? groups : [groups];
  return groupList.map((g) => {
    const href = extractLinkHref(g);
    const id = extractLinkId(g);
    return { id, name: g?.hint || null, href };
  });
}

async function getPropertyGroup(groupId, accountName) {
  const data = await espmGet(`/propertyGroup/${groupId}`, {}, accountName);
  const group = data?.propertyGroup;
  return {
    id: group?.id,
    name: group?.name,
    description: group?.description || null,
  };
}

async function getGroupProperties(groupId, accountName) {
  const data = await espmGet(`/propertyGroup/${groupId}/properties`, {}, accountName);
  const list = arrayify(data?.response?.links?.link);
  return list.map((link) => extractLinkId(link)).filter(Boolean);
}

async function getEnergyStarCertificationSummary(year, accountName) {
  const requestedYear = Number(year);
  if (!Number.isInteger(requestedYear)) {
    throw new Error("Please provide a valid year, such as 2025.");
  }

  const [properties, metricCatalog] = await Promise.all([
    listProperties(accountName),
    getMetricCatalog(accountName),
  ]);

  const yearsCertifiedMetric = findMetricName(
    metricCatalog,
    (description, name) =>
      description.includes("energy star certification") &&
      description.includes("year(s) certified") &&
      !description.includes("number of years") &&
      !name.includes("nextgen"),
    "energyStarCertificationYearsCertifiedScore"
  );

  if (!yearsCertifiedMetric) {
    throw new Error("Could not find the ENERGY STAR certification metrics in ESPM.");
  }

  const certifiedProperties = [];
  const failedProperties = [];

  for (const property of properties) {
    try {
      const [details, metricsData] = await Promise.all([
        getProperty(property.id, accountName),
        getPropertyMetrics(
          property.id,
          requestedYear,
          12,
          [yearsCertifiedMetric, "energyStarCertificationEligibility"],
          accountName
        ),
      ]);

      const yearsCertified = String(metricsData.metrics?.[yearsCertifiedMetric] || "");
      if (yearsCertified.includes(String(requestedYear))) {
        certifiedProperties.push({
          id: property.id,
          name: details.name,
          yearsCertified,
          eligible: metricsData.metrics?.energyStarCertificationEligibility || null,
        });
      }
    } catch (error) {
      failedProperties.push({
        id: property.id,
        name: property.name || null,
        error: error.message,
      });
    }
  }

  return {
    year: requestedYear,
    totalPropertiesChecked: properties.length,
    certifiedPropertyCount: certifiedProperties.length,
    failedPropertyCount: failedProperties.length,
    properties: certifiedProperties,
    metricUsed: yearsCertifiedMetric,
    failedProperties: failedProperties.slice(0, 25),
  };
}

async function getPortfolioSummary(accountName) {
  // Get all properties and pull metrics for each — builds a portfolio-level view
  const props = await listProperties(accountName);
  const year = new Date().getFullYear() - 1;

  const summaries = [];
  // Limit to first 50 to avoid very long runtime on huge portfolios
  const sample = props.slice(0, 50);

  for (const p of sample) {
    try {
      const [details, metricsData] = await Promise.all([
        getProperty(p.id, accountName),
        getPropertyMetrics(p.id, year, 12, null, accountName),
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
        ghgEmissions: metricsData.metrics?.totalLocationBasedGHGEmissions ?? null,
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

async function getGroupScoreSummary(groupId, accountName) {
  const [groupInfo, propertyIds] = await Promise.all([
    getPropertyGroup(groupId, accountName),
    getGroupProperties(groupId, accountName),
  ]);

  const year = new Date().getFullYear() - 1;
  const scores = [];

  for (const id of propertyIds) {
    try {
      const [details, metricsData] = await Promise.all([
        getProperty(id, accountName),
        getPropertyMetrics(id, year, 12, null, accountName),
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

// ─── Suspicious-Data Workflow Helpers ─────────────────────────────────────────

async function listPropertyMeters(propertyId, accountName) {
  const data = await espmGet(`/property/${propertyId}/meter/list`, {}, accountName);
  const meterLinks = arrayify(data?.response?.links?.link);

  const meters = [];
  for (const link of meterLinks) {
    const meterId = extractLinkId(link);
    if (!meterId) continue;
    try {
      const meterData = await espmGet(`/meter/${meterId}`, {}, accountName);
      const meter = meterData?.meter;
      meters.push({
        id: meterId,
        name: meter?.name || link?.hint || "Unknown",
        type: meter?.type || null,
        unitOfMeasure: meter?.unitOfMeasure || null,
        metered: meter?.metered || null,
        firstBillDate: meter?.firstBillDate || null,
        inUse: meter?.inUse || null,
        aggregateMeter: meter?.aggregateMeter || null,
        accessLevel: meter?.accessLevel || null,
      });
    } catch (err) {
      meters.push({
        id: meterId,
        name: link?.hint || "Unknown",
        error: err.message,
      });
    }
  }

  return { propertyId, meterCount: meters.length, meters };
}

async function getMeterConsumptionData(meterId, startDate, endDate, accountName) {
  let path = `/meter/${meterId}/consumptionData`;
  const params = ["page=1"];
  if (startDate) params.push(`startDate=${startDate}`);
  if (endDate) params.push(`endDate=${endDate}`);
  path += "?" + params.join("&");

  const data = await espmGet(path, {}, accountName);
  const entries = arrayify(data?.meterData?.meterConsumption);

  return {
    meterId,
    entryCount: entries.length,
    entries: entries.map((entry) => ({
      id: entry?.id,
      startDate: entry?.startDate,
      endDate: entry?.endDate,
      usage: entry?.usage,
      cost: extractText(entry?.cost),
      estimatedValue: entry?.estimatedValue,
      audit: {
        createdBy: entry?.audit?.createdBy || null,
        createdByAccountId: entry?.audit?.createdByAccountId || null,
        lastUpdatedBy: entry?.audit?.lastUpdatedBy || null,
        lastUpdatedByAccountId: entry?.audit?.lastUpdatedByAccountId || null,
        lastUpdatedDate: entry?.audit?.lastUpdatedDate || null,
      },
    })),
  };
}

async function listConnectedCustomers(accountName) {
  const data = await espmGet("/customer/list", {}, accountName);
  const customerLinks = arrayify(data?.response?.links?.link);

  return customerLinks.map((link) => ({
    id: extractLinkId(link),
    name: link?.hint || null,
  }));
}


function isBcHydroSource(auditField) {
  if (!auditField) return false;
  const lower = String(auditField).toLowerCase();
  return lower.includes("bc hydro") || lower.includes("bchydro");
}

function isAggregatedMeter(meter) {
  if (meter.aggregateMeter === true || meter.aggregateMeter === "true") return true;
  if (!meter.name) return false;
  const lower = meter.name.toLowerCase();
  return (
    lower.includes("aggregated") ||
    lower.includes("suites") ||
    lower.includes("units") ||
    lower.includes("residents")
  );
}

async function suspiciousDataCheck(propertyId, accountName) {
  const steps = [];

  // STEP 1: Get property details
  steps.push({ check: "Get property details", status: "running" });
  let property;
  try {
    property = await getProperty(propertyId, accountName);
    steps[steps.length - 1].status = "done";
    steps[steps.length - 1].result = {
      name: property.name,
      address: property.address,
      primaryFunction: property.primaryFunction,
    };
  } catch (err) {
    steps[steps.length - 1].status = "error";
    steps[steps.length - 1].result = err.message;
    return { propertyId, steps, outcome: "error", message: `Could not retrieve property: ${err.message}` };
  }

  const propertyType = property.primaryFunction || "Unknown";

  // STEP 2: Check meter access
  steps.push({ check: "Check meter access", status: "running" });
  let metersResult;
  let hasMeterAccess = false;
  try {
    metersResult = await listPropertyMeters(propertyId, accountName);
    hasMeterAccess = metersResult.meterCount > 0;
    steps[steps.length - 1].status = "done";
    steps[steps.length - 1].result = hasMeterAccess
      ? `Found ${metersResult.meterCount} meter(s)`
      : "No meters found";
  } catch (err) {
    steps[steps.length - 1].status = "done";
    steps[steps.length - 1].result = `No meter access (${err.message})`;
    hasMeterAccess = false;
  }

  // ─── BRANCH A: No meter access ───
  if (!hasMeterAccess) {
    steps[steps.length - 1].nextAction = "No meter access → checking if property is shared with BC Hydro";

    // STEP A1: Check BC Hydro connection
    steps.push({ check: "Check if property is shared with BC Hydro", status: "running" });
    try {
      const customers = await listConnectedCustomers(accountName);
      const bcHydroCustomer = customers.find((c) => isBcHydroSource(c.name));
      steps[steps.length - 1].status = "done";

      if (!bcHydroCustomer) {
        steps[steps.length - 1].result = "BC Hydro not found in connected customers";
        return {
          propertyId,
          propertyName: property.name,
          propertyType,
          steps,
          outcome: "suspicious",
          message:
            "The property has not been shared with BC Hydro. We cannot see the meters. The building owner should be contacted.",
        };
      }

      steps[steps.length - 1].result = `BC Hydro found: "${bcHydroCustomer.name}" (ID: ${bcHydroCustomer.id})`;

      // Return data for Claude to decide on aggregation
      return {
        propertyId,
        propertyName: property.name,
        propertyType,
        steps,
        outcome: "requires_aggregation_judgment",
        message: `The property is shared with BC Hydro but we cannot access the meters. You must now determine whether this property type ("${propertyType}") would be expected to have an aggregated meter. An aggregated meter is expected when the property would have 3 or more commercial BC Hydro accounts or 5 or more residential BC Hydro accounts — use your judgment based on the property type. If an aggregated meter IS expected, the building owner should be contacted. If an aggregated meter is NOT expected, the property data looks good.`,
      };
    } catch (err) {
      steps[steps.length - 1].status = "error";
      steps[steps.length - 1].result = err.message;
      return {
        propertyId,
        propertyName: property.name,
        propertyType,
        steps,
        outcome: "error",
        message: `Could not check connected customers: ${err.message}`,
      };
    }
  }

  // ─── BRANCH B: Have meter access ───
  steps[steps.length - 1].nextAction = "Have meter access → checking data source on each meter";

  // STEP B1: Check meter data source
  steps.push({ check: "Check meter data source (BC Hydro vs manual)", status: "running" });
  let anyBcHydro = false;
  const meterDetails = [];

  for (const meter of metersResult.meters) {
    if (meter.error) {
      meterDetails.push({ id: meter.id, name: meter.name, source: "unknown", error: meter.error });
      continue;
    }
    try {
      const consumption = await getMeterConsumptionData(meter.id, null, null, accountName);
      const bcHydroEntries = consumption.entries.filter(
        (e) => isBcHydroSource(e.audit?.createdBy) || isBcHydroSource(e.audit?.lastUpdatedBy)
      );
      const source = bcHydroEntries.length > 0 ? "BC Hydro Web Services" : "Manual entry";
      if (bcHydroEntries.length > 0) anyBcHydro = true;
      meterDetails.push({
        id: meter.id,
        name: meter.name,
        type: meter.type,
        source,
        totalEntries: consumption.entryCount,
        bcHydroEntries: bcHydroEntries.length,
        aggregateMeter: isAggregatedMeter(meter),
      });
    } catch (err) {
      meterDetails.push({ id: meter.id, name: meter.name, source: "unknown", error: err.message });
    }
  }

  steps[steps.length - 1].status = "done";
  steps[steps.length - 1].result = { anyBcHydro, meters: meterDetails };

  if (!anyBcHydro) {
    return {
      propertyId,
      propertyName: property.name,
      propertyType,
      steps,
      meters: meterDetails,
      outcome: "suspicious",
      message:
        "The meter data was manually entered (not from BC Hydro Web Services). The property owner should be contacted.",
    };
  }

  // Return data for Claude to decide on aggregation
  return {
    propertyId,
    propertyName: property.name,
    propertyType,
    steps,
    meters: meterDetails,
    outcome: "requires_aggregation_judgment",
    message: `The meter data is from BC Hydro Web Services. You must now determine whether this property type ("${propertyType}") would be expected to have an aggregated meter. An aggregated meter is expected when the property would have 3 or more commercial BC Hydro accounts or 5 or more residential BC Hydro accounts — use your judgment based on the property type. If an aggregated meter is NOT expected, the property data looks good. If an aggregated meter IS expected, check the meters list above for one that has aggregateMeter=true or whose name contains "aggregated", "suites", "units", or "residents". If found, the property data looks good. If not found, show the property type and meter list and report that an aggregated meter was expected but not found — the property owner should be contacted.`,
  };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "espm-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const ACCOUNT_NAME_PROP = {
  account_name: {
    type: "string",
    description:
      "ESPM username from accounts.csv. Optional only when exactly one account is configured; otherwise required.",
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_accounts",
      description:
        "List the ESPM accounts configured in accounts.csv (usernames + env). Use the returned names as the account_name parameter on other tools. Does not hit the ESPM API.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_account",
      description:
        "Get your ESPM account info — name, organization, and which environment you're connected to (test vs live).",
      inputSchema: { type: "object", properties: { ...ACCOUNT_NAME_PROP } },
    },
    {
      name: "list_properties",
      description:
        "List all property IDs in your ESPM account. Use this to discover what properties you have, then call get_property for details.",
      inputSchema: { type: "object", properties: { ...ACCOUNT_NAME_PROP } },
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
          ...ACCOUNT_NAME_PROP,
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
          ...ACCOUNT_NAME_PROP,
        },
        required: ["property_id"],
      },
    },
    {
      name: "list_property_groups",
      description:
        "List all property groups in your account (e.g. by fund, asset type, or management style). Returns group IDs you can use with other tools.",
      inputSchema: { type: "object", properties: { ...ACCOUNT_NAME_PROP } },
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
          ...ACCOUNT_NAME_PROP,
        },
        required: ["group_id"],
      },
    },
    {
      name: "get_group_score_summary",
      description:
        "Get a full score summary for a property group — average ENERGY STAR score, min/max, and per-property breakdown. Perfect for questions like 'what is the average score for my office properties?'",
      inputSchema: {
        type: "object",
        properties: {
          group_id: {
            type: "string",
            description: "The ESPM property group ID",
          },
          ...ACCOUNT_NAME_PROP,
        },
        required: ["group_id"],
      },
    },
    {
      name: "get_portfolio_summary",
      description:
        "Get a high-level summary of your entire portfolio — scores, EUI, and property details across all properties (samples up to 50). Good for 'what does my portfolio look like overall?' questions.",
      inputSchema: { type: "object", properties: { ...ACCOUNT_NAME_PROP } },
    },
    {
      name: "list_property_meters",
      description:
        "List all meters for a property, including name, type, unit of measure, and whether the meter is an aggregate meter.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: {
            type: "string",
            description: "The ESPM property ID",
          },
          ...ACCOUNT_NAME_PROP,
        },
        required: ["property_id"],
      },
    },
    {
      name: "get_meter_consumption_data",
      description:
        "Get consumption data entries for a meter, including usage amounts and audit info showing who created/last updated each entry (e.g. a utility web services account vs manual entry).",
      inputSchema: {
        type: "object",
        properties: {
          meter_id: {
            type: "string",
            description: "The ESPM meter ID",
          },
          start_date: {
            type: "string",
            description: "Start date in YYYY-MM-DD format (optional)",
          },
          end_date: {
            type: "string",
            description: "End date in YYYY-MM-DD format (optional)",
          },
          ...ACCOUNT_NAME_PROP,
        },
        required: ["meter_id"],
      },
    },
    {
      name: "suspicious_data_check",
      description:
        "Investigate whether a property's energy data looks legitimate or suspicious. Runs a step-by-step decision tree: checks meter access, data source (BC Hydro Web Services vs manual entry), and whether an aggregated meter is present when expected. Returns a detailed narrative of each check, its result, and a final verdict.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: {
            type: "string",
            description: "The ESPM property ID to investigate",
          },
          ...ACCOUNT_NAME_PROP,
        },
        required: ["property_id"],
      },
    },
    {
      name: "list_connected_customers",
      description:
        "List all customer accounts connected to your ESPM account. Useful for checking if a specific organization (e.g. BC Hydro) has a data exchange connection.",
      inputSchema: {
        type: "object",
        properties: { ...ACCOUNT_NAME_PROP },
      },
    },
    {
      name: "get_energy_star_certification_summary",
      description:
        "Count which properties were actually ENERGY STAR certified in a specific year, using ESPM certification metrics rather than score alone.",
      inputSchema: {
        type: "object",
        properties: {
          year: {
            type: "number",
            description: "Calendar year to check for ENERGY STAR certification, such as 2025.",
          },
          ...ACCOUNT_NAME_PROP,
        },
        required: ["year"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "list_accounts":
        result = listAccounts();
        break;
      case "get_account":
        result = await getAccount(args.account_name);
        break;
      case "list_properties":
        result = await listProperties(args.account_name);
        break;
      case "get_property":
        result = await getProperty(args.property_id, args.account_name);
        break;
      case "get_property_metrics":
        result = await getPropertyMetrics(
          args.property_id,
          args.year,
          args.month,
          null,
          args.account_name
        );
        break;
      case "list_property_groups":
        result = await listPropertyGroups(args.account_name);
        break;
      case "get_property_group":
        result = await getPropertyGroup(args.group_id, args.account_name);
        break;
      case "get_group_score_summary":
        result = await getGroupScoreSummary(args.group_id, args.account_name);
        break;
      case "get_portfolio_summary":
        result = await getPortfolioSummary(args.account_name);
        break;
      case "list_property_meters":
        result = await listPropertyMeters(args.property_id, args.account_name);
        break;
      case "get_meter_consumption_data":
        result = await getMeterConsumptionData(
          args.meter_id,
          args.start_date,
          args.end_date,
          args.account_name
        );
        break;
      case "suspicious_data_check":
        result = await suspiciousDataCheck(args.property_id, args.account_name);
        break;
      case "list_connected_customers":
        result = await listConnectedCustomers(args.account_name);
        break;
      case "get_energy_star_certification_summary":
        result = await getEnergyStarCertificationSummary(args.year, args.account_name);
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
