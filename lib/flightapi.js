/**
 * FlightAPI.io — real flight schedules + fares for a city pair.
 *
 * Replaces the prior Amadeus integration (Amadeus Self-Service is shutting
 * down on 2026-07-17). Returns multiple real flight offers; the caller
 * substitutes them for Claude's single estimated "Flight" mode so the user
 * can pick the schedule that fits their day plan.
 *
 * Returns [] (not throws) on any soft failure — missing key, bad IATA codes,
 * upstream HTTP error, parse error. The transport layer falls back to Claude
 * estimates so the Transport screen never breaks.
 */
const API_BASE = "https://api.flightapi.io/onewaytrip";
const REQUEST_TIMEOUT_MS = 15_000;
/** How many real flight offers to surface per leg. */
const MAX_OFFERS = 6;

/**
 * Combined quality score (lower = better). Penalises stops and long trips
 * with absolute dollar penalties so a 33-hour 1-stop at $845 ranks worse
 * than an 11-hour nonstop at $1,400 — the right answer for most travelers.
 *
 *   stops:    $300 per stop
 *   duration: $30 per hour beyond 12h
 */
function scoreOffer(price, stops, durationMin) {
  const hours = (Number(durationMin) || 0) / 60;
  return (
    (Number(price) || 0) +
    (Number(stops) || 0) * 300 +
    Math.max(0, hours - 12) * 30
  );
}

const isIata = (code) => typeof code === "string" && /^[A-Z]{3}$/.test(code);

/** ISO timestamp "2026-06-14T07:15:00" -> "07:15". */
function isoTime(iso) {
  const m = /T(\d{2}:\d{2})/.exec(String(iso || ""));
  return m ? m[1] : "";
}

/** Calendar-day offset between two ISO datetimes (UTC-agnostic). */
function dayOffset(depISO, arrISO) {
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(String(depISO || ""));
  const a = /^(\d{4}-\d{2}-\d{2})/.exec(String(arrISO || ""));
  if (!d || !a) return 0;
  const diff = new Date(`${a[1]}T00:00:00Z`) - new Date(`${d[1]}T00:00:00Z`);
  return Math.max(0, Math.round(diff / 86_400_000));
}

/** Minutes (180) -> "3h" or "3h 5m". */
function minutesToDuration(mins) {
  const n = Number(mins) || 0;
  const h = Math.floor(n / 60);
  const r = n % 60;
  if (h <= 0) return `${r}m`;
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
}

/** Pull the canonical name out of a FlightAPI carrier object. */
function carrierLabel(c) {
  if (!c) return "";
  return c.name || c.title || c.display_code || c.alt_id || "";
}

/** Two-letter IATA code from a FlightAPI carrier — used to prefix flight numbers. */
function carrierCode(c) {
  if (!c) return "";
  return c.display_code || c.alt_id || "";
}

/**
 * Real flight offers for the route. Empty array = soft failure or no data.
 */
async function getRealFlights(fromCode, toCode, departureDate, adults) {
  const key = process.env.FLIGHTAPI_KEY;
  if (!key) return [];
  if (!isIata(fromCode) || !isIata(toCode) || !departureDate) return [];

  const seats = String(adults > 0 ? adults : 1);
  // The key is the first path segment per FlightAPI's URL schema.
  const url =
    `${API_BASE}/${encodeURIComponent(key)}` +
    `/${fromCode}/${toCode}/${departureDate}` +
    `/${seats}/0/0/Economy/USD`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      // 4xx is usually no-data-for-route; 5xx is upstream — both downgrade
      // to "use Claude estimates," so soft-fail with a warning.
      console.warn(
        `[flightapi] HTTP ${res.status} for ${fromCode}->${toCode} ${departureDate}`,
      );
      return [];
    }
    data = await res.json();
  } catch (err) {
    console.warn("[flightapi] fetch failed:", err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }

  const itineraries = Array.isArray(data?.itineraries) ? data.itineraries : [];
  const legs = Array.isArray(data?.legs) ? data.legs : [];
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  const carriers = Array.isArray(data?.carriers) ? data.carriers : [];

  if (itineraries.length === 0 || legs.length === 0) return [];

  const legById = new Map(legs.map((l) => [l.id, l]));
  const segById = new Map(segments.map((s) => [s.id, s]));
  const carrierById = new Map(carriers.map((c) => [c.id, c]));

  // Build a complete normalized offer for every itinerary first; then pick
  // the surface set from the full pool. Doing it this way means a cheap
  // 1-stop and a moderately-priced nonstop both get considered side by side,
  // rather than the nonstop being chopped off the bottom of a price sort.
  const allOffers = [];
  const seen = new Set(); // dedupe by departure+arrival+carrier+flight#
  let idCounter = 0;
  for (const it of itineraries) {
    const legId = (it.leg_ids || [])[0];
    const leg = legId ? legById.get(legId) : null;
    if (!leg) continue;

    const price = Number(it?.pricing_options?.[0]?.price?.amount) || 0;
    const carrierId = (leg.marketing_carrier_ids || [])[0];
    const carrier = carrierById.get(carrierId);
    const operator = carrierLabel(carrier) || "Airline";

    const segIds = leg.segment_ids || [];
    const firstSeg = segById.get(segIds[0]);
    const flightNo =
      firstSeg && firstSeg.marketing_flight_number
        ? `${carrierCode(carrier)}${firstSeg.marketing_flight_number}`.trim()
        : "";

    const departureTime = isoTime(leg.departure);
    const arrivalTime = isoTime(leg.arrival);
    if (!departureTime || !arrivalTime) continue;
    const arrivalDayOffset = dayOffset(leg.departure, leg.arrival);
    const stops = Number(leg.stop_count) || 0;
    const perPerson = price > 0 ? Math.round(price) : 0;
    const durationMin = Number(leg.duration) || 0;

    const dedupeKey = `${departureTime}|${arrivalTime}|${operator}|${flightNo}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    allOffers.push({
      id: `flight-real-${idCounter++}`,
      operator,
      flightNumber: flightNo,
      duration: minutesToDuration(durationMin),
      durationMin,
      stops,
      departureTime,
      arrivalTime,
      arrivalDayOffset,
      priceFrom: perPerson,
      priceLabel: perPerson > 0 ? `From $${perPerson.toLocaleString()}/pp` : "",
      notes:
        stops === 0
          ? "Nonstop · live schedule"
          : `${stops} stop${stops > 1 ? "s" : ""} · live schedule`,
      _score: scoreOffer(perPerson, stops, durationMin),
    });
  }

  if (allOffers.length === 0) return [];

  // Pick a balanced set: best by quality score (which favours nonstops + reasonable
  // durations) AND cheapest absolute prices (for travellers who care about
  // wallet first). Dedupe; cap at MAX_OFFERS. Anyone who specifically wants
  // cheapest-only can use the Sort chips on the frontend.
  const byScore = [...allOffers].sort((a, b) => a._score - b._score);
  const byPrice = [...allOffers].sort(
    (a, b) => (a.priceFrom || Infinity) - (b.priceFrom || Infinity),
  );

  const picked = [];
  const pickedIds = new Set();
  // Top 3 by score (best balance: nonstops first when they exist).
  for (const o of byScore.slice(0, 3)) {
    if (picked.length >= MAX_OFFERS) break;
    if (pickedIds.has(o.id)) continue;
    pickedIds.add(o.id);
    picked.push(o);
  }
  // Top 3 by price (cheapest, regardless of quality).
  for (const o of byPrice.slice(0, 3)) {
    if (picked.length >= MAX_OFFERS) break;
    if (pickedIds.has(o.id)) continue;
    pickedIds.add(o.id);
    picked.push(o);
  }

  // Return best-first (the frontend Sort chips let the user re-order).
  picked.sort((a, b) => a._score - b._score);
  // Strip the internal scoring field; renumber ids so they're stable [0..N).
  return picked.map((o, i) => {
    const { _score, durationMin, ...rest } = o;
    return { ...rest, id: `flight-real-${i}` };
  });
}

module.exports = { getRealFlights };
