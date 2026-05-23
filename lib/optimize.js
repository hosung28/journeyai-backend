/**
 * Claude-powered day-route optimizer.
 *
 * Takes one stay's chosen places / activities / restaurants and returns a
 * day-by-day schedule that groups nearby stops, puts meals at the right time,
 * and caps each day at a sane number of stops.
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

function buildPrompt(stay) {
  const nights = Number(stay.nights) > 0 ? Number(stay.nights) : 1;
  const arrivalLine = stay.arrivalTime
    ? `\nDay 1 ARRIVAL: traveller lands at ${stay.arrivalTime}. Do NOT schedule anything before then; first activity should be at least 60 minutes after arrival to allow check-in.`
    : "";
  const departureLine = stay.departureTime
    ? `\nLast day DEPARTURE: traveller leaves at ${stay.departureTime}. Do NOT schedule anything within 3 hours of that time.`
    : "";
  return `Plan a day-by-day itinerary for a ${nights}-night stay in ${stay.city}.
Hotel base: ${stay.hotel || "city centre"}.${arrivalLine}${departureLine}
Places to visit: ${list(stay.places, (p) => `${p.name} (${p.area || "?"}, ${p.type || "sight"})`)}.
Activities booked: ${list(stay.activities, (a) => `${a.name} (${a.area || "?"}, ${a.type || "activity"})`)}.
Restaurants chosen: ${list(stay.restaurants, (r) => `${r.name} (${r.area || "?"}, ${r.meal || "meal"})`)}.

Build an optimised schedule that:
- Spreads everything across ${nights} day(s); at most 4 stops per day.
- Groups stops in the same or nearby area on the same day to minimise travel.
- Places each restaurant at its correct meal time (breakfast / lunch / dinner).
- Orders each day naturally: morning sights -> lunch -> afternoon -> dinner.
- Respects the ARRIVAL and DEPARTURE constraints above when given.
- Every chosen place, activity and restaurant appears exactly once.

Return ONLY this JSON shape:
{"days":[{"day":1,"title":"short theme, max 5 words","items":[{"time":"9:00 AM","kind":"place|activity|dining","name":"...","area":"...","note":"short tip, max 10 words"}]}]}`;
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

/** Coerce one day into the shape the app expects. */
function normalizeDay(day, index) {
  const items = Array.isArray(day.items) ? day.items : [];
  return {
    day: Number(day.day) || index + 1,
    title: String(day.title || `Day ${index + 1}`),
    items: items.map((it) => ({
      time: String(it.time || ""),
      kind: ["place", "activity", "dining"].includes(it.kind)
        ? it.kind
        : "place",
      name: String(it.name || ""),
      area: String(it.area || ""),
      note: String(it.note || ""),
    })),
  };
}

/** Ask Claude to optimise one stay into a day-by-day plan. */
async function optimizeStay(stay) {
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
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(stay) }],
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

module.exports = { optimizeStay };
