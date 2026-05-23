/**
 * FlightAware AeroAPI — real airline schedule data for a city pair.
 *
 * Replaces lib/flightapi.js. We deliberately give up real fares (AeroAPI's
 * schedule endpoint doesn't include pricing — and the app is a planning tool,
 * not a booking tool, so prices are estimates anyway) in exchange for the
 * deep, OAG-grade route coverage we couldn't get from FlightAPI.io's free tier.
 *
 * Endpoint:
 *   GET /schedules/{date_start}/{date_end}?origin={ICAO}&destination={ICAO}
 *   auth header: x-apikey
 *
 * Returns [] (not throws) on any soft failure so transport.js falls back to
 * Claude estimates and the screen never breaks.
 */
const API_BASE = "https://aeroapi.flightaware.com/aeroapi";
const REQUEST_TIMEOUT_MS = 15_000;
/** How many real flight offers to surface per leg. */
const MAX_OFFERS = 6;

/**
 * IATA -> ICAO airport mapping and timezone (IANA) per airport.
 *
 * Covers every city in journeyai/src/data/cities.ts plus the default home
 * base (SAN). When the user adds a custom city via AI search with an
 * unmapped IATA we silently skip the AeroAPI call and the backend falls
 * back to Claude estimates.
 */
const AIRPORTS = {
  // ── USA ──
  SAN: { icao: "KSAN", tz: "America/Los_Angeles" },
  LAX: { icao: "KLAX", tz: "America/Los_Angeles" },
  JFK: { icao: "KJFK", tz: "America/New_York" },
  MIA: { icao: "KMIA", tz: "America/New_York" },
  LAS: { icao: "KLAS", tz: "America/Los_Angeles" },
  ORD: { icao: "KORD", tz: "America/Chicago" },

  // ── Asia / Pacific ──
  NRT: { icao: "RJAA", tz: "Asia/Tokyo" },
  KIX: { icao: "RJBB", tz: "Asia/Tokyo" },
  ICN: { icao: "RKSI", tz: "Asia/Seoul" },
  BKK: { icao: "VTBS", tz: "Asia/Bangkok" },
  HKT: { icao: "VTSP", tz: "Asia/Bangkok" },
  DPS: { icao: "WADD", tz: "Asia/Makassar" },
  SIN: { icao: "WSSS", tz: "Asia/Singapore" },
  HKG: { icao: "VHHH", tz: "Asia/Hong_Kong" },
  TPE: { icao: "RCTP", tz: "Asia/Taipei" },
  SGN: { icao: "VVTS", tz: "Asia/Ho_Chi_Minh" },
  HAN: { icao: "VVNB", tz: "Asia/Ho_Chi_Minh" },
  KUL: { icao: "WMKK", tz: "Asia/Kuala_Lumpur" },
  MLE: { icao: "VRMM", tz: "Indian/Maldives" },

  // ── Middle East ──
  DXB: { icao: "OMDB", tz: "Asia/Dubai" },
  AUH: { icao: "OMAA", tz: "Asia/Dubai" },
  DOH: { icao: "OTHH", tz: "Asia/Qatar" },
  IST: { icao: "LTFM", tz: "Europe/Istanbul" },

  // ── Europe ──
  CDG: { icao: "LFPG", tz: "Europe/Paris" },
  FCO: { icao: "LIRF", tz: "Europe/Rome" },
  BCN: { icao: "LEBL", tz: "Europe/Madrid" },
  MAD: { icao: "LEMD", tz: "Europe/Madrid" },
  LHR: { icao: "EGLL", tz: "Europe/London" },
  AMS: { icao: "EHAM", tz: "Europe/Amsterdam" },
  BER: { icao: "EDDB", tz: "Europe/Berlin" },
  PRG: { icao: "LKPR", tz: "Europe/Prague" },
  VIE: { icao: "LOWW", tz: "Europe/Vienna" },
  LIS: { icao: "LPPT", tz: "Europe/Lisbon" },
  OPO: { icao: "LPPR", tz: "Europe/Lisbon" },
  ATH: { icao: "LGAV", tz: "Europe/Athens" },
  JTR: { icao: "LGSR", tz: "Europe/Athens" },
  JMK: { icao: "LGMK", tz: "Europe/Athens" },
  DUB: { icao: "EIDW", tz: "Europe/Dublin" },
  CPH: { icao: "EKCH", tz: "Europe/Copenhagen" },
  ARN: { icao: "ESSA", tz: "Europe/Stockholm" },
  ZRH: { icao: "LSZH", tz: "Europe/Zurich" },
  FLR: { icao: "LIRQ", tz: "Europe/Rome" },
  VCE: { icao: "LIPZ", tz: "Europe/Rome" },
  EDI: { icao: "EGPH", tz: "Europe/London" },
  BUD: { icao: "LHBP", tz: "Europe/Budapest" },

  // ── Americas (non-US) ──
  CUN: { icao: "MMUN", tz: "America/Cancun" },
  MEX: { icao: "MMMX", tz: "America/Mexico_City" },
  EZE: { icao: "SAEZ", tz: "America/Argentina/Buenos_Aires" },
  GIG: { icao: "SBGL", tz: "America/Sao_Paulo" },
  CTG: { icao: "SKCG", tz: "America/Bogota" },

  // ── Africa / Oceania ──
  CPT: { icao: "FACT", tz: "Africa/Johannesburg" },
  RAK: { icao: "GMMX", tz: "Africa/Casablanca" },
  NBO: { icao: "HKJK", tz: "Africa/Nairobi" },
  SYD: { icao: "YSSY", tz: "Australia/Sydney" },
  MEL: { icao: "YMML", tz: "Australia/Melbourne" },
  AKL: { icao: "NZAA", tz: "Pacific/Auckland" },
};

/**
 * ICAO airline code -> display name. Covers carriers commonly seen on the
 * routes our cities serve. Unknown codes fall back to the ICAO code itself.
 */
const AIRLINE_NAMES = {
  // ── USA ──
  AAL: "American Airlines",
  DAL: "Delta",
  UAL: "United Airlines",
  SWA: "Southwest",
  JBU: "JetBlue",
  ASA: "Alaska Airlines",
  HAL: "Hawaiian Airlines",
  // ── Japan ──
  ANA: "ANA (All Nippon Airways)",
  JAL: "Japan Airlines",
  APJ: "Peach Aviation",
  TZP: "ZIPAIR Tokyo",
  // ── Korea ──
  KAL: "Korean Air",
  AAR: "Asiana Airlines",
  // ── Greater China ──
  CCA: "Air China",
  CES: "China Eastern",
  CSN: "China Southern",
  CXA: "Xiamen Airlines",
  CAL: "China Airlines",
  EVA: "EVA Air",
  CPA: "Cathay Pacific",
  // ── SE Asia ──
  SIA: "Singapore Airlines",
  THA: "Thai Airways",
  PAL: "Philippine Airlines",
  MAS: "Malaysia Airlines",
  GIA: "Garuda Indonesia",
  HVN: "Vietnam Airlines",
  // ── Middle East ──
  UAE: "Emirates",
  ETD: "Etihad",
  QTR: "Qatar Airways",
  THY: "Turkish Airlines",
  // ── Europe ──
  BAW: "British Airways",
  DLH: "Lufthansa",
  AFR: "Air France",
  KLM: "KLM",
  SAS: "SAS",
  IBE: "Iberia",
  VLG: "Vueling",
  RYR: "Ryanair",
  EZY: "easyJet",
  AUA: "Austrian",
  SWR: "Swiss",
  TAP: "TAP Air Portugal",
  // ── Americas ──
  AMX: "Aeromexico",
  ARG: "Aerolíneas Argentinas",
  LAN: "LATAM",
  AVA: "Avianca",
  ACA: "Air Canada",
  // ── Oceania ──
  QFA: "Qantas",
  ANZ: "Air New Zealand",
  VOZ: "Virgin Australia",
};

/**
 * ICAO codes for cargo / charter carriers we should filter out — the
 * /schedules endpoint mixes these with passenger flights and they're
 * useless for a travel planner.
 */
const CARGO_CARRIERS = new Set([
  "NCA", // Nippon Cargo Airlines
  "GTI", // Atlas Air (charter/cargo)
  "FDX", // FedEx Express
  "UPS", // UPS Airlines
  "CKK", // China Cargo Airlines
  "CLX", // Cargolux
  "ABW", // AirBridgeCargo
  "PAC", // Polar Air Cargo
  "GEC", // Lufthansa Cargo
  "ATN", // Air Transport International
  "ABX", // ABX Air
  "DAE", // DHL Aero Expreso
  "SQC", // Singapore Airlines Cargo
  "KAE", // Kalitta Air
  "WGN", // Western Global
  "AAF", // Aigle Azur Cargo
  "MAA", // MasAir
  "CSV", // China Cargo
]);

/* ─────────────────────── Helpers ─────────────────────── */

const isIata = (code) => typeof code === "string" && /^[A-Z]{3}$/.test(code);

/** Return "HH:MM" in the given IANA timezone for an ISO UTC timestamp. */
function localTimeAt(iso, ianaTz) {
  if (!iso) return "";
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: ianaTz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return fmt.format(new Date(iso));
  } catch {
    return "";
  }
}

/** Calendar-day offset (in the relevant TZs) between dep and arr. */
function dayOffset(depIso, depTz, arrIso, arrTz) {
  if (!depIso || !arrIso) return 0;
  try {
    const fmt = (iso, tz) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(iso));
    const dep = fmt(depIso, depTz);
    const arr = fmt(arrIso, arrTz);
    const diff = (new Date(`${arr}T00:00:00Z`) - new Date(`${dep}T00:00:00Z`)) / 86_400_000;
    return Math.max(0, Math.round(diff));
  } catch {
    return 0;
  }
}

/** Minutes between two ISO timestamps (TZ-independent). */
function durationMinutes(depIso, arrIso) {
  const dep = new Date(depIso);
  const arr = new Date(arrIso);
  if (Number.isNaN(+dep) || Number.isNaN(+arr)) return 0;
  return Math.max(0, Math.round((arr - dep) / 60_000));
}

/** "11h 30m" / "55m". */
function minutesToDuration(mins) {
  const n = Number(mins) || 0;
  const h = Math.floor(n / 60);
  const r = n % 60;
  if (h <= 0) return `${r}m`;
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
}

/**
 * Parse an ICAO flight ident like "ANA5", "UAL32" or "TZP23" into
 * {airlineCode, flightNumber}. Returns empty fields when unparseable.
 */
function parseIdent(ident) {
  const m = /^([A-Z]{2,3})(\d+[A-Z]?)$/.exec(String(ident || ""));
  return m ? { airlineCode: m[1], flightNumber: m[2] } : { airlineCode: "", flightNumber: ident || "" };
}

/** YYYY-MM-DD + N days -> YYYY-MM-DD. */
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Quality score (lower = better). Matches lib/transport.js pickRecommended.
 *
 *   stops:       $300 per stop
 *   long-haul:   $30 per hour beyond 12h
 *   tie-break:   $1 per minute of total flight time
 *
 * For nonstops under 12h (e.g. multiple LAX->NRT options at 11h15m–11h50m),
 * the first two terms collapse to 0 and the minute-level tie-break picks
 * the shorter flight — preferring ANA's 11h15m over ZIPAIR's 11h45m even
 * when both are technically "under 12h." For longer or stop-laden flights
 * the other terms dominate.
 */
function scoreOffer(stops, durationMin) {
  const hours = (Number(durationMin) || 0) / 60;
  const mins = Number(durationMin) || 0;
  return (Number(stops) || 0) * 300 + Math.max(0, hours - 12) * 30 + mins;
}

/* ─────────────────────── Main ─────────────────────── */

/**
 * Real flight schedules for the route. Empty array = soft failure (no key,
 * unknown airport, upstream error, or no data) — the caller falls back to
 * Claude estimates.
 *
 * Note: AeroAPI's /schedules endpoint returns single-segment scheduled
 * flights only. Every result is a NONSTOP. Multi-stop connections are a
 * separate (more complex) lookup not supported here — for those the user
 * should search Google Flights via the booking link.
 */
async function getRealSchedules(fromCode, toCode, departureDate /*, adults */) {
  const key = process.env.AEROAPI_KEY;
  if (!key) return [];
  if (!isIata(fromCode) || !isIata(toCode) || !departureDate) return [];

  const from = AIRPORTS[fromCode];
  const to = AIRPORTS[toCode];
  if (!from || !to) {
    console.warn(
      `[aeroapi] unmapped airport: ${fromCode}->${toCode} (need ICAO+tz)`,
    );
    return [];
  }

  // Query a 24-hour window to catch late-day departures whose UTC
  // timestamp lands in the next calendar date.
  const dateStart = departureDate;
  const dateEnd = addDays(departureDate, 1);
  const url =
    `${API_BASE}/schedules/${dateStart}/${dateEnd}` +
    `?origin=${from.icao}&destination=${to.icao}&max_pages=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(url, {
      headers: { "x-apikey": key },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[aeroapi] HTTP ${res.status} for ${fromCode}->${toCode} ${departureDate}`,
      );
      return [];
    }
    data = await res.json();
  } catch (err) {
    console.warn("[aeroapi] fetch failed:", err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }

  const scheduled = Array.isArray(data?.scheduled) ? data.scheduled : [];
  if (scheduled.length === 0) return [];

  const offers = [];
  // Dedupe codeshares: same scheduled_out at same origin/dest is one
  // physical flight, even if it shows up under multiple idents.
  const seen = new Set();

  for (const s of scheduled) {
    const icaoIdent = s.ident_icao || s.ident || "";
    const { airlineCode } = parseIdent(icaoIdent);
    if (CARGO_CARRIERS.has(airlineCode)) continue;

    const dedupeKey = s.scheduled_out;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const departureTime = localTimeAt(s.scheduled_out, from.tz);
    const arrivalTime = localTimeAt(s.scheduled_in, to.tz);
    if (!departureTime || !arrivalTime) continue;

    const durationMin = durationMinutes(s.scheduled_out, s.scheduled_in);
    const arrivalDayOffset = dayOffset(s.scheduled_out, from.tz, s.scheduled_in, to.tz);

    // Prefer IATA ident for display (e.g. "NH5" vs "ANA5") since travelers
    // recognize IATA codes on boarding passes / Google Flights.
    const flightNumber = s.ident_iata || icaoIdent;
    const operator = AIRLINE_NAMES[airlineCode] || airlineCode || "Airline";

    offers.push({
      id: `flight-real-${offers.length}`,
      operator,
      flightNumber,
      duration: minutesToDuration(durationMin),
      durationMin,
      stops: 0, // /schedules only returns nonstop segments
      departureTime,
      arrivalTime,
      arrivalDayOffset,
      priceFrom: 0, // unknown — UI labels this as an estimate
      priceLabel: "", // app renders "Est." caption when this is empty
      notes: "Nonstop · real schedule",
      _score: scoreOffer(0, durationMin),
    });
  }

  if (offers.length === 0) return [];

  // Best-first: by score (duration) then by departure time as tiebreak.
  offers.sort((a, b) => {
    if (a._score !== b._score) return a._score - b._score;
    return a.departureTime.localeCompare(b.departureTime);
  });

  return offers.slice(0, MAX_OFFERS).map((o, i) => {
    const { _score, ...rest } = o;
    return { ...rest, id: `flight-real-${i}` };
  });
}

module.exports = { getRealSchedules };
