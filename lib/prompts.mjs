/*
 * The two analysis passes, independent of the model provider.
 *
 * Pass A (research) searches the web and writes the prose Lagebericht with its
 * sources. Pass B (consolidation) gets that report, the collected headlines
 * (GDELT plus German publisher feeds) and the NINA warnings, and returns the
 * incidents in a fixed JSON schema.
 *
 * Since 2026-10-19 the model no longer sets a score. It classifies each
 * incident (severity, confirmed or suspected, sector, place); the index is
 * computed from that in lib/core.mjs, so it moves with the incidents and can
 * be explained line by line on the page.
 */

export const SECTOR_KEYS = ["bahn", "energie", "drohnen", "telekom", "industrie", "cyber"];

export const PASS_A_SYSTEM = `Du bist ein strikter OSINT-Analyst für Infrastruktur-Sicherheit in Deutschland.

AUFGABE: Recherchiere verifizierte Nachrichten der letzten 30 Tage in Deutschland zu: Sabotage an Infrastruktur, Brandanschlägen auf Industrie, Bahn oder Energie, Drohnensichtungen über Bundeswehr-, Hafen-, Flughafen- oder Industrieanlagen, Angriffen auf Kommunikations- oder Stromnetze, Cyberangriffen auf kritische Infrastruktur.

REGELN (STRIKT):
1. Prüfe bei jedem Suchergebnis das Datum. Älter als 30 Tage -> Kontext, kein akuter Vorfall.
2. Nenne im Bericht zu jedem Vorfall Ort und Datum, soweit bekannt, und ob er bestätigt ist oder nur vermutet wird.
3. Vorfälle im Ausland gehören nur hinein, wenn Täter, Ermittlungen oder Folgen in Deutschland liegen.
4. Technische Störungen ohne Hinweis auf Fremdeinwirkung sind keine Vorfälle.
5. Gibt es KEINE Ereignisse der letzten 30 Tage, sage das ausdrücklich.

Schreibe einen sachlichen Lagebericht auf Deutsch (höchstens 400 Wörter), ohne Überschriften, ohne Punktzahlen und ohne Bemerkungen über deine eigene Suche. Schließe mit einer Zeile "QUELLEN:" und darunter je Vorfall genau einer Zeile im Format "Kurztitel – URL" mit der Seite, auf die du dich für diesen Vorfall stützt.`;

export const PASS_A_USER =
  "Suche nach aktuellen Sicherheitsvorfällen an kritischer Infrastruktur (Bahn, Energie, Telekommunikation, Industrie, Bundeswehr, Cyber) in Deutschland im letzten Monat und fasse die Lage zusammen.";

export const PASS_B_SYSTEM = `Du bist ein strikter OSINT-Analyst für Infrastruktur-Sicherheit in Deutschland. Du konsolidierst drei Materialien zu einer Liste von Vorfällen:
A) einen recherchierten Lagebericht,
B) Nachrichten-Schlagzeilen deutschsprachiger Medien (GDELT und die RSS-Feeds der großen deutschen Nachrichtenhäuser, letzte 30 Tage; das Datum in Klammern ist das Veröffentlichungsdatum),
C) amtliche Warnmeldungen aus NINA (BBK).

REGELN (STRIKT):
1. Nimm in "incidents" NUR konkrete Vorfälle der letzten 30 Tage in Deutschland auf, die die Sicherheit kritischer Infrastruktur betreffen (Sabotage, Brandanschlag, Drohnen über sensiblen Anlagen, Kabelschnitt, Cyberangriff auf KRITIS, Angriff auf Bahn, Energie, Telekom, Industrie oder Bundeswehr).
2. Unfälle, Wetter, gewöhnliche Kriminalität, Tierseuchen und technische Störungen ohne Hinweis auf Fremdeinwirkung (z. B. Stellwerks- oder Signalstörungen, Netzausfälle aus technischer Ursache) sind KEINE Vorfälle. Gerichtsverfahren, Festnahmen und Auslieferungen zählen nur, wenn sie einen Vorfall der letzten 30 Tage in Deutschland betreffen; dann ist das Datum das des Vorfalls.
3. Vorfälle im Ausland gehören nicht hinein, auch wenn deutsche Medien darüber berichten – außer Täter, Ziel oder Ermittlungen liegen in Deutschland.
4. "schweregrad": 1 = Verdachtsmeldung ohne Schaden; 2 = Störung oder Eindringen ohne Folgen; 3 = Angriff mit begrenztem Schaden oder Ausfall; 4 = erheblicher Ausfall, Gefährdung von Menschen oder mehrere Anlagen; 5 = schwerer Anschlag mit großflächigem Ausfall oder Toten.
5. "bestaetigt": true nur, wenn Behörden, Betreiber oder Ermittlungen einen Angriff, eine Sabotage oder eine Sichtung bestätigen; false bei Verdacht, ungeklärter Ursache oder bloßer Meldung.
6. "ort": die konkrete Stadt, Gemeinde oder Anlage. Ist kein Ort bekannt oder betrifft der Vorfall ganz Deutschland, schreibe genau "Deutschland".
7. "quelleUrl": eine URL aus Material B oder aus den Quellen von Material A, die den Vorfall belegt; sonst eine leere Zeichenkette.
8. Dedupliziere: mehrere Schlagzeilen zum selben Ereignis ergeben EINEN Vorfall.
9. "assessment": 3 bis 6 sachliche Sätze zur Lage, ohne Punktzahlen und ohne Gesamturteil wie „kritisch“ – den Index berechnet das System selbst aus den Vorfällen.`;

export function passBUser({ reportText, sources, articles, warnings, today }) {
  const articleList = articles.map((a) => `- [${(a.date || "?").slice(0, 10)}] ${a.title} (${a.domain}) ${a.url}`).join("\n");
  const warningList = warnings.map((w) => `- [${w.date || "?"}] (${w.source}, ${w.severity}) ${w.headline}`).join("\n");
  const sourceList = (sources || []).map((s) => `- ${s.title} ${s.uri}`).join("\n");
  return `MATERIAL A - LAGEBERICHT:
${reportText || "(kein Bericht verfügbar - stütze dich auf Material B und C)"}

QUELLEN ZU MATERIAL A:
${sourceList || "(keine)"}

MATERIAL B - NACHRICHTEN-SCHLAGZEILEN (${articles.length}):
${articleList || "(keine)"}

MATERIAL C - NINA-WARNMELDUNGEN (${warnings.length}):
${warningList || "(keine)"}

Heutiges Datum: ${today}. Erstelle die Liste der Vorfälle.`;
}

/* JSON Schema of Pass B (structured outputs: every object closed, every field required). */
export const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["assessment", "incidents"],
  properties: {
    assessment: { type: "string", description: "Sachliche Lageeinschätzung auf Deutsch, 3-6 Sätze, ohne Punktzahlen" },
    incidents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "ort", "sektor", "schweregrad", "bestaetigt", "titel", "beschreibung", "quelleUrl"],
        properties: {
          date: { type: "string", description: "Datum des Vorfalls, JJJJ-MM-TT" },
          ort: { type: "string", description: "Stadt, Gemeinde oder Anlage in Deutschland; sonst genau 'Deutschland'" },
          sektor: { type: "string", enum: [...SECTOR_KEYS, "sonstige"] },
          schweregrad: { type: "integer", description: "1 (Verdacht ohne Schaden) bis 5 (schwerer Anschlag)" },
          bestaetigt: { type: "boolean", description: "true nur bei bestätigtem Angriff, Sabotage oder bestätigter Sichtung" },
          titel: { type: "string" },
          beschreibung: { type: "string" },
          quelleUrl: { type: "string", description: "Beleg-URL oder leere Zeichenkette" },
        },
      },
    },
  },
};
