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
                                              ├─ lib/sources.mjs   GDELT DOC 2.0 + deutsche News-RSS + NINA
                                              ├─ lib/gemini.mjs    Pass A: Such-Grounding (Lagebericht + Quellen)
                                              │                    Pass B: responseSchema → Score/Sektoren/Vorfälle
                                              ├─ lib/core.mjs      Validierung, Nominatim-Geocoding, Historie
                                              └─ Blobs: latest, history, articles, geocache, runstate
```

- **Pass A** (Google-Search-Grounding) ist Anreicherung und darf scheitern;
  **Pass B** (strukturierte Konsolidierung von Lagebericht + Schlagzeilen +
  NINA) ist das Produkt und muss die Validierung in `lib/core.mjs` bestehen,
  sonst bleibt das vorige Lagebild stehen.
- **Nachrichtenlage:** Die GDELT-DOC-API drosselt pro IP und antwortet
  Rechenzentrums-Adressen praktisch durchgehend mit `HTTP 429`. Der Collector
  versucht es viermal im Abstand von sechs Sekunden und meldet den Ausfall als
  kurzen Hinweis; die Nachrichtenlage tragen parallel die RSS-Feeds der großen
  deutschen Nachrichtenhäuser, gefiltert auf Infrastruktur-Vokabular. Da Feeds
  nur den aktuellen Tag zeigen, sammelt der Blob `articles` die Schlagzeilen zu
  einem rollierenden 30-Tage-Archiv; ein erfolgreicher GDELT-Lauf füllt es in
  einem Zug auf.
- Fehlgeschlagene Quellen erscheinen als „Quellen-Hinweise" auf der Seite — in
  Klartext, nicht im Wortlaut der jeweiligen API.
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

- `npm test` — Offline-Tests der Validierungs- und Collector-Schicht
  (`tests/core.test.mjs`, `tests/sources.test.mjs`).
- `python -m http.server 8123` und `http://localhost:8123/index.html?demo=1`
  — Layout-Prüfung mit eingebetteten Demo-Daten, ohne Functions.
- `netlify dev` (mit gesetzten Env-Variablen) für den vollen Stack.

## Quellen

- [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) — deutschsprachige Nachrichten, letzte 30 Tage (frei, ohne Key; strenges IP-Rate-Limit).
- RSS-Feeds deutscher Nachrichtenhäuser: tagesschau, ZDFheute, Deutschlandfunk, Spiegel, Zeit, FAZ, Süddeutsche, Welt, ntv, heise — Schlagzeile, Link und Datum, gefiltert auf Infrastruktur-Sicherheit (`lib/sources.mjs`).
- [NINA-API des BBK](https://nina.api.bund.dev/) — MoWaS, Katwarn, Biwapp, Polizei (`warnung.bund.de/api31`).
- Google-Search-Grounding über die Gemini API (`gemini-2.5-flash`, Fallback `gemini-2.5-pro`).
- [Nominatim](https://nominatim.org/release-docs/latest/api/Search/) — Geocoding der Vorfallsorte.
- Kartenmaterial: [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende; Leaflet liegt unter `assets/vendor/leaflet/` (Lizenz beiliegend).
