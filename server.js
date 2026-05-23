// override: true makes .env authoritative even when a variable (e.g. an empty
// ANTHROPIC_API_KEY) is already present in the system/shell environment —
// otherwise dotenv silently keeps the pre-existing (empty) value.
require("dotenv").config({ override: true });

const express = require("express");
const cors = require("cors");
const { getTransportOptions } = require("./lib/transport");
const { optimizeStay } = require("./lib/optimize");

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
    endpoints: ["GET /health", "POST /api/transport"],
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    flightapi: Boolean(process.env.FLIGHTAPI_KEY),
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
    `  FlightAPI key: ${
      process.env.FLIGHTAPI_KEY
        ? "set — flights use live schedules + fares"
        : "missing — flights use Claude estimates"
    }`,
  );
  console.log(`  Health check: http://localhost:${PORT}/health\n`);
});
