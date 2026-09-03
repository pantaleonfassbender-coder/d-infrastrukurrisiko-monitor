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
                                              │                    Pass B: responseSchema → Score/Sektoren/Vorfälle (quelleUrl Pflicht)
                                              ├─ lib/core.mjs      Validierung, Nominatim-Geocoding, Historie
                                              └─ Blobs: latest, history, geocache, runstate
```

- **Pass A** (Google-Search-Grounding) ist Anreicherung und darf scheitern;
  **Pass B** (strukturierte Konsolidierung von Lagebericht + GDELT + NINA) ist
  das Produkt und muss die Validierung in `lib/core.mjs` bestehen, sonst
  bleibt das vorige Lagebild stehen.
- **Quellenpflicht pro Vorfall**: `quelleUrl` ist Pflichtfeld im Pass-B-Schema
  und muss auf einen GDELT-Artikel dieses Laufs zeigen. `lib/core.mjs` prüft
  die zitierte URL gegen den GDELT-Pool (Host ohne `www.`, Pfad ohne
  Schrägstrich am Ende; Schema, Query und Fragment werden ignoriert) und
  speichert die URL des Collectors. Vorfälle ohne solchen Beleg fallen heraus
  und werden als `stats.unsourcedIncidents` ausgewiesen — Karte und
  Vorfallsliste enthalten damit nur Nachprüfbares. Liefert GDELT gar nichts,
  schlägt der Lauf ab und das vorige Lagebild bleibt stehen, statt ein
  unbelegtes „keine Vorfälle" zu veröffentlichen.
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

- `node tests/core.test.mjs` — Offline-Tests der Validierungsschicht.
- `python -m http.server 8123` und `http://localhost:8123/index.html?demo=1`
  — Layout-Prüfung mit eingebetteten Demo-Daten, ohne Functions.
- `netlify dev` (mit gesetzten Env-Variablen) für den vollen Stack.

## Quellen

- [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) — deutschsprachige Nachrichten, letzte 30 Tage (frei, ohne Key).
- [NINA-API des BBK](https://nina.api.bund.dev/) — MoWaS, Katwarn, Biwapp, Polizei (`warnung.bund.de/api31`).
- Google-Search-Grounding über die Gemini API (`gemini-2.5-flash`, Fallback `gemini-2.5-pro`).
- [Nominatim](https://nominatim.org/release-docs/latest/api/Search/) — Geocoding der Vorfallsorte.
- Kartenmaterial: [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende; Leaflet liegt unter `assets/vendor/leaflet/` (Lizenz beiliegend).
