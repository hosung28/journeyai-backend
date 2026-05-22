/**
 * Claude transport-mode discovery.
 *
 * Returns every realistic transport mode for a city pair (flight, train,
 * ferry, bus, drive, walk). Prices and durations here are Claude's estimates;
 * flight legs are replaced with real Amadeus data downstream (see transport.js).
 */
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT =
  "You are a transport-routing API. Reply with ONLY a JSON array — no prose, no markdown fences.";

function buildPrompt(from, to) {
  return `List every realistic transport option between ${from.name}, ${from.country} and ${to.name}, ${to.country}.
Each array item must be an object with exactly these keys:
  id (string), icon (single emoji), mode (one of "Flight","Train","Ferry","Bus","Drive","Walk"),
  operator (real company name or "Various"), duration (e.g. "1h 30m" or "25 min"),
  priceFrom (USD number per person, 0 if free), priceLabel (e.g. "From $89/pp" or "Free"),
  frequency (e.g. "Multiple daily" or "2x weekly"), notes (useful tip, max 8 words, or ""),
  recommended (boolean — true for the single best overall option),
  available (boolean — false if this mode genuinely cannot serve this route).
Include ALL plausible modes. Put the recommended option first.`;
}

/** Pull a JSON array out of a model response, tolerating fences or stray prose. */
function extractJsonArray(text) {
  const cleaned = String(text || "")
    .replace(/```json|```/g, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through to bracket extraction */
  }
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* give up */
    }
  }
  return [];
}

/** Ask Claude for all transport modes between two cities. */
async function getTransportModes(from, to) {
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
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(from, to) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text =
    data && data.content && data.content[0] ? data.content[0].text : "[]";
  return extractJsonArray(text);
}

module.exports = { getTransportModes };
