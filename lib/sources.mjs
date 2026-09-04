/*
 * Deterministic collectors for the daily scan.
 *
 * Three free, keyless sources feed the model with verifiable candidates so
 * the risk index does not rest on search grounding alone:
 *
 *   - GDELT DOC 2.0: German-language news of the last 30 days matching the
 *     infrastructure-incident query below.
 *   - German publisher news feeds: the RSS/Atom feeds of the major German
 *     outlets, filtered to infrastructure-security wording. GDELT throttles
 *     per IP and answers HTTP 429 to practically every call from a data
 *     centre, so the news layer cannot depend on it alone — see collectGdelt.
 *   - NINA (BBK warning system): official civil-protection warnings (MoWaS,
 *     Katwarn, Biwapp, police).
 *
 * Publisher feeds only carry the current day, while GDELT looks back 30 days.
 * mergeArticles closes that gap: the caller keeps a rolling archive in Blobs,
 * so the 30-day window is built up one scan at a time.
 *
 * Every collector fails soft: an unreachable source yields an empty list and
 * a short German note in `errors`, never a failed run — the analysis then
 * simply leans on the remaining material.
 */

const FETCH_TIMEOUT_MS = 15000;

/* GDELT asks for at most one request every five seconds; a 429 is often the
   shared data-centre IP rather than this site, so a few spaced retries are
   worth the wait inside a background function. */
const GDELT_ATTEMPTS = 4;
const GDELT_RETRY_MS = 6000;

export const ARTICLE_MAX_AGE_DAYS = 30;
export const ARTICLE_ARCHIVE_MAX = 400;

const GDELT_QUERY =
  '(sabotage OR brandanschlag OR "kritische infrastruktur" OR drohnensichtung ' +
  'OR "drohnen gesichtet" OR "kabel durchtrennt" OR "anschlag auf" ' +
  'OR "angriff auf" OR "stromausfall") sourcecountry:germany sourcelang:ger';

/* Publisher feeds, meant for syndication and reachable from data centres. */
const NEWS_FEEDS = [
  ["tagesschau", "https://www.tagesschau.de/index~rss2.xml"],
  ["tagesschau-inland", "https://www.tagesschau.de/inland/index~rss2.xml"],
  ["zdfheute", "https://www.zdf.de/rss/zdf/nachrichten"],
  ["deutschlandfunk", "https://www.deutschlandfunk.de/nachrichten-100.rss"],
  ["spiegel", "https://www.spiegel.de/schlagzeilen/index.rss"],
  ["zeit", "https://newsfeed.zeit.de/politik/index"],
  ["faz", "https://www.faz.net/rss/aktuell/politik/"],
  ["sueddeutsche", "https://rss.sueddeutsche.de/rss/Topthemen"],
  ["welt", "https://www.welt.de/feeds/section/politik.rss"],
  ["ntv", "https://www.n-tv.de/rss"],
  ["heise", "https://www.heise.de/rss/heise-atom.xml"],
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

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: res.status, ok: res.ok, body: await res.text() };
}

async function fetchJson(url, headers = {}) {
  const { ok, status, body } = await fetchText(url, { accept: "application/json", ...headers });
  if (!ok) throw new Error(`HTTP ${status} von ${new URL(url).hostname}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`ungültige Antwort von ${new URL(url).hostname}`);
  }
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
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/*
 * One GDELT query, retried a few times with GDELT's own five-second spacing.
 * A rate-limited answer is plain text with status 429, so the body is read as
 * text first and only then parsed. The thrown message is short and German —
 * it ends up in the source hints on the page, where GDELT's own boiler-plate
 * ("Please limit requests to one every 5 seconds or contact …") told the
 * reader nothing.
 */
export async function collectGdelt({ attempts = GDELT_ATTEMPTS, retryMs = GDELT_RETRY_MS } = {}) {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
    encodeURIComponent(GDELT_QUERY) +
    "&mode=ArtList&format=json&maxrecords=75&sort=DateDesc&timespan=30d";

  let note = "nicht erreichbar";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(retryMs);
    let status = 0;
    let ok = false;
    let body = "";
    try {
      ({ status, ok, body } = await fetchText(url, { accept: "application/json" }));
    } catch (err) {
      note = err.name === "TimeoutError" ? "Zeitüberschreitung" : `Netzwerkfehler (${err.message})`;
      continue;
    }
    if (status === 429 || /limit requests|too many/i.test(body.slice(0, 200))) {
      note = "Rate-Limit der GDELT-API (HTTP 429)";
      continue;
    }
    if (!ok) {
      note = `HTTP ${status}`;
      continue;
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      note = "Antwort war kein JSON";
      continue;
    }
    return gdeltArticles(data);
  }
  throw new Error(`${note} — auch nach ${attempts} Versuchen`);
}

function gdeltArticles(data) {
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
      domain: a.domain || hostOf(a.url),
      date: parseGdeltDate(a.seendate),
      origin: "gdelt",
    });
    if (articles.length >= 60) break;
  }
  return articles;
}

/* ---------- Publisher news feeds ---------- */

function decodeXml(s) {
  return String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    /* Feeds often escape their markup, so tags reappear after decoding. */
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeCodePoint(n) {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/* Small RSS/Atom reader: the feeds only need title, link and date, which is
   not worth an XML dependency in a function bundle. */
export function parseFeed(xml) {
  const items = [];
  for (const block of String(xml || "").match(/<(item|entry)\b[\s\S]*?<\/\1>/g) || []) {
    const title = decodeXml((/<title[^>]*>([\s\S]*?)<\/title>/.exec(block) || [])[1]);
    let url = decodeXml((/<link[^>]*>([\s\S]*?)<\/link>/.exec(block) || [])[1]);
    if (!/^https?:\/\//i.test(url)) {
      const href = /<link[^>]*href="([^"]+)"/.exec(block);
      url = href ? decodeXml(href[1]) : "";
    }
    const raw = (/<(pubDate|updated|published|dc:date)[^>]*>([\s\S]*?)<\/\1>/.exec(block) || [])[2];
    const summary = decodeXml(
      (/<(description|summary|content)[^>]*>([\s\S]*?)<\/\1>/.exec(block) || [])[2]
    );
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const t = Date.parse(decodeXml(raw));
    items.push({
      title: title.slice(0, 200),
      url,
      date: Number.isFinite(t) ? new Date(t).toISOString() : null,
      summary: summary.slice(0, 400),
    });
  }
  return items;
}

/*
 * Headline filter. STRONG wording is enough on its own; the vaguer WEAK
 * wording needs an attack or disruption word next to it. War reporting from
 * abroad uses the same vocabulary, so it is dropped unless Germany is part of
 * the story. Whether a match is really an incident is still decided by the
 * model (pass B), which sees dates and rules; this filter only keeps the
 * material it gets to see relevant.
 */
const STRONG_RX =
  /sabotage|sabotiert|sabotageakt|brandanschl|kritische[rn]? infrastruktur|kritis\b|drohnensicht|drohnenvorfall|drohnenalarm|drohnenangriff|drohnen(?:überflug|überflüge)|kabel (?:durchtrennt|gekappt|zerstört)|durchtrennte[ns]? kabel|kabelschacht|kabelbrand|unterseekabel|seekabel|umspannwerk|trafostation|stellwerk|oberleitung|strommast|stromausfall|blackout|cyberangriff|cyberattacke|hackerangriff|ransomware|anschlag auf|anschlagsversuch|sprengsatz|sprengvorrichtung|brandsatz|nord stream/i;
const WEAK_RX =
  /drohne|pipeline|kraftwerk|raffinerie|wasserwerk|glasfaser|mobilfunk|rechenzentrum|bahnstrecke|bahnanlage|flughafen|stromnetz|gasnetz|spionage|bundeswehr/i;
const ATTACK_RX =
  /angriff|anschlag|sabotage|spionage|sprengung|beschädig|gekappt|durchtrennt|zerstört|ausfall|störung|gesperrt|verdacht|ermittl|bedroh|abgeschossen|eingedrungen|überflog|sichtung|gesichtet|gefährd|vorfall|zwischenfall|attack/i;
const ABROAD_RX =
  /ukrain|kyjiw|kiew|moskau|russische[nr]? (?:armee|truppen|streitkräfte)|gaza|israel|iran|nepal|china|taiwan|venezuela/i;
const GERMANY_RX =
  /deutschland|deutsche[nrs]?\b|bundes(?:wehr|regierung|polizei|netzagentur|amt|innenminister|kriminalamt|tag)|nrw|nordrhein|bayern|sachsen|hessen|brandenburg|niedersachsen|baden-württemberg|thüringen|bremen|saarland|rheinland|mecklenburg|schleswig|berlin|hamburg|münchen|köln|frankfurt|leipzig|dresden|stuttgart|düsseldorf|hannover|bremerhaven|rostock/i;

export function isInfraRelevant(text) {
  /* German headlines hyphenate compounds freely ("Drohnen-Vorfall",
     "Cyber-Angriff"), so inner hyphens are closed up before matching. */
  const t = String(text || "").replace(/(\p{L})[-–](\p{L})/gu, "$1$2");
  if (!t) return false;
  if (!STRONG_RX.test(t) && !(WEAK_RX.test(t) && ATTACK_RX.test(t))) return false;
  if (ABROAD_RX.test(t) && !GERMANY_RX.test(t)) return false;
  return true;
}

/* All publisher feeds in parallel; returns { articles, errors }. */
export async function collectNews({ feeds = NEWS_FEEDS, maxAgeDays = ARTICLE_MAX_AGE_DAYS } = {}) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const results = await Promise.allSettled(
    feeds.map(async ([source, url]) => {
      const { ok, status, body } = await fetchText(url, {
        accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
      });
      if (!ok) throw new Error(`HTTP ${status}`);
      return parseFeed(body)
        .filter((i) => {
          const t = Date.parse(i.date);
          return Number.isFinite(t) ? t >= cutoff : true;
        })
        .filter((i) => isInfraRelevant(`${i.title} ${i.summary}`))
        .map((i) => ({
          title: i.title,
          url: i.url,
          domain: hostOf(i.url) || source,
          date: i.date,
          origin: "news",
        }));
    })
  );

  const articles = [];
  const errors = [];
  const seen = new Set();
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      errors.push(`${feeds[i][0]}: ${r.reason?.message || r.reason}`);
      return;
    }
    for (const a of r.value) {
      const key = titleKey(a.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      articles.push(a);
    }
  });
  return { articles, errors };
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

/*
 * Merges freshly collected headlines into the rolling archive: newest first,
 * one entry per story, nothing older than the 30-day window. The first date
 * seen for a story wins, so a headline that keeps reappearing in the feeds
 * does not look newer than it is.
 */
export function mergeArticles(archive, fresh, { maxAgeDays = ARTICLE_MAX_AGE_DAYS, maxItems = ARTICLE_ARCHIVE_MAX } = {}) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const byKey = new Map();
  for (const a of [...(Array.isArray(archive) ? archive : []), ...(Array.isArray(fresh) ? fresh : [])]) {
    if (!a || typeof a.title !== "string" || typeof a.url !== "string") continue;
    if (!/^https?:\/\//i.test(a.url)) continue;
    const t = Date.parse(a.date);
    if (Number.isFinite(t) && t < cutoff) continue;
    const key = titleKey(a.title);
    if (!key) continue;
    const entry = {
      title: a.title.slice(0, 200),
      url: a.url.slice(0, 500),
      domain: a.domain || hostOf(a.url),
      date: Number.isFinite(t) ? new Date(t).toISOString() : null,
      origin: a.origin === "gdelt" ? "gdelt" : "news",
    };
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, entry);
      continue;
    }
    /* Keep the earliest known date, prefer an entry that has one at all. */
    const prevT = Date.parse(prev.date);
    if (Number.isFinite(t) && (!Number.isFinite(prevT) || t < prevT)) prev.date = entry.date;
  }
  return [...byKey.values()]
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .slice(0, maxItems);
}

/* Runs all collectors in parallel; never throws. */
export async function collectAll() {
  const [gdelt, news, nina] = await Promise.allSettled([
    collectGdelt(),
    collectNews(),
    collectNina(),
  ]);

  const errors = [];
  let gdeltArticles = [];
  let newsArticles = [];
  let warnings = [];

  if (gdelt.status === "fulfilled") gdeltArticles = gdelt.value;
  else errors.push(`gdelt: ${gdelt.reason?.message || gdelt.reason}`);

  if (news.status === "fulfilled") {
    newsArticles = news.value.articles;
    errors.push(...news.value.errors.map((e) => `feeds/${e}`));
  } else {
    errors.push(`feeds: ${news.reason?.message || news.reason}`);
  }

  if (nina.status === "fulfilled") {
    warnings = nina.value.warnings;
    errors.push(...nina.value.errors.map((e) => `nina/${e}`));
  } else {
    errors.push(`nina: ${nina.reason?.message || nina.reason}`);
  }

  /* GDELT first: its entries carry a real publication date, feed entries the
     date the feed reported them. */
  const articles = mergeArticles([], [...gdeltArticles, ...newsArticles], {
    maxItems: ARTICLE_ARCHIVE_MAX,
  });

  return {
    articles,
    warnings,
    errors,
    counts: { gdelt: gdeltArticles.length, news: newsArticles.length },
  };
}
