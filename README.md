# JourneyAI Backend

A small proxy server for the JourneyAI app. It keeps API keys off the device and
returns real transport data:

- **Claude** — discovers every realistic transport mode for a city pair
  (flight, train, ferry, bus, drive, walk) and AI-optimizes day-by-day plans.
- **FlightAPI.io** — replaces estimated flight legs with real flight offers
  (departure/arrival times, flight numbers, airlines, fares).

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
| `FLIGHTAPI_KEY` | Optional | https://www.flightapi.io -> sign up (20 free calls, then $49/mo) |

With only the Anthropic key, the Transport screen still works fully — flight
times and prices are Claude estimates. Add `FLIGHTAPI_KEY` and flight legs
switch to real, live data: real airline names, departure/arrival times, flight
numbers, and fares.

## Endpoints

- `GET /health` — reports which keys are configured.
- `POST /api/transport` — body `{ from, to, departureDate, adults }`,
  returns `{ options: TransportOption[] }`. When FlightAPI is configured,
  the single Claude "Flight" entry is replaced with multiple real flight
  offers (up to 5), each carrying schedule fields the app uses to plan
  arrival-day and departure-day activities.
- `POST /api/optimize` — body `{ city, nights, hotel, places, activities,
  restaurants }`, returns `{ days: OptimizedDay[] }`.

## Connecting the app

The app reads the backend URL from `EXPO_PUBLIC_API_URL` (in the app's `.env`).
For device testing, set it to this PC's LAN IP — e.g. `http://192.168.1.41:4000` —
and keep the phone on the same Wi-Fi. Restart `expo start` after changing it.

## Notes

- **Why we switched off Amadeus:** Amadeus announced the shutdown of its
  Self-Service developer portal on **2026-07-17**. Investing in it now is a
  dead end. FlightAPI.io is self-serve, has no sunset date, and covers 700+
  airlines.
- **Free tier is small.** FlightAPI's free tier is 20 calls total (not per
  month). Plenty to verify the integration; budget for $49/mo if you keep
  using it in beta. Each transport lookup uses 1 oneway-search call = 2 credits.
- **Soft failure.** If FlightAPI is unreachable or has no data for a route, the
  backend silently falls back to Claude estimates — the screen never breaks.
- **Train / ferry / bus prices are always Claude estimates.** No self-serve
  real-data API covers them (see CLAUDE.md).

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
   - `FLIGHTAPI_KEY` — optional (real flight schedules + fares)
   - Do **not** set `PORT` — Render provides it.

4. **Deploy.** You get a URL like `https://journeyai-backend.onrender.com`.
   Verify `https://<url>/health` → `{"ok":true,"claude":true,"flightapi":true}`.

5. Put that URL in the app's `EXPO_PUBLIC_API_URL`, then build the standalone app.

**Free-tier note:** the service sleeps after ~15 min idle (~30 s cold start on the
next request). Open the `/health` URL a minute before a demo to wake it, or
upgrade to the $7/mo Starter plan for always-on.

### Scaling later
Free → Starter ($7/mo, always-on) → Standard ($25/mo, more RAM/CPU) → Pro
(autoscaling). Prototype through substantial production load — plan changes only,
no migration.
