# Infrastruktur-Radar (OSINT)

Ein Lagebild zu Angriffen auf kritische Infrastruktur — Sabotage, Brandanschläge, Drohnensichtungen, Cyberangriffe auf Versorger, beschädigte Seekabel, GPS-Störungen — für **Deutschland**, **Baltikum & Polen** und die **übrige EU**, jeweils aus den letzten 30 Tagen und jeder Vorfall an eine belegte Quelle gebunden.

Statische Seite mit vier Netlify-Functions; der eigentliche Lauf passiert im Hintergrund. Beigelegt ist die Präsentation [`infrastruktur-und-sabotage.pdf`](infrastruktur-und-sabotage.pdf), aus der die Themeneinführung stammt.

> **Was das nicht ist.** Eine automatische Auswertung öffentlicher Nachrichten durch ein Sprachmodell — keine behördliche Lagemeldung, keine nachrichtendienstliche Bewertung, keine Entscheidungsgrundlage. Die Grenzen stehen ausführlich in [`impressum.html`](impressum.html) und gehören zum Werkzeug, nicht als Haftungsausschluss daneben.

---

## Wie ein Scan abläuft

Ein Klick auf „Scan aktualisieren" stößt einen **Hintergrundlauf** an und kehrt sofort zurück; die Seite verfolgt den Fortschritt über `/api/scan-status`. Der Lauf selbst:

1. **Beschaffung — deterministisch, ohne Modell.** Sechs regionsspezifische Google-News-Suchen, für Deutschland zusätzlich vier Tagesschau-Feeds (`index`, `inland`, `ausland`, `investigativ`), deren Treffer per Stichwortliste auf sicherheitsrelevante Themen gefiltert werden. Ergebnisse werden über URL und Titel dedupliziert und auf 40 Artikel begrenzt.
2. **Klassifikation.** Gemini bekommt genau diese Artikelliste und darf ausschließlich daraus Vorfälle bilden — nicht selbst recherchieren. Jeder Vorfall muss als `sourceUrl` eine der übergebenen URLs tragen.
3. **Verifikation.** Jede vom Modell genannte URL wird gegen die tatsächlich abgerufene Liste geprüft und als `verified` markiert.
4. **Datumsabgleich.** Für verifizierte Vorfälle ruft der Server die Quelle auf, löst eine etwaige Google-News-Weiterleitung auf die echte Publisher-Seite auf und liest deren ausgewiesenes Veröffentlichungsdatum. Weicht es ab, gilt das Datum der Quelle; der ursprüngliche Wert bleibt als `reportedDate` erhalten. Meldungen, die damit außerhalb des Fensters liegen, fallen heraus.
5. **Zwischenspeicher.** Der Bericht wird je Region in Netlify Blobs abgelegt und beim nächsten Seitenaufruf sofort angezeigt, ohne neuen Modelllauf.

### Warum die Suche `when:30d` mitschickt

Google News sortiert seine RSS-Suche nach **Relevanz, nicht nach Datum**. Ohne den Operator liefert eine Query überwiegend die thematisch besten Treffer der letzten Jahre, die der 30-Tage-Filter danach wegwirft. Gemessen am 19.08.2026:

| Region | ohne Operator | mit `when:30d` |
|---|---:|---:|
| Deutschland | 4 | 36 |
| Baltikum & Polen | 17 | 45 |
| Restliche EU | 4 | 45 |

Vier der sechs deutschen Queries lieferten ohne ihn **keinen einzigen** Treffer aus dem Fenster. Der Monitor meldete deshalb regelmäßig einen Baseline-Bericht ohne belegten Vorfall — nicht weil nichts geschehen war, sondern weil die Beschaffung nichts Aktuelles vorlegte. Der Wert wird aus `WINDOW_DAYS` abgeleitet; wer das Fenster ändert, ändert die Suche automatisch mit.

---

## Der Risiko-Score

Eine Heuristik nach den im System-Prompt hinterlegten Stufen, kein extern validiertes Maß:

| Bereich | Bedeutung |
|---|---|
| 35–45 | Keine neuen Vorfälle, anhaltende hybride Bedrohungslage (Status quo) |
| 50–70 | Neue Warnhinweise, Drohnensichtungen oder Verdachtsfälle im Fenster |
| 75–100 | Bestätigter physischer Angriff im Fenster |

**„Verifiziert" heißt ausschließlich**, dass die genannte Quell-URL zu einem tatsächlich abgerufenen Artikel gehört — nicht, dass der Vorfall bestätigt oder der Artikel zutreffend ist.

---

## Schutz der Ausgaben

Ein Scan kostet bis zu zehn Feed-Abrufe, einen Modelllauf und bis zu sechs Seitenabrufe, und der Knopf steht offen im Netz. Drei Schichten greifen ineinander ([`netlify/lib/quota.mts`](netlify/lib/quota.mts)):

| Schicht | Grenze | Wo |
|---|---|---|
| Burst | 5 Anfragen / 60 s (IP + Domain) | `config.rateLimit`, am Edge vor dem Start der Function |
| Pro Besucher | 20 Scans / UTC-Tag | Netlify Blobs |
| Seitenweit | 400 Scans / UTC-Tag | Netlify Blobs — die einzige Grenze, die wechselnde Adressen nicht umgehen |

Der Client wird über `sha256(siteID:IP)` wiedererkannt; **eine Adresse wird nicht gespeichert**. Ist Blobs nicht erreichbar, wird durchgelassen statt gesperrt — die Edge-Grenze deckelt weiterhin, und das ist besser als eine Seite, die für alle ausfällt. [`quota-sweep`](netlify/functions/quota-sweep.mts) räumt Zähler älter als drei Tage täglich weg.

Eine Absage nimmt der Seite nichts als den neuen Lauf: der zuletzt erzeugte Bericht bleibt über `/api/scan-status` sichtbar.

---

## Schnittstellen

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/scan` | Body `{ region }` mit `de`, `baltics-poland` oder `eu`. Stößt den Hintergrundlauf an und antwortet sofort mit `202 { status: "running" }`. `429` bei erschöpftem Kontingent. Läuft für die Region bereits etwas, kommt `{ alreadyRunning: true }` und es wird kein zweiter Lauf gestartet. |
| GET | `/api/scan-status?region=…` | Aktueller Stand der Region: `empty`, `running`, `done` (mit `result`) oder `error` (mit `message`). Bei `running` und `error` wird ein vorhandener älterer Bericht mitgeschickt, damit die Seite nie grundlos leer dasteht. |

### Warum der Lauf im Hintergrund passiert

Synchrone Netlify-Functions haben höchstens 26 Sekunden. Das reicht für Feeds, Modellauswertung und Datumsabgleich nicht: Gemessen bekam das Modell nach Abzug aller Reserven rund 16 Sekunden und lief hinein. Drei Anläufe, das über Konstanten zu retten, haben das gezeigt und nicht behoben — erst 504 durch die Plattform, dann leere Berichte, dann Zeitüberschreitung trotz geteiltem Fenster.

Der Lauf steckt deshalb in einer **Background-Function** (Endung `-background` im Dateinamen), die bis zu 15 Minuten laufen darf. `/api/scan` bucht nur das Kontingent, vermerkt `running` und stößt den Worker an. Damit stehen dem Modell statt 16 Sekunden mehrere Minuten zur Verfügung, und die Mengen (40 Artikel, 10 Vorfälle) folgen wieder fachlichen statt Uhr-Gründen.

---

## Entwicklung

```bash
npm install
npm run build   # src/app.jsx -> app.js, Tailwind -> styles.css
npm run dev     # netlify dev
```

**Netlify baut nichts.** `app.js` und `styles.css` liegen fertig im Repo, `publish` ist das Wurzelverzeichnis. Wer `src/app.jsx` oder Klassennamen ändert, muss `npm run build` laufen lassen — sonst zeigt die veröffentlichte Seite den alten Stand.

### Warum vorab übersetzt wird

Die Seite lud React, ReactDOM und Babel von `unpkg.com` und Tailwind von `cdn.tailwindcss.com`: vier Abrufe bei Dritten, die jedes Mal die Besucher-IP offenlegten, bevor etwas erschien — und die Tailwind-CDN weist selbst darauf hin, dass sie nicht für den produktiven Einsatz gedacht ist. React und ReactDOM liegen jetzt unter `vendor/`, Babel entfällt ganz (rund drei Megabyte Download und eine Transpilierung pro Besuch), Tailwind liefert 18 kB fertiges CSS. Die Seite kontaktiert damit genau einen Host.

### Umgebungsvariablen

| Variable | Vorgabe | Zweck |
|---|---|---|
| `SCAN_MODEL` | `gemini-3-flash-preview` | Modell für die Klassifikation. Schlägt es fehl, werden `gemini-3.5-flash` und `gemini-2.5-flash` der Reihe nach versucht. |
| `SCAN_MAX_TOKENS` | `8000` | Obergrenze der Modellausgabe. Nicht als Zeitbremse benutzen — siehe Zeitbudget. |
| `SCAN_BUDGET_MS` | `240000` | Zeitbudget des Hintergrundlaufs. |
| `SCAN_TRIGGER_SECRET` | — | Empfohlen. Ohne dieses Geheimnis kann der Hintergrund-Worker von außen angestoßen werden und verursacht echte Kosten. |

Einen eigenen API-Schlüssel braucht es nicht: Netlifys **AI Gateway** injiziert `GEMINI_API_KEY` und `GOOGLE_GEMINI_BASE_URL` zur Laufzeit. Das Gateway ist erst nach mindestens einem Produktions-Deployment aktiv; vorher fällt jeder Scan transparent auf einen Baseline-Bericht zurück, die abgerufenen Quellen bleiben sichtbar.

---

## Aufbau

```
index.html              Seitengerüst, lädt vendor/ + app.js + styles.css
impressum.html          Anbieterangabe und Datenschutz (ohne React, ohne CDN)
src/app.jsx             Quelle der Anwendung
src/input.css           Tailwind-Direktiven
app.js, styles.css      erzeugt von `npm run build` — nicht von Hand ändern
vendor/                 React und ReactDOM 18.3.1 (UMD)
tailwind.config.js
netlify.toml            publish, Functions, Header, SPA-Fallback
netlify/functions/
  scan.mts                  POST /api/scan — bucht Kontingent, stößt den Lauf an, antwortet sofort
  scan-run-background.mts   der eigentliche Lauf, bis zu 15 Minuten
  scan-status.mts           GET  /api/scan-status — Stand je Region (empty/running/done/error)
  quota-sweep.mts           täglich, räumt Kontingentzähler weg
netlify/lib/
  scan-core.mts             die Pipeline: Beschaffung, Klassifikation, Verifikation, Datumsabgleich
  quota.mts                 Besucher- und Tagesgrenzen über Netlify Blobs
```

---

## Zeitbudget

Der Hintergrundlauf hat 15 Minuten zur Verfügung und hält sich an ein eigenes Budget von 4 Minuten (`SCAN_BUDGET_MS`), damit ein hängender Anbieter den Lauf nicht endlos offen hält. Davon gehen 5 Sekunden für das Schreiben des Ergebnisses und 30 Sekunden für den Datumsabgleich ab; der Rest steht dem Modell zur Verfügung, aufgeteilt über die Ausweichkette.

**Das Token-Limit ist keine Zeitbremse.** Die Gemini-Modelle denken vor der Antwort, und diese Denkschritte zählen gegen `maxOutputTokens`. Es zu senken, um die Laufzeit zu drücken, führt dazu, dass für das JSON nichts übrig bleibt (`finishReason: MAX_TOKENS`) — die Function prüft das jetzt und sagt es, statt einen nichtssagenden JSON-Fehler zu werfen. Die Laufzeit begrenzt der Abbruch-Timer, den Umfang begrenzt `MAX_INCIDENTS`.

---

## Lizenz

Keine Lizenzdatei enthalten. Alle Rechte beim Autor, solange keine Lizenz ergänzt wird.

© 2026 — Dr. Pantaleon Fassbender — pantaleonfassbender@gmail.com
