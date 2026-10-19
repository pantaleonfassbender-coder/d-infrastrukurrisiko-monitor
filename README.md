# Infrastruktur-Radar Deutschland (OSINT)

Tägliches Lagebild zur Sicherheit kritischer Infrastruktur in Deutschland:
Risiko-Index (35–100) mit Sektor-Aufschlüsselung, Index-Verlauf, Vorfallskarte
und belegtem Lagebericht. Statische Seite plus Netlify Functions; die
Modellzugänge bleiben serverseitig.

## Architektur

```
Browser ── GET /api/report ──────────► report.mjs ──► Netlify Blobs
        ── POST /api/scan/trigger ───► scan-trigger.mjs ─┐
                                                         ▼
Cron (05:30 UTC) ── scan-schedule.mjs ──► POST /api/scan/run (Background, 15 min)
                                              │ scan-run.mjs
                                              ├─ lib/sources.mjs   GDELT DOC 2.0 + deutsche News-RSS + NINA   ┐ parallel
                                              ├─ lib/llm.mjs       Pass A: Recherche mit Websuche              ┘
                                              │                    Pass B: strukturierte Vorfallsliste
                                              │   ├─ lib/claude.mjs   Claude (claude-opus-5-5) über das Netlify AI Gateway
                                              │   └─ lib/gemini.mjs   Gemini 2.5 als Rückfallebene
                                              ├─ lib/prompts.mjs   gemeinsame Prompts und JSON-Schema
                                              ├─ lib/core.mjs      Validierung, Index-Berechnung, Geocoding, Historie
                                              └─ Blobs: latest, history, articles, geocache, runstate
```

- **Der Index wird berechnet, nicht geschätzt** (Methode v3, seit 2026-10-19).
  Das Modell bestimmt nur die einzelnen Vorfälle: Schweregrad 1–5, bestätigt
  oder Verdacht, Sektor, Ort. `lib/core.mjs` rechnet daraus:
  Gewicht = Schweregrad-Gewicht (S1 2, S2 4, S3 8, S4 14, S5 22) × 1 bzw. 0,5
  (Verdacht) × ½ je 7 Tage Alter; Index = 35 + 65 × (1 − e^(−Summe/30));
  Sektoren gleich, mit Skala 15. Bis 2026-10-18 setzte das Modell den Wert
  selbst – er stand an 36 von 47 Tagen auf 75, weil fast immer irgendein
  bestätigter Angriff in 30 Tagen vorlag. Die Seite zeigt, welche Vorfälle den
  Index treiben, und markiert den Methodenwechsel im Verlauf.
- **Modelle:** Pass A (Recherche) und Pass B (Auswertung) laufen zuerst auf
  Claude, bei Ausfall auf Gemini (`lib/llm.mjs`). Claudes Websuche liefert die
  echten Artikel-URLs mit Zitatstellen; Gemini-Grounding-Links sind
  verfallende Weiterleitungen und werden beim Scan auf die Ziel-URL aufgelöst.
  Pass B nutzt Structured Outputs bzw. das Gemini-Antwortschema.
- **GDELT:** Der Sprachfilter heißt `sourcelang:german` (das Kürzel `ger`
  beantwortet GDELT mit HTTP 200 und „Invalid/Unsupported Language.“), und die
  Anfrage darf höchstens etwa neun Begriffe enthalten. Rechenzentrums-Adressen
  bekommen oft `HTTP 429`; der Collector versucht es sechsmal im Abstand von
  20 Sekunden. GDELT-Schlagzeilen laufen durch denselben Infrastruktur- und
  Auslandsfilter wie die RSS-Feeds; das 30-Tage-Archiv im Blob `articles`
  sammelt beide.
- **Karte:** Vorfälle ohne konkreten Ort („Deutschland“, „bundesweit“ …)
  stehen in der Liste, bekommen aber keinen Kartenpunkt im Landesmittelpunkt.
- Fehlgeschlagene Quellen und Modell-Rückfälle erscheinen als
  „Quellen-Hinweise“ auf der Seite.
- Der Worker drosselt sich selbst auf einen Lauf pro 10 Minuten.

## Deployment (Netlify)

1. Repo mit Netlify verbinden (Publish-Verzeichnis: Repo-Wurzel; Functions
   werden aus `netlify/functions` erkannt, Blobs brauchen keine Einrichtung).
2. Modellzugang:
   - **Claude:** Das Netlify AI Gateway injiziert `ANTHROPIC_API_KEY` und
     `ANTHROPIC_BASE_URL` in die Functions; nichts weiter zu tun. Alternativ
     einen eigenen `ANTHROPIC_API_KEY` setzen.
   - **Gemini** (Rückfall): `GEMINI_API_KEY`.
   - `LLM_PROVIDER=gemini` dreht die Reihenfolge um.
3. `SCAN_TOKEN` (empfohlen) — beliebiger zufälliger String; schützt
   `/api/scan/run` vor direkten Fremdaufrufen.
4. Deployen. Der Lauf kommt täglich um 05:30 UTC — oder sofort über den Button
   „Scan aktualisieren“. Welches Modell lief, steht unter „System Status“.

## Lokal

- `npm test` — Offline-Tests (`tests/core.test.mjs`, `tests/sources.test.mjs`,
  `tests/llm.test.mjs`).
- `python -m http.server 8123` und `http://localhost:8123/index.html?demo=1`
  — Layout-Prüfung mit eingebetteten Demo-Daten, ohne Functions.
- `netlify dev` (mit gesetzten Env-Variablen) für den vollen Stack.

## Quellen

- [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) — deutschsprachige Nachrichten, letzte 30 Tage (frei, ohne Key; strenges IP-Rate-Limit).
- RSS-Feeds deutscher Nachrichtenhäuser: tagesschau, ZDFheute, Deutschlandfunk, Spiegel, Zeit, FAZ, Süddeutsche, Welt, ntv, heise — gefiltert auf Infrastruktur-Sicherheit (`lib/sources.mjs`).
- [NINA-API des BBK](https://nina.api.bund.dev/) — MoWaS, Katwarn, Biwapp, Polizei (`warnung.bund.de/api31`).
- Recherche und Auswertung: Claude (Anthropic) mit Websuche; Rückfall Gemini 2.5 mit Google-Search-Grounding.
- [Nominatim](https://nominatim.org/release-docs/latest/api/Search/) — Geocoding der Vorfallsorte.
- Kartenmaterial: [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende; Leaflet liegt unter `assets/vendor/leaflet/` (Lizenz beiliegend).
