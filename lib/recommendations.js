/**
 * Claude-powered Trip Preference recommendations.
 *
 * Single endpoint that returns AI-recommended Places (Phase 1; Activities
 * and Restaurants land in Phase 2) for a destination based on the trip-wide
 * preferences the user set on the Trip Preferences screen.
 *
 * Claude is also asked to include 1-2 city-signature picks per destination even
 * if they don't directly match the user's chip selections — surfaced with
 * `signature: true` so the frontend can label them.
 *
 * Returns [] (not throws) on soft failures so the caller can fall back to
 * the static `src/data/places.ts` pool if everything goes wrong.
 */
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT =
  "You are an expert local travel planner. Reply with ONLY a JSON object — no prose, no markdown fences.";

/* ───────────────── In-memory cache ─────────────────
 *
 * Same pattern as lib/transport.js — the user re-rendering Explore for
 * the same destination should not re-bill Anthropic. 30-min TTL matches the
 * frontend React Query staleTime.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

function cacheKey(city, prefs, count) {
  // Hash by stable serialization; alreadyPicked is intentionally NOT in
  // the key so toggling items doesn't bust the recommendation set.
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
  return `${city}|${count}|${prefStr}`;
}

function evictExpired() {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
}

/* ───────────────── Prompt building ───────────────── */

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

function describeInterests(keys, labelMap) {
  if (!Array.isArray(keys) || keys.length === 0) return "(none specified)";
  return keys.map((k) => labelMap[k] || k).join(", ");
}

function describeSliders(prefs) {
  const sliderWord = (n) => {
    const v = Number(n) || 3;
    if (v <= 1) return "1/5";
    if (v >= 5) return "5/5";
    return `${v}/5`;
  };
  return [
    `Pace ${sliderWord(prefs.pace)} (1=relaxed, 5=packed)`,
    `Tourist-vs-local ${sliderWord(prefs.touristVsLocal)} (1=famous landmarks, 5=hidden gems)`,
    `Adventure ${sliderWord(prefs.adventure)} (1=familiar, 5=try anything)`,
    `Budget: ${prefs.budget || "mid"}`,
  ].join(" · ");
}

function buildPlacesPrompt({ city, nights, travelers, prefs, alreadyPicked, count }) {
  const picks = (alreadyPicked || []).map((p) => `${p.name} (${p.area})`).join("; ");
  return `Plan PLACES to visit for a ${nights}-night destination in ${city} (${travelers} traveler${travelers > 1 ? "s" : ""}).

Traveler's place interests: ${describeInterests(prefs.placesInterests, PLACE_LABELS)}
${prefs.placesOther ? `Other interests (free text): "${prefs.placesOther}"` : ""}
Trip vibe: ${describeSliders(prefs)}
${picks ? `Already picked (avoid duplicates): ${picks}` : ""}

Recommend ${count} REAL, well-known places in ${city} that match the interests above. Variety is good — span neighborhoods and types so the user has choice.

Also include 1-2 city-signature picks (the iconic things travelers expect when they visit ${city}) even if they don't directly match the chip-selected interests. Mark those with "signature": true. Examples: Senso-ji for Tokyo, Eiffel Tower for Paris, Acropolis for Athens.

Return ONLY this JSON object:
{"places":[{"name":"Real place name","area":"Neighborhood/district","type":"Temple|Museum|Park|Viewpoint|Market|Landmark|Gallery|etc.","duration":"e.g. 2h or 45 min","bestTime":"Morning|Afternoon|Evening","rating":4.5,"tags":["tag1","tag2"],"cost":0,"whyPicked":"Short rationale, max 15 words","signature":false}]}`;
}

/* ───────────────── Response parsing ───────────────── */

function extractObject(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  for (const candidate of [cleaned, cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)]) {
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

/**
 * Deterministic id from name + area + city so the same place keeps the same
 * id across Claude re-rolls. Lets the frontend's "already added" check
 * (destination.places.some(x => x.id === place.id)) survive cache evictions.
 * Offset by 1_000_000 to distinguish from the static data ids (< 100).
 */
function stableId(name, area, city) {
  const s = `${name}|${area}|${city}`.toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 1_000_000 + Math.abs(h);
}

function normalizePlace(p, city) {
  const bestTime = VALID_BEST_TIMES.includes(p.bestTime) ? p.bestTime : "Afternoon";
  const rating = Math.max(0, Math.min(5, Number(p.rating) || 4.5));
  const cost = Math.max(0, Number(p.cost) || 0);
  const name = String(p.name || "").trim();
  const area = String(p.area || "").trim();
  return {
    id: stableId(name, area, city),
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
  };
}

/* ───────────────── Main entry ───────────────── */

async function recommendForDestination({ city, nights, travelers, tripPreferences, alreadyPicked }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set in the backend .env");
  }
  const prefs = tripPreferences || {};
  const count = nights >= 3 ? 12 : nights === 2 ? 10 : 8;

  const key = cacheKey(city, prefs, count);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    console.log(`[recommendations] cache HIT  ${key.slice(0, 80)}...`);
    return hit.payload;
  }
  evictExpired();

  const prompt = buildPlacesPrompt({ city, nights, travelers, prefs, alreadyPicked, count });

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
  const rawPlaces = Array.isArray(obj.places) ? obj.places : [];
  const places = rawPlaces.map((p) => normalizePlace(p, city)).filter((p) => p.name);

  const payload = { places };

  // Only cache non-empty results — caching empty would mask transient outages.
  if (places.length > 0) {
    cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    console.log(
      `[recommendations] cache MISS ${key.slice(0, 80)}... -> stored ${places.length} places`,
    );
  } else {
    console.log(`[recommendations] cache MISS ${key.slice(0, 80)}... -> empty, not caching`);
  }

  return payload;
}

module.exports = { recommendForDestination };
