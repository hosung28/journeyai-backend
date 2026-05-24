/**
 * AI-powered worldwide city search.
 *
 * Returns 6-10 travel destinations matching a user query, each shaped
 * to the frontend's `City` interface (minus the `id`, which the
 * frontend assigns from `AI_CITY_ID_BASE` after the response).
 *
 * Previously this call was made client-direct from the mobile app
 * (src/hooks/useCitySearch.ts), but the Anthropic key must never ship
 * in the APK. Moved to the backend proxy in Batch IV.3.
 */
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT =
  "You are a travel destination API. Reply with ONLY a JSON array — no prose, no markdown fences.";

function buildPrompt(query) {
  return `The user typed "${query}".
Return ONLY a valid JSON array (no markdown, no explanation) of matching travel destinations.
Each object must have exactly these keys:
  name (city name), country (country name), code (IATA airport code, 3 uppercase letters),
  flag (country flag emoji), em (one landmark or nature emoji), desc (description, max 7 words)
Return 6-10 results, most relevant first. Cover cities, regions, and travel themes if applicable.`;
}

/** Pull a JSON array out of a model response, tolerating fences. */
function extractArray(text) {
  const cleaned = String(text || "")
    .replace(/```json|```/g, "")
    .trim();
  for (const candidate of [
    cleaned,
    cleaned.slice(cleaned.indexOf("["), cleaned.lastIndexOf("]") + 1),
  ]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try next */
    }
  }
  return [];
}

/** Normalize one Claude city row into the City shape (without id). */
function normalize(row) {
  return {
    name: String(row.name || "").trim(),
    country: String(row.country || "").trim(),
    code: String(row.code || "")
      .trim()
      .toUpperCase()
      .slice(0, 3),
    flag: String(row.flag || "🌍").trim(),
    em: String(row.em || "📍").trim(),
    desc: String(row.desc || "").trim(),
  };
}

/**
 * Search for cities matching a free-text query.
 * Returns an array of city rows (no `id` — the frontend assigns it
 * from AI_CITY_ID_BASE so static + AI IDs never collide).
 */
async function searchCities(query) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set in the backend .env");
  }
  const cleanQuery = String(query || "").trim();
  if (cleanQuery.length < 2) return [];

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(cleanQuery) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text =
    data && data.content && data.content[0] ? data.content[0].text : "[]";
  return extractArray(text)
    .map(normalize)
    .filter((c) => c.name && c.code.length === 3);
}

module.exports = { searchCities };
