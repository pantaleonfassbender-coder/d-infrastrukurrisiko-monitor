/*
 * The two Gemini passes of a scan.
 *
 * Pass A ("grounded") runs Google-Search grounding and produces the prose
 * Lagebericht plus the grounded source list. Pass B ("structured") gets the
 * Lagebericht, the collected news headlines and the NINA warnings and must
 * answer in a fixed JSON schema — scores, sector scores and geocodable
 * incidents. The passes are separate because the Gemini API does not allow
 * combining the google_search tool with a JSON response schema in one call.
 *
 * The API key comes from the caller (a Netlify function reading
 * GEMINI_API_KEY); this module never touches the environment itself.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/* Ordered fallback. 404/429/5xx moves to the next candidate; anything else
   (bad key, bad request) aborts, because retrying cannot fix it. */
const MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.5-pro"];

export const SECTOR_KEYS = ["bahn", "energie", "drohnen", "telekom", "industrie", "cyber"];

const SCORE_RULES = `BERECHNUNG DES SCORES (0-100):
- 35-45 (BASELINE): Keine neuen Vorfälle in den letzten 30 Tagen, aber hohe abstrakte Gefahr (geopolitische Grundspannung).
- 50-70: Neue Warnhinweise, Drohnensichtungen, Verdachtsfälle in den letzten 30 Tagen.
- 75-100: Bestätigter, physischer Angriff auf Infrastruktur in den letzten 30 Tagen.
Ereignisse, die älter als 30 Tage sind, sind KONTEXT und erhöhen den Score nicht.`;

async function callModel(apiKey, payload) {
  let lastError = null;
  for (const model of MODEL_CANDIDATES) {
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p.text || "").join("");
      return { model, text, data };
    }
    let detail = "";
    try {
      detail = (await res.json())?.error?.message || "";
    } catch {
      /* body already consumed or not JSON */
    }
    lastError = new Error(`${model}: HTTP ${res.status} ${detail}`.trim());
    const retriable = res.status === 404 || res.status === 429 || res.status >= 500;
    if (!retriable) throw lastError;
  }
  throw lastError || new Error("no model candidates configured");
}

/* Pass A: grounded prose report. Returns { text, sources, model }. */
export async function groundedReport(apiKey) {
  const systemPrompt = `Du bist ein strikter OSINT-Analyst für Infrastruktur-Sicherheit in Deutschland.

AUFGABE: Suche nach verifizierten Nachrichten der letzten 30 Tage in Deutschland zu: Sabotage an Infrastruktur, Brandanschlägen auf Industrie/Bahn/Energie, Drohnensichtungen über Bundeswehr- oder Industrieanlagen, Angriffen auf Kommunikations- oder Stromnetze, Cyberangriffen auf kritische Infrastruktur.

REGELN (STRIKT):
1. Prüfe bei jedem Suchergebnis das Datum. Älter als 30 Tage -> Kontext, kein akuter Vorfall.
2. Nenne im Bericht zu jedem Vorfall Ort und Datum, soweit bekannt.
3. Gibt es KEINE Ereignisse der letzten 30 Tage, sage das ausdrücklich und beschreibe die Baseline-Lage.

Schreibe einen sachlichen Lagebericht auf Deutsch (max. 400 Wörter), ohne Markdown-Überschriften.`;

  const { model, text, data } = await callModel(apiKey, {
    contents: [
      {
        parts: [
          {
            text: "Suche nach aktuellen Sicherheitsvorfällen an kritischer Infrastruktur (Bahn, Energie, Telekommunikation, Industrie, Bundeswehr, Cyber) in Deutschland im letzten Monat und fasse die Lage zusammen.",
          },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .map((c) => c.web)
    .filter((w) => w && w.uri)
    .slice(0, 12)
    .map((w) => ({ uri: w.uri, title: w.title || w.uri, origin: "grounding" }));

  return { text: text.trim(), sources, model };
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "INTEGER", description: "Gesamt-Risiko-Index 0-100" },
    assessment: {
      type: "STRING",
      description: "Konsolidierter Lagebericht auf Deutsch, 3-6 Sätze",
    },
    sectors: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          key: { type: "STRING", enum: SECTOR_KEYS },
          score: { type: "INTEGER" },
        },
        required: ["key", "score"],
      },
    },
    incidents: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING", description: "ISO-Datum JJJJ-MM-TT" },
          ort: { type: "STRING", description: "Ort/Stadt in Deutschland" },
          lat: { type: "NUMBER" },
          lon: { type: "NUMBER" },
          sektor: { type: "STRING", enum: [...SECTOR_KEYS, "sonstige"] },
          schweregrad: { type: "INTEGER", description: "1 (gering) bis 5 (kritisch)" },
          titel: { type: "STRING" },
          beschreibung: { type: "STRING" },
          quelleUrl: { type: "STRING" },
        },
        required: ["date", "ort", "sektor", "schweregrad", "titel"],
      },
    },
  },
  required: ["score", "assessment", "sectors", "incidents"],
};

/* Pass B: structured consolidation. Returns { analysis, model }. */
export async function structuredAnalysis(apiKey, { reportText, articles, warnings, newsProvider }) {
  const articleList = articles
    .map((a) => `- [${a.date || "?"}] ${a.title} (${a.domain}) ${a.url}`)
    .join("\n");
  const warningList = warnings
    .map((w) => `- [${w.date || "?"}] (${w.source}, ${w.severity}) ${w.headline}`)
    .join("\n");

  const systemPrompt = `Du bist ein strikter OSINT-Analyst für Infrastruktur-Sicherheit in Deutschland. Du konsolidierst drei Materialien zu einem strukturierten Lagebild:
A) einen recherchierten Lagebericht,
B) Nachrichten-Schlagzeilen aus einer Medienrecherche (deutschsprachige Medien, letzte 30 Tage),
C) amtliche Warnmeldungen aus NINA (BBK).

REGELN (STRIKT):
1. Nimm in "incidents" NUR konkrete Vorfälle der letzten 30 Tage in Deutschland auf, die das Thema Infrastruktur-Sicherheit betreffen (Sabotage, Brandanschlag, Drohnen, Kabelschnitt, Cyberangriff auf KRITIS, Angriff auf Bahn/Energie/Telekom/Industrie/Bundeswehr).
2. Unfälle, Wetter, gewöhnliche Kriminalität und Tierseuchen sind KEINE Vorfälle in diesem Sinn.
3. Jeder Vorfall braucht Ort und Datum; lat/lon als ungefähre WGS84-Koordinaten des Ortes, wenn du sie kennst.
4. quelleUrl: wenn möglich eine URL aus Material B; sonst weglassen.
5. Dedupliziere: mehrere Schlagzeilen zum selben Ereignis ergeben EINEN Vorfall.
6. Sektor-Scores nach derselben Skala wie der Gesamtscore; Sektoren ohne Vorfälle bleiben auf Baseline (35-45).
${SCORE_RULES}`;

  const userText = `MATERIAL A - LAGEBERICHT:
${reportText || "(kein Bericht verfügbar - stütze dich auf Material B und C)"}

MATERIAL B - SCHLAGZEILEN AUS ${(newsProvider || "medienrecherche").toUpperCase()} (${articles.length}):
${articleList || "(keine)"}

MATERIAL C - NINA-WARNMELDUNGEN (${warnings.length}):
${warningList || "(keine)"}

Heutiges Datum: ${new Date().toISOString().slice(0, 10)}. Erstelle das strukturierte Lagebild.`;

  const { model, text } = await callModel(apiKey, {
    contents: [{ parts: [{ text: userText }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  return { analysis: JSON.parse(text), model };
}
