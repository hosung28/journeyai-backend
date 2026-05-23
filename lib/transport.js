/**
 * Orchestrates a single leg's transport options.
 *
 *   1. Claude lists every realistic mode (flight, train, ferry, bus, drive,
 *      walk) for the city pair — durations and prices are estimates.
 *   2. FlightAPI.io returns real flight offers (schedules + fares) for the
 *      same leg. When available, those replace the single Claude "Flight"
 *      entry with multiple real flight options — one card per offer, so the
 *      traveller can pick the schedule that fits their day plan.
 *
 * The two lookups run in parallel; FlightAPI failures fall back to the
 * Claude estimate so the Transport screen never goes blank.
 */
const { getTransportModes } = require("./claude");
const { getRealFlights } = require("./flightapi");

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

/** Project a real FlightAPI offer into the TransportOption shape. */
function realFlightOption(offer, index, claudeFlight) {
  return {
    id: offer.id || `flight-real-${index}`,
    icon: "✈️",
    mode: "Flight",
    operator: offer.operator,
    duration: offer.duration,
    priceFrom: offer.priceFrom,
    priceLabel: offer.priceLabel,
    frequency: claudeFlight?.frequency || "Daily",
    notes: offer.notes,
    // Only the cheapest live option carries the Recommended badge — the
    // others are alternatives. This matches how the rest of the list reads.
    recommended: index === 0,
    available: true,

    // New schedule fields — surfaced in the Transport card and used by the
    // day optimizer so it doesn't schedule activities before arrival.
    departureTime: offer.departureTime,
    arrivalTime: offer.arrivalTime,
    arrivalDayOffset: offer.arrivalDayOffset,
    flightNumber: offer.flightNumber,
    stops: offer.stops,
  };
}

async function getTransportOptions({ from, to, departureDate, adults }) {
  const [rawModes, realFlights] = await Promise.all([
    getTransportModes(from, to),
    getRealFlights(from.code, to.code, departureDate, adults).catch((err) => {
      console.warn("[flightapi] skipped:", err.message);
      return [];
    }),
  ]);

  const claudeOptions = rawModes
    .map(normalize)
    .filter((o) => o.available);

  // No real flight data — return Claude estimates as-is.
  if (realFlights.length === 0) return claudeOptions;

  // Real flight data exists — strip Claude's single "Flight" entry and
  // splice in the real options at the same position so ordering is stable.
  const flightIdx = claudeOptions.findIndex((o) => /flight/i.test(o.mode));
  const claudeFlight = flightIdx >= 0 ? claudeOptions[flightIdx] : null;
  const realCards = realFlights.map((o, i) => realFlightOption(o, i, claudeFlight));

  if (flightIdx >= 0) {
    return [
      ...claudeOptions.slice(0, flightIdx),
      ...realCards,
      ...claudeOptions.slice(flightIdx + 1),
    ];
  }
  // Claude didn't include a flight (e.g. a same-city leg). Prepend the
  // real flights anyway — if they came back, flights are clearly viable.
  return [...realCards, ...claudeOptions];
}

module.exports = { getTransportOptions };
