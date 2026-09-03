/*
 * Deterministic collectors for the daily scan.
 *
 * Two layers of free, keyless material feed the model with verifiable
 * candidates so the risk index does not rest on search grounding alone:
 *
 *   - a NEWS layer of German-language headlines from the last 30 days, and
 *   - the NINA layer (BBK warning system) with official civil-protection
 *     warnings (MoWaS, Katwarn, Biwapp, police).
 *
 * The news layer is tiered rather than a single API, because GDELT — the
 * primary and richest source — answers HTTP 429 whenever the shared outbound
 * IP of the function runtime has been busy ("limit requests to one every 5
 * seconds"), which in practice happens for hours at a time and used to leave
 * a scan with no headlines at all. Tiers are tried in order and the first one
 * that yields headlines wins:
 *
 *   1. GDELT DOC 2.0   - broadest coverage, but rate-limited without warning
 *   2. Google News RSS - the same kind of cross-outlet search, keyless
 *   3. tagesschau.de   - single outlet, but a stable public API
 *
 * Every collector fails soft: an unreachable source yields an empty list and
 * a note in `errors`, never a failed run — the analysis then simply leans on
 * the remaining material.
 */

const FETCH_TIMEOUT_MS = 15000;

/* GDELT asks for at most one request every five seconds, so a retry that
   waits less than that is guaranteed to be refused again. */
const GDELT_RETRY_BASE_MS = 6000;

const MAX_ARTICLES = 60;
const ARTICLE_MAX_AGE_DAYS = 35;

const GDELT_QUERY =
  '(sabotage OR brandanschlag OR "kritische infrastruktur" OR drohnensichtung ' +
  'OR "drohnen gesichtet" OR "kabel durchtrennt" OR "anschlag auf" ' +
  'OR "angriff auf" OR "stromausfall") sourcecountry:germany sourcelang:ger';

/* One Google News query per threat family; a single long OR-query returns
   markedly fewer usable hits there than several focussed ones. */
const GOOGLE_NEWS_QUERIES = [
  '"kritische Infrastruktur" (Sabotage OR Anschlag OR Angriff)',
  "Drohnen (Bundeswehr OR Flughafen OR Kraftwerk OR Industrieanlage) gesichtet",
  '(Brandanschlag OR Kabelschacht OR "Kabel durchtrennt") (Bahn OR Strom OR Glasfaser)',
  "Cyberangriff (Stadtwerke OR Energieversorger OR Behörde OR Klinik)",
];

const TAGESSCHAU_QUERIES = [
  "sabotage infrastruktur",
  "drohne gesichtet",
  "brandanschlag",
  "cyberangriff kritische infrastruktur",
];

/* Canonical BBK host; the bund.dev proxy host is only a mirror of this. */
const NINA_FEEDS = [
  ["mowas", "https://warnung.bund.de/api31/mowas/mapData.json"],
  ["katwarn", "https://warnung.bund.de/api31/katwarn/mapData.json"],
  ["biwapp", "https://warnung.bund.de/api31/biwapp/mapData.json"],
  ["police", "https://warnung.bund.de/api31/police/mapData.json"],
];

const USER_AGENT = "d-infrastrukturrisiko-monitor/2.1 (+https://github.com/pantaleonfassbender-coder)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, host, retryAfter) {
    super(`HTTP ${status} from ${host}`);
    this.status = status;
    /* 429 and 5xx are worth another attempt; a 4xx from a malformed query is
       not, and retrying it only burns the run's time budget. */
    this.retriable = status === 429 || status >= 500;
    const seconds = Number(retryAfter);
    this.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }
}

/* A body that arrived but cannot be used — worth one more attempt. */
class BadBodyError extends Error {
  constructor(message) {
    super(message);
    this.retriable = true;
  }
}

function isRetriable(err) {
  /* Network errors and timeouts carry no verdict of their own and are always
     worth retrying; HTTP and body errors decide for themselves. */
  if (err instanceof HttpError || err instanceof BadBodyError) return err.retriable;
  return true;
}

/*
 * fetch with jittered backoff. `read` turns the Response into the value the
 * caller wants and may itself reject the body as unusable, which counts as a
 * failed attempt — the GDELT rate limiter sometimes answers plain text under
 * HTTP 200, and that must not look like a successful fetch.
 */
async function fetchWithRetry(url, { headers = {}, attempts = 2, baseDelayMs = 1500, read } = {}) {
  const host = new URL(url).hostname;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new HttpError(res.status, host, res.headers.get("retry-after"));
      return read ? await read(res) : res;
    } catch (err) {
      if (!isRetriable(err) || attempt >= attempts) throw err;
      const wait = Math.max(err.retryAfterMs || 0, baseDelayMs * attempt) + Math.random() * 750;
      await sleep(wait);
    }
  }
}

/* Reads a JSON body and reports a non-JSON one with a readable excerpt
   instead of a bare parser message. */
function jsonReader(host) {
  return async (res) => {
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch {
      throw new BadBodyError(`non-JSON body from ${host}: ${body.trim().slice(0, 110)}`);
    }
  };
}

async function fetchJson(url, options) {
  return fetchWithRetry(url, {
    ...options,
    headers: { accept: "application/json", ...(options?.headers || {}) },
    read: jsonReader(new URL(url).hostname),
  });
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

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\d?\./, "");
  } catch {
    return "";
  }
}

function recentEnough(iso) {
  if (!iso) return true; /* an undated headline is still a candidate */
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true;
  return (Date.now() - t) / 86400000 <= ARTICLE_MAX_AGE_DAYS;
}

/*
 * Drops duplicates by normalised title (several outlets carry one event) and
 * caps the list, so every provider hands the model the same shape and size.
 */
export function dedupeArticles(list, limit = MAX_ARTICLES) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    if (!a || !a.url || !a.title) continue;
    const key = titleKey(a.title);
    if (!key || seen.has(key)) continue;
    if (!recentEnough(a.date)) continue;
    seen.add(key);
    out.push({
      title: String(a.title).slice(0, 200),
      url: String(a.url).slice(0, 600),
      domain: a.domain || hostOf(a.url),
      date: a.date || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ---------------------------------------------------------------- tier 1 */

export async function collectGdelt() {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
    encodeURIComponent(GDELT_QUERY) +
    "&mode=ArtList&format=json&maxrecords=75&sort=DateDesc&timespan=30d";
  /* Two attempts only: when GDELT is throttling the runtime's IP it stays
     throttled for far longer than a scan may wait. */
  const data = await fetchJson(url, { attempts: 2, baseDelayMs: GDELT_RETRY_BASE_MS });
  return dedupeArticles(
    (data.articles || []).map((a) => ({
      title: a.title,
      url: a.url,
      domain: a.domain,
      date: parseGdeltDate(a.seendate),
    }))
  );
}

/* ---------------------------------------------------------------- tier 2 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e])
    .trim();
}

function tag(item, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item);
  return m ? decodeXml(m[1]) : "";
}

/*
 * Google News RSS items carry the outlet in <source url="…"> and repeat it in
 * the title as " - Outlet", which is noise for the model and is stripped.
 */
export function parseGoogleNewsRss(xml) {
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map((item) => {
    const sourceUrl = /<source[^>]*url="([^"]+)"/.exec(item)?.[1] || "";
    const domain = hostOf(sourceUrl);
    let title = tag(item, "title");
    const outlet = tag(item, "source");
    if (outlet && title.endsWith(` - ${outlet}`)) title = title.slice(0, -(outlet.length + 3));
    const published = Date.parse(tag(item, "pubDate"));
    return {
      title,
      url: tag(item, "link"),
      domain,
      date: Number.isFinite(published) ? new Date(published).toISOString() : null,
    };
  });
}

export async function collectGoogleNews() {
  const results = await Promise.allSettled(
    GOOGLE_NEWS_QUERIES.map(async (q) => {
      const url =
        "https://news.google.com/rss/search?q=" +
        encodeURIComponent(`${q} when:30d`) +
        "&hl=de&gl=DE&ceid=DE:de";
      const res = await fetchWithRetry(url, { headers: { accept: "application/rss+xml, application/xml" } });
      return parseGoogleNewsRss(await res.text());
    })
  );
  const articles = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!articles.length && results.every((r) => r.status === "rejected")) {
    throw new Error(results[0].reason?.message || "all Google News queries failed");
  }
  /* Newest first, mirroring GDELT's sort=DateDesc. */
  articles.sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
  return dedupeArticles(articles);
}

/* ---------------------------------------------------------------- tier 3 */

export function mapTagesschauResults(payload) {
  return (payload?.searchResults || []).map((r) => {
    const url = r.detailsweb || r.shareURL || "";
    const published = Date.parse(r.date);
    return {
      title: [r.topline, r.title].filter(Boolean).join(": ").slice(0, 200) || r.title,
      url,
      domain: hostOf(url),
      date: Number.isFinite(published) ? new Date(published).toISOString() : null,
    };
  });
}

export async function collectTagesschau() {
  const results = await Promise.allSettled(
    TAGESSCHAU_QUERIES.map(async (q) => {
      const url =
        "https://www.tagesschau.de/api2u/search?pageSize=20&searchText=" + encodeURIComponent(q);
      return mapTagesschauResults(await fetchJson(url));
    })
  );
  const articles = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!articles.length && results.every((r) => r.status === "rejected")) {
    throw new Error(results[0].reason?.message || "all tagesschau queries failed");
  }
  articles.sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
  return dedupeArticles(articles);
}

/* -------------------------------------------------------------- news tier */

export const NEWS_PROVIDERS = [
  ["gdelt", collectGdelt],
  ["googlenews", collectGoogleNews],
  ["tagesschau", collectTagesschau],
];

export const NEWS_PROVIDER_LABELS = {
  gdelt: "GDELT",
  googlenews: "Google News",
  tagesschau: "tagesschau.de",
  none: "keine",
};

/*
 * Walks the tiers until one delivers headlines. Never throws: a run without
 * any news still has NINA and the grounded search to work with.
 */
export async function collectNews(providers = NEWS_PROVIDERS) {
  const errors = [];
  for (const [name, collect] of providers) {
    try {
      const articles = await collect();
      if (articles.length) return { articles, provider: name, errors };
      errors.push(`${name}: no articles`);
    } catch (err) {
      errors.push(`${name}: ${err?.message || err}`);
    }
  }
  return { articles: [], provider: "none", errors };
}

/* -------------------------------------------------------------- nina tier */

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

/* Runs both layers in parallel; never throws. */
export async function collectAll() {
  const [news, nina] = await Promise.allSettled([collectNews(), collectNina()]);
  const errors = [];
  let articles = [];
  let newsProvider = "none";
  let warnings = [];
  if (news.status === "fulfilled") {
    articles = news.value.articles;
    newsProvider = news.value.provider;
    errors.push(...news.value.errors.map((e) => `news/${e}`));
  } else {
    errors.push(`news: ${news.reason?.message || news.reason}`);
  }
  if (nina.status === "fulfilled") {
    warnings = nina.value.warnings;
    errors.push(...nina.value.errors.map((e) => `nina/${e}`));
  } else {
    errors.push(`nina: ${nina.reason?.message || nina.reason}`);
  }
  return { articles, newsProvider, warnings, errors };
}
