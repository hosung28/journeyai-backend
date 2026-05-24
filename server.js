// override: true makes .env authoritative even when a variable (e.g. an empty
// ANTHROPIC_API_KEY) is already present in the system/shell environment —
// otherwise dotenv silently keeps the pre-existing (empty) value.
require("dotenv").config({ override: true });

const express = require("express");
const cors = require("cors");
const { getTransportOptions } = require("./lib/transport");
const { optimizeDestination } = require("./lib/optimize");
const { recommendForDestination } = require("./lib/recommendations");
const { recommendHotels } = require("./lib/hotels");

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
      "POST /api/hotels",
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
 * body: {
 *   city, nights, travelers, tripPreferences,
 *   alreadyPickedPlaces?, alreadyPickedActivities?, alreadyPickedRestaurants?
 * }
 * -> { places: Place[], activities: Activity[], restaurants: Restaurant[] }
 *
 * Phase 2: single Claude call generates all three categories together so the
 * model can balance recommendations across them (e.g. a dinner spot near a
 * recommended place). `alreadyPicked` (no suffix) is accepted as legacy
 * alias for `alreadyPickedPlaces`.
 */
app.post("/api/recommendations", async (req, res) => {
  const {
    city,
    nights,
    travelers,
    tripPreferences,
    alreadyPicked,
    alreadyPickedPlaces,
    alreadyPickedActivities,
    alreadyPickedRestaurants,
  } = req.body || {};
  if (!city || typeof city !== "string") {
    return res.status(400).json({ error: "'city' (string) is required." });
  }
  if (!tripPreferences || typeof tripPreferences !== "object") {
    return res
      .status(400)
      .json({ error: "'tripPreferences' (object) is required." });
  }
  try {
    const payload = await recommendForDestination({
      city,
      nights: Number(nights) > 0 ? Number(nights) : 1,
      travelers: Number(travelers) > 0 ? Number(travelers) : 1,
      tripPreferences,
      alreadyPicked: Array.isArray(alreadyPicked) ? alreadyPicked : [],
      alreadyPickedPlaces: Array.isArray(alreadyPickedPlaces)
        ? alreadyPickedPlaces
        : [],
      alreadyPickedActivities: Array.isArray(alreadyPickedActivities)
        ? alreadyPickedActivities
        : [],
      alreadyPickedRestaurants: Array.isArray(alreadyPickedRestaurants)
        ? alreadyPickedRestaurants
        : [],
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
 * POST /api/hotels
 * body: {
 *   city, nights, travelers, checkIn?, checkOut?,
 *   hotelPreferences: { stars[], budget, vibes[], mustHaves[], locationPriority },
 *   picks: { places[], activities[], restaurants[] }
 * }
 * -> { hotels: Hotel[] }
 *
 * AI-recommended hotels for a destination, ranked by the user's location
 * priority (transit access / proximity / value) relative to the items they
 * already picked in Explore.
 */
app.post("/api/hotels", async (req, res) => {
  const {
    city,
    nights,
    travelers,
    checkIn,
    checkOut,
    hotelPreferences,
    picks,
  } = req.body || {};
  if (!city || typeof city !== "string") {
    return res.status(400).json({ error: "'city' (string) is required." });
  }
  if (!hotelPreferences || typeof hotelPreferences !== "object") {
    return res
      .status(400)
      .json({ error: "'hotelPreferences' (object) is required." });
  }
  try {
    const payload = await recommendHotels({
      city,
      nights: Number(nights) > 0 ? Number(nights) : 1,
      travelers: Number(travelers) > 0 ? Number(travelers) : 1,
      checkIn: typeof checkIn === "string" ? checkIn : null,
      checkOut: typeof checkOut === "string" ? checkOut : null,
      hotelPreferences,
      picks: picks || {},
    });
    res.json(payload);
  } catch (err) {
    console.error("[/api/hotels] failed:", err);
    res.status(502).json({
      error: "Could not generate hotel recommendations.",
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
  const destination = req.body || {};
  if (!destination.city) {
    return res.status(400).json({ error: "destination 'city' is required." });
  }
  try {
    const days = await optimizeDestination(destination);
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
