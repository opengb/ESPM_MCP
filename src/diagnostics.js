/**
 * ESPM Diagnostics
 * Data quality checks and VAM readiness analysis for Energy Star Portfolio Manager properties.
 *
 * Exported as a setup function to receive shared API/utility helpers from index.js,
 * avoiding circular dependencies while keeping diagnostic logic self-contained.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const AGGREGATED_METER_PATTERNS = [
  /aggregat/i,
  /whole\s*building/i,
  /whole\s*site/i,
  /campus\s*total/i,
  /\btotal\b/i,
  /\bbulk\b/i,
  /\bmaster\b/i,
  /\bbuilding\s*total/i,
];

// Low electricity EUI thresholds by primary function (kBtu/ft²/year).
// Below these, meter coverage is likely partial (e.g. suites excluded).
const ELEC_EUI_LOW_THRESHOLDS = {
  "Multifamily Housing": 15,
  "Office": 20,
  "Retail Store": 15,
  "K-12 School": 15,
  "College/University": 20,
  "default": 15,
};

const GAS_EUI_NEAR_ZERO_THRESHOLD = 5; // kBtu/ft²/year

// Canadian National Median Site EUI by ESPM primary function (kBtu/ft²/year).
// Source: ENERGY STAR Portfolio Manager, August 2023 Canadian National Median Table.
// Values converted from GJ/m² × 88.055 = kBtu/ft².
// N/A types (Parking, Data Centre, Utility, etc.) are omitted — no benchmark check for those.
const CANADIAN_MEDIAN_SITE_EUI = {
  // Banking / Financial
  "Bank Branch": 82.8,
  "Financial Office": 76.6,
  // Education
  "Adult Education": 74.0,
  "College/University": 91.6,
  "K-12 School": 61.6,
  "Pre-school/Daycare": 62.5,
  "Vocational School": 74.0,
  "Other - Education": 74.0,
  // Entertainment / Public Assembly
  "Convention Centre": 94.2,
  "Movie Theatre": 75.7,
  "Museum": 36.1,
  "Performing Arts": 75.7,
  "Ice/Curling Rink": 96.9,
  "Bowling Alley": 75.7,
  "Fitness Centre/Health Club/Gym": 59.9,
  "Roller Rink": 59.9,
  "Swimming Pool": 59.9,
  "Other - Recreation": 59.9,
  "Social/Meeting Hall": 75.7,
  "Indoor Arena": 145.3,
  "Race Track": 75.7,
  "Stadium (Closed)": 75.7,
  "Stadium (Open)": 75.7,
  "Other - Stadium": 59.9,
  "Aquarium": 75.7,
  "Bar/Nightclub": 75.7,
  "Casino": 75.7,
  "Zoo": 75.7,
  "Other - Entertainment/Public Assembly": 75.7,
  // Food
  "Convenience Store with Gas Station": 94.2,
  "Convenience Store without Gas Station": 94.2,
  "Fast Food Restaurant": 112.7,
  "Restaurant": 112.7,
  "Other - Restaurant/Bar": 112.7,
  "Supermarket/Grocery Store": 94.2,
  "Wholesale Club/Supercentre": 74.8,
  "Other Food Sales": 94.2,
  "Food Service": 112.7,
  // Health Care
  "Ambulatory Surgical Centre": 193.7,
  "Hospital (General Medical & Surgical)": 193.7,
  "Other/Specialty Hospital": 193.7,
  "Medical Office": 65.2,
  "Outpatient Rehabilitation/Physical Therapy": 65.2,
  "Residential Care Facility": 106.5,
  "Senior Living Community": 106.5,
  "Urgent Care/Clinic/Other Outpatient": 65.2,
  // Lodging / Residential
  "Barracks": 76.6,
  "Hotel": 76.6,
  "Multifamily Housing": 72.2,
  "Prison/Incarceration": 75.7,
  "Residence Hall/Dormitory": 76.6,
  "Other - Lodging/Residential": 76.6,
  // Mixed Use
  "Mixed Use Property": 72.2,
  // Office
  "Office": 76.6,
  "Veterinary Office": 75.7,
  // Public Services
  "Courthouse": 76.6,
  "Fire Station": 58.1,
  "Library": 90.7,
  "Mailing Centre/Post Office": 82.8,
  "Police Station": 58.1,
  "Social/Meeting Hall - Public": 75.7,
  "Transportation Terminal/Station": 75.7,
  "Other - Public Services": 75.7,
  // Religious
  "Worship Facility": 49.3,
  // Retail
  "Automobile Dealership": 81.0,
  "Enclosed Mall": 72.2,
  "Lifestyle Centre": 74.8,
  "Strip Mall": 72.2,
  "Other - Mall": 72.2,
  "Retail Store": 74.8,
  // Technology / Science / Services
  "Laboratory": 75.7,
  "Other - Technology/Science": 75.7,
  "Personal Services (Health/Beauty, Dry Cleaning, etc.)": 75.7,
  "Repair Services (Vehicle, Shoe, Locksmith, etc.)": 81.0,
  "Other - Services": 75.7,
  // Warehouse / Storage
  "Self-Storage Facility": 63.4,
  "Distribution Centre": 63.4,
  "Non-Refrigerated Warehouse": 63.4,
  "Refrigerated Warehouse": 63.4,
  // Other
  "Other": 75.7,
};

// Conversion factors from common ESPM units to kBtu (site energy)
const UNIT_TO_KBTU = {
  kwh: 3.412, mwh: 3412,
  kbtu: 1, mbtu: 1000,
  therms: 100, therm: 100,
  ccf: 102.6, mcf: 1026, kcf: 1026, cf: 1.026,
  dekatherms: 1000, dekatherm: 1000,
  gj: 947.817,
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function looksLikeAggregatedMeter(name) {
  return AGGREGATED_METER_PATTERNS.some((pattern) => pattern.test(name));
}

function classifyMeterType(type) {
  if (!type) return "unknown";
  const t = type.toLowerCase();
  if (t.includes("electric")) return "electricity";
  if (t.includes("solar") || t.includes("photovoltaic")) return "solar";
  if (t.includes("gas") || t.includes("propane")) return "gas";
  return "other";
}

function toKBtu(usage, unitOfMeasure) {
  if (!usage || isNaN(usage)) return 0;
  const unit = (unitOfMeasure || "").toLowerCase().replace(/\s+/g, "");
  return usage * (UNIT_TO_KBTU[unit] ?? 1);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Returns the diagnostic tool functions bound to the shared API/utility helpers.
 * @param {object} helpers - { espmGet, arrayify, safeNum, extractText, extractLinkId, getProperty, getPropertyMetrics }
 */
export function setupDiagnostics({ espmGet, arrayify, safeNum, extractText, extractLinkId, getProperty, getPropertyMetrics }) {

  async function getMeterDetails(meterId, accountName) {
    const data = await espmGet(`/meter/${meterId}`, {}, accountName);
    const meter = data?.meter;
    return {
      id: meterId,
      name: extractText(meter?.name),
      type: extractText(meter?.type),
      unitOfMeasure: extractText(meter?.unitOfMeasure),
      dataEntryMethod: extractText(meter?.dataEntryMethod),
      inUse: extractText(meter?.inUse),
    };
  }

  async function getMeterConsumption(meterId, year, accountName) {
    const y = year || new Date().getFullYear() - 1;
    const data = await espmGet(
      `/meter/${meterId}/consumptionData?startDate=${y}-01-01&endDate=${y}-12-31`,
      {},
      accountName
    );

    const entries = arrayify(data?.meterData?.meterConsumption);
    if (entries.length === 0) {
      return { meterId, year: y, entryCount: 0, readings: [], profileAssessment: "no data" };
    }

    const readings = entries.map((entry) => ({
      startDate: extractText(entry?.startDate),
      endDate: extractText(entry?.endDate),
      usage: safeNum(extractText(entry?.usage)),
      estimated: extractText(entry?.estimatedValue) === "true",
    }));

    const usages = readings.map((r) => r.usage).filter((u) => u !== null && u >= 0);
    const total = usages.reduce((a, b) => a + b, 0);
    const mean = usages.length > 0 ? total / usages.length : 0;
    const stddev =
      usages.length > 1
        ? Math.sqrt(usages.reduce((sum, u) => sum + (u - mean) ** 2, 0) / usages.length)
        : 0;
    const cv = mean > 0 ? stddev / mean : null;

    // Detect billing interval regularity
    const daySpans = readings
      .map((r) => {
        if (!r.startDate || !r.endDate) return null;
        return Math.round((new Date(r.endDate) - new Date(r.startDate)) / 86400000);
      })
      .filter((d) => d !== null);
    const avgDays =
      daySpans.length > 0
        ? Math.round(daySpans.reduce((a, b) => a + b, 0) / daySpans.length)
        : null;
    const billingPattern =
      avgDays == null ? "unknown"
      : avgDays <= 35 ? "monthly"
      : avgDays <= 70 ? "bi-monthly"
      : avgDays <= 100 ? "quarterly"
      : "irregular";

    // Seasonal variation: split entries into winter (Oct-Mar) vs summer (Apr-Sep)
    // by start month. Only meaningful for gas/heating assessment.
    const winterUsage = readings
      .filter((r) => {
        const m = r.startDate ? new Date(r.startDate).getMonth() : -1; // 0-indexed
        return m >= 9 || m <= 2; // Oct=9, Nov=10, Dec=11, Jan=0, Feb=1, Mar=2
      })
      .reduce((sum, r) => sum + (r.usage ?? 0), 0);
    const summerUsage = readings
      .filter((r) => {
        const m = r.startDate ? new Date(r.startDate).getMonth() : -1;
        return m >= 3 && m <= 8; // Apr=3 through Sep=8
      })
      .reduce((sum, r) => sum + (r.usage ?? 0), 0);
    const winterSummerRatio =
      summerUsage > 0 ? Math.round((winterUsage / summerUsage) * 10) / 10 : null;

    // Profile assessment heuristics (useful for gas meter diagnosis)
    let profileAssessment = "normal";
    const notes = [];
    if (billingPattern === "irregular") {
      notes.push("Irregular billing intervals detected — may need HDD smoothing before VAM.");
      profileAssessment = "irregular billing";
    }
    if (cv !== null && cv > 1.2) {
      notes.push(`High month-to-month variance (CoV=${Math.round(cv * 100) / 100}) — spiky profile, possible billing artifacts.`);
      if (profileAssessment === "normal") profileAssessment = "high variance";
    }
    if (winterSummerRatio !== null && winterSummerRatio < 1.5) {
      notes.push(`Low seasonal variation (winter/summer ratio=${winterSummerRatio}) — profile looks flat, may be DHW-only rather than space heating.`);
      if (profileAssessment === "normal") profileAssessment = "flat/baseload";
    }
    const zeroEntries = readings.filter((r) => r.usage === 0 || r.usage === null).length;
    if (zeroEntries > 0) {
      notes.push(`${zeroEntries} entry/entries with zero or null usage.`);
    }

    return {
      meterId,
      year: y,
      entryCount: readings.length,
      totalUsage: Math.round(total * 100) / 100,
      meanUsagePerEntry: Math.round(mean * 100) / 100,
      coefficientOfVariation: cv !== null ? Math.round(cv * 100) / 100 : null,
      billingPattern,
      averageDaysPerEntry: avgDays,
      winterSummerRatio,
      zeroEntries,
      profileAssessment,
      notes,
      readings,
    };
  }

  async function checkAggregatedMeters(propertyId, accountName) {
    const data = await espmGet(`/property/${propertyId}/meter/list`, {}, accountName);
    const meters = arrayify(data?.response?.links?.link);

    if (meters.length === 0) {
      return {
        propertyId,
        metersFound: 0,
        aggregatedMeters: [],
        hasAggregatedMeter: false,
      };
    }

    const meterList = meters.map((link) => ({
      id: extractLinkId(link),
      name: link?.hint || null,
    }));

    const aggregatedMeters = meterList.filter(
      (m) => m.name && looksLikeAggregatedMeter(m.name)
    );

    return {
      propertyId,
      metersFound: meterList.length,
      meters: meterList,
      aggregatedMeters,
      hasAggregatedMeter: aggregatedMeters.length > 0,
    };
  }

  async function runDataQualityCheck(propertyId, accountName) {
    const year = new Date().getFullYear() - 1;

    const [propertyDetails, meterListData, metricsData] = await Promise.all([
      getProperty(propertyId, accountName),
      espmGet(`/property/${propertyId}/meter/list`, {}, accountName),
      getPropertyMetrics(propertyId, year, 12, ["siteIntensity"], accountName),
    ]);

    const meterStubs = arrayify(meterListData?.response?.links?.link)
      .map((link) => ({ id: extractLinkId(link), name: link?.hint || null }))
      .filter((m) => m.id);

    const meterDetails = await Promise.all(
      meterStubs.map((m) =>
        getMeterDetails(m.id, accountName).catch(() => ({ id: m.id, name: m.name, type: null, unitOfMeasure: null, dataEntryMethod: null }))
      )
    );

    const meters = meterDetails.map((m) => ({
      ...m,
      typeClass: classifyMeterType(m.type),
      isAggregated: m.name ? looksLikeAggregatedMeter(m.name) : false,
    }));

    const byType = (cls) => meters.filter((m) => m.typeClass === cls);
    const electricityMeters = byType("electricity");
    const gasMeters = byType("gas");
    const solarMeters = byType("solar");
    const manualMeters = meters.filter((m) =>
      m.dataEntryMethod?.toLowerCase().includes("manual")
    );
    const aggregatedMeters = meters.filter((m) => m.isAggregated);

    const gfa = parseFloat(propertyDetails.grossFloorArea) || 0;
    const primaryFunction = propertyDetails.primaryFunction;
    const elecThreshold =
      ELEC_EUI_LOW_THRESHOLDS[primaryFunction] ?? ELEC_EUI_LOW_THRESHOLDS.default;

    // Compute EUI directly from meter consumption, aggregated per fuel type.
    // All non-solar meters are included so site EUI covers every fuel stream.
    // Solar is excluded (generation, not consumption — would understate gross load).
    const consumptionMeters = meters.filter((m) => m.typeClass !== "solar");
    const consumptionResults = await Promise.all(
      consumptionMeters.map((m) =>
        getMeterConsumption(m.id, year, accountName).catch(() => null)
      )
    );

    // Map meter id → consumption result for easy lookup
    const consumptionById = new Map(
      consumptionMeters.map((m, i) => [m.id, consumptionResults[i]])
    );
    const meterKBtu = (m) => {
      const c = consumptionById.get(m.id);
      return c ? toKBtu(c.totalUsage, m.unitOfMeasure) : 0;
    };

    const elecKBtu = electricityMeters.reduce((sum, m) => sum + meterKBtu(m), 0);
    const gasKBtu = gasMeters.reduce((sum, m) => sum + meterKBtu(m), 0);
    const totalKBtu = consumptionMeters.reduce((sum, m) => sum + meterKBtu(m), 0);

    const elecEUI = gfa > 0 && elecKBtu > 0 ? Math.round((elecKBtu / gfa) * 10) / 10 : null;
    const gasEUI = gfa > 0 && gasKBtu > 0 ? Math.round((gasKBtu / gfa) * 10) / 10 : null;
    const computedSiteEUI = gfa > 0 && totalKBtu > 0 ? Math.round((totalKBtu / gfa) * 10) / 10 : null;

    const siteEUI = metricsData.metrics?.siteIntensity ?? null;

    const checks = [];

    // Determine which fuel streams are potentially unreliable (for vamStrategy)
    const elecUnreliable =
      aggregatedMeters.some((m) => m.typeClass === "electricity") ||
      (elecEUI !== null && elecEUI < elecThreshold);
    const gasUnreliable =
      gasMeters.length === 0 ||
      (gasEUI !== null && gasEUI < GAS_EUI_NEAR_ZERO_THRESHOLD);

    checks.push({
      check: "aggregatedMeter",
      status: aggregatedMeters.length > 0 ? "warn" : "ok",
      finding:
        aggregatedMeters.length > 0
          ? `${aggregatedMeters.length} meter(s) with aggregated-sounding names: ${aggregatedMeters.map((m) => m.name).join(", ")}`
          : "No aggregated meter names detected.",
      recommendation:
        aggregatedMeters.length > 0
          ? "Confirm whether the aggregated meter sums the other meters of the same type. If so, remove it from ESPM 'in use' to eliminate double-counting. If the individual meters don't cover the full building, this fuel stream is only partially captured — check the EUI flags below and consider the two-pass calibration approach."
          : null,
    });

    checks.push({
      check: "electricityMeters",
      status: electricityMeters.length === 0 ? "flag" : "ok",
      finding:
        electricityMeters.length === 0
          ? "No electricity meters found."
          : `${electricityMeters.length} electricity meter(s) found.`,
      recommendation:
        electricityMeters.length === 0
          ? "No electricity data in ESPM. If the building has electric equipment, calibrate VAM on gas only. Lock plug and lighting loads to physically reasonable defaults (e.g. 5 W/m²) and remove electricity from the objective function."
          : null,
    });

    checks.push({
      check: "gasMeters",
      status: gasMeters.length === 0 ? "warn" : "ok",
      finding:
        gasMeters.length === 0
          ? "No natural gas meters — if building has gas equipment, data may be missing."
          : `${gasMeters.length} gas meter(s) found.${gasMeters.length > 1 ? " Multiple gas meters — verify all units are covered." : ""}`,
      recommendation:
        gasMeters.length === 0
          ? "No gas data in ESPM. If the building uses gas, calibrate VAM on electricity only. Consider running get_meter_consumption on electricity meters to check profile reliability before proceeding."
          : gasMeters.length > 1
          ? "Multiple gas meters present. Use get_meter_consumption on each to check if all meters show space-heating seasonal patterns, or if some are DHW/MUA-only — which would indicate partial coverage."
          : null,
    });

    checks.push({
      check: "solarMeters",
      status: solarMeters.length > 0 ? "warn" : "ok",
      finding:
        solarMeters.length > 0
          ? `${solarMeters.length} solar/PV meter(s) detected — net metering may distort the electricity profile for VAM.`
          : "No solar meters detected.",
      recommendation:
        solarMeters.length > 0
          ? "Net metering can suppress or distort gross electricity consumption. Confirm whether ESPM is recording gross consumption or net (after solar offset). If net, electricity data is unreliable for VAM — apply the two-pass approach using gas as the primary calibration stream."
          : null,
    });

    if (elecEUI !== null) {
      checks.push({
        check: "electricityEUI",
        status: elecEUI < elecThreshold ? "warn" : "ok",
        finding:
          elecEUI < elecThreshold
            ? `Electricity EUI is ${elecEUI} kBtu/ft² (aggregated across ${electricityMeters.length} meter(s)) — below ${elecThreshold} threshold for ${primaryFunction || "this building type"}. Suite meters may be excluded.`
            : `Electricity EUI is ${elecEUI} kBtu/ft² (aggregated across ${electricityMeters.length} meter(s)).`,
        recommendation:
          elecEUI < elecThreshold
            ? "Low electricity EUI suggests partial coverage (e.g. common areas only, suites excluded). Electricity stream is unreliable for VAM. Recommended approach: lock plug and lighting loads to known values (e.g. 5 W/m²), remove electricity from the hyperopt objective, and calibrate on gas only."
            : null,
      });
    }

    if (gasMeters.length > 0 && gasEUI !== null) {
      checks.push({
        check: "gasEUI",
        status: gasEUI < GAS_EUI_NEAR_ZERO_THRESHOLD ? "warn" : "ok",
        finding:
          gasEUI < GAS_EUI_NEAR_ZERO_THRESHOLD
            ? `Gas EUI is ${gasEUI} kBtu/ft² (aggregated across ${gasMeters.length} meter(s)) — near zero despite having gas meters. Meter may not be capturing actual usage.`
            : `Gas EUI is ${gasEUI} kBtu/ft² (aggregated across ${gasMeters.length} meter(s)).`,
        recommendation:
          gasEUI < GAS_EUI_NEAR_ZERO_THRESHOLD
            ? "Near-zero gas EUI despite having gas meters suggests the meter captures only DHW or MUA, not suite space heating. Gas stream is unreliable for VAM. Recommended two-pass approach: Pass 1 — calibrate with modified inputs that minimize heating load (best-case envelope), letting the optimizer fit DHW and ventilation baseload. Pass 2 — lock the parameters from Pass 1, remove gas from the objective, and calibrate on electricity; gas prediction comes as a byproduct. Run get_meter_consumption to confirm the seasonal profile before deciding."
            : null,
      });
    }

    // Site EUI benchmark against Canadian national medians
    const canadianMedian = CANADIAN_MEDIAN_SITE_EUI[primaryFunction] ?? null;
    if (computedSiteEUI !== null && canadianMedian !== null) {
      const lowerBound = Math.round(canadianMedian * 0.2 * 10) / 10;
      const upperBound = Math.round(canadianMedian * 2.0 * 10) / 10;
      const inRange = computedSiteEUI >= lowerBound && computedSiteEUI <= upperBound;
      const tooLow = computedSiteEUI < lowerBound;
      checks.push({
        check: "siteEUIBenchmark",
        status: inRange ? "ok" : "warn",
        finding: inRange
          ? `Computed site EUI ${computedSiteEUI} kBtu/ft² is within the expected range for ${primaryFunction} (${lowerBound}–${upperBound} kBtu/ft²; Canadian national median: ${canadianMedian} kBtu/ft²).`
          : tooLow
          ? `Computed site EUI ${computedSiteEUI} kBtu/ft² is below the lower bound of ${lowerBound} kBtu/ft² (0.2× the ${canadianMedian} kBtu/ft² Canadian median for ${primaryFunction}). This suggests incomplete meter coverage.`
          : `Computed site EUI ${computedSiteEUI} kBtu/ft² exceeds the upper bound of ${upperBound} kBtu/ft² (2× the ${canadianMedian} kBtu/ft² Canadian median for ${primaryFunction}). This may indicate double-counting or unusually high consumption.`,
        recommendation: inRange ? null
          : tooLow
          ? "Site EUI well below the national median suggests significant meter coverage gaps — likely not all fuel streams are captured in ESPM. Review the meter inventory and confirm all main meters are enrolled and set to 'in use'."
          : "Site EUI more than double the national median may indicate an aggregated meter double-counting consumption, or a genuine outlier. Check the aggregatedMeter finding above and verify that no meter is being counted twice.",
      });
    }

    checks.push({
      check: "manualEntry",
      status: manualMeters.length > 0 ? "warn" : "ok",
      finding:
        manualMeters.length > 0
          ? `${manualMeters.length} meter(s) use manual data entry: ${manualMeters.map((m) => m.name || m.id).join(", ")}`
          : "All meters use automated/utility data entry.",
      recommendation:
        manualMeters.length > 0
          ? "Manually entered meters are higher risk for data gaps or transcription errors. Run get_meter_consumption to check for zero entries, irregular billing intervals, or suspicious patterns before trusting this stream for VAM."
          : null,
    });

    const flagCount = checks.filter((c) => c.status !== "ok").length;

    // Derive VAM strategy recommendation from the pattern of flags
    let vamStrategy = null;
    if (flagCount > 0) {
      if (elecUnreliable && !gasUnreliable) {
        vamStrategy =
          "Electricity stream is unreliable. Recommended: lock plug and lighting loads to known values (e.g. 5 W/m²) and remove electricity from the hyperopt objective. Calibrate on gas only.";
      } else if (gasUnreliable && !elecUnreliable) {
        vamStrategy =
          "Gas stream is unreliable or absent. Recommended two-pass calibration: Pass 1 — calibrate with modified inputs isolating uncertain parameters (best-case envelope to minimize heating, fitting DHW and ventilation baseload). Pass 2 — lock Pass 1 parameters, remove gas from the objective, and calibrate on electricity; gas prediction comes as a byproduct.";
      } else if (elecUnreliable && gasUnreliable) {
        vamStrategy =
          "Both electricity and gas streams appear unreliable. VAM calibration is not recommended without resolving meter coverage. Review meter inventory in ESPM and confirm which stream (if any) captures full building consumption.";
      } else {
        vamStrategy =
          "Flags detected but may not affect calibration streams directly. Review individual check recommendations above.";
      }
    }

    return {
      propertyId,
      propertyName: propertyDetails.name,
      primaryFunction: primaryFunction || "Unknown",
      grossFloorArea: propertyDetails.grossFloorArea,
      year,
      siteEUI: computedSiteEUI ?? siteEUI,
      canadianMedianSiteEUI: canadianMedian,
      metersTotal: meters.length,
      meters,
      checks,
      flagCount,
      vamReadiness:
        flagCount === 0
          ? "ready"
          : flagCount <= 2
          ? "review recommended"
          : "issues detected",
      vamStrategy,
    };
  }

  return { getMeterConsumption, checkAggregatedMeters, runDataQualityCheck };
}
