/**
 * Claude-powered Trip Preference recommendations.
 *
 * Single endpoint that returns AI-recommended Places, Activities AND
 * Restaurants for a destination, based on the trip-wide preferences the
 * user set on the Trip Preferences screen. ONE Claude call returns all
 * three categories together so the model can balance recommendations
 * across them (e.g. suggest a dinner spot near a recommended place).
 *
 * Claude is also asked to include 1-2 city-signature picks per category
 * even if they don't directly match the user's chip selections —
 * surfaced with `signature: true` so the frontend can label them.
 *
 * Returns empty arrays (not throws) on soft failures so the caller can
 * fall back to the static `src/data/*.ts` pools if everything goes wrong.
 */
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT =
  "You are an expert local travel planner. Reply with ONLY a JSON object — no prose, no markdown fences.";

/* ───────────────── In-memory cache ─────────────────
 *
 * Same pattern as lib/transport.js — the user re-rendering Explore for
 * the same destination should not re-bill Anthropic. 30-min TTL matches
 * the frontend React Query staleTime.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

function cacheKey(city, prefs, counts) {
  // Hash by stable serialization; alreadyPicked* fields are intentionally
  // NOT in the key so toggling items doesn't bust the recommendation set.
  const prefStr = JSON.stringify({
    p: (prefs.placesInterests || []).slice().sort(),
    po: prefs.placesOther || "",
    a: (prefs.activitiesInterests || []).slice().sort(),
    ao: prefs.activitiesOther || "",
    b: prefs.breakfast,
    l: prefs.lunch,
    d: prefs.dinner,
    diet: (prefs.dietary || []).slice().sort(),
    do: prefs.diningOther || "",
    pace: prefs.pace,
    tvl: prefs.touristVsLocal,
    adv: prefs.adventure,
    bud: prefs.budget,
  });
  return `${city}|p${counts.places}a${counts.activities}r${counts.restaurants}|${prefStr}`;
}

function evictExpired() {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
}

/* ───────────────── Taxonomy → readable labels ───────────────── */

const PLACE_LABELS = {
  history: "History & heritage (ancient sites, monuments, ruins)",
  architecture: "Architecture (palaces, churches, modernist buildings)",
  instagram: "Instagram-worthy / photogenic spots",
  nature: "Nature & gardens",
  religion: "Religion & spirituality (temples, shrines, churches, mosques)",
  art: "Art & museums",
  neighborhoods: "Local neighborhoods (where locals live)",
  "hidden-gems": "Hidden gems / off-the-tourist-trail",
};

const ACTIVITY_LABELS = {
  "food-experiences":
    "Local food experiences (cooking classes, food tours, market visits)",
  "guided-tours": "Guided tours (walking, biking, themed)",
  "outdoor-hiking": "Outdoor & hiking (trails, parks, nature excursions)",
  adventure: "Adventure (zip-lining, paragliding, water sports)",
  "cultural-workshops":
    "Cultural workshops (crafts, tea ceremony, calligraphy)",
  nightlife: "Nightlife (bars, clubs, live music)",
  wellness: "Wellness (spa, hot springs, yoga)",
  "day-trips": "Day trips (out-of-city excursions)",
  shopping: "Shopping (markets, boutiques, design stores)",
  "family-friendly": "Family-friendly (zoos, parks, kid-focused)",
};

const BREAKFAST_LABELS = {
  quick: "Quick & simple — pastry + coffee, grab and go",
  hotel: "Hotel breakfast — whatever's included",
  local: "Local breakfast spot — neighborhood café where locals eat",
  leisurely: "Leisurely brunch — sit-down, take time",
  skip: "Skip / coffee only",
};
const LUNCH_LABELS = {
  "street-food": "Street food / markets — adventurous, local",
  "local-favorites": "Local lunch spots — where locals eat, not tourist menus",
  casual: "Casual sit-down — proper restaurant, not fancy",
  "quick-bite": "Quick bite on the move — sandwich / noodle bar, 30 min max",
  "at-attractions": "At the attraction — café inside / near the sight",
};
const DINNER_LABELS = {
  "local-favorites": "Local favorites — neighborhood gems, mid-range",
  "casual-lively": "Casual & lively — izakaya / tapas bar / energy",
  "special-occasion": "Special occasion — upscale fine dining",
  michelin: "Michelin / chef's table — premier dining",
  "date-night": "Date night — intimate, scenic, quiet",
};

function describeInterests(keys, labelMap) {
  if (!Array.isArray(keys) || keys.length === 0) return "(none specified)";
  return keys.map((k) => labelMap[k] || k).join(", ");
}

function describeSliders(prefs) {
  const v = (n) => {
    const x = Number(n) || 3;
    return Math.min(5, Math.max(1, x));
  };
  return [
    `Pace ${v(prefs.pace)}/5 (1=relaxed, 5=packed)`,
    `Tourist-vs-local ${v(prefs.touristVsLocal)}/5 (1=famous landmarks, 5=hidden gems)`,
    `Adventure ${v(prefs.adventure)}/5 (1=familiar, 5=try anything)`,
    `Budget: ${prefs.budget || "mid"}`,
  ].join(" · ");
}

function diningLine(prefs) {
  const lines = [];
  if (prefs.breakfast)
    lines.push(`Breakfast: ${BREAKFAST_LABELS[prefs.breakfast] || prefs.breakfast}`);
  if (prefs.lunch)
    lines.push(`Lunch: ${LUNCH_LABELS[prefs.lunch] || prefs.lunch}`);
  if (prefs.dinner)
    lines.push(`Dinner: ${DINNER_LABELS[prefs.dinner] || prefs.dinner}`);
  if (Array.isArray(prefs.dietary) && prefs.dietary.length > 0)
    lines.push(`Dietary: ${prefs.dietary.join(", ")}`);
  if (prefs.diningOther) lines.push(`Other dining notes: "${prefs.diningOther}"`);
  return lines.length === 0 ? "(no specific preferences)" : lines.join(" · ");
}

/* ───────────────── Prompt building ───────────────── */

function buildCombinedPrompt({
  city,
  nights,
  travelers,
  prefs,
  alreadyPickedPlaces,
  alreadyPickedActivities,
  alreadyPickedRestaurants,
  counts,
}) {
  const listPicks = (arr) =>
    (arr || []).map((p) => `${p.name} (${p.area})`).join("; ") || "(none)";

  return `Plan a personalized travel guide for a ${nights}-night destination in ${city} (${travelers} traveler${travelers > 1 ? "s" : ""}).

== TRAVELER PREFERENCES ==
Place interests: ${describeInterests(prefs.placesInterests, PLACE_LABELS)}
${prefs.placesOther ? `Place interests (free text): "${prefs.placesOther}"` : ""}
Activity interests: ${describeInterests(prefs.activitiesInterests, ACTIVITY_LABELS)}
${prefs.activitiesOther ? `Activity interests (free text): "${prefs.activitiesOther}"` : ""}
Dining: ${diningLine(prefs)}
Trip vibe: ${describeSliders(prefs)}

== ALREADY PICKED (avoid duplicates) ==
Places: ${listPicks(alreadyPickedPlaces)}
Activities: ${listPicks(alreadyPickedActivities)}
Restaurants: ${listPicks(alreadyPickedRestaurants)}

== RECOMMENDATIONS REQUESTED ==
Recommend ${counts.places} REAL places, ${counts.activities} REAL activities, and ${counts.restaurants} REAL restaurants in ${city} that match the preferences above. Variety is good — span neighborhoods, types, price tiers, and meal slots.

For restaurants, spread across breakfast / lunch / dinner roughly evenly so the user has options for every meal of their ${nights}-night stay. Respect dietary restrictions strictly.

Also include 1-2 city-signature picks per category — the iconic things travelers expect when they visit ${city} — even if they don't directly match the chip-selected interests. Mark each with "signature": true.

You may suggest activities or restaurants that are near a place you also recommend; the user benefits when picks cluster geographically.

== OUTPUT ==
For EVERY item, include an "openingHours" string with realistic operating
hours / day-of-week closures based on your world knowledge of the venue.
Keep it short (max ~50 chars). Examples:
  "Daily 9:00 AM – 5:00 PM"
  "Mon-Sat 10-19, closed Sun"
  "Tue-Sun 18:00-23:00 (closed Mon)"
  "Daily 7-11 AM, 5-9 PM"
  "24/7"
If you genuinely don't know, return "Hours not available".

Return ONLY this JSON object — no prose, no markdown fences:
{
  "places": [
    {"name":"Real name","area":"Neighborhood/district","type":"Temple|Museum|Park|Viewpoint|Market|Landmark|Gallery|etc.","duration":"e.g. 2h or 45 min","bestTime":"Morning|Afternoon|Evening","rating":4.5,"tags":["tag1","tag2"],"cost":0,"whyPicked":"Short rationale, max 15 words","signature":false,"openingHours":"Daily 9 AM – 5 PM"}
  ],
  "activities": [
    {"name":"Real name","area":"Neighborhood/district","type":"Cooking class|Food tour|Walking tour|Workshop|Spa|Day trip|etc.","duration":"e.g. 3h or Half-day","rating":4.6,"tags":["tag1"],"price":"$|$$|$$$|$$$$","cost":75,"badge":null,"whyPicked":"Short rationale, max 15 words","signature":false,"openingHours":"Morning + afternoon departures daily"}
  ],
  "restaurants": [
    {"name":"Real name","area":"Neighborhood/district","type":"Sushi|Ramen|Italian|Steakhouse|Cafe|etc.","price":"$|$$|$$$|$$$$","rating":4.5,"badge":null,"meal":"Breakfast|Lunch|Dinner","cost":30,"whyPicked":"Short rationale, max 15 words","signature":false,"openingHours":"Tue-Sun 11:30-22:00 (closed Mon)"}
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

const VALID_BEST_TIMES = ["Morning", "Afternoon", "Evening"];
const VALID_MEALS = ["Breakfast", "Lunch", "Dinner"];
const VALID_PRICE_TIERS = ["$", "$$", "$$$", "$$$$"];

/**
 * Deterministic id from name + area + city so the same item keeps the same
 * id across Claude re-rolls. Lets the frontend's "already added" check
 * (destination.X.some(x => x.id === item.id)) survive cache evictions.
 *
 * Offset per category to avoid id collisions across types:
 *   places      → 1_000_000+
 *   activities  → 2_000_000+
 *   restaurants → 3_000_000+
 */
function stableId(name, area, city, offset) {
  const s = `${name}|${area}|${city}`.toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return offset + Math.abs(h);
}

function normalizePlace(p, city) {
  const bestTime = VALID_BEST_TIMES.includes(p.bestTime)
    ? p.bestTime
    : "Afternoon";
  const rating = Math.max(0, Math.min(5, Number(p.rating) || 4.5));
  const cost = Math.max(0, Number(p.cost) || 0);
  const name = String(p.name || "").trim();
  const area = String(p.area || "").trim();
  return {
    id: stableId(name, area, city, 1_000_000),
    city,
    name,
    area,
    type: String(p.type || "Sight").trim(),
    duration: String(p.duration || "").trim(),
    rating,
    reviews: "AI",
    source: "AI",
    bestTime,
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 5).map(String) : [],
    cost,
    whyPicked: String(p.whyPicked || "").trim(),
    signature: Boolean(p.signature),
    openingHours: String(p.openingHours || "").trim() || undefined,
  };
}

function normalizeActivity(a, city) {
  const rating = Math.max(0, Math.min(5, Number(a.rating) || 4.5));
  const cost = Math.max(0, Number(a.cost) || 0);
  const name = String(a.name || "").trim();
  const area = String(a.area || "").trim();
  const price = VALID_PRICE_TIERS.includes(a.price) ? a.price : "$$";
  return {
    id: stableId(name, area, city, 2_000_000),
    city,
    name,
    area,
    type: String(a.type || "Experience").trim(),
    duration: String(a.duration || "").trim(),
    rating,
    reviews: "AI",
    source: "AI",
    price,
    cost,
    badge: a.badge ? String(a.badge).trim() : null,
    tags: Array.isArray(a.tags) ? a.tags.slice(0, 5).map(String) : [],
    whyPicked: String(a.whyPicked || "").trim(),
    signature: Boolean(a.signature),
    openingHours: String(a.openingHours || "").trim() || undefined,
  };
}

function normalizeRestaurant(r, city) {
  const rating = Math.max(0, Math.min(5, Number(r.rating) || 4.5));
  const cost = Math.max(0, Number(r.cost) || 0);
  const name = String(r.name || "").trim();
  const area = String(r.area || "").trim();
  const price = VALID_PRICE_TIERS.includes(r.price) ? r.price : "$$";
  const meal = VALID_MEALS.includes(r.meal) ? r.meal : "Dinner";
  return {
    id: stableId(name, area, city, 3_000_000),
    city,
    name,
    area,
    type: String(r.type || "Restaurant").trim(),
    price,
    rating,
    reviews: "AI",
    badge: r.badge ? String(r.badge).trim() : null,
    meal,
    cost,
    whyPicked: String(r.whyPicked || "").trim(),
    signature: Boolean(r.signature),
    openingHours: String(r.openingHours || "").trim() || undefined,
  };
}

/* ───────────────── Main entry ───────────────── */

async function recommendForDestination({
  city,
  nights,
  travelers,
  tripPreferences,
  alreadyPicked, // legacy — equivalent to alreadyPickedPlaces
  alreadyPickedPlaces,
  alreadyPickedActivities,
  alreadyPickedRestaurants,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set in the backend .env");
  }
  const prefs = tripPreferences || {};

  const counts = {
    places: nights >= 3 ? 12 : nights === 2 ? 10 : 8,
    activities: nights >= 3 ? 8 : nights === 2 ? 6 : 4,
    restaurants: nights >= 3 ? 12 : nights === 2 ? 9 : 6,
  };

  const pickedPlaces = alreadyPickedPlaces || alreadyPicked || [];
  const pickedActivities = alreadyPickedActivities || [];
  const pickedRestaurants = alreadyPickedRestaurants || [];

  const key = cacheKey(city, prefs, counts);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    console.log(`[recommendations] cache HIT  ${key.slice(0, 80)}...`);
    return hit.payload;
  }
  evictExpired();

  const prompt = buildCombinedPrompt({
    city,
    nights,
    travelers,
    prefs,
    alreadyPickedPlaces: pickedPlaces,
    alreadyPickedActivities: pickedActivities,
    alreadyPickedRestaurants: pickedRestaurants,
    counts,
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
      max_tokens: 6000,
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

  const rawPlaces = Array.isArray(obj.places) ? obj.places : [];
  const rawActivities = Array.isArray(obj.activities) ? obj.activities : [];
  const rawRestaurants = Array.isArray(obj.restaurants) ? obj.restaurants : [];

  const places = rawPlaces.map((p) => normalizePlace(p, city)).filter((p) => p.name);
  const activities = rawActivities
    .map((a) => normalizeActivity(a, city))
    .filter((a) => a.name);
  const restaurants = rawRestaurants
    .map((r) => normalizeRestaurant(r, city))
    .filter((r) => r.name);

  const payload = { places, activities, restaurants };

  const totalCount = places.length + activities.length + restaurants.length;
  // Only cache non-empty results — caching empty would mask transient outages.
  if (totalCount > 0) {
    cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    console.log(
      `[recommendations] cache MISS ${key.slice(0, 80)}... -> stored ${places.length}P / ${activities.length}A / ${restaurants.length}R`,
    );
  } else {
    console.log(
      `[recommendations] cache MISS ${key.slice(0, 80)}... -> empty, not caching`,
    );
  }

  return payload;
}

module.exports = { recommendForDestination };
