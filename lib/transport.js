/**
 * Orchestrates a single leg's transport options.
 *
 *   1. Claude lists every realistic mode (flight, train, ferry, bus, drive,
 *      walk) for the city pair — durations and prices are estimates.
 *   2. FlightAware AeroAPI returns real airline schedule data (no fares —
 *      the app is a planning tool, not a booking tool, so prices stay as
 *      estimates and the user clicks out to Google Flights to book).
 *
 * The two lookups run in parallel; AeroAPI failures fall back to the
 * Claude estimate so the Transport screen never goes blank.
 */
const { getTransportModes } = require("./claude");
const { getRealSchedules } = require("./aeroapi");

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
 * driver of AeroAPI credit burn during testing. A 30-min TTL gives us
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

/**
 * (Removed) — see comment block below for rationale.
 *
 * Earlier versions of this file ranked flights and marked one Recommended.
 * The previous heuristic (cheapest / shortest / fewest-stops) imposed a
 * preference we can't actually know: some travelers care about price,
 * others about airline brand, others about departure time fitting their
 * day. The Sort chips on the Transport screen now let users impose their
 * own ordering. Non-flight modes (train, ferry, bus) still receive a
 * Recommended flag from Claude when Claude decides one mode is the obvious
 * best fit for the route.
 *
 * Score (lower = better):
 *   price    (USD per person; usually 0 for AeroAPI schedule data)
 *   stops    $300 per stop
 *   duration $30 per hour beyond 12h (penalises ultra-long red-eyes)
 *
 * When no prices are present (AeroAPI's /schedules endpoint), the score
 * reduces to duration + stops — which picks the shortest direct flight.
 *
 * Returns { idx, reason } where `idx` is the offer index to mark
 * recommended and `reason` is the human-readable rationale shown in the UI.
 */
// (pickRecommended function removed — see doc comment above)

/**
 * Build a Google Flights search URL for the route + date.
 *
 * Google Flights' public deep-link doesn't accept a specific flight number
 * (their URL routing is internal), so we send the user to the search results
 * for the route. They see live fares and can book from there. Matches the
 * app's positioning: a planning tool that hands off to dedicated booking
 * surfaces.
 */
function buildGoogleFlightsUrl(from, to, departureDate) {
  const fromName = from?.name ? `${from.name}` : from?.code || "";
  const toName = to?.name ? `${to.name}` : to?.code || "";
  if (!fromName || !toName || !departureDate) return "";
  const q = encodeURIComponent(
    `Flights to ${toName} from ${fromName} on ${departureDate}`,
  );
  return `https://www.google.com/travel/flights?q=${q}`;
}

/** Project a real schedule offer into the TransportOption shape. */
function realFlightOption(offer, index, claudeFlight, bookingUrl) {
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
    // Real flights are never marked Recommended — see header comment.
    recommended: false,
    recommendReason: "",
    available: true,

    // Schedule fields — surfaced in the Transport card and used by the
    // day optimizer so it doesn't schedule activities before arrival.
    departureTime: offer.departureTime,
    arrivalTime: offer.arrivalTime,
    arrivalDayOffset: offer.arrivalDayOffset,
    flightNumber: offer.flightNumber,
    stops: offer.stops,

    // Tap-to-book — opens Google Flights search for this route+date.
    // Per-flight deep links aren't public, so all real cards for the same
    // leg share the same search URL.
    bookingUrl,
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

  const [rawModes, realSchedules] = await Promise.all([
    getTransportModes(from, to),
    getRealSchedules(from.code, to.code, departureDate, adults).catch((err) => {
      console.warn("[aeroapi] skipped:", err.message);
      return [];
    }),
  ]);

  const claudeOptions = rawModes
    .map(normalize)
    .filter((o) => o.available);

  let options;
  if (realSchedules.length === 0) {
    // No real schedule data — return Claude estimates as-is.
    options = claudeOptions;
  } else {
    // Real schedule data exists — strip Claude's single "Flight" entry and
    // splice in the real options at the same position so ordering is stable.
    const flightIdx = claudeOptions.findIndex((o) => /flight/i.test(o.mode));
    const claudeFlight = flightIdx >= 0 ? claudeOptions[flightIdx] : null;
    const bookingUrl = buildGoogleFlightsUrl(from, to, departureDate);
    const realCards = realSchedules.map((o, i) =>
      realFlightOption(o, i, claudeFlight, bookingUrl),
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
  // legitimate retries when Claude or AeroAPI was just transiently down.
  if (options.length > 0) {
    cache.set(key, { options, expiresAt: Date.now() + CACHE_TTL_MS });
    console.log(
      `[transport] cache MISS ${key} -> stored ${options.length} options (real schedules: ${realSchedules.length})`,
    );
  } else {
    console.log(`[transport] cache MISS ${key} -> empty, not caching`);
  }

  return options;
}

module.exports = { getTransportOptions };
