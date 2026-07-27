import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { GoogleGenAI } from "@google/genai";

// Gemini 3 Flash über das Netlify AI Gateway. Das Gateway injiziert
// GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL zur Laufzeit, daher kommt der
// zero-config Konstruktor ohne Secrets im Quelltext aus.
const MODEL = "gemini-3-flash-preview";
const SYNTHESIS_MAX_TOKENS = 8000;

// Gesamt-Zeitbudget der synchronen Function. Es liegt bewusst unter dem
// Plattform-Limit (60 s für synchrone Netlify Functions), damit die Function
// IMMER selbst eine JSON-Antwort liefert. Wird das Budget überschritten, bricht
// sonst die Plattform die Ausführung ab und schickt eine HTML-Fehlerseite
// (Status 504) an den Client – die dort zu „keine gültige JSON-Antwort" bzw.
// „Unexpected token '<'" führt, weil eine HTML-Antwort nicht als JSON geparst
// werden kann. Jeder potenziell langlaufende Schritt (Modellauswertung,
// optionale Datumsauflösung in Schritt 3b) wird an dieses Budget gekoppelt.
const SCAN_BUDGET_MS = 50_000;
// Puffer, der am Ende des Budgets für Serialisierung, Cache-Schreiben und die
// Antwort reserviert bleibt.
const RESPONSE_RESERVE_MS = 4_000;
// Zeit, die nach der Modellauswertung dem optionalen Datumsabgleich (Schritt 3b)
// vorbehalten bleibt. Die Modellauswertung erhält entsprechend weniger Budget,
// damit für die Quellenauflösung noch Zeit übrig ist.
const DATE_RESOLUTION_RESERVE_MS = 9_000;
// Obergrenze einer einzelnen Quellenauflösung (zwei HTTP-Aufrufe à 4 s). Es wird
// keine neue Auflösung mehr gestartet, wenn sie das Zeitbudget reißen könnte.
const RESOLVE_MAX_MS = 9_000;

// Ergebnis-Cache: der letzte Lagebericht je Region liegt unter dem
// regionsspezifischen Schlüssel und wird von /api/scan-status ausgeliefert,
// damit wiederkehrende Besucher sofort den jüngsten Stand sehen, ohne einen
// neuen Modelllauf auszulösen.
const SCAN_STORE = "scans";

// Nur Meldungen der letzten 30 Tage gelten als aktueller Vorfall.
const WINDOW_DAYS = 30;
// Obergrenze der an das Modell übergebenen Artikel, damit der Prompt kompakt
// bleibt und die Klassifikation schnell und günstig ist.
const MAX_ARTICLES = 45;

// -----------------------------------------------------------------------------
// Regionen
// -----------------------------------------------------------------------------
// Der Monitor deckt drei Fokusgebiete in je eigenen Tabs ab: Deutschland
// (deutschsprachige Quellen inkl. Tagesschau) sowie zwei englischsprachige
// Auswertungen für das Baltikum & Polen und die übrige EU. Jede Region hat
// eigene Suchanfragen, einen eigenen Nachrichten-Locale und einen eigenen
// Cache-Schlüssel; das Ausgabeschema und die deutschsprachige Zusammenfassung
// bleiben identisch, damit die Oberfläche unverändert rendert.

type RegionId = "de" | "baltics-poland" | "eu";

interface NewsLocale {
  hl: string;
  gl: string;
  ceid: string;
}

interface RegionConfig {
  id: RegionId;
  label: string;
  cacheKey: string;
  locale: NewsLocale;
  queries: string[];
  includeTagesschau: boolean;
  // Kurzbeschreibung des geografischen Fokus für den System-Prompt.
  scope: string;
  // Beschreibung der Quellenlage für den User-Prompt.
  sourcesLabel: string;
}

const LOCALE_DE: NewsLocale = { hl: "de", gl: "DE", ceid: "DE:de" };
const LOCALE_EN: NewsLocale = { hl: "en-US", gl: "US", ceid: "US:en" };

const REGIONS: Record<RegionId, RegionConfig> = {
  de: {
    id: "de",
    label: "Deutschland",
    // Bestehender Schlüssel bleibt erhalten, damit ein vorhandener Cache gilt.
    cacheKey: "latest",
    locale: LOCALE_DE,
    includeTagesschau: true,
    scope: "Deutschland",
    sourcesLabel: "Google News (deutschsprachig) und der Tagesschau",
    queries: [
      "Sabotage kritische Infrastruktur Deutschland",
      "Drohnensichtung Bundeswehr Kaserne",
      "Anschlag Bahn Kabel Sabotage",
      "Cyberangriff Stadtwerke Versorger Deutschland",
      "Brandanschlag Umspannwerk Strommast",
      "Angriff Wasserversorgung Telekommunikation Deutschland",
    ],
  },
  "baltics-poland": {
    id: "baltics-poland",
    label: "Baltikum & Polen",
    cacheKey: "latest-baltics-poland",
    locale: LOCALE_EN,
    includeTagesschau: false,
    scope:
      "die baltischen Staaten (Estland, Lettland, Litauen) und Polen. Die zugrunde liegenden Nachrichten sind englischsprachig",
    sourcesLabel: "englischsprachigen Google-News-Quellen",
    queries: [
      "critical infrastructure sabotage Baltic states Poland",
      "undersea cable damage Baltic Sea sabotage",
      "drone sighting military base Poland Lithuania Estonia Latvia",
      "cyberattack energy utility Poland Baltic states",
      "railway sabotage Poland arson attack",
      "GPS jamming Baltic Sea Kaliningrad hybrid threat",
    ],
  },
  eu: {
    id: "eu",
    label: "Restliche EU",
    cacheKey: "latest-eu",
    locale: LOCALE_EN,
    includeTagesschau: false,
    scope:
      "die übrige Europäische Union (ausdrücklich OHNE Deutschland, die baltischen Staaten und Polen). Die zugrunde liegenden Nachrichten sind englischsprachig",
    sourcesLabel: "englischsprachigen Google-News-Quellen",
    queries: [
      "critical infrastructure sabotage European Union",
      "undersea cable pipeline sabotage Europe",
      "drone sighting airport military Europe hybrid threat",
      "cyberattack energy grid utility Europe",
      "arson attack railway signalling Europe sabotage",
      "espionage sabotage critical infrastructure France Italy Spain Netherlands",
    ],
  },
};

function resolveRegion(id: unknown): RegionConfig {
  return REGIONS[(id as RegionId)] ?? REGIONS.de;
}

function buildSystemPrompt(region: RegionConfig): string {
  return `Du bist ein OSINT-Analyst für die Sicherheit kritischer Infrastruktur. Dein geografischer Fokus in diesem Durchlauf: ${region.scope}.

AUFGABE: Bewerte AUSSCHLIESSLICH die dir übergebene Liste echter Nachrichtenartikel. Recherchiere nicht selbst und erfinde keine Artikel. Identifiziere daraus verifizierte Sicherheitsvorfälle der letzten 30 Tage im genannten Fokusgebiet. Fokus: Sabotage an Infrastruktur, Brandanschläge auf Industrie/Bahn, Drohnensichtungen über Militär oder kritischer Infrastruktur, Angriffe auf Bahnanlagen, Cyberangriffe auf Versorger (Strom, Wasser, Telekommunikation), Beschädigung von Seekabeln/Pipelines, GPS-Störungen und sonstige hybride Bedrohungen.

STRIKTE REGELN:
1. Jeder gemeldete Vorfall MUSS als "sourceUrl" exakt eine der URLs aus der übergebenen Artikelliste verwenden. Verwende niemals eine URL, die nicht in der Liste steht.
2. Nimm nur Vorfälle auf, die durch einen Artikel belegt sind und die letzten 30 Tage betreffen. Ältere Ereignisse sind Kontext, kein akuter Vorfall.
3. Gib für jeden Vorfall ein möglichst genaues Datum ("YYYY-MM-DD") und den Ort im Fokusgebiet an. Nutze dafür das Veröffentlichungsdatum bzw. den Inhalt des Artikels. Verwirf Meldungen, die außerhalb des Fokusgebiets liegen.
4. Nicht jeder Artikel ist ein sicherheitsrelevanter Vorfall. Verwirf themenfremde Treffer (Sport, Politik ohne Infrastrukturbezug, Wirtschaft allgemein). Findest du keine belegten Vorfälle, gib eine leere Liste zurück.
5. REFERENZIERUNG IM LAGEBERICHT: Nenne Quellen im "summary" IMMER einheitlich mit ihrem Medien-/Quellennamen im Fließtext (z.B. „laut Tagesschau", „wie der NDR berichtet", „einer Meldung von Reuters zufolge"). Verwende NIEMALS die laufende Nummer aus der Artikelliste und schreibe NIEMALS „(Quelle 3)", „Quelle 5" o.Ä. Die Nummerierung der übergebenen Liste dient nur deiner internen Zuordnung und ist dem Leser nicht sichtbar.

BERECHNUNG DES RISIKO-SCORES (0-100):
- 35-45 (BASELINE): Keine neuen Vorfälle, aber anhaltende hybride Bedrohungslage (Status Quo).
- 50-70: Neue Warnhinweise, Drohnensichtungen oder Verdachtsfälle innerhalb der letzten 30 Tage.
- 75-100: Bestätigter, physischer Angriff innerhalb der letzten 30 Tage.

AUSGABEFORMAT: Antworte mit GENAU EINEM JSON-Objekt und keinem weiteren Text davor oder danach. Der Lagebericht ("summary") ist stets DEUTSCHSPRACHIG, auch wenn die Quellen englischsprachig sind. Schema:
{
  "score": <ganze Zahl 0-100>,
  "level": "RUHIG" | "LATENT" | "KRITISCH",
  "summary": "<deutschsprachiger Lagebericht; nennt Quellen einheitlich mit ihrem Medien-/Quellennamen im Fließtext, niemals als laufende Nummer (Quelle X)>",
  "incidents": [
    {
      "title": "<kurzer Titel>",
      "location": "<Stadt/Region/Land>",
      "date": "<YYYY-MM-DD>",
      "severity": "niedrig" | "mittel" | "hoch",
      "category": "<z.B. Bahn, Energie, Militär, Cyber, Industrie, Seekabel>",
      "description": "<1-2 Sätze>",
      "sourceUrl": "<eine der übergebenen Artikel-URLs>",
      "sourceTitle": "<Titel des Artikels>"
    }
  ]
}
Wenn keine belegbaren Vorfälle der letzten 30 Tage vorliegen: "incidents": [] und ein Score zwischen 35 und 40. Der Score muss zur Anzahl und Schwere der gefundenen Vorfälle passen.`;
}

// -----------------------------------------------------------------------------
// Nachrichtenbeschaffung (deterministisch, ohne Modell)
// -----------------------------------------------------------------------------

interface Article {
  title: string;
  url: string;
  source: string;
  pubDate: string; // ISO-String, sofern parsebar
}

// Gezieltes Query-Set je Region für den schlüsselfreien Google-News-RSS-
// Suchfeed. Jede Query liefert echte, datierte, verlinkte Treffer. Die
// Queries stehen in der jeweiligen RegionConfig (siehe oben) und sind der
// zentrale Qualitätshebel.
function googleNewsUrl(query: string, locale: NewsLocale): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}`;
}

// Der allgemeine Tagesschau-Feed. Er ist thematisch breit, daher werden seine
// Treffer unten per Stichwort auf sicherheitsrelevante Themen gefiltert, bevor
// sie an das Modell gehen.
const TAGESSCHAU_FEED = "https://www.tagesschau.de/index~rss2.xml";

const TAGESSCHAU_KEYWORDS = [
  "sabotage", "drohne", "drohnen", "anschlag", "brandanschlag", "cyber",
  "cyberangriff", "hacker", "bahn", "gleis", "kabel", "umspannwerk",
  "strommast", "stromausfall", "kritische infrastruktur", "bundeswehr",
  "kaserne", "wasserversorgung", "versorger", "stadtwerke", "pipeline",
  "spionage", "hybrid",
];

function stripCdata(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? stripCdata(m[1]) : "";
}

// Leichtgewichtiger RSS-2.0-Parser. Kein XML-Framework nötig; das Parsing ist
// bewusst tolerant, damit ein leicht abweichender Feed keinen Abbruch erzeugt.
function parseRss(xml: string): Article[] {
  const items: Article[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title = tag(block, "title");
    const link = tag(block, "link");
    if (!title || !link) continue;
    const pub = tag(block, "pubDate");
    const parsed = pub ? new Date(pub) : null;
    // Google News hängt die Quelle als "… - Quelle" an bzw. liefert <source>.
    const source = tag(block, "source") || hostOf(link);
    items.push({
      title,
      url: link,
      source,
      pubDate: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : "",
    });
  }
  return items;
}

async function fetchFeed(url: string): Promise<Article[]> {
  const res = await fetch(url, {
    headers: {
      // Ein UA-String vermeidet, dass manche Feeds eine leere Anfrage abweisen.
      "User-Agent": "Infrastruktur-Radar/1.0 (+netlify function)",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Feed ${hostOf(url)} antwortete mit ${res.status}`);
  const xml = await res.text();
  return parseRss(xml);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// -----------------------------------------------------------------------------
// Datumsabgleich: echtes Veröffentlichungsdatum der Quelle bestimmen
// -----------------------------------------------------------------------------
// Das im Feed gelieferte Datum (Google-News-`pubDate`) spiegelt oft nur den
// Zeitpunkt wider, zu dem eine Meldung im Suchfeed erschien – nicht die
// Erstveröffentlichung auf der Publisher-Seite. Ältere Artikel werden dadurch
// mit einem zu jungen Datum "hochgespült". Die folgenden Helfer rufen die
// verlinkte Seite auf, lösen eine etwaige Google-News-Weiterleitung auf die
// echte Publisher-URL auf und lesen deren ausgewiesenes Veröffentlichungsdatum.

// Browserähnlicher User-Agent, damit Publisher-Seiten und die Google-News-
// Weiterleitung serverseitig ausgeliefert werden (viele Seiten verweigern
// sonst die Antwort an nackte Bots).
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Google-eigene Hosts (News-Redirect, Consent, Assets sowie Analytics, Tag
// Manager und Werbung), die keine echte Artikelseite darstellen. Wichtig:
// google-analytics.com und googletagmanager.com matchen NICHT auf "google.*"
// (das "google" ist dort nicht durch einen Punkt begrenzt) und müssen daher
// ausdrücklich aufgeführt werden – sonst würde ein in einer Interstitial-Seite
// eingebettetes gtag-/Analytics-Skript fälschlich als Publisher-URL übernommen.
function isGoogleHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|googletagmanager\.com|google-analytics\.com|googleadservices\.com|googlesyndication\.com|doubleclick\.net)$/i.test(
      h,
    );
  } catch {
    return false;
  }
}

// Weitere Hosts, die zwar in Interstitial-/Publisher-HTML verlinkt sind, aber
// nie den eigentlichen Artikel darstellen (Tracking, Social, CDN/Assets).
const NON_ARTICLE_HOST =
  /(^|\.)(schema\.org|w3\.org|youtube\.com|youtu\.be|ampproject\.org|facebook\.com|twitter\.com|x\.com|linkedin\.com|instagram\.com|pinterest\.com|tiktok\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/i;

// Statische Assets (Skripte, Styles, Bilder, Feeds …) – niemals ein Artikel.
const ASSET_PATH =
  /\.(?:js|mjs|css|json|xml|rss|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|mp3|zip)(?:$|\?)/i;

// Grobe Plausibilitätsprüfung: Zeigt eine URL auf eine echte Artikelseite und
// nicht auf ein Tracking-Skript, ein statisches Asset oder eine bekannte
// Nicht-Artikel-Domain? Dies ist die zentrale Schutzschicht dagegen, dass ein
// eingebettetes gtag.js/analytics.js als „Quelle" beim Nutzer landet.
function looksLikeArticleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (isGoogleHost(url) || NON_ARTICLE_HOST.test(parsed.hostname)) return false;
  if (ASSET_PATH.test(parsed.pathname)) return false;
  return true;
}

// Aus einer Google-News-Interstitial-Seite die erste echte Publisher-URL ziehen.
// Es werden nur artikelartige URLs akzeptiert; Tracking-Skripte, Assets und
// Nicht-Artikel-Domains (Google, Analytics, Social, CDN) werden übersprungen.
function extractPublisherUrl(html: string): string {
  const hrefs = html.match(/href="(https?:\/\/[^"]+)"/gi) || [];
  for (const raw of hrefs) {
    const m = raw.match(/href="(https?:\/\/[^"]+)"/i);
    if (!m) continue;
    const u = m[1].replace(/&amp;/g, "&");
    if (!looksLikeArticleUrl(u)) continue;
    return u;
  }
  return "";
}

// Das tatsächliche Veröffentlichungsdatum aus dem HTML einer Artikelseite lesen.
// Reihenfolge nach Verlässlichkeit: strukturierte Metadaten vor <time>.
function extractPublishedDate(html: string): string {
  const toIso = (raw: string): string => {
    const d = new Date(raw.trim());
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  };
  const metaTags = html.match(/<meta[^>]+>/gi) || [];
  const wanted =
    /(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|datePublished|date|dc\.date(?:\.issued)?|pubdate|publishdate|sailthru\.date)["']/i;
  for (const tagStr of metaTags) {
    if (!wanted.test(tagStr)) continue;
    const c = tagStr.match(/content=["']([^"']+)["']/i);
    if (c) {
      const iso = toIso(c[1]);
      if (iso) return iso;
    }
  }
  const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  if (ld) {
    const iso = toIso(ld[1]);
    if (iso) return iso;
  }
  const t = html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  if (t) {
    const iso = toIso(t[1]);
    if (iso) return iso;
  }
  return "";
}

async function fetchHtml(
  url: string,
): Promise<{ finalUrl: string; html: string } | null> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(4_000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  return { finalUrl: res.url || url, html };
}

// Löst eine (ggf. über Google News umgeleitete) Quell-URL auf die echte
// Publisher-Seite auf und liest deren Veröffentlichungsdatum. Schlägt etwas
// fehl, wird sauber auf die Ausgangs-URL bzw. ein leeres Datum zurückgefallen –
// der Abgleich verschlechtert also nie das bestehende Verhalten.
async function resolveSource(
  originalUrl: string,
): Promise<{ url: string; publishedDate: string }> {
  try {
    let page = await fetchHtml(originalUrl);
    if (!page) return { url: originalUrl, publishedDate: "" };
    if (isGoogleHost(page.finalUrl)) {
      const publisher = extractPublisherUrl(page.html);
      if (publisher) {
        const next = await fetchHtml(publisher).catch(() => null);
        if (next) page = next;
        else return { url: publisher, publishedDate: "" };
      }
    }
    const url = isGoogleHost(page.finalUrl) ? originalUrl : page.finalUrl;
    return { url, publishedDate: extractPublishedDate(page.html) };
  } catch {
    return { url: originalUrl, publishedDate: "" };
  }
}

// Läuft eine Liste mit begrenzter Nebenläufigkeit ab, damit weder das
// Funktions-Zeitbudget noch die Zielserver überlastet werden.
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
}

function withinWindow(article: Article, now: number): boolean {
  if (!article.pubDate) return true; // Datum unbekannt: nicht vorschnell verwerfen
  const t = new Date(article.pubDate).getTime();
  if (Number.isNaN(t)) return true;
  return now - t <= WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

function isTagesschauRelevant(article: Article): boolean {
  const hay = article.title.toLowerCase();
  // Wortgrenzen verhindern Teilstring-Fehltreffer (z.B. "hybrid" in
  // "Hybridrasen" oder "bahn" in "Autobahn").
  return TAGESSCHAU_KEYWORDS.some((kw) =>
    new RegExp(`\\b${kw}\\b`, "i").test(hay),
  );
}

// Alle Feeds parallel abrufen, zusammenführen, auf das Zeitfenster filtern und
// per URL/Titel deduplizieren. Einzelne fehlschlagende Feeds beenden den Scan
// nicht (Promise.allSettled), damit ein wackeliger Feed nie den ganzen Lauf
// scheitern lässt.
async function collectArticles(
  region: RegionConfig,
): Promise<{ articles: Article[]; feedsOk: number }> {
  const now = Date.now();
  const tasks = [
    ...region.queries.map((q) => ({
      url: googleNewsUrl(q, region.locale),
      tagesschau: false,
    })),
    ...(region.includeTagesschau
      ? [{ url: TAGESSCHAU_FEED, tagesschau: true }]
      : []),
  ];

  const settled = await Promise.allSettled(
    tasks.map(async (t) => {
      const items = await fetchFeed(t.url);
      return t.tagesschau ? items.filter(isTagesschauRelevant) : items;
    }),
  );

  let feedsOk = 0;
  const seen = new Map<string, Article>();
  for (const r of settled) {
    if (r.status !== "fulfilled") {
      console.error("scan: Feed fehlgeschlagen:", (r.reason as any)?.message || r.reason);
      continue;
    }
    feedsOk++;
    for (const a of r.value) {
      if (!withinWindow(a, now)) continue;
      const key = a.url || a.title;
      if (!seen.has(key)) seen.set(key, a);
    }
  }

  const articles = [...seen.values()]
    .sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""))
    .slice(0, MAX_ARTICLES);

  return { articles, feedsOk };
}

// -----------------------------------------------------------------------------
// Klassifikation (Gemini) + JSON-Auswertung
// -----------------------------------------------------------------------------

function buildUserPrompt(articles: Article[], region: RegionConfig): string {
  const list = articles
    .map((a, i) => {
      const date = a.pubDate ? a.pubDate.slice(0, 10) : "Datum unbekannt";
      return `${i + 1}. [${date}] ${a.title} — Quelle: ${a.source} — URL: ${a.url}`;
    })
    .join("\n");

  return `Fokusgebiet: ${region.scope}. Hier ist die aktuelle Artikelliste aus ${region.sourcesLabel} (${articles.length} Treffer der letzten ${WINDOW_DAYS} Tage). Werte AUSSCHLIESSLICH diese Artikel aus und gib das finale JSON-Objekt gemäß Schema aus (kein Text davor oder danach):

${list}

Denke daran: Jeder gemeldete Vorfall MUSS als "sourceUrl" exakt eine der obigen URLs verwenden. Verwirf themenfremde Artikel und Meldungen außerhalb des Fokusgebiets. Der Lagebericht ("summary") ist deutschsprachig und nennt Quellen einheitlich mit ihrem Medien-/Quellennamen (z.B. „laut Tagesschau"), niemals als laufende Nummer wie „(Quelle 3)". Findest du keinen belegten akuten Vorfall, gib "incidents": [] mit einem Baseline-Score (35-40) aus und beschreibe in "summary" transparent, dass die Artikel ausgewertet wurden, aber kein akuter Vorfall belegt ist.`;
}

function parseAnalysis(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Keine JSON-Analyse in der Modellantwort gefunden.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function buildBaseline(articleCount: number, reason: string, region: RegionConfig) {
  return {
    score: 38,
    level: "LATENT" as const,
    summary:
      `Automatischer Baseline-Lagebericht (${region.label}): ${reason} ` +
      `Es besteht die anhaltende, latente hybride Bedrohungslage für kritische Infrastruktur im Fokusgebiet ${region.scope}; ` +
      `ein akuter, durch Quellen belegter Vorfall der letzten ${WINDOW_DAYS} Tage konnte in diesem Durchlauf nicht bestätigt werden.` +
      (articleCount > 0 ? ` (${articleCount} Artikel ausgewertet.)` : ""),
    incidents: [] as any[],
  };
}

// -----------------------------------------------------------------------------
// Funktion: synchron. Ein Request, eine Antwort (~5-15s), kein Polling mehr.
// -----------------------------------------------------------------------------
export default async (req: Request, _context: Context) => {
  const startedAt = Date.now();
  const store = getStore({ name: SCAN_STORE, consistency: "strong" });

  // Region aus dem Request-Body lesen (Default: Deutschland). Ein unbekannter
  // Wert fällt sicher auf "de" zurück.
  let region: RegionConfig = REGIONS.de;
  try {
    const body = await req.json();
    region = resolveRegion(body?.region);
  } catch {
    /* Kein/ungültiger Body → Standardregion Deutschland. */
  }

  try {
    // 1) Nachrichten deterministisch beschaffen.
    const { articles, feedsOk } = await collectArticles(region);

    // Quellenliste für die UI: die tatsächlich abgerufenen, echten Artikel.
    const sources = articles.map((a) => ({ url: a.url, title: a.title }));
    const sourceUrls = new Set(sources.map((s) => s.url));
    const sourceHosts = new Set(sources.map((s) => hostOf(s.url)));

    // 2) Klassifikation durch Gemini – reine Inferenz über mitgelieferten Text,
    //    voll über das AI Gateway unterstützt (keine serverseitigen Tools).
    let analysis: any;
    let degraded = false;

    if (feedsOk === 0) {
      // Kein einziger Feed erreichbar → transparenter Baseline-Bericht statt Fehler.
      degraded = true;
      analysis = buildBaseline(0, "Es konnten keine Nachrichten-Feeds abgerufen werden.", region);
    } else {
      const ai = new GoogleGenAI({});
      // Der Modellaufruf ist der einzige potenziell langlaufende Schritt und wird
      // deshalb hart an das verbleibende Zeitbudget gekoppelt. Ohne dieses Limit
      // kann ein langsames oder kaltes AI Gateway die Function bis zum
      // Plattform-Limit blockieren – die Plattform antwortet dann mit einer
      // HTML-504-Seite statt JSON. `abortSignal` bricht clientseitig ab,
      // `httpOptions.timeout` ist der SDK-eigene Timeout; beide greifen deutlich
      // vor dem Plattform-Limit. Läuft die Auswertung in dieses Limit oder ist
      // das Gateway nicht erreichbar, wird transparent auf einen Baseline-Bericht
      // zurückgefallen – die echten, bereits abgerufenen Quellen bleiben sichtbar.
      const modelDeadline =
        startedAt + SCAN_BUDGET_MS - RESPONSE_RESERVE_MS - DATE_RESOLUTION_RESERVE_MS;
      const modelTimeoutMs = Math.max(8_000, modelDeadline - Date.now());
      try {
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: buildUserPrompt(articles, region),
          config: {
            systemInstruction: buildSystemPrompt(region),
            maxOutputTokens: SYNTHESIS_MAX_TOKENS,
            temperature: 0.2,
            responseMimeType: "application/json",
            abortSignal: AbortSignal.timeout(modelTimeoutMs),
            httpOptions: { timeout: modelTimeoutMs },
          },
        });
        analysis = parseAnalysis(response.text ?? "");
      } catch (modelError: any) {
        degraded = true;
        const msg = String(modelError?.message ?? modelError ?? "");
        const timedOut =
          modelError?.name === "AbortError" ||
          modelError?.name === "TimeoutError" ||
          /abort|timed?\s*out|timeout|deadline/i.test(msg);
        const reason = timedOut
          ? `Die KI-Auswertung überschritt das Zeitlimit dieses Durchlaufs (${Math.round(modelTimeoutMs / 1000)} s).`
          : "Die KI-Auswertung war in diesem Durchlauf nicht erreichbar (das AI Gateway ist erst nach mindestens einem Produktions-Deployment aktiv).";
        console.error("scan: Modellauswertung fehlgeschlagen:", msg);
        analysis = buildBaseline(articles.length, reason, region);
      }
    }

    // 3) Jeden Vorfall gegen die echten Artikel-URLs als "verified" markieren.
    const incidents = Array.isArray(analysis.incidents) ? analysis.incidents : [];
    for (const inc of incidents) {
      const url: string = inc.sourceUrl || "";
      inc.verified = !!url && (sourceUrls.has(url) || sourceHosts.has(hostOf(url)));
    }

    // 3b) DATUMSABGLEICH: Für jeden Vorfall die verlinkte Quelle aufrufen, die
    //     (ggf. über Google News umgeleitete) Publisher-URL auflösen und das
    //     dort ausgewiesene Veröffentlichungsdatum lesen. Weicht es vom Datum
    //     ab, das aus Feed/Modell stammt, wird das quellenverifizierte Datum
    //     übernommen (der ursprüngliche Wert bleibt als "reportedDate" erhalten).
    //     Zusätzlich wird – wenn möglich – die direkte Publisher-URL statt der
    //     Google-News-Weiterleitung verlinkt. Der Abgleich läuft erst auf der
    //     kleinen Vorfallsliste (nicht auf allen Artikeln), damit das synchrone
    //     Zeitbudget der Funktion eingehalten wird.
    let dateAdjustments = 0;
    let dateResolutionSkipped = 0;
    await mapLimit(incidents, 6, async (inc: any) => {
      const url: string = inc.sourceUrl || "";
      if (!url) return;
      // Zeitbudget wahren: Es wird keine neue Auflösung mehr begonnen, wenn sie
      // (inkl. ihrer eigenen Obergrenze RESOLVE_MAX_MS und der Antwort-Reserve)
      // das Gesamtbudget reißen könnte. Der Vorfall behält dann sein vom
      // Modell/Feed gemeldetes Datum und die ursprüngliche Quell-URL.
      if (Date.now() > startedAt + SCAN_BUDGET_MS - RESPONSE_RESERVE_MS - RESOLVE_MAX_MS) {
        dateResolutionSkipped++;
        return;
      }
      const { url: resolvedUrl, publishedDate } = await resolveSource(url);
      // Nur übernehmen, wenn die aufgelöste URL plausibel ein Artikel ist –
      // sonst bliebe im Zweifel ein Tracking-Skript/Asset als Quelle hängen.
      if (resolvedUrl && looksLikeArticleUrl(resolvedUrl)) inc.sourceUrl = resolvedUrl;
      if (!publishedDate) return;
      const pub = publishedDate.slice(0, 10);
      inc.publishedDate = pub;
      inc.dateVerified = true;
      if (inc.date && inc.date !== pub) {
        inc.reportedDate = inc.date;
        inc.date = pub;
        inc.dateAdjusted = true;
        dateAdjustments++;
      } else if (!inc.date) {
        inc.date = pub;
      }
    });

    if (dateResolutionSkipped > 0) {
      console.warn(
        `scan: Datumsauflösung für ${dateResolutionSkipped} Vorfall/Vorfälle wegen Zeitbudget übersprungen.`,
      );
    }

    // Anhand des verifizierten Datums die von Google News wieder hochgespülten
    // Altmeldungen entfernen, die außerhalb des 30-Tage-Fensters liegen. Ohne
    // verifiziertes Datum bleibt ein Vorfall erhalten (nicht vorschnell verwerfen).
    const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const finalIncidents = incidents.filter((inc: any) => {
      if (!inc.publishedDate) return true;
      const t = new Date(inc.publishedDate).getTime();
      return Number.isNaN(t) || t >= cutoff;
    });
    const staleRemoved = incidents.length - finalIncidents.length;

    const result = {
      region: region.id,
      score: analysis.score ?? 38,
      level: analysis.level ?? "LATENT",
      summary: analysis.summary ?? "",
      incidents: finalIncidents,
      sources,
      degraded,
      dateAdjustments,
      staleRemoved,
      model: MODEL,
      generatedAt: new Date().toISOString(),
    };

    // 4) Als jüngsten Stand der Region cachen und direkt zurückgeben.
    await store.setJSON(region.cacheKey, { status: "done", result });

    return Response.json(result);
  } catch (error: any) {
    const message = error?.message || "Unbekannter Fehler bei der Analyse.";
    console.error("scan:", message);
    return Response.json(
      {
        error:
          "Die Analyse ist fehlgeschlagen: " +
          message +
          " Bitte erneut versuchen. Hinweis: Das AI Gateway ist erst nach mindestens einem Produktions-Deployment aktiv.",
      },
      { status: 502 },
    );
  }
};

export const config: Config = {
  path: "/api/scan",
  method: "POST",
};
