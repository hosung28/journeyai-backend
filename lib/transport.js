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

/**
 * In-memory orchestrator cache.
 *
 * Repeated lookups of the same (from, to, date, adults) — caused by the app
 * re-rendering Transport or the user navigating away and back — are the main
 * driver of FlightAPI credit burn during testing. A 30-min TTL gives us
 * effectively-free re-tests without staling the data.
 *
 * Render's free tier sleeps after 15 min idle, which wipes this Map; that's
 * fine. Render's free tier is single-instance, so a process-local Map is
 * sufficient — no Redis needed.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

function cacheKey({ from, to, departureDate, adults }) {
  const f = from?.code || from?.name || "?";
  const t = to?.code || to?.name || "?";
  return `${f}|${t}|${departureDate || "?"}|${adults || 1}`;
}

function evictExpired() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}

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
  const key = cacheKey({ from, to, departureDate, adults });
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    console.log(`[transport] cache HIT  ${key}`);
    return hit.options;
  }
  evictExpired();

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

  let options;
  if (realFlights.length === 0) {
    // No real flight data — return Claude estimates as-is.
    options = claudeOptions;
  } else {
    // Real flight data exists — strip Claude's single "Flight" entry and
    // splice in the real options at the same position so ordering is stable.
    const flightIdx = claudeOptions.findIndex((o) => /flight/i.test(o.mode));
    const claudeFlight = flightIdx >= 0 ? claudeOptions[flightIdx] : null;
    const realCards = realFlights.map((o, i) =>
      realFlightOption(o, i, claudeFlight),
    );
    options =
      flightIdx >= 0
        ? [
            ...claudeOptions.slice(0, flightIdx),
            ...realCards,
            ...claudeOptions.slice(flightIdx + 1),
          ]
        : // Claude didn't include a flight (e.g. a same-city leg). Prepend
          // the real flights anyway — if they came back, flights are viable.
          [...realCards, ...claudeOptions];
  }

  // Only cache non-empty results — caching an empty array would suppress
  // legitimate retries when Claude or FlightAPI was just transiently down.
  if (options.length > 0) {
    cache.set(key, { options, expiresAt: Date.now() + CACHE_TTL_MS });
    console.log(
      `[transport] cache MISS ${key} -> stored ${options.length} options (real flights: ${realFlights.length})`,
    );
  } else {
    console.log(`[transport] cache MISS ${key} -> empty, not caching`);
  }

  return options;
}

module.exports = { getTransportOptions };
