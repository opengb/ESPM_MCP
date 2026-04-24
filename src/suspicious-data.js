/**
 * Suspicious Data Workflow
 * Decision-tree checks to determine whether a property's energy data looks legitimate.
 */

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

// ─── Main Workflow ───────────────────────────────────────────────────────────

async function suspiciousDataCheck(propertyId, accountName, deps) {
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
      outcome: "requires_aggregation_judgment",
      message: `The property is shared with BC Hydro but we cannot read the meter data. You must now determine whether this property type ("${propertyType}") would be expected to have an aggregated meter. An aggregated meter is expected when the property would have 3 or more commercial BC Hydro accounts or 5 or more residential BC Hydro accounts — use your judgment based on the property type. If an aggregated meter IS expected, check the meters list for one that has aggregateMeter=true or whose name contains "aggregated", "suites", "units", or "residents". If found, the property data looks good. If not found, the building owner should be contacted. If an aggregated meter is NOT expected, the property data looks good.`,
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
    message: `The meter data is from BC Hydro Web Services. You must now determine whether this property type ("${propertyType}") would be expected to have an aggregated meter. An aggregated meter is expected when the property would have 3 or more commercial BC Hydro accounts or 5 or more residential BC Hydro accounts — use your judgment based on the property type. If an aggregated meter is NOT expected, the property data looks good. If an aggregated meter IS expected, check the meters list above for one that has aggregateMeter=true or whose name contains "aggregated", "suites", "units", or "residents". If found, the property data looks good. If not found, show the property type and meter list and report that an aggregated meter was expected but not found — the property owner should be contacted.`,
  };
}

// ─── Display Instructions ────────────────────────────────────────────────────

const DISPLAY_INSTRUCTIONS = `
IMPORTANT: Always present suspicious data check results in this compact format. Do NOT use tables. Do NOT add extra commentary beyond the verdict line.

**Suspicious Data Check — [propertyName] (ID: [propertyId])**

[propertyName], [address]
[propertyType] | Account: [account]

Then print ONE line per check that was actually performed, using the data from "steps" and "meters". Use ✅ for pass and ⚠️ for problems. Examples:

Meter access: ✅ 4 meters found
BC Hydro connected: ✅ Yes ("BC Hydro Web Services")
Data source: ✅ 2 electric meters from BC Hydro Web Services
Aggregated meter: ✅ Found ("meter name here")

Or:

Meter access: ✅ 2 meters found
BC Hydro connected: ⚠️ No
Data source: ⚠️ All meter data was manually entered (not from BC Hydro Web Services)

Or:

Meter access: ⚠️ No meter access
BC Hydro connected: ⚠️ Not found in connected customers

Always show the BC Hydro connection status if bcHydroConnected is present in the result. Only show other checks that were actually run — do not show skipped branches.

End with:

Verdict: ✅ Property data looks good.
— or —
Verdict: ⚠️ [message from the result, e.g. "The property owner should be contacted."]
— or —
Verdict: ❌ [error message]

If outcome is "requires_aggregation_judgment", make your judgment about whether the property type needs an aggregated meter, then print the verdict as ✅ or ⚠️ accordingly. Add one brief sentence explaining your reasoning.

If the verdict is ⚠️ (the property owner should be contacted), also print a draft email below the verdict.

CRITICAL: Copy the template below VERBATIM. Do NOT rephrase, reword, or paraphrase any sentence. The ONLY changes allowed are:
- Replace {{PROPERTY_NAME}} with the actual property name
- Replace {{PROPERTY_ID}} with the actual property ID
- Replace {{METER_TYPES}} with the actual meter types from the data (e.g. "Natural Gas" or "District Energy")
- Include or exclude entire paragraphs based on the conditions noted — but never change the wording of a paragraph you include.

---

DRAFT EMAIL:

Hi x,

Thank you for submitting your building {{PROPERTY_NAME}} (ID: {{PROPERTY_ID}}) to the Building Owner Portal!

Upon our initial review, the data suggests that the energy usage data submitted is incomplete based on typical Site EUI ranges. Please add all meters and energy sources (examples include: {{METER_TYPES}}) for the entire building and verify the units of the energy data submitted.

[Include the next paragraph ONLY if an aggregated meter is expected based on property type:]
For Strata buildings, please ensure that you have reported the Electricity consumption data from the Common Area meter as well as the residential units. BC Hydro can help you aggregate the Electricity data for stratas with more than 5 residential accounts. You can find the instructions in our Data Aggregation article in Part 1 of our knowledge base.

We'd also like to point out that it's an option to set up the automatic data exchange with BC Hydro or FortisBC by following the instructions in our knowledge base, which can replace manual data entry: https://support.crdbenchmarking.ca/portal/en/kb/articles/3-1-how-to-add-energy-data-automatically-set-up-data-exchange-with-utility-provider-s-in-espm

Once this information has been added in ENERGY STAR Portfolio Manager, please click resubmit in the Building Owner Portal to complete your submission.

If you have any questions, please let us know.

---
`;

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
      const result = await suspiciousDataCheck(args.property_id, args.account_name, deps);
      result._displayInstructions = DISPLAY_INSTRUCTIONS;
      return result;
    }
    default:
      return null;
  }
}
