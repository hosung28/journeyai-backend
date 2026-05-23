# JourneyAI Backend

A small proxy server for the JourneyAI app. It keeps API keys off the device and
returns real transport data:

- **Claude** — discovers every realistic transport mode for a city pair
  (flight, train, ferry, bus, drive, walk) and AI-optimizes day-by-day plans.
- **FlightAware AeroAPI** — replaces estimated flight legs with real airline
  schedule data (real flight numbers, real airlines, airport-local
  departure/arrival times, cargo flights filtered, codeshares dedup'd).
  Each real-flight card carries a `bookingUrl` deep-link to Google Flights;
  JourneyAI is a planning tool, not a booking tool, so the user does the
  actual booking on Google Flights.

## Setup

```bash
cd journeyai-backend
npm install
# copy .env.example to .env, then edit .env with your keys
npm start
```

### Keys

| Variable | Required? | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | https://console.anthropic.com -> API Keys |
| `AEROAPI_KEY` | Optional | https://www.flightaware.com/commercial/aeroapi -> subscribe ($5/mo complimentary credit; set a monthly cap to never exceed $5) |

With only the Anthropic key, the Transport screen still works fully — flight
times and operators are Claude estimates. Add `AEROAPI_KEY` and flight legs
switch to real airline schedules: real airline names, real flight numbers,
airport-local times, dedup'd codeshares, cargo filtered. Prices stay as
estimates (AeroAPI's schedule endpoint doesn't include fares) — booking
deep-links out to Google Flights.

## Endpoints

- `GET /health` — reports which keys are configured.
- `POST /api/transport` — body `{ from, to, departureDate, adults }`,
  returns `{ options: TransportOption[] }`. When AeroAPI is configured,
  the single Claude "Flight" entry is replaced with up to 6 real flight
  cards (nonstops only — AeroAPI's `/schedules` endpoint), each carrying
  schedule fields the day optimizer uses and a `bookingUrl` deep-link.
- `POST /api/optimize` — body `{ city, nights, hotel, arrivalTime,
  departureTime, places, activities, restaurants }`, returns
  `{ days: OptimizedDay[] }`. The optimizer respects arrival/departure
  anchors when surrounding legs have real schedule data.

## Connecting the app

The app reads the backend URL from `EXPO_PUBLIC_API_URL` (in the app's `.env`).
For device testing, set it to this PC's LAN IP — e.g. `http://192.168.1.41:4000` —
and keep the phone on the same Wi-Fi. Restart `expo start` after changing it.

## Notes

- **Why AeroAPI and not Amadeus / FlightAPI / Skyscanner:**
  - Amadeus Self-Service shuts down 2026-07-17 — dead end.
  - FlightAPI.io's free tier (20 calls total) had thin route inventory and
    consistent gaps on common nonstops (LAX→NRT showed only 1-stops; SAN→NRT
    returned HTTP 400).
  - Skyscanner and Google Flights are partner-only / discontinued for
    self-serve developers.
  - AeroAPI is self-serve, OAG-grade schedule coverage, no sunset.
- **Budget is bounded.** The complimentary credit is $5/month; set a hard
  monthly cap in the FlightAware portal so spend can't exceed $5 even if a
  client bug spams the endpoint. The orchestrator's 30-min cache stretches
  the budget further.
- **Schedule-only, no fares.** AeroAPI's `/schedules` endpoint doesn't include
  prices. Real-flight cards show "Est." with a tap-out to Google Flights —
  matching the "planning tool not booking tool" positioning.
- **Nonstops only.** `/schedules` returns single-segment flights. For
  multi-segment connections users click out to Google Flights via the
  per-card booking link.
- **Soft failure.** If AeroAPI is unreachable, returns no data, or sees an
  unmapped IATA code, the backend silently falls back to Claude estimates —
  the Transport screen never breaks.
- **Airport coverage.** `lib/aeroapi.js` carries an IATA→ICAO+timezone map
  for every city in the app's `src/data/cities.ts`. Adding cities requires
  adding to that map (or accepting Claude-estimate fallback).

## Deploying to Render

The backend must run in the cloud for a standalone app demo (no laptop). Render
has a free tier and needs no credit card.

1. **Push this folder to a GitHub repo:**
   ```bash
   cd journeyai-backend
   git remote add origin https://github.com/<you>/journeyai-backend.git
   git push -u origin main
   ```
   (The repo is already initialised with an initial commit. `.env` is gitignored,
   so your keys are never committed.)

2. **Render dashboard → New → Blueprint** → connect the repo. Render reads
   `render.yaml` automatically. (Or use **New → Web Service** and set build
   `npm install`, start `npm start`, health check `/health`, plan Free.)

3. **Environment tab → add your keys:**
   - `ANTHROPIC_API_KEY` — required
   - `AEROAPI_KEY` — optional (real airline schedules)
   - Do **not** set `PORT` — Render provides it.

4. **Deploy.** You get a URL like `https://journeyai-backend.onrender.com`.
   Verify `https://<url>/health` → `{"ok":true,"claude":true,"aeroapi":true}`.

5. Put that URL in the app's `EXPO_PUBLIC_API_URL`, then build the standalone app.

**Free-tier note:** the service sleeps after ~15 min idle (~30 s cold start on the
next request). Open the `/health` URL a minute before a demo to wake it, or
upgrade to the $7/mo Starter plan for always-on.

### Scaling later
Free → Starter ($7/mo, always-on) → Standard ($25/mo, more RAM/CPU) → Pro
(autoscaling). Prototype through substantial production load — plan changes only,
no migration.
