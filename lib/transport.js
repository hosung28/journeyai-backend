/**
 * Orchestrates a single leg's transport options:
 *   1. Claude lists every realistic mode (estimates).
 *   2. Amadeus replaces the flight leg with a real fare when available.
 * The two lookups run in parallel.
 */
const { getTransportModes } = require("./claude");
const { getRealFlight } = require("./amadeus");

const MODE_ICON = {
  Flight: "✈️",
  Train: "🚄",
  Ferry: "⛴️",
  Bus: "🚌",
  Drive: "🚗",
  Walk: "🚶",
};

/** Coerce a raw Claude option into the app's TransportOption shape. */
function normalize(option, index) {
  const mode = String(option.mode || "Other");
  const priceFrom = Number(option.priceFrom) || 0;
  return {
    id: String(option.id || `${mode.toLowerCase()}-${index}`),
    icon: option.icon || MODE_ICON[mode] || "🧭",
    mode,
    operator: option.operator || "Various",
    duration: option.duration || "",
    priceFrom,
    priceLabel: option.priceLabel || (priceFrom ? `From $${priceFrom}/pp` : "Free"),
    frequency: option.frequency || "",
    notes: option.notes || "",
    recommended: Boolean(option.recommended),
    available: option.available !== false,
  };
}

async function getTransportOptions({ from, to, departureDate, adults }) {
  const [rawModes, realFlight] = await Promise.all([
    getTransportModes(from, to),
    getRealFlight(from.code, to.code, departureDate, adults).catch((err) => {
      // Missing Amadeus keys or a sandbox hiccup — fall back to estimates.
      console.warn("[amadeus] skipped:", err.message);
      return null;
    }),
  ]);

  return rawModes
    .map(normalize)
    .filter((o) => o.available)
    .map((o) => {
      if (realFlight && /flight/i.test(o.mode)) {
        return {
          ...o,
          operator: realFlight.operator,
          duration: realFlight.duration || o.duration,
          priceFrom: realFlight.priceFrom,
          priceLabel: realFlight.priceLabel,
          notes: realFlight.notes || o.notes,
        };
      }
      return o;
    });
}

module.exports = { getTransportOptions };
