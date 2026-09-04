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

/*
 * GDELT DOC 2.0.
 *
 * `sourcelang:` expects GDELT's own language *name*, not an ISO code. The
 * collector used to send `sourcelang:ger`, which GDELT answers with HTTP 200
 * and the plain-text body "Invalid/Unsupported Language." — so the response
 * looked fine, `res.json()` blew up on the first character, and the run only
 * ever recorded an opaque parse error with zero articles.
 *
 * The query stays a single request on purpose: GDELT asks for no more than
 * one call every five seconds and answers anything faster with HTTP 429, so
 * splitting the terms over several requests loses more material to throttling
 * than the extra precision wins back.
 *
 * It also has to stay short: GDELT caps the query at 250 characters and
 * answers anything longer with "Your query was too short or too long", so
 * every added term costs another one. tests/sources.test.mjs guards the
 * budget, because the rejection is easy to reintroduce and shows up only as
 * an empty source.
 *
 * Staying inside that budget is what `"angriff auf"` and `stromausfall` were
 * spent on: alone they mostly matched sport, politics and weather-related
 * power cuts, all of which lib/core.mjs discards as accidents anyway. The
 * room they freed pays for the three specific terms below, of which
 * `umspannwerk` names a grid target far more precisely.
 */
export const GDELT_QUERY =
  '(sabotage OR brandanschlag OR "kritische infrastruktur" OR drohnensichtung ' +
  'OR "kabel durchtrennt" OR kabelbrand OR umspannwerk OR cyberangriff ' +
  'OR "anschlag auf") sourcecountry:germany sourcelang:german';

/* 250 is the documented ceiling for maxrecords; sorted newest-first the
   window comfortably covers 30 days of German coverage. */
const GDELT_MAX_RECORDS = 250;
const GDELT_MAX_ARTICLES = 120;
/* GDELT's throttle is sticky: once tripped it keeps answering 429 for a
   while, so the backoff is deliberately generous. Five attempts spread over
   roughly 80 seconds, which a daily background scan can well afford. */
const GDELT_ATTEMPTS = 5;
const GDELT_RETRY_MS = 8000;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * GDELT signals every kind of problem with a human-readable sentence instead
 * of a status code or an error object: a bad parameter arrives as HTTP 200
 * text/html ("Invalid/Unsupported Language."), throttling as "Please limit
 * requests to one every 5 seconds". Reading the body as text and deciding
 * here turns those into a legible message rather than a JSON syntax error,
 * and says whether trying again can possibly help.
 *
 * Returns { articles } on success or { error, retriable } on failure.
 */
export function interpretGdeltBody(status, body) {
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    /* the body is prose, not JSON - classified below */
  }
  /* Valid JSON means GDELT accepted the query, so a missing or empty
     `articles` key is a real "nothing matched" answer, not a failure. */
  if (data && typeof data === "object") {
    return { articles: Array.isArray(data.articles) ? data.articles : [] };
  }
  const snippet = String(body || "").trim().replace(/\s+/g, " ").slice(0, 120);
  return {
    /* Unprefixed: collectAll labels the source when it collects the errors. */
    error: snippet || `HTTP ${status}`,
    /* Throttling and server trouble pass; a rejected query never will. */
    retriable: status === 429 || status >= 500 || /limit requests/i.test(body || ""),
  };
}

async function fetchGdelt(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const outcome = interpretGdeltBody(res.status, await res.text());
  if (outcome.articles) return outcome.articles;
  const err = new Error(outcome.error);
  err.retriable = outcome.retriable;
  throw err;
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

/* Deduplicates by URL and by near-identical headline, newest first. */
export function normalizeGdeltArticles(raw) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const articles = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    if (!a || !a.url || !a.title) continue;
    if (seenUrls.has(a.url)) continue;
    const key = titleKey(a.title);
    if (!key || seenTitles.has(key)) continue;
    seenUrls.add(a.url);
    seenTitles.add(key);
    articles.push({
      title: String(a.title).slice(0, 200),
      url: a.url,
      domain: a.domain || "",
      date: parseGdeltDate(a.seendate),
    });
    if (articles.length >= GDELT_MAX_ARTICLES) break;
  }
  return articles;
}

/*
 * One GDELT query, retried through throttling and transient network errors.
 * A query GDELT rejects outright is raised immediately — waiting cannot fix
 * a bad parameter, and the message says which one.
 */
export async function collectGdelt() {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
    encodeURIComponent(GDELT_QUERY) +
    `&mode=ArtList&format=json&maxrecords=${GDELT_MAX_RECORDS}&sort=DateDesc&timespan=30d`;

  let lastError = null;
  for (let attempt = 1; attempt <= GDELT_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(GDELT_RETRY_MS * (attempt - 1));
    try {
      return normalizeGdeltArticles(await fetchGdelt(url));
    } catch (err) {
      lastError = err;
      if (err.retriable === false) throw err;
    }
  }
  throw lastError;
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
  if (gdelt.status === "fulfilled") {
    articles = gdelt.value;
    /* A silent zero is what hid the broken query for so long, so say it. */
    if (!articles.length) errors.push("gdelt: query returned no articles");
  } else {
    errors.push(`gdelt: ${gdelt.reason?.message || gdelt.reason}`);
  }
  if (nina.status === "fulfilled") {
    warnings = nina.value.warnings;
    errors.push(...nina.value.errors.map((e) => `nina/${e}`));
  } else {
    errors.push(`nina: ${nina.reason?.message || nina.reason}`);
  }
  return { articles, warnings, errors };
}
