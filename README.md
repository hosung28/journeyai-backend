# JourneyAI Backend

A small proxy server for the JourneyAI app. It keeps API keys off the device and
returns real transport data:

- **Claude** — discovers every realistic transport mode for a city pair
  (flight, train, ferry, bus, drive, walk).
- **Amadeus** — replaces flight legs with real, live fares (free sandbox).

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
| `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET` | Optional | https://developers.amadeus.com -> create a Self-Service app (free, instant) |

With only the Anthropic key, the transport screen works fully — flight prices are
Claude estimates. Add the Amadeus keys and flight legs switch to real live fares.

## Endpoints

- `GET /health` — reports which keys are configured.
- `POST /api/transport` — body `{ from, to, departureDate, adults }`,
  returns `{ options: TransportOption[] }`.

## Connecting the app

The app reads the backend URL from `EXPO_PUBLIC_API_URL` (in the app's `.env`).
For device testing, set it to this PC's LAN IP — e.g. `http://192.168.1.41:4000` —
and keep the phone on the same Wi-Fi. Restart `expo start` after changing it.

## Notes

- The Amadeus **test** environment is a realistic but limited dataset. If it has
  no data for a given route/date, that flight gracefully falls back to Claude's
  estimate — the screen never breaks.
- Train / ferry / bus prices are always Claude estimates: no free real-data API
  covers them (see CLAUDE.md).

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
   - `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET` — optional (real flight fares)
   - Do **not** set `PORT` — Render provides it.

4. **Deploy.** You get a URL like `https://journeyai-backend.onrender.com`.
   Verify `https://<url>/health` → `{"ok":true,"claude":true,...}`.

5. Put that URL in the app's `EXPO_PUBLIC_API_URL`, then build the standalone app.

**Free-tier note:** the service sleeps after ~15 min idle (~30 s cold start on the
next request). Open the `/health` URL a minute before a demo to wake it, or
upgrade to the $7/mo Starter plan for always-on.

### Scaling later
Free → Starter ($7/mo, always-on) → Standard ($25/mo, more RAM/CPU) → Pro
(autoscaling). Prototype through substantial production load — plan changes only,
no migration.
