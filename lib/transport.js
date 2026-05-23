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

/**
 * Pick the recommended flight from a real-flight offer list.
 *
 * Score (lower is better) — absolute penalties calibrated for international
 * long-haul, where stops add 6-20 hours and a cheap 1-stop can be 2× the
 * journey of a nonstop:
 *
 *   stops:    $300 per stop
 *   duration: $30 per hour beyond 12h (i.e. very long total trip times)
 *
 * Matches the selection score in lib/flightapi.js so the Recommended offer
 * is the same one the selection logic considered "best" when filtering.
 *
 * Returns { idx, reason } where `idx` is the offer index to mark
 * recommended and `reason` is the human-readable rationale shown in the UI.
 */
function pickRecommended(offers) {
  if (offers.length === 0) return { idx: -1, reason: "" };
  if (offers.length === 1) {
    const o = offers[0];
    return {
      idx: 0,
      reason: o.stops === 0 ? "Only nonstop option" : "Best available",
    };
  }
  const cheapest = offers.reduce(
    (m, o) => (o.priceFrom > 0 && o.priceFrom < m ? o.priceFrom : m),
    Infinity,
  );
  const shortest = offers.reduce(
    (m, o) => (o.durationMin > 0 && o.durationMin < m ? o.durationMin : m),
    Infinity,
  );
  const cheapestOffer = offers.find((o) => o.priceFrom === cheapest);
  /**
   * Score in absolute dollars — must match flightapi.js scoreOffer so the
   * recommended flight is the same one the selection considered "best."
   *   stops:    $300 per stop
   *   duration: $30 per hour beyond 12h
   */
  const scoreOf = (o) => {
    const price = o.priceFrom > 0 ? o.priceFrom : 0;
    const hours = (o.durationMin || 0) / 60;
    return price + (o.stops || 0) * 300 + Math.max(0, hours - 12) * 30;
  };
  let bestIdx = 0;
  let bestScore = Infinity;
  offers.forEach((o, i) => {
    const s = scoreOf(o);
    if (s < bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  });
  const winner = offers[bestIdx];
  const isCheapest = winner.priceFrom === cheapest;
  const isShortest = winner.durationMin === shortest;
  const hoursSaved = cheapestOffer
    ? Math.round((cheapestOffer.durationMin - winner.durationMin) / 60)
    : 0;
  const extraDollars = winner.priceFrom - cheapest;

  let reason;
  if (isCheapest && winner.stops === 0) reason = "Cheapest · Nonstop";
  else if (winner.stops === 0 && extraDollars > 0)
    reason = `Nonstop · only $${extraDollars.toLocaleString()} more than cheapest`;
  else if (winner.stops === 0) reason = "Nonstop · best value";
  else if (isCheapest && isShortest) reason = "Cheapest and shortest";
  else if (isCheapest) reason = "Cheapest option";
  else if (isShortest && hoursSaved >= 3)
    reason = `${hoursSaved}h shorter than cheapest · only $${extraDollars.toLocaleString()} more`;
  else if (hoursSaved >= 3)
    reason = `${hoursSaved}h shorter than cheapest · $${extraDollars.toLocaleString()} more`;
  else reason = "Best balance of price and time";
  return { idx: bestIdx, reason };
}

/** Project a real FlightAPI offer into the TransportOption shape. */
function realFlightOption(offer, index, claudeFlight, recommendation) {
  const isRecommended = index === recommendation.idx;
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
    recommended: isRecommended,
    // Human-readable rationale, shown under the Recommended badge.
    recommendReason: isRecommended ? recommendation.reason : "",
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
    const recommendation = pickRecommended(realFlights);
    const realCards = realFlights.map((o, i) =>
      realFlightOption(o, i, claudeFlight, recommendation),
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
