# Infrastruktur-Radar Deutschland (OSINT)

Tägliches Lagebild zur Sicherheit kritischer Infrastruktur in Deutschland:
Risiko-Index (0–100) mit Sektor-Aufschlüsselung, Score-Historie, Vorfallskarte
und belegtem Lagebericht. Statische Seite plus Netlify Functions; der
Gemini-Key bleibt serverseitig.

## Architektur

```
Browser ── GET /api/report ──────────► report.mjs ──► Netlify Blobs
        ── POST /api/scan/trigger ───► scan-trigger.mjs ─┐
                                                         ▼
Cron (05:30 UTC) ── scan-schedule.mjs ──► POST /api/scan/run (Background)
                                              │ scan-run.mjs
                                              ├─ lib/sources.mjs   GDELT DOC 2.0 + NINA (warnung.bund.de)
                                              ├─ lib/gemini.mjs    Pass A: Such-Grounding (Lagebericht + Quellen)
                                              │                    Pass B: responseSchema → Score/Sektoren/Vorfälle
                                              ├─ lib/core.mjs      Validierung, Nominatim-Geocoding, Historie
                                              └─ Blobs: latest, history, geocache, runstate
```

- **Pass A** (Google-Search-Grounding) ist Anreicherung und darf scheitern;
  **Pass B** (strukturierte Konsolidierung von Lagebericht + GDELT + NINA) ist
  das Produkt und muss die Validierung in `lib/core.mjs` bestehen, sonst
  bleibt das vorige Lagebild stehen.
- Baseline-Regel serverseitig erzwungen: ohne Vorfälle der letzten 30 Tage
  wird der Score auf 35–45 geklemmt.
- Geocoding: Modell-Koordinaten werden nur innerhalb Deutschlands akzeptiert,
  fehlende füllt Nominatim (gedrosselt, mit persistentem Cache).
- Der Worker drosselt sich selbst auf einen Lauf pro 10 Minuten.

## Deployment (Netlify)

1. Repo mit Netlify verbinden (Publish-Verzeichnis: Repo-Wurzel; Functions
   werden aus `netlify/functions` erkannt, Blobs brauchen keine Einrichtung).
2. Environment-Variablen setzen:
   - `GEMINI_API_KEY` (erforderlich) — Google-AI-Studio-Key, nur serverseitig.
   - `SCAN_TOKEN` (empfohlen) — beliebiger zufälliger String; schützt
     `/api/scan/run` vor direkten Fremdaufrufen. `scan-schedule` und
     `scan-trigger` reichen ihn automatisch weiter.
3. Deployen. Der erste Lauf kommt um 05:30 UTC — oder sofort über den Button
   „Scan aktualisieren" auf der Seite.

## Lokal

- `npm test` — Offline-Tests der Validierungs- und Collector-Schicht.
- `python -m http.server 8123` und `http://localhost:8123/index.html?demo=1`
  — Layout-Prüfung mit eingebetteten Demo-Daten, ohne Functions.
- `netlify dev` (mit gesetzten Env-Variablen) für den vollen Stack.

## Quellen

- [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) — deutschsprachige Nachrichten, letzte 30 Tage (frei, ohne Key).
  Drei Eigenheiten der API, die `lib/sources.mjs` abfedert: `sourcelang:`
  erwartet den Sprachnamen (`german`, **nicht** `ger` — sonst antwortet GDELT
  mit HTTP 200 und dem Klartext „Invalid/Unsupported Language."), die Query
  darf höchstens 250 Zeichen lang sein, und mehr als eine Anfrage pro fünf
  Sekunden quittiert GDELT mit „Please limit requests…". Alle drei Fehler
  kommen als Prosa statt als Statuscode, werden deshalb am Textkörper erkannt
  und bei Drosselung mit Backoff wiederholt.
- [NINA-API des BBK](https://nina.api.bund.dev/) — MoWaS, Katwarn, Biwapp, Polizei (`warnung.bund.de/api31`).
- Google-Search-Grounding über die Gemini API (`gemini-2.5-flash`, Fallback `gemini-2.5-pro`).
- [Nominatim](https://nominatim.org/release-docs/latest/api/Search/) — Geocoding der Vorfallsorte.
- Kartenmaterial: [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende; Leaflet liegt unter `assets/vendor/leaflet/` (Lizenz beiliegend).
