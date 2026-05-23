// override: true makes .env authoritative even when a variable (e.g. an empty
// ANTHROPIC_API_KEY) is already present in the system/shell environment —
// otherwise dotenv silently keeps the pre-existing (empty) value.
require("dotenv").config({ override: true });

const express = require("express");
const cors = require("cors");
const { getTransportOptions } = require("./lib/transport");
const { optimizeStay } = require("./lib/optimize");
const { recommendForStay } = require("./lib/recommendations");

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json({ limit: "256kb" }));

// Lightweight request log.
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.path}`);
  next();
});

app.get("/", (_req, res) => {
  res.json({
    service: "journeyai-backend",
    endpoints: [
      "GET /health",
      "POST /api/transport",
      "POST /api/recommendations",
      "POST /api/optimize",
    ],
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    aeroapi: Boolean(process.env.AEROAPI_KEY),
  });
});

/**
 * POST /api/transport
 * body: { from: City, to: City, departureDate?: "YYYY-MM-DD", adults?: number }
 * -> { options: TransportOption[] }
 */
app.post("/api/transport", async (req, res) => {
  const { from, to, departureDate, adults } = req.body || {};
  if (!from || !to || !from.name || !to.name) {
    return res
      .status(400)
      .json({ error: "Both 'from' and 'to' cities are required." });
  }
  try {
    const options = await getTransportOptions({
      from,
      to,
      departureDate: typeof departureDate === "string" ? departureDate : null,
      adults: Number(adults) > 0 ? Number(adults) : 1,
    });
    res.json({ options });
  } catch (err) {
    console.error("[/api/transport] failed:", err);
    res.status(502).json({
      error: "Could not load transport options.",
      detail: String(err && err.message ? err.message : err),
    });
  }
});

/**
 * POST /api/recommendations
 * body: { city, nights, travelers, tripPreferences, alreadyPicked? }
 * -> { places: Place[] }   (Phase 1 — activities/restaurants land in Phase 2)
 */
app.post("/api/recommendations", async (req, res) => {
  const { city, nights, travelers, tripPreferences, alreadyPicked } =
    req.body || {};
  if (!city || typeof city !== "string") {
    return res.status(400).json({ error: "'city' (string) is required." });
  }
  if (!tripPreferences || typeof tripPreferences !== "object") {
    return res
      .status(400)
      .json({ error: "'tripPreferences' (object) is required." });
  }
  try {
    const payload = await recommendForStay({
      city,
      nights: Number(nights) > 0 ? Number(nights) : 1,
      travelers: Number(travelers) > 0 ? Number(travelers) : 1,
      tripPreferences,
      alreadyPicked: Array.isArray(alreadyPicked) ? alreadyPicked : [],
    });
    res.json(payload);
  } catch (err) {
    console.error("[/api/recommendations] failed:", err);
    res.status(502).json({
      error: "Could not generate recommendations.",
      detail: String(err && err.message ? err.message : err),
    });
  }
});

/**
 * POST /api/optimize
 * body: { city, nights, hotel, places[], activities[], restaurants[] }
 * -> { days: OptimizedDay[] }
 */
app.post("/api/optimize", async (req, res) => {
  const stay = req.body || {};
  if (!stay.city) {
    return res.status(400).json({ error: "stay 'city' is required." });
  }
  try {
    const days = await optimizeStay(stay);
    res.json({ days });
  } catch (err) {
    console.error("[/api/optimize] failed:", err);
    res.status(502).json({
      error: "Could not optimize the itinerary.",
      detail: String(err && err.message ? err.message : err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`\nJourneyAI backend listening on http://0.0.0.0:${PORT}`);
  console.log(
    `  Claude key:  ${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING — transport will fail"}`,
  );
  console.log(
    `  AeroAPI key: ${
      process.env.AEROAPI_KEY
        ? "set — flights use real airline schedules (FlightAware)"
        : "missing — flights use Claude estimates"
    }`,
  );
  console.log(`  Health check: http://localhost:${PORT}/health\n`);
});
