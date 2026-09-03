/*
 * Deterministic collectors for the daily scan.
 *
 * Two free, keyless APIs feed the model with verifiable candidates so the
 * risk index does not rest on search grounding alone:
 *
 *   - GDELT DOC 2.0: German-language news of the last 30 days matching the
 *     infrastructure-incident query below.
 *   - NINA (bund.dev proxy of the BBK warning system): official civil-
 *     protection warnings (MoWaS, Katwarn, Biwapp, police).
 *
 * Every collector fails soft: an unreachable source yields an empty list and
 * a note in `errors`, never a failed run — the analysis then simply leans on
 * the remaining material.
 */

const FETCH_TIMEOUT_MS = 15000;

const GDELT_QUERY =
  '(sabotage OR brandanschlag OR "kritische infrastruktur" OR drohnensichtung ' +
  'OR "drohnen gesichtet" OR "kabel durchtrennt" OR "anschlag auf" ' +
  'OR "angriff auf" OR "stromausfall") sourcecountry:germany sourcelang:ger';

/* Canonical BBK host; the bund.dev proxy host is only a mirror of this. */
const NINA_FEEDS = [
  ["mowas", "https://warnung.bund.de/api31/mowas/mapData.json"],
  ["katwarn", "https://warnung.bund.de/api31/katwarn/mapData.json"],
  ["biwapp", "https://warnung.bund.de/api31/biwapp/mapData.json"],
  ["police", "https://warnung.bund.de/api31/police/mapData.json"],
];

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res.json();
}

/* GDELT's seendate looks like "20260903T053000Z". */
function parseGdeltDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(s || "");
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

function titleKey(title) {
  return (title || "").toLowerCase().replace(/[^a-zäöüß0-9]+/g, " ").trim().slice(0, 80);
}

export async function collectGdelt() {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
    encodeURIComponent(GDELT_QUERY) +
    "&mode=ArtList&format=json&maxrecords=75&sort=DateDesc&timespan=30d";
  const data = await fetchJson(url);
  const seen = new Set();
  const articles = [];
  for (const a of data.articles || []) {
    if (!a.url || !a.title) continue;
    const key = titleKey(a.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    articles.push({
      title: a.title.slice(0, 200),
      url: a.url,
      domain: a.domain || "",
      date: parseGdeltDate(a.seendate),
    });
    if (articles.length >= 60) break;
  }
  return articles;
}

export async function collectNina() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const results = await Promise.allSettled(
    NINA_FEEDS.map(async ([source, url]) => {
      const items = await fetchJson(url);
      return (Array.isArray(items) ? items : [])
        .filter((w) => w.type !== "Cancel")
        .map((w) => ({
          source,
          headline: (w.i18nTitle && w.i18nTitle.de) || "",
          severity: w.severity || "",
          date: w.startDate || "",
        }))
        .filter((w) => {
          if (!w.headline) return false;
          const t = Date.parse(w.date);
          return Number.isFinite(t) ? t >= cutoff : true;
        });
    })
  );
  const warnings = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") warnings.push(...r.value);
    else errors.push(`${NINA_FEEDS[i][0]}: ${r.reason?.message || r.reason}`);
  });
  return { warnings: warnings.slice(0, 80), errors };
}

/* Runs both collectors in parallel; never throws. */
export async function collectAll() {
  const [gdelt, nina] = await Promise.allSettled([collectGdelt(), collectNina()]);
  const errors = [];
  let articles = [];
  let warnings = [];
  if (gdelt.status === "fulfilled") articles = gdelt.value;
  else errors.push(`gdelt: ${gdelt.reason?.message || gdelt.reason}`);
  if (nina.status === "fulfilled") {
    warnings = nina.value.warnings;
    errors.push(...nina.value.errors.map((e) => `nina/${e}`));
  } else {
    errors.push(`nina: ${nina.reason?.message || nina.reason}`);
  }
  return { articles, warnings, errors };
}
