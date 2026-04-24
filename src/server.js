/**
 * ESPM MCP Server — shared setup.
 *
 * Both entry points (transports/stdio.js and transports/http.js) import
 * `createEspmServer` from here. All tool definitions, handlers, and ESPM
 * client code live in this module.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { parseStringPromise } from "xml2js";
import { getTools as getSuspiciousDataTools, handleTool as handleSuspiciousDataTool } from "./suspicious-data.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setupDiagnostics } from "./diagnostics.js";

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

// Inline CSV content takes precedence over the file. Unescape \n so PaaS
// platforms that can't store literal newlines in env vars still work.
const csvEnvData = process.env.ESPM_ACCOUNTS_CSV_DATA
  ? process.env.ESPM_ACCOUNTS_CSV_DATA.replace(/\\n/g, "\n")
  : null;

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

function loadAccounts(path, rawContent = null) {
  const map = new Map();
  let text;
  if (rawContent != null) {
    text = rawContent;
  } else {
    if (!existsSync(path)) return map;
    text = readFileSync(path, "utf8");
  }

  const records = parseCsv(text);
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

function loadAccountsFromEnv() {
  const map = new Map();
  const username = process.env.ESPM_ACCOUNT_USERNAME;
  const password = process.env.ESPM_ACCOUNT_PASSWORD;
  const env = process.env.ESPM_ACCOUNT_ENV || "test";
  if (username && password) {
    map.set(username, { username, password, env });
  }
  return map;
}

// Priority: ESPM_ACCOUNTS_CSV_DATA (inline CSV for PaaS) → CSV file → single-account env vars
const accounts = (() => {
  const fromCsv = loadAccounts(csvPath, csvEnvData);
  if (fromCsv.size > 0) return fromCsv;
  return loadAccountsFromEnv();
})();

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
  return (env === "live" || env === "prod")
    ? "https://portfoliomanager.energystar.gov/ws"
    : "https://portfoliomanager.energystar.gov/wstest";
}

// ─── ESPM API Client ─────────────────────────────────────────────────────────
// This is the only function that contacts the ESPM API. It is intentionally
// read-only: all requests use GET. No write path exists in this server.

async function espmGet(path, options = {}, accountName) {
  const { username, password, env } = resolveCredentials(accountName);
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  const url = `${baseUrlFor(env)}${path}`;
  const response = await fetch(url, {
    method: "GET",
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
    source: csvEnvData ? "ESPM_ACCOUNTS_CSV_DATA" : existsSync(csvPath) ? csvPath : null,
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

const { getMeterConsumption, checkAggregatedMeters, runDataQualityCheck, detectFaultyDataPoints, runFullDiagnostic } =
  setupDiagnostics({ espmGet, arrayify, safeNum, extractText, extractLinkId, getProperty, getPropertyMetrics });

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

async function getEnergyCurrentDate(propertyId, accountName) {
  const today = new Date();
  const data = await espmGet(
    `/property/${propertyId}/metrics?year=${today.getFullYear()}&month=${today.getMonth() + 1}&measurementSystem=METRIC`,
    { headers: { "PM-Metrics": "energyCurrentDate" } },
    accountName
  );
  const dateStr = data?.propertyMetrics?.metric?.value;
  if (!dateStr || typeof dateStr !== "string") {
    throw new Error(`Could not fetch energyCurrentDate for property ${propertyId}`);
  }
  // Parse "YYYY-MM-DD" by splitting — avoids JS UTC-rollback timezone bugs
  const [yearStr, monthStr] = dateStr.split("-");
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10);
  const currYear = new Date().getFullYear();
  if (year === currYear) {
    year = currYear - 1;
    month = 12;
  }
  return { year, month };
}

async function getMonthlyEnergyStream(propertyId, year, month, accountName) {
  let y = year;
  let m = month;
  if (!y || !m) {
    const anchor = await getEnergyCurrentDate(propertyId, accountName);
    y = y || anchor.year;
    m = m || anchor.month;
  }

  const ENERGY_STREAM_METRICS = {
    siteElectricityUseMonthly: "electricity",
    siteNaturalGasUseMonthly: "naturalGas",
    siteEnergyUseFuelOil1Monthly: "fuelOil1",
    siteEnergyUseFuelOil2Monthly: "fuelOil2",
    siteEnergyUseFuelOil4Monthly: "fuelOil4",
    siteEnergyUseFuelOil5And6Monthly: "fuelOil5And6",
    siteEnergyUsePropaneMonthly: "propane",
    siteEnergyUseDistrictSteamMonthly: "districtSteam",
    siteEnergyUseDistrictHotWaterMonthly: "districtHotWater",
    siteEnergyUseDistrictChilledWaterMonthly: "districtChilledWater",
  };

  const data = await espmGet(
    `/property/${propertyId}/metrics/monthly?year=${y}&month=${m}&measurementSystem=METRIC`,
    { headers: { "PM-Metrics": Object.keys(ENERGY_STREAM_METRICS).join(",") } },
    accountName
  );

  const rawMetrics = arrayify(data?.propertyMetrics?.metric);
  const streams = {};

  for (const metric of rawMetrics) {
    const friendlyKey = ENERGY_STREAM_METRICS[metric?.name];
    if (!friendlyKey) continue;

    const series = arrayify(metric?.monthlyMetric)
      .map((entry) => {
        const value = extractText(entry?.value);
        return {
          year: parseInt(entry?.year, 10),
          month: parseInt(entry?.month, 10),
          value: value !== null ? parseFloat(value) : null,
        };
      })
      .filter((entry) => entry.value !== null)
      .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

    if (series.length > 0) {
      streams[friendlyKey] = { unit: metric?.uom || "GJ", series };
    }
  }

  return { propertyId, dataThrough: { year: y, month: m }, streams };
}

// ─── Energy QA Helpers ───────────────────────────────────────────────────────

// Building types where summer electricity > winter is physically expected
// (ice cooling, refrigeration, etc.) — summer dip flag adds a caveat for these.
const SUMMER_DOMINANT_ELEC_TYPES = new Set([
  "Ice/Curling Rink", "Refrigerated Warehouse", "Swimming Pool",
  "Roller Rink", "Indoor Arena", "Aquarium",
]);


function calcRSquared(xArr, yArr) {
  const n = xArr.length;
  if (n < 4) return null;
  const meanX = xArr.reduce((a, b) => a + b, 0) / n;
  const meanY = yArr.reduce((a, b) => a + b, 0) / n;
  const ssXX = xArr.reduce((s, xi) => s + (xi - meanX) ** 2, 0);
  const ssXY = xArr.reduce((s, xi, i) => s + (xi - meanX) * (yArr[i] - meanY), 0);
  if (ssXX === 0) return null;
  const b = ssXY / ssXX;
  const a = meanY - b * meanX;
  const ssTot = yArr.reduce((s, yi) => s + (yi - meanY) ** 2, 0);
  if (ssTot === 0) return null;
  const ssRes = yArr.reduce((s, yi, i) => s + (yi - (a + b * xArr[i])) ** 2, 0);
  return 1 - ssRes / ssTot;
}

function solveNxN(A, b) {
  const n = A.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[maxRow][col])) maxRow = row;
    }
    [m[col], m[maxRow]] = [m[maxRow], m[col]];
    if (Math.abs(m[col][col]) < 1e-12) return null;
    for (let row = col + 1; row < n; row++) {
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k++) m[row][k] -= factor * m[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = m[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= m[i][j] * x[j];
    x[i] /= m[i][i];
  }
  return x;
}

// General OLS R² for any number of predictors.
// xArrays = [x1, x2, ...], each the same length as yArr.
function calcRSquaredMultiN(xArrays, yArr) {
  const n = yArr.length;
  const k = xArrays.length;
  if (n < k + 3) return null;
  const p = k + 1;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = [1, ...xArrays.map((x) => x[i])];
    for (let r = 0; r < p; r++) {
      Xty[r] += xi[r] * yArr[i];
      for (let c = 0; c < p; c++) XtX[r][c] += xi[r] * xi[c];
    }
  }
  const coeffs = solveNxN(XtX, Xty);
  if (!coeffs) return null;
  const meanY = yArr.reduce((a, b) => a + b, 0) / n;
  const ssTot = yArr.reduce((s, yi) => s + (yi - meanY) ** 2, 0);
  if (ssTot === 0) return null;
  const ssRes = yArr.reduce((s, yi, i) => {
    const yHat = coeffs[0] + xArrays.reduce((sum, x, j) => sum + coeffs[j + 1] * x[i], 0);
    return s + (yi - yHat) ** 2;
  }, 0);
  return 1 - ssRes / ssTot;
}

function calcRSquaredMulti(x1Arr, x2Arr, yArr) {
  return calcRSquaredMultiN([x1Arr, x2Arr], yArr);
}

function rateR2(r2) {
  if (r2 === null) return "INSUFFICIENT_DATA";
  return r2 >= 0.55 ? "GOOD" : r2 >= 0.4 ? "ACCEPTABLE" : "POOR";
}

// Adjusted R² penalises for extra predictors: fairer comparison across model complexity.
// Returns null if there aren't enough degrees of freedom (n ≤ k + 1).
function adjustR2(r2, n, k) {
  if (r2 === null || n <= k + 1) return null;
  return 1 - (1 - r2) * (n - 1) / (n - k - 1);
}

async function geocodeAddress(city, state, country = "Canada") {
  // Use structured query — more reliable than free-text for Canadian addresses
  const params = new URLSearchParams({ city, state, country, format: "json", limit: "1" });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    method: "GET",
    headers: { "User-Agent": "ESPM-MCP-QA/1.0" },
  });
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function fetchMonthlyWeatherData(lat, lon, startDate, endDate, hddBalance = 18, cddBalance = 10, dptBalance = 11) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean,dew_point_2m_mean&timezone=auto`;
  const res = await fetch(url, { method: "GET" });
  const data = await res.json();
  if (!data.daily?.time) throw new Error("Open-Meteo returned no weather data");

  const monthlyHDD = {}, monthlyCDD = {}, monthlyDPTDD = {};
  for (let i = 0; i < data.daily.time.length; i++) {
    const key = data.daily.time[i].substring(0, 7);
    const temp = data.daily.temperature_2m_mean[i];
    const dpt  = data.daily.dew_point_2m_mean?.[i];
    if (temp != null) {
      monthlyHDD[key]  = (monthlyHDD[key]  || 0) + Math.max(0, hddBalance - temp);
      monthlyCDD[key]  = (monthlyCDD[key]  || 0) + Math.max(0, temp - cddBalance);
    }
    if (dpt != null) {
      monthlyDPTDD[key] = (monthlyDPTDD[key] || 0) + Math.max(0, dpt - dptBalance);
    }
  }
  return { monthlyHDD, monthlyCDD, monthlyDPTDD };
}

function findRecommendedWindow(streams, { monthlyHDD, monthlyCDD, monthlyDPTDD }, minLength = 6) {
  const streamKeys = Object.keys(streams);
  if (!streamKeys.length) return [];
  const allMonths = Object.keys(monthlyHDD).sort();
  if (!allMonths.length) return [];

  // Build per-stream dirty-month flags (missing, exact-zero, spike)
  const streamMeta = {};
  for (const [key, { series }] of Object.entries(streams)) {
    const byKey = Object.fromEntries(
      series.map((pt) => [`${pt.year}-${String(pt.month).padStart(2, "0")}`, pt.value])
    );
    const nonNullVals = series.map((pt) => pt.value).filter((v) => v !== null && v > 0);
    const sortedVals = [...nonNullVals].sort((a, b) => a - b);
    const median = sortedVals.length ? sortedVals[Math.floor(sortedVals.length / 2)] : 0;
    const hasNonZero = nonNullVals.length > 0;
    streamMeta[key] = {
      byKey,
      dirtyFlags: allMonths.map((k) => {
        const v = byKey[k];
        if (v === undefined || v === null) return "missing";
        if (v === 0 && hasNonZero) return "zero";
        if (median > 0 && v > 3 * median) return "spike";
        return null;
      }),
    };
  }

  // A month is usable only if clean across ALL present streams
  const isGloballyDirty = allMonths.map((_, i) => {
    for (const { dirtyFlags } of Object.values(streamMeta)) {
      if (dirtyFlags[i]) return dirtyFlags[i];
    }
    return null;
  });

  // Find all contiguous globally-clean runs >= minLength
  const runs = [];
  let runStart = null;
  for (let i = 0; i <= allMonths.length; i++) {
    if (i < allMonths.length && !isGloballyDirty[i]) {
      if (runStart === null) runStart = i;
    } else {
      if (runStart !== null) {
        const len = i - runStart;
        if (len >= minLength) runs.push({ start: runStart, end: i - 1 });
        runStart = null;
      }
    }
  }

  // Score each run: compute per-stream CV and R² for all four regression types.
  // Ranking uses worst-case HDD R² across streams as the tiebreaker.
  const candidates = [];
  for (const run of runs) {
    const runMonths = allMonths.slice(run.start, run.end + 1);
    const hdds   = runMonths.map((k) => monthlyHDD[k]);
    const cdds   = runMonths.map((k) => monthlyCDD[k]);
    const dptdds = runMonths.map((k) => monthlyDPTDD[k]);
    let skipRun = false;
    const r2ByStream = {};

    for (const [key, { byKey }] of Object.entries(streamMeta)) {
      const vals = runMonths.map((k) => byKey[k]).filter((v) => v !== undefined && v !== null);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const stddev = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
      const cv = mean > 0 ? stddev / mean : 0;
      if (cv < 0.05) { skipRun = true; break; }

      const n = vals.length;
      const mkEntry = (r2, k) => {
        const adj = adjustR2(r2, n, k);
        const rounded = adj !== null ? Math.round(adj * 1000) / 1000 : null;
        return { r2: rounded, rating: rateR2(rounded) };
      };
      r2ByStream[key] = {
        hdd:           mkEntry(calcRSquared(hdds, vals), 1),
        cdd:           mkEntry(calcRSquared(cdds, vals), 1),
        dptdd:         mkEntry(calcRSquared(dptdds, vals), 1),
        hdd_cdd:       mkEntry(calcRSquaredMultiN([hdds, cdds], vals), 2),
        hdd_dptdd:     mkEntry(calcRSquaredMultiN([hdds, dptdds], vals), 2),
        cdd_dptdd:     mkEntry(calcRSquaredMultiN([cdds, dptdds], vals), 2),
        hdd_cdd_dptdd: mkEntry(calcRSquaredMultiN([hdds, cdds, dptdds], vals), 3),
      };
    }
    if (skipRun) continue;

    candidates.push({
      start: allMonths[run.start],
      end: allMonths[run.end],
      months: run.end - run.start + 1,
      streams: streamKeys,
      r2: r2ByStream,
    });
  }

  // Rank: longer first, then best worst-case HDD+CDD R² across streams as tiebreaker
  candidates.sort((a, b) => {
    if (b.months !== a.months) return b.months - a.months;
    const aMin = Math.min(...Object.values(a.r2).map((v) => v.hdd_cdd?.r2 ?? -1));
    const bMin = Math.min(...Object.values(b.r2).map((v) => v.hdd_cdd?.r2 ?? -1));
    return bMin - aMin;
  });

  return candidates.slice(0, 3);
}

async function assessCalibrationReadiness(propertyId, accountName) {
  const anchor = await getEnergyCurrentDate(propertyId, accountName);
  const y = anchor.year;
  const m = anchor.month;

  const NUM_YEARS = 10;
  const yearAnchors = Array.from({ length: NUM_YEARS }, (_, i) => ({
    year: i === 0 ? y : y - i,
    month: i === 0 ? m : 12,
  }));

  const [propData, ...yearDataArr] = await Promise.all([
    espmGet(`/property/${propertyId}`, {}, accountName),
    ...yearAnchors.map(({ year, month }) =>
      getMonthlyEnergyStream(propertyId, year, month, accountName).catch(() => null)
    ),
  ]);

  const prop = propData?.property;
  const gfaObj = prop?.grossFloorArea;
  const gfaValue = parseFloat(gfaObj?.value || gfaObj?._ || gfaObj || 0);
  const gfaUnits = gfaObj?.units || "Square Meters";
  const gfaM2 = gfaUnits.toLowerCase().includes("feet") ? gfaValue * 0.092903 : gfaValue;
  const primaryFunction = prop?.primaryFunction || null;
  const address = prop?.address;
  const fullAddress = address
    ? [address.address1, address.city, address.state, address.postalCode].filter(Boolean).join(", ")
    : null;

  // Merge streams across all fetched years, deduplicate, and sort chronologically.
  const mergedStreams = {};
  for (const yearData of yearDataArr) {
    if (!yearData) continue;
    for (const [key, { unit, series }] of Object.entries(yearData.streams)) {
      if (!mergedStreams[key]) mergedStreams[key] = { unit, series: [] };
      mergedStreams[key].series.push(...series);
    }
  }
  for (const stream of Object.values(mergedStreams)) {
    const seen = new Set();
    stream.series = stream.series
      .filter((pt) => {
        const k = `${pt.year}-${String(pt.month).padStart(2, "0")}`;
        return seen.has(k) ? false : (seen.add(k), true);
      })
      .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
  }
  const streams = mergedStreams;

  let monthlyHDD = {}, monthlyCDD = {}, monthlyDPTDD = {};
  let weatherError = null;
  let recommendedWindows = [];
  let rSquared = {};
  let timescaleAnalysis = {};
  let recommendation = null;
  let validLabels = [];
  let hasMultiYearData = false;

  try {
    const coords = await geocodeAddress(address?.city, address?.state);
    if (!coords) throw new Error(`Could not geocode: ${address?.city}, ${address?.state}`);

    const allYears = Object.values(streams).flatMap(({ series }) => series.map((pt) => pt.year));
    const minYear = allYears.length ? Math.min(...allYears) : y - 1;
    const endDay = new Date(y, m, 0).getDate();
    ({ monthlyHDD, monthlyCDD, monthlyDPTDD } = await fetchMonthlyWeatherData(
      coords.lat, coords.lon,
      `${minYear}-01-01`,
      `${y}-${String(m).padStart(2, "0")}-${endDay}`
    ));

    // Full-window R² per stream
    const mkPt = (pt) => `${pt.year}-${String(pt.month).padStart(2, "0")}`;
    for (const [key, { series }] of Object.entries(streams)) {
      const pts = series.filter((pt) => pt.value !== null);
      const hddPts = pts.filter((pt) => monthlyHDD[mkPt(pt)]   !== undefined);
      const cddPts = pts.filter((pt) => monthlyCDD[mkPt(pt)]   !== undefined);
      const dptPts = pts.filter((pt) => monthlyDPTDD[mkPt(pt)] !== undefined);
      const triPts = pts.filter((p) => monthlyHDD[mkPt(p)] !== undefined && monthlyCDD[mkPt(p)] !== undefined && monthlyDPTDD[mkPt(p)] !== undefined);
      const getHdd  = (ps) => ps.map((p) => monthlyHDD[mkPt(p)]);
      const getCdd  = (ps) => ps.map((p) => monthlyCDD[mkPt(p)]);
      const getDpt  = (ps) => ps.map((p) => monthlyDPTDD[mkPt(p)]);
      const getE    = (ps) => ps.map((p) => p.value);
      const mkEntry = (r2, n, k) => {
        const adj = adjustR2(r2, n, k);
        const rounded = adj !== null ? Math.round(adj * 1000) / 1000 : null;
        return { r2: rounded, rating: rateR2(rounded), monthsUsed: n };
      };
      rSquared[key] = {
        hdd:           mkEntry(hddPts.length >= 4 ? calcRSquared(getHdd(hddPts), getE(hddPts))                                           : null, hddPts.length, 1),
        cdd:           mkEntry(cddPts.length >= 4 ? calcRSquared(getCdd(cddPts), getE(cddPts))                                           : null, cddPts.length, 1),
        dptdd:         mkEntry(dptPts.length >= 4 ? calcRSquared(getDpt(dptPts), getE(dptPts))                                           : null, dptPts.length, 1),
        hdd_cdd:       mkEntry(triPts.length >= 6 ? calcRSquaredMultiN([getHdd(triPts), getCdd(triPts)], getE(triPts))                   : null, triPts.length, 2),
        hdd_dptdd:     mkEntry(triPts.length >= 6 ? calcRSquaredMultiN([getHdd(triPts), getDpt(triPts)], getE(triPts))                   : null, triPts.length, 2),
        cdd_dptdd:     mkEntry(triPts.length >= 6 ? calcRSquaredMultiN([getCdd(triPts), getDpt(triPts)], getE(triPts))                   : null, triPts.length, 2),
        hdd_cdd_dptdd: mkEntry(triPts.length >= 7 ? calcRSquaredMultiN([getHdd(triPts), getCdd(triPts), getDpt(triPts)], getE(triPts))   : null, triPts.length, 3),
      };
    }

    // Recommended clean windows (contiguous, gap-free across all streams)
    recommendedWindows = findRecommendedWindow(streams, { monthlyHDD, monthlyCDD, monthlyDPTDD });

    // Timescale R² matrix: trailing N-year windows × 7 regression types
    const mkKey = (yr, mo) => `${yr}-${String(mo).padStart(2, "0")}`;
    const maxMonths = (y - minYear) * 12 + m;
    const windowSizes = [];
    for (let n = 12; n <= Math.min(NUM_YEARS * 12, maxMonths); n += 12) windowSizes.push(n);

    const REGRESSIONS = [
      { key: "hdd",           k: 1, fn: (pts) => calcRSquared(pts.map((p) => p.hdd), pts.map((p) => p.e)) },
      { key: "cdd",           k: 1, fn: (pts) => calcRSquared(pts.map((p) => p.cdd), pts.map((p) => p.e)) },
      { key: "dptdd",         k: 1, fn: (pts) => calcRSquared(pts.map((p) => p.dpt), pts.map((p) => p.e)) },
      { key: "hdd_cdd",       k: 2, fn: (pts) => calcRSquaredMultiN([pts.map((p) => p.hdd), pts.map((p) => p.cdd)], pts.map((p) => p.e)), minN: 6 },
      { key: "hdd_dptdd",     k: 2, fn: (pts) => calcRSquaredMultiN([pts.map((p) => p.hdd), pts.map((p) => p.dpt)], pts.map((p) => p.e)), minN: 6 },
      { key: "cdd_dptdd",     k: 2, fn: (pts) => calcRSquaredMultiN([pts.map((p) => p.cdd), pts.map((p) => p.dpt)], pts.map((p) => p.e)), minN: 6 },
      { key: "hdd_cdd_dptdd", k: 3, fn: (pts) => calcRSquaredMultiN([pts.map((p) => p.hdd), pts.map((p) => p.cdd), pts.map((p) => p.dpt)], pts.map((p) => p.e)), minN: 7 },
    ];

    for (const [streamKey, { series }] of Object.entries(streams)) {
      const byKey = Object.fromEntries(series.map((pt) => [mkKey(pt.year, pt.month), pt.value]));
      const timescales = [];
      for (const nMonths of windowSizes) {
        const windowMonths = [];
        for (let i = nMonths - 1; i >= 0; i--) {
          let wm = m - i, wy = y;
          while (wm <= 0) { wm += 12; wy--; }
          windowMonths.push(mkKey(wy, wm));
        }
        const pts = windowMonths
          .map((k) => ({ k, e: byKey[k] ?? null, hdd: monthlyHDD[k] ?? null, cdd: monthlyCDD[k] ?? null, dpt: monthlyDPTDD[k] ?? null }))
          .filter((p) => p.e !== null && p.hdd !== null && p.cdd !== null && p.dpt !== null);
        if (pts.length < nMonths * 0.8) {
          timescales.push({ label: `${nMonths / 12}yr`, months: nMonths, window: { start: windowMonths[0], end: windowMonths[windowMonths.length - 1] }, coverage: pts.length, skipped: true });
          continue;
        }
        const r2 = {};
        for (const reg of REGRESSIONS) {
          const minN = reg.minN ?? 4;
          const raw = pts.length >= minN ? reg.fn(pts) : null;
          const adj = adjustR2(raw, pts.length, reg.k);
          const rounded = adj !== null ? Math.round(adj * 1000) / 1000 : null;
          r2[reg.key] = { r2: rounded, rating: rateR2(rounded) };
        }
        timescales.push({ label: `${nMonths / 12}yr`, months: nMonths, window: { start: windowMonths[0], end: windowMonths[windowMonths.length - 1] }, coverage: pts.length, r2 });
      }
      timescaleAnalysis[streamKey] = { timescales };
    }

    // Joint recommendation
    const SINGLE = ["hdd", "cdd", "dptdd"];
    const DOUBLE = ["hdd_cdd", "hdd_dptdd", "cdd_dptdd"];
    const TRIPLE = ["hdd_cdd_dptdd"];
    const streamKeys = Object.keys(timescaleAnalysis);
    validLabels = windowSizes
      .map((n) => `${n / 12}yr`)
      .filter((label) => streamKeys.every((sk) => timescaleAnalysis[sk].timescales.some((t) => t.label === label && !t.skipped)))
      .reverse();

    function evalJoint(label, reg) {
      const r2ByStream = {};
      for (const sk of streamKeys) {
        const ts = timescaleAnalysis[sk].timescales.find((t) => t.label === label && !t.skipped);
        if (!ts || !ts.r2[reg] || ts.r2[reg].r2 === null) return null;
        r2ByStream[sk] = ts.r2[reg];
      }
      const vals = Object.values(r2ByStream).map((e) => e.r2);
      return {
        r2ByStream,
        minR2: Math.round(Math.min(...vals) * 1000) / 1000,
        avgR2: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 1000) / 1000,
        allGood:       vals.every((r) => r >= 0.55),
        allAcceptable: vals.every((r) => r >= 0.4),
      };
    }

    // If the property has multi-year data available: best R² across all windows + regression types.
    // If only 1yr of data exists: parsimony (simplest model that passes).
    hasMultiYearData = validLabels.some((l) => l !== "1yr");

    outer: for (const threshold of ["allGood", "allAcceptable"]) {
      const basisLabel = threshold === "allGood" ? "all streams GOOD" : "all streams ACCEPTABLE";
      if (hasMultiYearData) {
        let best = null;
        for (const label of validLabels) {
          for (const reg of [...SINGLE, ...DOUBLE, ...TRIPLE]) {
            const joint = evalJoint(label, reg);
            if (joint?.[threshold] && (best === null || joint.minR2 > best.joint.minR2)) {
              best = { label, reg, joint };
            }
          }
        }
        if (best) {
          const ts = timescaleAnalysis[streamKeys[0]].timescales.find((t) => t.label === best.label);
          recommendation = { timescale: best.label, window: ts.window, months: ts.months, regression: best.reg, ...best.joint, basis: `${basisLabel} (best fit)` };
          break outer;
        }
      } else {
        for (const group of [SINGLE, DOUBLE, TRIPLE]) {
          for (const reg of group) {
            const joint = evalJoint("1yr", reg);
            if (joint?.[threshold]) {
              const ts = timescaleAnalysis[streamKeys[0]].timescales.find((t) => t.label === "1yr");
              recommendation = { timescale: "1yr", window: ts.window, months: ts.months, regression: reg, ...joint, basis: `${basisLabel} (parsimony)` };
              break outer;
            }
          }
        }
      }
    }
    if (!recommendation) {
      let best = null;
      for (const label of validLabels) {
        for (const reg of [...SINGLE, ...DOUBLE, ...TRIPLE]) {
          const joint = evalJoint(label, reg);
          if (joint && (best === null || joint.minR2 > best.minR2)) {
            const ts = timescaleAnalysis[streamKeys[0]].timescales.find((t) => t.label === label);
            best = { timescale: label, window: ts.window, months: ts.months, regression: reg, ...joint, basis: "best available" };
          }
        }
      }
      recommendation = best;
    }

  } catch (err) {
    weatherError = err.message;
  }

  // ── Determine the analysis window ────────────────────────────────────────
  // Use the best recommended window (longest clean run with highest R²).
  // Fall back to a trailing 12-month window if no clean window was found.
  let windowMonths;
  let analysisWindow;
  if (recommendedWindows.length > 0) {
    const best = recommendedWindows[0];
    windowMonths = [];
    const [sy, sm] = best.start.split("-").map(Number);
    const [ey, em] = best.end.split("-").map(Number);
    let cy = sy, cm = sm;
    while (cy < ey || (cy === ey && cm <= em)) {
      windowMonths.push(`${cy}-${String(cm).padStart(2, "0")}`);
      cm++; if (cm > 12) { cm = 1; cy++; }
    }
    analysisWindow = { start: best.start, end: best.end, months: windowMonths.length, source: "recommended" };
  } else {
    windowMonths = [];
    for (let i = 11; i >= 0; i--) {
      let wm = m - i;
      let wy = y;
      while (wm <= 0) { wm += 12; wy--; }
      windowMonths.push(`${wy}-${String(wm).padStart(2, "0")}`);
    }
    analysisWindow = { start: windowMonths[0], end: windowMonths[windowMonths.length - 1], months: 12, source: "fallback_12_month" };
  }

  // ── Check 1: missing, negative, AND exact-zero months ───────────────────
  // Exact zeros are flagged separately: WNM weights them as extra-suspicious
  // outliers because "likeliest incorrect energy value from ESPM is a reading of 0".
  const dataQuality = {};
  for (const [key, { series }] of Object.entries(streams)) {
    const byKey = Object.fromEntries(
      series.map((pt) => [`${pt.year}-${String(pt.month).padStart(2, "0")}`, pt.value])
    );
    const hasNonZero = series.some((pt) => pt.value > 0);
    dataQuality[key] = {
      missingMonths: windowMonths.filter((k) => byKey[k] === undefined),
      negativeMonths: windowMonths.filter((k) => byKey[k] !== undefined && byKey[k] < 0),
      zeroMonths: windowMonths.filter((k) => byKey[k] === 0 && hasNonZero),
    };
  }

  // ── Check 4: flat / annualized profile (CV of analysis window) ───────────
  // CV < 0.05 indicates all months are nearly identical — a tenant likely
  // entered a single annual figure that ESPM spread evenly (see VA-841).
  const flatProfile = {};
  for (const [key, { series }] of Object.entries(streams)) {
    const byKey = Object.fromEntries(
      series.map((pt) => [`${pt.year}-${String(pt.month).padStart(2, "0")}`, pt.value])
    );
    const vals = windowMonths.map((k) => byKey[k]).filter((v) => v !== undefined && v !== null && v > 0);
    if (vals.length < 6) {
      flatProfile[key] = { cv: null, status: "INSUFFICIENT_DATA" };
      continue;
    }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const stddev = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    const cv = mean > 0 ? stddev / mean : 0;
    flatProfile[key] = {
      cv: Math.round(cv * 1000) / 1000,
      status: cv < 0.05 ? "FLAT (possible annualized data)" : "OK",
    };
  }

  // ── Check 5: year-over-year change (complete calendar years only) ─────────
  const yearOverYear = {};
  for (const [key, { series }] of Object.entries(streams)) {
    const byYear = {};
    for (const pt of series) {
      if (!byYear[pt.year]) byYear[pt.year] = [];
      byYear[pt.year].push(pt.value);
    }
    const completeYears = Object.entries(byYear)
      .filter(([, vals]) => vals.length === 12)
      .map(([yr, vals]) => ({ year: parseInt(yr, 10), total: Math.round(vals.reduce((a, b) => a + b, 0) * 10) / 10 }))
      .sort((a, b) => a.year - b.year);
    const changes = [];
    for (let i = 1; i < completeYears.length; i++) {
      const prev = completeYears[i - 1];
      const curr = completeYears[i];
      const pct = prev.total > 0 ? (curr.total - prev.total) / prev.total : null;
      changes.push({
        from: prev.year, to: curr.year,
        fromTotal: prev.total, toTotal: curr.total,
        changePct: pct !== null ? Math.round(pct * 1000) / 10 : null,
        flagged: pct !== null && Math.abs(pct) > 0.4,
      });
    }
    yearOverYear[key] = { completeYears, changes };
  }

  // ── Check 6: spike detection (>3× median of analysis window) ─────────────
  const spikes = {};
  for (const [key, { series }] of Object.entries(streams)) {
    const byKey = Object.fromEntries(
      series.map((pt) => [`${pt.year}-${String(pt.month).padStart(2, "0")}`, pt.value])
    );
    const vals = windowMonths.map((k) => byKey[k]).filter((v) => v !== undefined && v !== null && v > 0);
    if (!vals.length) { spikes[key] = { median: null, spikedMonths: [] }; continue; }
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const spikedMonths = windowMonths
      .filter((k) => byKey[k] !== undefined && byKey[k] > 3 * median)
      .map((k) => ({ month: k, value: Math.round(byKey[k] * 10) / 10, ratio: Math.round((byKey[k] / median) * 10) / 10 }));
    spikes[key] = { median: Math.round(median * 10) / 10, spikedMonths };
  }

  // ── Check 7: summer electricity dip (solar net-metering proxy) ────────────
  // In Canada, summer electricity should not be lower than winter unless solar
  // generation is netted at the meter. Flag if summer avg < 80% of winter avg.
  let summerElecDip = null;
  if (streams.electricity) {
    const byKey = Object.fromEntries(
      streams.electricity.series.map((pt) => [`${pt.year}-${String(pt.month).padStart(2, "0")}`, pt.value])
    );
    const winterMonths = windowMonths.filter((k) => [12, 1, 2].includes(parseInt(k.split("-")[1], 10)));
    const summerMonths = windowMonths.filter((k) => [6, 7, 8].includes(parseInt(k.split("-")[1], 10)));
    const winterVals = winterMonths.map((k) => byKey[k]).filter((v) => v !== undefined && v > 0);
    const summerVals = summerMonths.map((k) => byKey[k]).filter((v) => v !== undefined && v > 0);
    if (winterVals.length >= 2 && summerVals.length >= 2) {
      const winterAvg = winterVals.reduce((a, b) => a + b, 0) / winterVals.length;
      const summerAvg = summerVals.reduce((a, b) => a + b, 0) / summerVals.length;
      const ratio = Math.round((summerAvg / winterAvg) * 100) / 100;
      summerElecDip = {
        winterAvg: Math.round(winterAvg * 10) / 10,
        summerAvg: Math.round(summerAvg * 10) / 10,
        ratio,
        status: ratio < 0.8 ? "FLAGGED (possible solar net-metering)" : "OK",
        caveat: ratio < 0.8 && SUMMER_DOMINANT_ELEC_TYPES.has(primaryFunction)
          ? `Note: ${primaryFunction} buildings typically have higher summer electricity consumption (e.g. ice cooling, refrigeration). Verify whether this dip reflects solar net-metering or is expected for this building type.`
          : null,
      };
    }
  }

  // Collect all triggered checks into a flat flags list for easy scanning
  const flags = [];
  for (const [key, q] of Object.entries(dataQuality)) {
    if (q.missingMonths.length) flags.push({ check: "missingMonths", stream: key, months: q.missingMonths });
    if (q.negativeMonths.length) flags.push({ check: "negativeMonths", stream: key, months: q.negativeMonths });
    if (q.zeroMonths.length) flags.push({ check: "zeroMonths", stream: key, months: q.zeroMonths });
  }
  for (const [key, fp] of Object.entries(flatProfile)) {
    if (fp.status && fp.status !== "OK" && fp.status !== "INSUFFICIENT_DATA")
      flags.push({ check: "flatProfile", stream: key, status: fp.status });
  }
  for (const [key, yoy] of Object.entries(yearOverYear)) {
    for (const ch of yoy.changes) {
      if (ch.flagged) flags.push({ check: "yearOverYear", stream: key, from: ch.from, to: ch.to, changePct: ch.changePct });
    }
  }
  for (const [key, sp] of Object.entries(spikes)) {
    if (sp.spikedMonths?.length) flags.push({ check: "spike", stream: key, months: sp.spikedMonths.map((s) => s.month) });
  }
  if (summerElecDip?.status && summerElecDip.status !== "OK")
    flags.push({ check: "summerElecDip", ratio: summerElecDip.ratio, status: summerElecDip.status, caveat: summerElecDip.caveat || undefined });
  if (recommendedWindows.length === 0 && !weatherError)
    flags.push({ check: "noCleanWindow", message: "No contiguous clean window ≥6 months found across all streams" });

  // ── Narrative ───────────────────────────────────────────────────────────────
  const narrative = [];
  const streamNames = Object.keys(streams);
  const allSeries = Object.values(streams).flatMap((s) => s.series);
  const earliestYear = allSeries.length ? Math.min(...allSeries.map((s) => s.year)) : y;
  const earliestMonth = allSeries.filter((s) => s.year === earliestYear).length
    ? Math.min(...allSeries.filter((s) => s.year === earliestYear).map((s) => s.month))
    : 1;
  const yearsOfData = validLabels.length ? Math.max(...validLabels.map((l) => parseInt(l))) : 1;

  // Step 1: Data collection
  narrative.push({
    step: 1,
    title: "Data collection",
    detail: `Retrieved ${yearsOfData} year${yearsOfData !== 1 ? "s" : ""} of monthly energy data for ${streamNames.join(" and ")} spanning ${earliestYear}-${String(earliestMonth).padStart(2, "0")} to ${y}-${String(m).padStart(2, "0")}. Matched with daily weather data from Open-Meteo for ${address?.city || "the property location"}, converted to monthly HDD (base 18°C, ASHRAE), CDD (base 10°C, ASHRAE 90.1), and DPTDD (base 11°C) values.`,
  });

  // Step 2: Data quality
  if (flags.length === 0) {
    narrative.push({
      step: 2,
      title: "Data quality",
      detail: "All quality checks passed — no missing months, no negative or zero readings, no spikes, no flat/annualised profiles, and no large year-over-year jumps. The data is clean and complete.",
    });
  } else {
    const flagSummary = flags.map((f) => {
      if (f.check === "missingMonths") return `${f.months.length} missing month(s) in ${f.stream}`;
      if (f.check === "spike") return `spike(s) in ${f.stream}`;
      if (f.check === "flatProfile") return `flat/annualised profile in ${f.stream}`;
      if (f.check === "yearOverYear") return `${f.changePct > 0 ? "+" : ""}${f.changePct}% YoY change in ${f.stream} (${f.from}→${f.to})`;
      if (f.check === "summerElecDip") return "possible solar net-metering on electricity";
      if (f.check === "zeroMonths") return `zero-value month(s) in ${f.stream}`;
      if (f.check === "negativeMonths") return `negative value(s) in ${f.stream}`;
      return f.check;
    }).join("; ");
    narrative.push({
      step: 2,
      title: "Data quality",
      detail: `${flags.length} issue(s) flagged: ${flagSummary}. These should be reviewed before calibration as they may affect the regression results.`,
    });
  }

  // Step 3: Regression strategy
  if (weatherError) {
    narrative.push({
      step: 3,
      title: "Regression strategy",
      detail: `Weather data could not be retrieved (${weatherError}). Regression analysis was skipped — quality checks above are still valid but no R² or recommendation is available.`,
    });
  } else if (hasMultiYearData) {
    narrative.push({
      step: 3,
      title: "Regression strategy: best fit",
      detail: `The property has ${yearsOfData} years of data available. With enough data points, adding extra weather predictors (CDD, DPTDD) is genuinely informative rather than noise-fitting. We scan all ${validLabels.length} window size${validLabels.length !== 1 ? "s" : ""} (${validLabels[validLabels.length - 1]} to ${validLabels[0]}) and all 7 weather-driver combinations to find the option that maximises the minimum adjusted R² across all fuel streams simultaneously. All R² values are adjusted for the number of predictors — a 3-predictor model needs a meaningfully higher raw R² to beat a 1-predictor model.`,
    });
  } else {
    narrative.push({
      step: 3,
      title: "Regression strategy: parsimony",
      detail: "Only 1 year (12 months) of data is available. With so few data points, adding extra predictors risks overfitting — the model would memorise the quirks of that specific year rather than the true weather-energy relationship. We use the simplest model (fewest predictors) that still achieves GOOD adjusted R² for all streams.",
    });
  }

  // Step 4: Per-stream weather signal analysis
  if (!weatherError) {
    for (const [streamKey, types] of Object.entries(rSquared)) {
      const tsByStream = timescaleAnalysis[streamKey]?.timescales || [];
      const validTs = tsByStream.filter((t) => !t.skipped);
      const fullWindowBest = Object.entries(types)
        .filter(([, v]) => v.r2 !== null)
        .sort((a, b) => (b[1].r2 ?? 0) - (a[1].r2 ?? 0))[0];

      // Find the last timescale where any regression is GOOD
      const lastGoodTs = [...validTs].reverse().find((ts) =>
        Object.values(ts.r2).some((v) => v.rating === "GOOD")
      );
      const firstPoorTs = validTs.find((ts) =>
        Object.values(ts.r2).every((v) => v.rating !== "GOOD")
      );

      let detail;
      if (fullWindowBest?.[1]?.rating === "GOOD") {
        detail = `Strong weather correlation over the full ${yearsOfData}-year window — best regression is ${fullWindowBest[0]} (R²=${fullWindowBest[1].r2}).`;
        if (lastGoodTs && firstPoorTs) {
          detail += ` Signal remains reliable up to the ${lastGoodTs.label} window and degrades beyond — suggesting the building's operating regime changed roughly ${firstPoorTs.label.replace("yr", "")} years ago.`;
        }
      } else {
        // Full window is poor — find best short-window result
        let bestShort = null;
        for (const ts of validTs) {
          for (const [reg, v] of Object.entries(ts.r2)) {
            if (v.rating === "GOOD" && (bestShort === null || v.r2 > bestShort.r2)) {
              bestShort = { label: ts.label, reg, r2: v.r2 };
            }
          }
        }
        if (bestShort) {
          detail = `Over the full ${yearsOfData}-year window, ${streamKey} shows poor weather correlation (best R²=${fullWindowBest?.[1]?.r2 ?? "n/a"}) — the long-term signal is masked by structural changes in the building's operation (e.g. occupancy shifts, retrofits, or system changes). However, at ${bestShort.label} the signal is strong (${bestShort.reg}, R²=${bestShort.r2}), meaning recent consumption patterns are weather-driven. A shorter calibration window is preferred for this stream.`;
        } else {
          detail = `${streamKey} shows poor weather correlation at all timescales (best R²=${fullWindowBest?.[1]?.r2 ?? "n/a"}). This stream may be dominated by occupancy, plug loads, or process energy rather than weather — calibration against weather drivers may have limited accuracy.`;
        }
      }
      // Disconnect check: does the joint recommendation use a different regression than what's individually optimal for this stream?
      if (recommendation) {
        const recTs = timescaleAnalysis[streamKey]?.timescales.find((t) => t.label === recommendation.timescale && !t.skipped);
        if (recTs) {
          const streamBestAtRec = Object.entries(recTs.r2)
            .filter(([, v]) => v.r2 !== null)
            .sort((a, b) => (b[1].r2 ?? 0) - (a[1].r2 ?? 0))[0];
          if (streamBestAtRec && streamBestAtRec[0] !== recommendation.regression) {
            const drivingStreams = streamNames.filter((sk) => {
              if (sk === streamKey) return false;
              const otherTs = timescaleAnalysis[sk]?.timescales.find((t) => t.label === recommendation.timescale && !t.skipped);
              if (!otherTs) return false;
              const withSimpler = otherTs.r2[streamBestAtRec[0]];
              const withRecommended = otherTs.r2[recommendation.regression];
              return withSimpler?.rating !== "GOOD" && withRecommended?.rating === "GOOD";
            });
            if (drivingStreams.length > 0) {
              detail += ` Note: at the recommended ${recommendation.timescale} window, ${streamKey} alone would be best served by ${streamBestAtRec[0]} (adj R²=${streamBestAtRec[1].r2}), but the joint recommendation uses ${recommendation.regression} because ${drivingStreams.join(" and ")} need${drivingStreams.length === 1 ? "s" : ""} the additional predictor(s) to reach GOOD.`;
            }
          }
        }
      }

      narrative.push({ step: 4, title: `${streamKey} analysis`, detail });
    }
  }

  // Step 5: Recommendation rationale
  if (recommendation) {
    const streamSummary = Object.entries(recommendation.r2ByStream)
      .map(([k, v]) => `${k} adj R²=${v.r2} (${v.rating})`).join(", ");
    narrative.push({
      step: 5,
      title: "Recommendation",
      detail: `Use the ${recommendation.timescale} window (${recommendation.window.start} → ${recommendation.window.end}) with ${recommendation.regression} as the weather driver(s). This gives the best joint fit across all streams: minimum adj R²=${recommendation.minR2} (${streamSummary}). Basis: ${recommendation.basis}.`,
    });
  } else {
    narrative.push({
      step: 5,
      title: "Recommendation",
      detail: "No window achieved GOOD or ACCEPTABLE adjusted R² for all streams simultaneously. Calibration against weather drivers may not be reliable for this property — investigate the data quality issues and consider whether the building's energy use is weather-sensitive.",
    });
  }

  // Step 6: Meter-level checks reminder
  narrative.push({
    step: 6,
    title: "Also recommended: run_data_quality_check",
    detail: "This tool checks the energy time series only. Before calibration, also run run_data_quality_check on this property to verify meter configuration — it will flag aggregated meters, missing fuel types (e.g. no gas meter despite gas use being expected), solar net-metering at the meter level, and manual data entry. These are separate from time-series quality and can materially affect calibration accuracy.",
  });

  return {
    propertyId,
    propertyName: prop?.name || "Unknown",
    primaryFunction,
    gfaM2: Math.round(gfaM2),
    dataAnchor: { year: y, month: m },
    narrative,
    recommendation,
    flags,
    analysisWindow,
    recommendedWindows,
    rSquared,
    timescaleAnalysis,
    dataQuality,
    flatProfile,
    yearOverYear,
    spikes,
    summerElecDip,
    weatherError: weatherError || undefined,
  };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const ACCOUNT_NAME_PROP = {
  account_name: {
    type: "string",
    description:
      "ESPM username from accounts.csv. Optional only when exactly one account is configured; otherwise required.",
  },
};

export function createEspmServer() {
  const server = new Server(
    { name: "espm-mcp", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

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
        name: "run_full_diagnostic",
        description:
          "Run a complete VAM readiness diagnostic on a property. Checks meter configuration (aggregated meters, coverage gaps, EUI benchmarks, manual entry) AND scans all monthly readings for faulty data points (negatives, isolated zeros, zero sequences, spikes/drops vs adjacent months). Returns a unified report with all issues and a recommended VAM calibration strategy. Use this as the primary entry point for any property data quality investigation.",
        inputSchema: {
          type: "object",
          properties: {
            property_id: { type: "string", description: "The ESPM property ID" },
            year: { type: "number", description: "Year to check readings for (defaults to last full year)" },
            ...ACCOUNT_NAME_PROP,
          },
          required: ["property_id"],
        },
      },
      {
        name: "run_data_quality_check",
        description:
          "Run a meter-level data quality diagnostic on a property before a VAM run. Checks for aggregated meters, missing electricity/gas meters, solar net metering, suspiciously low EUI (partial coverage), and manual data entry. Returns a structured report with a vamReadiness assessment. For a full diagnostic including per-reading fault detection, use run_full_diagnostic instead.",
        inputSchema: {
          type: "object",
          properties: {
            property_id: { type: "string", description: "The ESPM property ID" },
            ...ACCOUNT_NAME_PROP,
          },
          required: ["property_id"],
        },
      },
      {
        name: "get_meter_consumption",
        description:
          "Get monthly consumption data for a specific meter, with stats on billing regularity, seasonal variation, and profile shape. Use this after run_data_quality_check to diagnose whether a gas meter has irregular billing (needs HDD smoothing), a flat/baseload-only profile (DHW, not space heating), or data gaps. Requires a meter ID from the meter list.",
        inputSchema: {
          type: "object",
          properties: {
            meter_id: { type: "string", description: "The ESPM meter ID" },
            year: { type: "number", description: "Year to fetch consumption data for (defaults to last full year)" },
            ...ACCOUNT_NAME_PROP,
          },
          required: ["meter_id"],
        },
      },
      {
        name: "check_aggregated_meters",
        description:
          "Check if a property has any meters whose names look like aggregated meters (e.g. 'Whole Building', 'Building Total', 'Aggregate'). Returns the full meter list and flags suspected aggregated meters.",
        inputSchema: {
          type: "object",
          properties: {
            property_id: { type: "string", description: "The ESPM property ID" },
            ...ACCOUNT_NAME_PROP,
          },
          required: ["property_id"],
        },
      },
      {
        name: "detect_faulty_data_points",
        description:
          "Scan all meters on a property for faulty individual readings: negative values, isolated zeros (likely missed reads), consecutive zero sequences (missing data periods), and anomalous spikes or drops vs adjacent months. Returns flagged readings with recommendations to null them in ESPM before VAM calibration.",
        inputSchema: {
          type: "object",
          properties: {
            property_id: { type: "string", description: "The ESPM property ID" },
            year: { type: "number", description: "Year to check (defaults to last full year)" },
            ...ACCOUNT_NAME_PROP,
          },
          required: ["property_id"],
        },
      },
      ...getSuspiciousDataTools(ACCOUNT_NAME_PROP),
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
      {
        name: "get_monthly_energy_stream",
        description:
          "Get monthly energy consumption time series for a property by fuel type — electricity, natural gas, district energy, fuel oil, propane. Returns calendar-month values in GJ for all fuel types that have data, up to the specified year/month anchor.",
        inputSchema: {
          type: "object",
          properties: {
            property_id: {
              type: "string",
              description: "The ESPM property ID",
            },
            year: {
              type: "number",
              description: "End year of the data window (defaults to last full year)",
            },
            month: {
              type: "number",
              description: "End month of the data window (defaults to 12)",
            },
            ...ACCOUNT_NAME_PROP,
          },
          required: ["property_id"],
        },
      },
      {
        name: "assess_calibration_readiness",
        description:
          "Full calibration readiness assessment for a property. Fetches up to 10 years of energy data and weather (HDD, CDD, DPTDD) in one pass, then returns: (1) data quality flags — missing/negative/zero months, flat profiles, year-over-year changes, spikes, summer electricity dip; (2) full-window R² for all 7 weather-driver combinations per stream; (3) timescale R² matrix (1yr–10yr × 7 regression types); (4) joint recommendation — the longest window and simplest regression type where all fuel streams meet the quality threshold simultaneously.",
        inputSchema: {
          type: "object",
          properties: {
            property_id: { type: "string", description: "The ESPM property ID" },
            ...ACCOUNT_NAME_PROP,
          },
          required: ["property_id"],
        },
      },
    ],
  }));

  const READ_ONLY_TOOLS = new Set([
    "list_accounts",
    "get_account",
    "list_properties",
    "get_property",
    "get_property_metrics",
    "list_property_groups",
    "get_property_group",
    "get_group_score_summary",
    "get_portfolio_summary",
    "run_data_quality_check",
    "get_meter_consumption",
    "check_aggregated_meters",
    "list_property_meters",
    "get_meter_consumption_data",
    "suspicious_data_check",
    "get_energy_star_certification_summary",
    "get_monthly_energy_stream",
    "assess_calibration_readiness",
  ]);

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!READ_ONLY_TOOLS.has(name)) {
      throw new Error(`Tool "${name}" is not registered. This server is read-only.`);
    }

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
        case "run_full_diagnostic":
          result = await runFullDiagnostic(args.property_id, args.year, args.account_name);
          break;
        case "run_data_quality_check":
          result = await runDataQualityCheck(args.property_id, args.account_name);
          break;
        case "get_meter_consumption":
          result = await getMeterConsumption(args.meter_id, args.year, args.account_name);
          break;
        case "check_aggregated_meters":
          result = await checkAggregatedMeters(args.property_id, args.account_name);
          break;
        case "detect_faulty_data_points":
          result = await detectFaultyDataPoints(args.property_id, args.year, args.account_name);
          break;
        case "get_energy_star_certification_summary":
          result = await getEnergyStarCertificationSummary(args.year, args.account_name);
          break;
        case "get_monthly_energy_stream":
          result = await getMonthlyEnergyStream(args.property_id, args.year, args.month, args.account_name);
          break;
        case "assess_calibration_readiness":
          result = await assessCalibrationReadiness(args.property_id, args.account_name);
          break;
        default: {
          const suspiciousDataDeps = { espmGet, arrayify, extractLinkId, extractText, getProperty, accounts, resolveCredentials };
          result = await handleSuspiciousDataTool(name, args, suspiciousDataDeps);
          if (result === null) throw new Error(`Unknown tool: ${name}`);
          break;
        }
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

  return server;
}
