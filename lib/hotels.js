/**
 * Claude-powered AI hotel recommendations.
 *
 * Takes hotel preferences (stars, budget, vibes, must-haves, location
 * priority) AND the places / activities / restaurants the user already
 * picked, and recommends hotels ranked by the user's chosen criterion:
 *
 *   - "transit"   → best public-transit access to the picked items
 *   - "proximity" → closest absolute distance to the picked items
 *   - "value"     → best overall value (price/quality/location balance)
 *
 * Each hotel comes back with a `whyPicked` rationale, a `nearestTransit`
 * blurb, and a Booking.com search deep-link the app renders as
 * "Book on Booking.com →".
 *
 * Returns { hotels: [] } (not throws) on soft failures so the caller falls
 * back to the static src/data/hotels.ts pool.
 */
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT =
  "You are an expert local hotel concierge. Reply with ONLY a JSON object — no prose, no markdown fences.";

/* ───────────────── In-memory cache ───────────────── */

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

function cacheKey(city, hotelPrefs, picksSignature) {
  const prefStr = JSON.stringify({
    s: (hotelPrefs.stars || []).slice().sort(),
    b: hotelPrefs.budget,
    v: (hotelPrefs.vibes || []).slice().sort(),
    m: (hotelPrefs.mustHaves || []).slice().sort(),
    lp: hotelPrefs.locationPriority,
  });
  return `${city}|${picksSignature}|${prefStr}`;
}

function evictExpired() {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
}

/* ───────────────── Taxonomy → readable labels ───────────────── */

const VIBE_LABELS = {
  boutique: "Boutique — small, design-led, characterful",
  modern: "Modern — clean lines, contemporary",
  traditional: "Traditional — local style, heritage feel",
  luxury: "Luxury — full-service premium",
  business: "Business — efficient, work-friendly",
};

const MUST_HAVE_LABELS = {
  breakfast: "Breakfast included",
  pool: "Pool",
  gym: "Gym / fitness center",
  spa: "Spa",
  kitchen: "In-room kitchen / kitchenette",
  "family-rooms": "Family rooms / suites",
  "pet-friendly": "Pet-friendly",
};

const LOCATION_PRIORITY_LABELS = {
  transit:
    "BEST PUBLIC-TRANSIT ACCESS to the picked items (subway / rail stops, fewest transfers)",
  proximity:
    "CLOSEST ABSOLUTE DISTANCE to the picked items (walking distance preferred)",
  value:
    "BEST OVERALL VALUE — balance price, quality, and being reasonably central to the picks",
};

function listLabel(keys, labelMap) {
  if (!Array.isArray(keys) || keys.length === 0) return "(no preference)";
  return keys.map((k) => labelMap[k] || k).join(", ");
}

function describePicks(picks, limit) {
  if (!Array.isArray(picks) || picks.length === 0) return "(none)";
  return picks
    .slice(0, limit)
    .map((p) => `${p.name} (${p.area || "?"})`)
    .join("; ");
}

/* ───────────────── Booking.com URL ───────────────── */

/** Build a Booking.com search URL for a hotel name + city + dates. */
function buildBookingUrl({ name, city, checkIn, checkOut, travelers }) {
  if (!name || !city) return "";
  const q = encodeURIComponent(`${name} ${city}`);
  const params = [`ss=${q}`];
  if (checkIn) params.push(`checkin=${encodeURIComponent(checkIn)}`);
  if (checkOut) params.push(`checkout=${encodeURIComponent(checkOut)}`);
  if (travelers > 0) params.push(`group_adults=${travelers}`);
  return `https://www.booking.com/searchresults.html?${params.join("&")}`;
}

/* ───────────────── Prompt building ───────────────── */

function buildHotelsPrompt({
  city,
  nights,
  travelers,
  checkIn,
  checkOut,
  hotelPrefs,
  picks,
  count,
}) {
  const dates =
    checkIn && checkOut
      ? `${checkIn} → ${checkOut} (${nights} night${nights !== 1 ? "s" : ""})`
      : `${nights} night${nights !== 1 ? "s" : ""}`;
  return `Recommend hotels for a ${dates} destination in ${city} for ${travelers} traveler${travelers !== 1 ? "s" : ""}.

== HOTEL PREFERENCES ==
Star rating: ${(hotelPrefs.stars || []).length > 0 ? hotelPrefs.stars.map((s) => `${s}-star`).join(", ") : "(no preference)"}
Budget tier (per night): ${hotelPrefs.budget || "mid"}
Vibe: ${listLabel(hotelPrefs.vibes, VIBE_LABELS)}
Must-have amenities: ${listLabel(hotelPrefs.mustHaves, MUST_HAVE_LABELS)}
Location priority: ${LOCATION_PRIORITY_LABELS[hotelPrefs.locationPriority] || LOCATION_PRIORITY_LABELS.transit}

== USER'S PICKED ITEMS IN ${city.toUpperCase()} ==
These are the places, activities and restaurants the traveler will be visiting. Recommend hotels that fit the LOCATION PRIORITY above relative to these:

Places: ${describePicks(picks.places, 12)}
Activities: ${describePicks(picks.activities, 8)}
Restaurants: ${describePicks(picks.restaurants, 10)}

== RECOMMENDATIONS REQUESTED ==
Recommend ${count} REAL, well-known hotels in ${city} that:
1. Match the user's preferences (stars, budget, vibe, must-have amenities) as closely as possible — strict on must-haves.
2. Optimise for the LOCATION PRIORITY relative to the picked items above.
3. Span a price range so the user has choice (cheapest → most expensive within the budget tier).

For each hotel include:
- name (real, well-known property)
- area (neighborhood / district)
- stars (3, 4, or 5)
- price (USD per night, your best estimate)
- rating (0-10 scale, 8.0+ for good hotels)
- amenities (4-6 short tags)
- nearestTransit (e.g. "2 min walk to Akasaka Station (Chiyoda Line)")
- whyPicked (max 20 words explaining WHY this hotel given the user's prefs + their picks — mention specific picked items by name when relevant)
- signature (true for 1-2 city-iconic / landmark hotels even if outside the strict prefs; false otherwise)

Return ONLY this JSON object — no prose, no markdown fences:
{
  "hotels": [
    {"name":"Real hotel name","area":"Neighborhood","stars":4,"price":280,"rating":8.5,"amenities":["Free WiFi","Breakfast","Gym","Pool"],"nearestTransit":"2 min walk to Akasaka Station","whyPicked":"3 stops from Senso-ji and Shibuya; matches your 'boutique modern' vibe; breakfast included.","signature":false}
  ]
}`;
}

/* ───────────────── Response parsing ───────────────── */

function extractObject(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  for (const candidate of [
    cleaned,
    cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1),
  ]) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object") return obj;
    } catch {
      /* try next */
    }
  }
  return {};
}

/**
 * Deterministic id from name + area + city so the same hotel keeps the
 * same id across Claude re-rolls. Offset by 4_000_000 to keep distinct
 * from places (1M+), activities (2M+), restaurants (3M+).
 */
function stableId(name, area, city) {
  const s = `${name}|${area}|${city}`.toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 4_000_000 + Math.abs(h);
}

function clampStars(n) {
  const v = Number(n) || 0;
  if (v <= 2) return 3;
  if (v >= 5) return 5;
  return Math.round(v);
}

function normalizeHotel(h, city, bookingArgs) {
  const name = String(h.name || "").trim();
  const area = String(h.area || "").trim();
  const stars = clampStars(h.stars);
  const price = Math.max(0, Math.round(Number(h.price) || 0));
  const rating = Math.max(0, Math.min(10, Number(h.rating) || 8));
  const amenities = Array.isArray(h.amenities)
    ? h.amenities.slice(0, 6).map(String)
    : [];
  return {
    id: stableId(name, area, city),
    name,
    area,
    stars,
    price,
    rating,
    reviews: "AI",
    em: "🏨",
    badge: null,
    amenities,
    source: "AI",
    whyPicked: String(h.whyPicked || "").trim(),
    signature: Boolean(h.signature),
    nearestTransit: String(h.nearestTransit || "").trim(),
    bookingUrl: buildBookingUrl({ ...bookingArgs, name, city }),
  };
}

/* ───────────────── Main entry ───────────────── */

async function recommendHotels({
  city,
  nights,
  travelers,
  checkIn,
  checkOut,
  hotelPreferences,
  picks,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set in the backend .env");
  }
  const hotelPrefs = hotelPreferences || {};
  const cleanPicks = {
    places: Array.isArray(picks?.places) ? picks.places : [],
    activities: Array.isArray(picks?.activities) ? picks.activities : [],
    restaurants: Array.isArray(picks?.restaurants) ? picks.restaurants : [],
  };

  // Picks signature for cache key — order- and case-insensitive.
  const sig = JSON.stringify({
    p: cleanPicks.places
      .map((p) => `${(p.name || "").toLowerCase()}|${(p.area || "").toLowerCase()}`)
      .sort(),
    a: cleanPicks.activities
      .map((a) => `${(a.name || "").toLowerCase()}|${(a.area || "").toLowerCase()}`)
      .sort(),
    r: cleanPicks.restaurants
      .map((r) => `${(r.name || "").toLowerCase()}|${(r.area || "").toLowerCase()}`)
      .sort(),
  });

  const count = 6;
  const key = cacheKey(city, hotelPrefs, sig);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    console.log(`[hotels] cache HIT  ${key.slice(0, 80)}...`);
    return hit.payload;
  }
  evictExpired();

  const prompt = buildHotelsPrompt({
    city,
    nights,
    travelers,
    checkIn,
    checkOut,
    hotelPrefs,
    picks: cleanPicks,
    count,
  });

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.content?.[0]?.text || "{}";
  const obj = extractObject(text);
  const rawHotels = Array.isArray(obj.hotels) ? obj.hotels : [];

  const bookingArgs = {
    city,
    checkIn,
    checkOut,
    travelers: Number(travelers) > 0 ? Number(travelers) : 1,
  };
  const hotels = rawHotels
    .map((h) => normalizeHotel(h, city, bookingArgs))
    .filter((h) => h.name);

  const payload = { hotels };

  if (hotels.length > 0) {
    cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    console.log(`[hotels] cache MISS ${key.slice(0, 80)}... -> stored ${hotels.length} hotels`);
  } else {
    console.log(`[hotels] cache MISS ${key.slice(0, 80)}... -> empty, not caching`);
  }

  return payload;
}

module.exports = { recommendHotels };
