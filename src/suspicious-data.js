/**
 * Suspicious Data Workflow
 * Decision-tree checks to determine whether a property's energy data looks legitimate.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Expected GFA Data ───────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// Maps custom-id-1 → expected GFA (m²)
const expectedGfaMap = new Map();

try {
  const gfaPath = join(__dirname, "../melody-workflow-resources/crd_expected_gfa.csv");
  const text = readFileSync(gfaPath, "utf8");
  for (const line of text.split("\n").slice(1)) {
    const [customId, gfa] = line.split(",").map((s) => s.trim());
    if (customId && gfa) expectedGfaMap.set(customId, parseFloat(gfa));
  }
} catch {
  // GFA file not available — GFA checks will be skipped
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── API Functions ───────────────────────────────────────────────────────────

async function listPropertyMeters(propertyId, accountName, { espmGet, arrayify, extractLinkId }) {
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

async function getMeterConsumptionData(meterId, startDate, endDate, accountName, { espmGet, arrayify, extractText }) {
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

// ─── Aggregation Guidance ─────────────────────────────────────────────────────

const AGGREGATION_GUIDANCE = `You must now determine whether this property type would be expected to have an aggregated meter.

An aggregated meter is expected when the property would have 3 or more commercial BC Hydro accounts or 5 or more residential BC Hydro accounts. Use the property type to judge this:

LIKELY NEEDS aggregated meter:
- Multifamily Housing / Strata — many residential units, each with their own BC Hydro account
- Senior Living Community / Assisted Living — many residential units
- Residence Hall / Dormitory — many residential units
- Mixed Use Property — residential + commercial units
- Hotel / Resort — many individually-metered rooms possible

LIKELY DOES NOT need aggregated meter:
- Office / Warehouse / Retail — typically one or a few commercial accounts
- K-12 School / Library / Fire Station / Worship Facility — single account
- Swimming Pool / Recreation Centre — single account
- Parking — single account

When in doubt, lean toward expecting an aggregated meter.

If an aggregated meter IS expected, check the meters list for one that has aggregateMeter=true or whose name contains "aggregated", "suites", "units", or "residents". If found, the property data looks good. If not found, the building owner should be contacted.

If an aggregated meter is NOT expected, the property data looks good.`;

// ─── Main Workflow ───────────────────────────────────────────────────────────

async function suspiciousDataCheck(propertyId, accountName, deps, { customId } = {}) {
  const { getProperty, accounts } = deps;
  const steps = [];

  // STEP 1: Get property details (try all accounts if needed)
  steps.push({ check: "Get property details", status: "running" });
  let property;
  let resolvedAccountName = accountName;

  if (accountName) {
    // Specific account requested — try only that one
    try {
      property = await getProperty(propertyId, accountName);
    } catch (err) {
      steps[steps.length - 1].status = "error";
      steps[steps.length - 1].result = err.message;
      if (err.message.includes("404")) {
        return {
          propertyId,
          steps,
          outcome: "error",
          message: `Property ${propertyId} not found using ESPM account "${accountName}". Verify the property ID is correct and that it has been shared with this account.`,
        };
      }
      return { propertyId, steps, outcome: "error", message: `Could not retrieve property: ${err.message}` };
    }
  } else {
    // No account specified — try all available accounts
    const triedAccounts = [];
    for (const [name] of accounts) {
      try {
        property = await getProperty(propertyId, name);
        resolvedAccountName = name;
        break;
      } catch (err) {
        triedAccounts.push(name);
      }
    }
    if (!property) {
      steps[steps.length - 1].status = "error";
      steps[steps.length - 1].result = `Property not found in any account`;
      return {
        propertyId,
        steps,
        outcome: "error",
        message: `Property ${propertyId} not found. Tried ESPM account(s): ${triedAccounts.join(", ")}. Verify the property ID is correct and that it has been shared with one of these accounts.`,
      };
    }
  }

  steps[steps.length - 1].status = "done";
  steps[steps.length - 1].result = {
    name: property.name,
    address: property.address,
    primaryFunction: property.primaryFunction,
    account: resolvedAccountName || accounts.keys().next().value,
  };

  const propertyType = property.primaryFunction || "Unknown";
  const isCrd = resolvedAccountName === "CRDBenchmarking";

  // ─── GFA Check (independent, CRD only) ───
  let gfaFlag = null; // null = not checked, "pass" or "fail"
  let gfaDetails = null;
  if (isCrd) {
    steps.push({ check: "GFA check (CRD)", status: "running" });
    if (!customId) {
      steps[steps.length - 1].status = "done";
      steps[steps.length - 1].result = "Custom ID not provided — GFA check skipped";
    } else {
      const expectedGfa = expectedGfaMap.get(customId);
      if (expectedGfa == null) {
        steps[steps.length - 1].status = "done";
        steps[steps.length - 1].result = `Custom ID ${customId} not found in expected GFA list — GFA check skipped`;
      } else {
        const actualGfa = parseFloat(property.grossFloorArea);
        if (isNaN(actualGfa)) {
          steps[steps.length - 1].status = "done";
          steps[steps.length - 1].result = "No GFA value in ESPM — GFA check skipped";
        } else {
          const pctDiff = Math.abs(actualGfa - expectedGfa) / expectedGfa;
          gfaDetails = {
            customId,
            actualGfa: Math.round(actualGfa * 100) / 100,
            expectedGfa: Math.round(expectedGfa * 100) / 100,
            pctDiff: Math.round(pctDiff * 1000) / 10,
          };
          if (pctDiff > 0.4) {
            gfaFlag = "fail";
            steps[steps.length - 1].status = "done";
            steps[steps.length - 1].result = `ESPM GFA (${gfaDetails.actualGfa} m²) differs from expected (${gfaDetails.expectedGfa} m²) by ${gfaDetails.pctDiff}% — exceeds 40% threshold`;
          } else {
            gfaFlag = "pass";
            steps[steps.length - 1].status = "done";
            steps[steps.length - 1].result = `ESPM GFA (${gfaDetails.actualGfa} m²) vs expected (${gfaDetails.expectedGfa} m²) — ${gfaDetails.pctDiff}% difference, within threshold`;
          }
        }
      }
    }
  }

  const gfaResult = { gfaFlag, gfaDetails, customId: customId || null };

  // STEP 2: Check meter access
  steps.push({ check: "Check meter access", status: "running" });
  let metersResult;
  let hasMeterAccess = false;
  try {
    metersResult = await listPropertyMeters(propertyId, resolvedAccountName, deps);
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

    // TODO: Check whether this specific property has been shared with BC Hydro.
    // The ESPM API has no endpoint for property-level sharing. This will require
    // scraping the ESPM web UI property summary page to read the "Sharing this
    // Property" table. For now, we always return false.
    steps.push({ check: "Check if property is shared with BC Hydro", status: "done" });
    const bcHydroShared = false;
    steps[steps.length - 1].result = "Unable to verify (property-level sharing check not yet implemented)";

    if (!bcHydroShared) {
      return {
        propertyId,
        propertyName: property.name,
        propertyType,
        steps,
        bcHydroConnected: false,
        ...gfaResult,
        outcome: "suspicious",
        message:
          "We cannot see the meters and cannot yet verify whether the property has been shared with BC Hydro. The building owner should be contacted.",
      };
    }
  }

  // ─── BRANCH B: Have meter access ───
  steps[steps.length - 1].nextAction = "Have meter access → checking data source on each meter";

  // TODO: Check whether this specific property has been shared with BC Hydro.
  // The ESPM API has no endpoint for property-level sharing. This will require
  // scraping the ESPM web UI property summary page to read the "Sharing this
  // Property" table. For now, we always return false.
  const bcHydroConnected = false;
  const bcHydroCustomerName = null;

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
      const consumption = await getMeterConsumptionData(meter.id, null, null, resolvedAccountName, deps);
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

  // If we couldn't read consumption data on any meter, treat as "meters not shared"
  const allUnreadable = meterDetails.length > 0 && meterDetails.every((m) => m.source === "unknown");
  if (allUnreadable) {
    steps[steps.length - 1].result = "Could not read consumption data on any meter — treating as meters not shared";

    // Include meter names/types we could see even though consumption data was unreadable
    const visibleMeters = metersResult.meters.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      aggregateMeter: m.aggregateMeter,
    }));

    if (!bcHydroConnected) {
      return {
        propertyId,
        propertyName: property.name,
        propertyType,
        steps,
        meters: visibleMeters,
        bcHydroConnected,
        bcHydroCustomerName,
        ...gfaResult,
        outcome: "suspicious",
        message:
          "The property has not been shared with BC Hydro. We cannot read the meter data. The building owner should be contacted.",
      };
    }

    // Shared with BC Hydro but can't read meters — defer aggregation judgment
    return {
      propertyId,
      propertyName: property.name,
      propertyType,
      steps,
      meters: visibleMeters,
      bcHydroConnected,
      bcHydroCustomerName,
      ...gfaResult,
      outcome: "requires_aggregation_judgment",
      message: `The property is shared with BC Hydro but we cannot read the meter data. Property type: "${propertyType}". ${AGGREGATION_GUIDANCE}`,
    };
  }

  const baseResult = {
    propertyId,
    propertyName: property.name,
    propertyType,
    steps,
    meters: meterDetails,
    bcHydroConnected,
    bcHydroCustomerName,
    ...gfaResult,
  };

  if (!anyBcHydro) {
    return {
      ...baseResult,
      outcome: "suspicious",
      message:
        "The meter data was manually entered (not from BC Hydro Web Services). The property owner should be contacted.",
    };
  }

  // Return data for Claude to decide on aggregation
  return {
    ...baseResult,
    outcome: "requires_aggregation_judgment",
    message: `The meter data is from BC Hydro Web Services. Property type: "${propertyType}". ${AGGREGATION_GUIDANCE}`,
  };
}

// ─── Email Template & Display Instructions ───────────────────────────────────

const EMAIL_TEMPLATE_INSTRUCTIONS = `
If the verdict is ⚠️ (the property owner should be contacted), also print a draft email below the verdict. If contactEmail is present in the result, print "To: [contactEmail]" above the email.

There are THREE email templates depending on what failed. Check gfaFlag and the meter outcome to determine which:
- If ONLY the GFA check failed (gfaFlag is "fail" and meter checks passed): use the GFA TEMPLATE
- If ONLY the meter checks failed (gfaFlag is not "fail"): use the METER TEMPLATE
- If BOTH failed: use the HYBRID TEMPLATE

CRITICAL: Copy the template below VERBATIM. Do NOT rephrase, reword, or paraphrase any sentence. The ONLY changes allowed are:
- Replace {{CONTACT_NAME}} with the contactName from the result if present, otherwise use "x"
- Replace {{PROPERTY_NAME}} with the actual property name
- Replace {{PROPERTY_ID}} with the actual property ID
- Replace {{METER_TYPES}} with the actual meter types from the data (e.g. "Natural Gas" or "District Energy")
- Include or exclude entire paragraphs based on the conditions noted — but never change the wording of a paragraph you include.

===== METER TEMPLATE (use when only meter checks failed) =====

Hi {{CONTACT_NAME}},

Thank you for submitting your building {{PROPERTY_NAME}} (ID: {{PROPERTY_ID}}) to the Building Owner Portal!

Upon our initial review, the data suggests that the energy usage data submitted is incomplete based on typical Site EUI ranges. Please add all meters and energy sources (examples include: {{METER_TYPES}}) for the entire building and verify the units of the energy data submitted.

[Include the next paragraph ONLY if an aggregated meter is expected based on property type:]
For Strata buildings, please ensure that you have reported the Electricity consumption data from the Common Area meter as well as the residential units. BC Hydro can help you aggregate the Electricity data for stratas with more than 5 residential accounts. You can find the instructions in our Data Aggregation article in Part 1 of our knowledge base.

We'd also like to point out that it's an option to set up the automatic data exchange with BC Hydro or FortisBC by following the instructions in our knowledge base, which can replace manual data entry: https://support.crdbenchmarking.ca/portal/en/kb/articles/3-1-how-to-add-energy-data-automatically-set-up-data-exchange-with-utility-provider-s-in-espm

Once this information has been added in ENERGY STAR Portfolio Manager, please click resubmit in the Building Owner Portal to complete your submission.

If you have any questions, please let us know.

===== GFA TEMPLATE (use when only GFA check failed) =====

Hi {{CONTACT_NAME}},

Thank you for submitting your building {{PROPERTY_NAME}} (CRD ID: {{CUSTOM_ID}}) to the Building Owner Portal (https://bop.opentech.eco/orgs/crd). Upon our review, the energy data looks complete but we wanted to flag a discrepancy between the Gross Floor Area entered into ESPM ({{ESPM_GFA}} m²) and the GFA on our covered buildings list ({{EXPECTED_GFA}} m²). To be clear, the Gross Floor Area on our covered buildings list is an estimated value, but we would like to double check that you are using the GFA definition from ENERGY STAR Portfolio Manager (ESPM Resource), not another measure of floor area.

Please confirm, and if you have access to documentation such as building floor plans, architectural drawings, engineering reports, or insurance documents please share so that we can update our program's buildings list if needed.

If you have any questions, please let us know.

===== HYBRID TEMPLATE (use when BOTH GFA and meter checks failed) =====

Hi {{CONTACT_NAME}},

Thank you for submitting your building {{PROPERTY_NAME}} (CRD ID: {{CUSTOM_ID}}) to the Building Owner Portal (https://bop.opentech.eco/orgs/crd). Upon our review, we wanted to flag a couple of items:

1. There is a discrepancy between the Gross Floor Area entered into ESPM ({{ESPM_GFA}} m²) and the GFA on our covered buildings list ({{EXPECTED_GFA}} m²). To be clear, the Gross Floor Area on our covered buildings list is an estimated value, but we would like to double check that you are using the GFA definition from ENERGY STAR Portfolio Manager (ESPM Resource), not another measure of floor area. Please confirm, and if you have access to documentation such as building floor plans, architectural drawings, engineering reports, or insurance documents please share so that we can update our program's buildings list if needed.

2. The energy usage data submitted appears incomplete based on typical Site EUI ranges. Please add all meters and energy sources (examples include: {{METER_TYPES}}) for the entire building and verify the units of the energy data submitted.

[Include the next paragraph ONLY if an aggregated meter is expected based on property type:]
For Strata buildings, please ensure that you have reported the Electricity consumption data from the Common Area meter as well as the residential units. BC Hydro can help you aggregate the Electricity data for stratas with more than 5 residential accounts. You can find the instructions in our Data Aggregation article in Part 1 of our knowledge base.

We'd also like to point out that it's an option to set up the automatic data exchange with BC Hydro or FortisBC by following the instructions in our knowledge base, which can replace manual data entry: https://support.crdbenchmarking.ca/portal/en/kb/articles/3-1-how-to-add-energy-data-automatically-set-up-data-exchange-with-utility-provider-s-in-espm

Once this information has been added in ENERGY STAR Portfolio Manager, please click resubmit in the Building Owner Portal to complete your submission.

If you have any questions, please let us know.

=====
`;

const DISPLAY_INSTRUCTIONS = `
IMPORTANT: Always present suspicious data check results in this compact format. Do NOT use tables. Do NOT add extra commentary beyond the verdict line.

**Suspicious Data Check — [propertyName] (ID: [propertyId])**

[propertyName], [address]
[propertyType] | Account: [account]

Then print a bulleted list with ONE bullet per check that was actually traversed. Each check MUST be its own bullet — never combine checks. Be concise.

- GFA check: [✅/⚠️/skipped] [short result] (only for CRD properties)
- Meter access: [✅/⚠️] [short result]
- BC Hydro data source: [✅/⚠️] [short result]
- Aggregated meter needed: [✅/⚠️] [short result]
- Aggregated meter found: [✅/⚠️] [short result]

Only show bullets for checks that were actually traversed — omit skipped checks. Keep each bullet to one short sentence.

End with:

Verdict: ✅ Property data looks good.
— or —
Verdict: ⚠️ [short reason]. The property owner should be contacted.
— or —
Verdict: ❌ [error message]

If outcome is "requires_aggregation_judgment", decide ✅ or ⚠️ and add one brief reason.
${EMAIL_TEMPLATE_INSTRUCTIONS}`;

const BATCH_DISPLAY_INSTRUCTIONS = `
IMPORTANT: Present batch suspicious data check results as follows.

First, process ALL properties and make your judgments for any with outcome "requires_aggregation_judgment". Then print a summary with the FINAL counts after your judgments:

**Suspicious Data Check — [totalProperties] properties checked**

✅ Looks good: [count] | ⚠️ Flagged: [count]

Count properties as flagged if their outcome is "suspicious" OR if you judged "requires_aggregation_judgment" as ⚠️. Count as looks good if outcome is "looks_good" OR if you judged "requires_aggregation_judgment" as ✅. Do NOT use any pre-computed summary — compute the counts yourself after making all judgments.

Then for EACH property, print a block with a bulleted list of checks. Each check MUST be its own bullet point — never combine checks on one line. Be concise — no extra commentary.

**[propertyName] (ID: [propertyId])** — [propertyType]

- GFA check: [✅/⚠️/skipped] [short result] (only for CRD properties)
- Meter access: [✅/⚠️] [short result]
- BC Hydro data source: [✅/⚠️] [short result]
- Aggregated meter needed: [✅/⚠️] [short result]
- Aggregated meter found: [✅/⚠️] [short result]

Verdict: [✅/⚠️/❌] [short verdict]

Only show bullets for checks that were actually traversed — omit checks that were skipped. Keep each bullet to one short sentence. For "requires_aggregation_judgment", decide ✅ or ⚠️ and add one brief reason.

If the property was flagged (⚠️), print the draft email immediately after that property's verdict, before moving on to the next property.
${EMAIL_TEMPLATE_INSTRUCTIONS}`;

// ─── Tool Definitions & Handler ──────────────────────────────────────────────

export function getTools(ACCOUNT_NAME_PROP) {
  return [
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
      description: `Investigate whether a property's energy data looks legitimate or suspicious.

HOW IT WORKS:
This tool runs a decision tree of checks on each property to determine if its energy data is trustworthy:

1. GFA check (CRD only) — Is the Gross Floor Area in ESPM within 40% of the expected value? Requires custom_id.
2. Meter access — Can we see the property's meters in ESPM?
3. Data source — Was the meter data populated by BC Hydro Web Services, or manually entered?
4. Aggregated meter — For property types with many units (e.g. multifamily, strata), is there an aggregated electricity meter from BC Hydro?

The GFA check runs independently alongside the meter checks. A property is flagged if EITHER check fails.

Meter decision tree:
  Meter access?
  ├── YES → Data from BC Hydro?
  │   ├── YES → Aggregated meter needed?
  │   │   ├── YES → Aggregated meter found?
  │   │   │   ├── YES → ✅ Looks good
  │   │   │   └── NO → ⚠️ Contact owner
  │   │   └── NO → ✅ Looks good
  │   └── NO → ⚠️ Manually entered data, contact owner
  └── NO → Shared with BC Hydro?
      ├── YES → Aggregated meter needed?
      │   ├── YES → ⚠️ Contact owner
      │   └── NO → ✅ Looks good
      └── NO → ⚠️ Contact owner

USAGE:
- Single property: provide property_id (e.g. "88547924")
- Batch check: provide property_ids array (e.g. ["88547924", "9976853"])
- From a file: upload a CSV or Excel file with a "pm-property-id" column

When flagged ⚠️, a draft email to the building owner is generated.

IMPORTANT: If the user uploads or provides a CSV or Excel file, you MUST read the file contents and extract these columns, passing them as the corresponding parameters:
- 'pm-property-id' → property_ids (array)
- 'custom-id-1' → custom_ids (object mapping pm-property-id to custom-id-1)
- 'data-contact-name' → contact_names (object mapping pm-property-id to name)
- 'data-contact-email' → contact_emails (object mapping pm-property-id to email)
Do NOT pass a file path — this tool cannot read files directly.`,
      inputSchema: {
        type: "object",
        properties: {
          property_id: {
            type: "string",
            description: "A single ESPM property ID to investigate.",
          },
          custom_id: {
            type: "string",
            description: "The CRD custom ID for a single property (used for GFA check). Optional — if omitted for a CRD property, GFA check is skipped.",
          },
          property_ids: {
            type: "array",
            items: { type: "string" },
            description: "An array of ESPM property IDs to check in batch.",
          },
          custom_ids: {
            type: "object",
            description: "A mapping of pm-property-id to custom-id-1 (from the 'custom-id-1' column in an uploaded file). Used for GFA checks. Example: {\"88547924\": \"43893\"}",
          },
          contact_names: {
            type: "object",
            description: "A mapping of pm-property-id to data-contact-name. Example: {\"88547924\": \"John Smith\"}",
          },
          contact_emails: {
            type: "object",
            description: "A mapping of pm-property-id to data-contact-email. Example: {\"88547924\": \"admin@example.com\"}",
          },
        },
      },
    },
  ];
}

export async function handleTool(name, args, deps) {
  switch (name) {
    case "list_property_meters":
      return await listPropertyMeters(args.property_id, args.account_name, deps);
    case "get_meter_consumption_data":
      return await getMeterConsumptionData(
        args.meter_id,
        args.start_date,
        args.end_date,
        args.account_name,
        deps
      );
    case "suspicious_data_check": {
      // Determine property IDs: from array or single ID
      let propertyIds;
      if (args.property_ids && args.property_ids.length > 0) {
        propertyIds = args.property_ids;
      } else if (args.property_id) {
        // Single property — run and return directly
        const result = await suspiciousDataCheck(args.property_id, args.account_name, deps, { customId: args.custom_id });
        result._displayInstructions = DISPLAY_INSTRUCTIONS;
        return result;
      } else {
        return { error: "Provide property_id or property_ids." };
      }

      if (propertyIds.length === 0) {
        return { error: "No property IDs found." };
      }

      // Batch mode
      const customIds = args.custom_ids || {};
      const contactNames = args.contact_names || {};
      const contactEmails = args.contact_emails || {};
      const results = [];
      for (const pid of propertyIds) {
        const result = await suspiciousDataCheck(pid, args.account_name, deps, { customId: customIds[pid] });
        if (contactNames[pid]) result.contactName = contactNames[pid];
        if (contactEmails[pid]) result.contactEmail = contactEmails[pid];
        results.push(result);
      }

      return {
        _displayInstructions: BATCH_DISPLAY_INSTRUCTIONS,
        totalProperties: propertyIds.length,
        results,
      };
    }
    default:
      return null;
  }
}
