/*
 * Validation, geocoding and history bookkeeping for a scan.
 *
 * Model output is untrusted: everything Pass B returns runs through
 * normalizeAnalysis before it may reach the archive, and a run that fails
 * there leaves the previous Lagebild in place rather than replacing it with
 * something malformed.
 *
 * The source obligation is enforced here rather than in the schema: an
 * incident survives only if its quelleUrl resolves to one of the GDELT
 * articles the collector actually retrieved, and the stored value is then the
 * collector's own URL, not the model's rendering of it. Incidents the model
 * cannot back with such an article are dropped, so nothing reaches the map or
 * the incident list that a reader cannot check. Without a GDELT pool the
 * obligation cannot be checked at all and the run fails, because publishing
 * an unverifiable "no incidents" Lagebild would understate the situation
 * instead of reporting the outage.
 */

import { SECTOR_KEYS } from "./gemini.mjs";

export const SECTOR_LABELS = {
  bahn: "Bahn",
  energie: "Energie",
  drohnen: "Drohnen",
  telekom: "Telekom",
  industrie: "Industrie",
  cyber: "Cyber",
  sonstige: "Sonstige",
};

/* Germany plus a small margin, for sanity-checking coordinates. */
const DE_BOUNDS = { latMin: 47.0, latMax: 55.3, lonMin: 5.5, lonMax: 15.5 };

const BASELINE_MIN = 35;
const BASELINE_MAX = 45;
const MAX_INCIDENTS = 25;
const MAX_INCIDENT_AGE_DAYS = 45;

export function riskLevel(score) {
  if (score > 70) return "KRITISCH";
  if (score > 45) return "ERHÖHT";
  if (score >= 30) return "LATENT";
  return "RUHIG";
}

function clampScore(n, fallback = BASELINE_MIN) {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function inGermany(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= DE_BOUNDS.latMin &&
    lat <= DE_BOUNDS.latMax &&
    lon >= DE_BOUNDS.lonMin &&
    lon <= DE_BOUNDS.lonMax
  );
}

function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const ageDays = (Date.now() - t) / 86400000;
  if (ageDays < -2 || ageDays > MAX_INCIDENT_AGE_DAYS) return null;
  return s;
}

/*
 * Turns raw Pass-B output into the shape the site renders, or throws.
 * `sourceUrls` is the GDELT article pool of this run; every incident must
 * cite one of these URLs to be kept.
 */
export function normalizeAnalysis(raw, { sourceUrls = [] } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("analysis is not an object");
  if (typeof raw.assessment !== "string" || raw.assessment.trim().length < 40) {
    throw new Error("assessment missing or too thin");
  }

  const pool = buildSourcePool(sourceUrls);
  if (pool.size === 0) {
    throw new Error("no GDELT source pool for this run: incident sourcing cannot be verified");
  }

  const candidates = (Array.isArray(raw.incidents) ? raw.incidents : [])
    .filter((i) => i && typeof i === "object")
    .map((i) => ({
      date: validDate(i.date),
      ort: typeof i.ort === "string" ? i.ort.trim().slice(0, 80) : "",
      lat: Number(i.lat),
      lon: Number(i.lon),
      sektor: SECTOR_KEYS.includes(i.sektor) ? i.sektor : "sonstige",
      schweregrad: Math.max(1, Math.min(5, Math.round(Number(i.schweregrad) || 1))),
      titel: typeof i.titel === "string" ? i.titel.trim().slice(0, 160) : "",
      beschreibung:
        typeof i.beschreibung === "string" ? i.beschreibung.trim().slice(0, 600) : "",
      quelleUrl: resolveSource(i.quelleUrl, pool),
    }))
    .filter((i) => i.date && i.ort && i.titel);

  /* The source obligation: no GDELT article, no incident. Counted so a run
     that loses most of its incidents this way is visible in the stats. */
  const sourced = candidates.filter((i) => i.quelleUrl);
  const unsourcedDropped = candidates.length - sourced.length;
  const incidents = sourced.slice(0, MAX_INCIDENTS);

  /* Coordinates from the model are kept only when they are plausibly German;
     geocodeIncidents replaces or fills them from Nominatim afterwards. */
  for (const i of incidents) {
    if (!inGermany(i.lat, i.lon)) {
      i.lat = null;
      i.lon = null;
    }
  }

  let score = clampScore(raw.score);
  if (incidents.length === 0) {
    /* The baseline rule, enforced server-side rather than trusted. */
    score = Math.max(BASELINE_MIN, Math.min(BASELINE_MAX, score));
  }

  const sectorMap = new Map(
    (Array.isArray(raw.sectors) ? raw.sectors : [])
      .filter((s) => s && SECTOR_KEYS.includes(s.key))
      .map((s) => [s.key, clampScore(s.score)])
  );
  const sectors = SECTOR_KEYS.map((key) => ({
    key,
    label: SECTOR_LABELS[key],
    score: sectorMap.get(key) ?? BASELINE_MIN,
  }));

  return {
    score,
    level: riskLevel(score),
    assessment: raw.assessment.trim(),
    sectors,
    incidents,
    unsourcedDropped,
  };
}

/*
 * Matching key for a source URL: host without "www.", path without a trailing
 * slash, protocol/query/fragment ignored. The model tends to reproduce a URL
 * with a dropped tracking parameter or a switched scheme, and such a citation
 * still points at the same article.
 */
function urlKey(u) {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return host + parsed.pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/* key -> the collector's original URL, first occurrence winning. */
function buildSourcePool(urls) {
  const pool = new Map();
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = safeUrl(raw);
    const key = url && urlKey(url);
    if (key && !pool.has(key)) pool.set(key, url);
  }
  return pool;
}

/* The cited URL as it appears in the pool, or "" if it is not from there. */
function resolveSource(cited, pool) {
  const url = safeUrl(cited);
  if (!url) return "";
  return pool.get(urlKey(url)) || "";
}

function safeUrl(u) {
  if (typeof u !== "string") return "";
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? u.slice(0, 500) : "";
  } catch {
    return "";
  }
}

/*
 * Fills missing coordinates from Nominatim, one lookup per unique place name,
 * throttled to respect the usage policy. `cache` is a plain object persisted
 * in Blobs between runs so recurring places cost nothing.
 */
export async function geocodeIncidents(incidents, cache = {}, { maxLookups = 12 } = {}) {
  let lookups = 0;
  for (const inc of incidents) {
    if (inGermany(inc.lat, inc.lon)) continue;
    const key = inc.ort.toLowerCase();
    if (cache[key]) {
      inc.lat = cache[key].lat;
      inc.lon = cache[key].lon;
      continue;
    }
    if (lookups >= maxLookups) continue;
    lookups += 1;
    try {
      const url =
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=de&q=" +
        encodeURIComponent(inc.ort);
      const res = await fetch(url, {
        headers: {
          "user-agent": "d-infrastrukturrisiko-monitor/1.0 (github.com/pantaleonfassbender-coder)",
          accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const hits = await res.json();
        const hit = Array.isArray(hits) && hits[0];
        if (hit) {
          const lat = Number(hit.lat);
          const lon = Number(hit.lon);
          if (inGermany(lat, lon)) {
            inc.lat = lat;
            inc.lon = lon;
            cache[key] = { lat, lon };
          }
        }
      }
    } catch {
      /* An incident without coordinates still appears in the list view. */
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
  return cache;
}

/*
 * Appends today's figures to the history, replacing an earlier entry for the
 * same date (a manual rescan updates the day rather than duplicating it).
 */
export function updateHistory(history, entry, { maxDays = 400 } = {}) {
  const list = (Array.isArray(history) ? history : []).filter(
    (h) => h && h.date && h.date !== entry.date
  );
  list.push(entry);
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  return list.slice(-maxDays);
}
