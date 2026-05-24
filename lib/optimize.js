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
  const arrivalLine = destination.arrivalTime
    ? `\nDay 1 ARRIVAL: traveller lands at ${destination.arrivalTime}. Do NOT schedule anything before then; first activity should be at least 60 minutes after arrival to allow check-in.`
    : "";
  const departureLine = destination.departureTime
    ? `\nLast day DEPARTURE: traveller leaves at ${destination.departureTime}. Do NOT schedule anything within 3 hours of that time.`
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

  return `Plan a day-by-day itinerary for a ${nights}-night destination in ${destination.city}.
Hotel base: ${destination.hotel || "city centre"}.${arrivalLine}${departureLine}${mealLine}${customLine}
Places to visit: ${list(destination.places, (p) => `${p.name} (${p.area || "?"}, ${p.type || "sight"})`)}.
Activities booked: ${list(destination.activities, (a) => `${a.name} (${a.area || "?"}, ${a.type || "activity"})`)}.
Restaurants chosen: ${list(destination.restaurants, (r) => `${r.name} (${r.area || "?"}, ${r.meal || "meal"})`)}.

Build an optimised schedule that:
- Spreads everything across ${nights} day(s); at most 5 stops per day (suggested meals + custom events count toward this).
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

/** Pull the days array out of a model response, tolerating fences / stray prose. */
function extractDays(text) {
  const cleaned = String(text || "")
    .replace(/```json|```/g, "")
    .trim();
  for (const candidate of [
    cleaned,
    cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1),
  ]) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && Array.isArray(obj.days)) return obj.days;
    } catch {
      /* try next */
    }
  }
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
      max_tokens: 2500,
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
  return extractDays(text).map(normalizeDay);
}

module.exports = { optimizeDestination };
