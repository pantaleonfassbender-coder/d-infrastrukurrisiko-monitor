/*
 * Validation, geocoding and history bookkeeping for a scan.
 *
 * Model output is untrusted: everything Pass B returns runs through
 * normalizeAnalysis before it may reach the archive, and a run that fails
 * there leaves the previous Lagebild in place rather than replacing it with
 * something malformed.
 */

import { SECTOR_KEYS } from "./prompts.mjs";

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

/*
 * The index (method v3, since 2026-10-19). The model classifies incidents; the
 * number comes from here, so it is the same rule every day and every point of
 * it can be traced to an incident:
 *   weight = SEVERITY_WEIGHT[severity] x (1 if confirmed, 0.5 if suspected) x 0.5^(age / 7 days)
 *   index  = 35 + 65 x (1 - e^(-load / 30)), load = sum of the weights
 * 35 is the baseline (no incident); a fresh confirmed severity-5 attack alone
 * gives about 69, two of them about 85. Sector scores use the same rule with
 * a scale of 15, because a sector carries fewer incidents. Until 2026-10-18
 * the model set the score itself; it stood at 75 on 36 of 47 days.
 */
export const INDEX_METHOD = {
  id: "v3",
  since: "2026-10-19",
  severityWeight: { 1: 2, 2: 4, 3: 8, 4: 14, 5: 22 },
  suspectedFactor: 0.5,
  halfLifeDays: 7,
  base: BASELINE_MIN,
  scale: 30,
  sectorScale: 15,
};

export function incidentWeight(inc, now = Date.now()) {
  const M = INDEX_METHOD;
  const age = Math.max(0, (now - Date.parse(inc.date)) / 86400000);
  const w = (M.severityWeight[inc.schweregrad] || 0) * (inc.bestaetigt ? 1 : M.suspectedFactor) * 0.5 ** (age / M.halfLifeDays);
  return Math.round(w * 10) / 10;
}

const fromLoad = (load, scale) => Math.round(INDEX_METHOD.base + (100 - INDEX_METHOD.base) * (1 - Math.exp(-load / scale)));

export function computeIndex(incidents, now = Date.now()) {
  const weights = incidents.map((i) => incidentWeight(i, now));
  const load = weights.reduce((a, w) => a + w, 0);
  const sectors = SECTOR_KEYS.map((key) => {
    const l = incidents.reduce((a, inc, k) => a + (inc.sektor === key ? weights[k] : 0), 0);
    return { key, label: SECTOR_LABELS[key], score: fromLoad(l, INDEX_METHOD.sectorScale), load: Math.round(l * 10) / 10 };
  });
  return { score: fromLoad(load, INDEX_METHOD.scale), load: Math.round(load * 10) / 10, weights, sectors };
}

/* Places that are no place: such incidents stay in the list, but get no point on the map. */
const GENERIC_PLACE_RX = /^(deutschland|bundesweit|deutschlandweit|bundesgebiet|ganz deutschland|mehrere (orte|städte|bundesländer|standorte)|verschiedene orte|unbekannt|nicht bekannt|ohne ort|online|internet|überregional|europa|ausland)$/i;
export const isGenericPlace = (ort) => GENERIC_PLACE_RX.test(String(ort || "").trim());
const MAX_INCIDENTS = 25;
const MAX_INCIDENT_AGE_DAYS = 31;   /* the page promises the last 30 days; one day of slack for time zones */

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

/* Turns raw Pass-B output into the shape the site renders, or throws. */
export function normalizeAnalysis(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") throw new Error("analysis is not an object");
  if (typeof raw.assessment !== "string" || raw.assessment.trim().length < 40) {
    throw new Error("assessment missing or too thin");
  }

  const incidents = (Array.isArray(raw.incidents) ? raw.incidents : [])
    .filter((i) => i && typeof i === "object")
    .map((i) => ({
      date: validDate(i.date),
      ort: typeof i.ort === "string" ? i.ort.trim().slice(0, 80) : "",
      lat: Number(i.lat),
      lon: Number(i.lon),
      bestaetigt: i.bestaetigt === true,
      sektor: SECTOR_KEYS.includes(i.sektor) ? i.sektor : "sonstige",
      schweregrad: Math.max(1, Math.min(5, Math.round(Number(i.schweregrad) || 1))),
      titel: typeof i.titel === "string" ? i.titel.trim().slice(0, 160) : "",
      beschreibung:
        typeof i.beschreibung === "string" ? i.beschreibung.trim().slice(0, 600) : "",
      quelleUrl: safeUrl(i.quelleUrl),
    }))
    .filter((i) => i.date && i.ort && i.titel)
    .slice(0, MAX_INCIDENTS);

  /* Coordinates from the model are kept only when they are plausibly German;
     geocodeIncidents replaces or fills them from Nominatim afterwards. */
  for (const i of incidents) {
    i.generic = isGenericPlace(i.ort);
    if (i.generic || !inGermany(i.lat, i.lon)) {
      i.lat = null;
      i.lon = null;
    }
  }

  /* The index is computed, never taken from the model. */
  const index = computeIndex(incidents, now);
  incidents.forEach((inc, k) => { inc.gewicht = index.weights[k]; });
  incidents.sort((a, b) => b.gewicht - a.gewicht || (a.date < b.date ? 1 : -1));

  return {
    score: index.score,
    level: riskLevel(index.score),
    assessment: raw.assessment.trim(),
    sectors: index.sectors,
    incidents,
    index: { method: INDEX_METHOD.id, load: index.load, rule: INDEX_METHOD },
  };
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
    if (inc.generic || isGenericPlace(inc.ort)) continue;   /* no point in the middle of the country */
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
