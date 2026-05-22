/**
 * Amadeus Flight Offers Search — real flight fares for a city pair.
 *
 * Uses the free TEST (sandbox) environment. Returns the cheapest real offer,
 * or null when the sandbox has no data for the route/date — the caller then
 * keeps Claude's estimate, so the screen never breaks.
 */
const AMADEUS_HOST = "https://test.api.amadeus.com"; // sandbox; production: api.amadeus.com

// OAuth tokens last ~30 min; cache and reuse.
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const clientId = process.env.AMADEUS_CLIENT_ID;
  const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET not set");
  }
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const res = await fetch(`${AMADEUS_HOST}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Amadeus auth HTTP ${res.status}`);
  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    // Refresh a minute early.
    expiresAt: Date.now() + (Number(data.expires_in || 1799) - 60) * 1000,
  };
  return tokenCache.token;
}

const isIata = (code) => typeof code === "string" && /^[A-Z]{3}$/.test(code);

/** ISO 8601 duration "PT11H5M" -> "11h 5m". */
function parseDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || "");
  if (!m) return "";
  return [m[1] ? `${m[1]}h` : "", m[2] ? `${m[2]}m` : ""]
    .filter(Boolean)
    .join(" ");
}

const titleCase = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Real flight summary for the route, or null when Amadeus has nothing usable.
 * Throws only on a missing-credentials / auth failure.
 */
async function getRealFlight(fromCode, toCode, departureDate, adults) {
  if (!isIata(fromCode) || !isIata(toCode) || !departureDate) return null;

  const token = await getAccessToken();
  const params = new URLSearchParams({
    originLocationCode: fromCode,
    destinationLocationCode: toCode,
    departureDate,
    adults: String(adults > 0 ? adults : 1),
    currencyCode: "USD",
    max: "5",
  });

  const res = await fetch(
    `${AMADEUS_HOST}/v2/shopping/flight-offers?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  // 400 usually = route/date not in the sandbox dataset. Treat as "no data".
  if (!res.ok) return null;

  const data = await res.json();
  const offers = data && Array.isArray(data.data) ? data.data : [];
  if (offers.length === 0) return null;

  const carriers = (data.dictionaries && data.dictionaries.carriers) || {};
  const best = offers.reduce((a, b) =>
    parseFloat(a.price.grandTotal) <= parseFloat(b.price.grandTotal) ? a : b,
  );
  const itinerary = best.itineraries && best.itineraries[0];
  const segments = (itinerary && itinerary.segments) || [];
  const stops = Math.max(0, segments.length - 1);
  const carrierCode =
    (best.validatingAirlineCodes && best.validatingAirlineCodes[0]) ||
    (segments[0] && segments[0].carrierCode);
  const adultCount = adults > 0 ? adults : 1;
  const perPerson = Math.round(parseFloat(best.price.grandTotal) / adultCount);

  return {
    operator: carriers[carrierCode]
      ? titleCase(carriers[carrierCode])
      : carrierCode || "Airline",
    duration: parseDuration(itinerary && itinerary.duration),
    priceFrom: perPerson,
    priceLabel: `From $${perPerson.toLocaleString()}/pp`,
    notes:
      stops === 0
        ? "Nonstop · live fare"
        : `${stops} stop${stops > 1 ? "s" : ""} · live fare`,
  };
}

module.exports = { getRealFlight };
