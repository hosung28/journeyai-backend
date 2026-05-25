/**
 * Claude-powered day-route optimizer.
 *
 * Takes one destination's chosen places / activities / restaurants and returns
 * a day-by-day schedule that groups nearby stops, puts meals at the right
 * time, and caps each day at a sane number of stops.
 *
 * Batch III additions:
 *  - Meal-gap fill: if a destination has no breakfast / lunch / dinner
 *    restaurant picked, ask Claude to inject a 'Suggested' meal row
 *    flagged with suggested:true. Frontend renders these with a
 *    "tap to choose" chip that deep-links to the Restaurants tab.
 *  - Map coords: every item gets approximate lat / lng so the per-day
 *    map can drop pins + draw the route between them. Claude's geo
 *    accuracy is ~±100-200m which is plenty for an overview pin.
 *  - Custom-event anchors: caller can pass customEvents = [{ day, time,
 *    title, area, note }] and each is treated as a FIXED anchor at the
 *    user's specified time. Returned in the day plan with custom:true.
 */
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT =
  "You are an expert local travel planner. Reply with ONLY a JSON object — no prose, no markdown fences.";

function list(items, fmt) {
  if (!Array.isArray(items) || items.length === 0) return "none";
  return items.map(fmt).join("; ");
}

/** Which meal slots are missing from the user's restaurant picks. */
function missingMeals(restaurants) {
  const have = new Set(
    (Array.isArray(restaurants) ? restaurants : [])
      .map((r) => String(r.meal || "").toLowerCase()),
  );
  const slots = ["breakfast", "lunch", "dinner"];
  return slots.filter((m) => !have.has(m));
}

function buildPrompt(destination, customEvents) {
  const nights = Number(destination.nights) > 0 ? Number(destination.nights) : 1;
  // Airport-to-hotel transit realistically takes 2–2.5 hours (customs,
  // baggage, transit, check-in). We insert two fixed items at the start of
  // Day 1 and ask Claude to build the rest of the day around them.
  const arrivalLine = destination.arrivalTime
    ? `\nDay 1 ARRIVAL: traveller lands at ${destination.arrivalTime}. The plan for Day 1 MUST begin with these two fixed items (do not omit them, do not move them):
  1) kind:"place", name:"Transit from Airport", area:"Airport → ${destination.hotel || "City Centre"}", time: ~30-45 min after arrival, note:"Taxi, train or shuttle to hotel", travelFromPrev:null
  2) kind:"place", name:"Hotel Check-in & Freshen Up", area:"${destination.hotel || "Hotel"}", time: ~1.5-2 h after arrival, note:"Settle in, rest if needed", travelFromPrev: realistic mode from airport
  Schedule the first actual activity at least 30 minutes after the hotel check-in item.`
    : "";
  // Return-flight prep: insert a transit row and airport-check-in row at the
  // end of the last day so the early cutoff is explicit, not silent.
  const departureLine = destination.departureTime
    ? `\nLast day DEPARTURE: traveller's flight departs at ${destination.departureTime}. The plan for the LAST day MUST end with these two fixed items (do not omit them, do not move them):
  1) kind:"place", name:"Transit to Airport", area:"${destination.hotel || "City Centre"} → Airport", time: ~2.5 h before departure, note:"Allow extra time for traffic", travelFromPrev: realistic mode to airport
  2) kind:"place", name:"Airport Check-in & Security", area:"Airport", time: ~1.5 h before departure, note:"Check in, clear security, find gate"
  Do NOT schedule any sightseeing stops after the Transit to Airport item.`
    : "";

  const gaps = missingMeals(destination.restaurants);
  const mealLine =
    gaps.length === 0
      ? ""
      : `\nMEAL GAPS: the user did NOT pick a restaurant for: ${gaps.join(", ")}. For EACH gap, for EACH day, insert ONE meal row with kind:"dining", suggested:true, meal:"<breakfast|lunch|dinner>", and name = your best local pick near that day's other stops (a real restaurant name when you know one, otherwise a generic descriptor like "Local sushi counter"). These are SUGGESTIONS — the traveller will tap to choose.`;

  const customs = Array.isArray(customEvents) ? customEvents : [];
  const customLine =
    customs.length === 0
      ? ""
      : `\nFIXED CUSTOM EVENTS — the traveller has personally added these and they are NON-NEGOTIABLE anchors. Schedule the day's other stops AROUND them. Each event MUST appear in the day plan exactly once at its given time with kind:"custom" and custom:true:\n${customs
          .map(
            (c) =>
              `  - Day ${Number(c.day) || 1} at ${c.time || "?"}: "${c.title || ""}"${c.area ? ` (${c.area})` : ""}${c.note ? ` — ${c.note}` : ""}`,
          )
          .join("\n")}`;

  return `Plan a day-by-day itinerary for a ${nights}-day stay in ${destination.city}.
Hotel base: ${destination.hotel || "city centre"}.${arrivalLine}${departureLine}${mealLine}${customLine}
Places to visit: ${list(destination.places, (p) => `${p.name} (${p.area || "?"}, ${p.type || "sight"})`)}.
Activities booked: ${list(destination.activities, (a) => `${a.name} (${a.area || "?"}, ${a.type || "activity"})`)}.
Restaurants chosen: ${list(destination.restaurants, (r) => `${r.name} (${r.area || "?"}, ${r.meal || "meal"})`)}.

Build an optimised schedule that:
- Returns EXACTLY ${nights} day(s) in the days array. NOT ${nights + 1}, NOT
  ${Math.max(0, nights - 1)}. The "day" field of each item starts at 1 and
  goes up to ${nights}. If you can't fit every item into ${nights} day(s),
  pack more stops into a day — DO NOT add an extra day.
- Aim for 5-7 stops per day, but go higher when needed to include every
  chosen item within the ${nights}-day window.
- Groups stops in the same or nearby area on the same day to minimise travel.
- Places each restaurant (chosen AND suggested) at its correct meal time (breakfast / lunch / dinner).
- Orders each day naturally: morning sights -> lunch -> afternoon -> dinner.
- Respects the ARRIVAL and DEPARTURE constraints above when given.
- Respects FIXED CUSTOM EVENTS as non-movable anchors at their stated times.
- Every chosen place, activity and restaurant appears exactly once.
- For every item include an approximate "lat" and "lng" (decimal degrees,
  4 decimals, e.g. 35.6762). These power a per-day overview map — accuracy
  to within ~100-200m is fine; use your geographic knowledge of the city.
- For every item EXCEPT the first of each day, include a "travelFromPrev"
  estimate of how the traveler gets from the previous item to this one:
    mode = "walk" | "metro" | "taxi" | "bus" | "train" | "bike"
    duration = short human format like "12 min walk" / "8 min metro" / "20 min taxi"
  Pick the realistic dominant mode for the city (e.g. Tokyo defaults to
  metro for >1km hops; small European old towns default to walk; LA
  defaults to taxi/ride-share). First item of each day omits this field.

Return ONLY this JSON shape:
{"days":[{"day":1,"title":"short theme, max 5 words","items":[{"time":"9:00 AM","kind":"place|activity|dining|custom","name":"...","area":"...","note":"short tip, max 10 words","lat":35.7148,"lng":139.7967,"meal":"breakfast","suggested":false,"custom":false,"travelFromPrev":{"mode":"metro","duration":"12 min metro"}}]}]}`;
}

/**
 * Pull the days array out of a model response.
 *
 * Three-pass strategy:
 *   1. Whole cleaned response (fast path).
 *   2. First-`{` to last-`}` substring (handles stray prose).
 *   3. Truncation recovery — Claude may have run out of output budget
 *      mid-item. Walk the response, find the last complete day object
 *      inside the `days` array, and synthesize a valid closing.
 *
 * When all three fail, logs head + tail + length of the response so
 * future failures are diagnosable from Render's stdout.
 */
function extractDays(text) {
  const cleaned = String(text || "")
    .replace(/```json|```/g, "")
    .trim();

  // Pass 1: try the whole cleaned response.
  try {
    const obj = JSON.parse(cleaned);
    if (obj && Array.isArray(obj.days)) return obj.days;
  } catch { /* fall through */ }

  // Pass 2: trim to the brace-bounded JSON object.
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const obj = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      if (obj && Array.isArray(obj.days)) return obj.days;
    } catch { /* fall through */ }
  }

  // Pass 3 (truncation recovery): the response may have been cut off
  // mid-item by the max_tokens cap. Walk the chars after the `days`
  // array open, tracking brace depth + string state. Every time we
  // close a depth-0 `}` (a complete day object), record its index.
  // Then splice the response at the last such index and append `]}` to
  // recreate a valid `{"days":[...]}` ending.
  const daysKeyIdx = cleaned.indexOf('"days"');
  if (daysKeyIdx !== -1) {
    const arrOpenIdx = cleaned.indexOf("[", daysKeyIdx);
    if (arrOpenIdx !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      let lastDayEndIdx = -1;
      for (let i = arrOpenIdx + 1; i < cleaned.length; i++) {
        const c = cleaned[i];
        if (escape) { escape = false; continue; }
        if (c === "\\") { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === "{" || c === "[") {
          depth++;
        } else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0 && c === "}") lastDayEndIdx = i;
          if (depth === -1) break; // array closed cleanly elsewhere
        }
      }
      if (lastDayEndIdx > arrOpenIdx) {
        const repaired = cleaned.slice(0, lastDayEndIdx + 1) + "]}";
        try {
          const obj = JSON.parse(repaired);
          if (obj && Array.isArray(obj.days) && obj.days.length > 0) {
            console.warn(
              `[optimize] Recovered ${obj.days.length} days from truncated response ` +
                `(${cleaned.length} chars, cap was likely hit).`,
            );
            return obj.days;
          }
        } catch { /* fall through */ }
      }
    }
  }

  // All three passes failed — log enough to diagnose later.
  const head = cleaned.slice(0, 200).replace(/\s+/g, " ");
  const tail = cleaned.slice(-200).replace(/\s+/g, " ");
  console.warn(
    `[optimize] extractDays returned empty. ` +
      `response_chars=${cleaned.length} head="${head}" tail="${tail}"`,
  );
  return [];
}

const VALID_TRAVEL_MODES = [
  "walk",
  "metro",
  "taxi",
  "bus",
  "train",
  "bike",
];

const VALID_KINDS = ["place", "activity", "dining", "custom"];
const VALID_MEALS = ["breakfast", "lunch", "dinner"];

/** Coerce one day into the shape the app expects. */
function normalizeDay(day, index) {
  const items = Array.isArray(day.items) ? day.items : [];
  return {
    day: Number(day.day) || index + 1,
    title: String(day.title || `Day ${index + 1}`),
    items: items.map((it, idx) => {
      // travelFromPrev: only on items past the first of each day; mode is
      // restricted to a known set; duration is free text but trimmed.
      let travelFromPrev = null;
      if (
        idx > 0 &&
        it.travelFromPrev &&
        typeof it.travelFromPrev === "object"
      ) {
        const mode = VALID_TRAVEL_MODES.includes(it.travelFromPrev.mode)
          ? it.travelFromPrev.mode
          : "walk";
        const duration = String(it.travelFromPrev.duration || "").trim();
        if (duration) travelFromPrev = { mode, duration };
      }
      // Lat/lng are optional — if Claude omits or returns garbage,
      // map markers will just skip that pin.
      const latRaw = Number(it.lat);
      const lngRaw = Number(it.lng);
      const lat =
        Number.isFinite(latRaw) && latRaw >= -90 && latRaw <= 90
          ? latRaw
          : null;
      const lng =
        Number.isFinite(lngRaw) && lngRaw >= -180 && lngRaw <= 180
          ? lngRaw
          : null;
      const kind = VALID_KINDS.includes(it.kind) ? it.kind : "place";
      const meal = VALID_MEALS.includes(String(it.meal || "").toLowerCase())
        ? String(it.meal).toLowerCase()
        : null;
      return {
        time: String(it.time || ""),
        kind,
        name: String(it.name || ""),
        area: String(it.area || ""),
        note: String(it.note || ""),
        lat,
        lng,
        meal,
        suggested: Boolean(it.suggested) && kind === "dining",
        custom: Boolean(it.custom) || kind === "custom",
        travelFromPrev,
      };
    }),
  };
}

/** Ask Claude to optimise one destination into a day-by-day plan. */
async function optimizeDestination(destination, customEvents) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set in the backend .env");
  }

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      // Raised from 2500 -> 8000 after a real-device report where a
      // user with 10 places + 10 activities + 9 restaurants (29 items)
      // got an empty schedule. Each item now carries 10+ fields
      // (time, kind, name, area, note, lat, lng, meal, suggested,
      // custom, travelFromPrev), so a 29-item response easily exceeds
      // 2500 tokens and Claude truncates mid-day. 8000 gives ~80
      // items of headroom while still being well under the model's
      // hard cap.
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildPrompt(destination, customEvents) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text =
    data && data.content && data.content[0] ? data.content[0].text : "{}";
  // Defensive cap: never return more days than the caller asked for.
  // Claude occasionally over-produces (e.g. emitting day 3 for a 2-night
  // stay), and the frontend has its own cap, but enforcing it here too
  // keeps the API contract honest.
  const requestedNights = Number(destination.nights) > 0 ? Number(destination.nights) : 1;
  const all = extractDays(text).map(normalizeDay);
  return all.slice(0, requestedNights);
}

module.exports = { optimizeDestination };
