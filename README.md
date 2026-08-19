# Infrastruktur-Radar (OSINT)

Ein Lagebild zu Angriffen auf kritische Infrastruktur — Sabotage, Brandanschläge, Drohnensichtungen, Cyberangriffe auf Versorger, beschädigte Seekabel, GPS-Störungen — für **Deutschland**, **Baltikum & Polen** und die **übrige EU**, jeweils aus den letzten 30 Tagen und jeder Vorfall an eine belegte Quelle gebunden.

Statische Seite mit drei Netlify-Functions. Beigelegt ist die Präsentation [`infrastruktur-und-sabotage.pdf`](infrastruktur-und-sabotage.pdf), aus der die Themeneinführung stammt.

> **Was das nicht ist.** Eine automatische Auswertung öffentlicher Nachrichten durch ein Sprachmodell — keine behördliche Lagemeldung, keine nachrichtendienstliche Bewertung, keine Entscheidungsgrundlage. Die Grenzen stehen ausführlich in [`impressum.html`](impressum.html) und gehören zum Werkzeug, nicht als Haftungsausschluss daneben.

---

## Wie ein Scan abläuft

Ein Klick auf „Scan aktualisieren" löst einen synchronen Durchlauf aus (ein Request, eine Antwort, kein Polling):

1. **Beschaffung — deterministisch, ohne Modell.** Sechs regionsspezifische Google-News-Suchen, für Deutschland zusätzlich vier Tagesschau-Feeds (`index`, `inland`, `ausland`, `investigativ`), deren Treffer per Stichwortliste auf sicherheitsrelevante Themen gefiltert werden. Ergebnisse werden über URL und Titel dedupliziert und auf 45 Artikel begrenzt.
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
| POST | `/api/scan` | Body `{ region }` mit `de`, `baltics-poland` oder `eu`. Antwortet mit dem fertigen Lagebericht. `429` bei erschöpftem Kontingent. |
| GET | `/api/scan-status?region=…` | Der zuletzt gecachte Bericht der Region, ohne neuen Modelllauf. |

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
  scan.mts              POST /api/scan — Beschaffung, Klassifikation, Verifikation
  scan-status.mts       GET  /api/scan-status — letzter Stand je Region
  quota-sweep.mts       täglich, räumt Kontingentzähler weg
netlify/lib/quota.mts   Besucher- und Tagesgrenzen über Netlify Blobs
```

---

## Zeitbudget

Synchrone Netlify-Functions brechen nach 60 Sekunden hart ab und liefern dann eine HTML-Fehlerseite statt JSON — im Browser sichtbar als „Unexpected token '<'". Die Function hält sich deshalb an ein eigenes Budget von 50 Sekunden, reserviert 4 Sekunden für die Antwort und 9 für den Datumsabgleich, und koppelt jeden potenziell langen Schritt daran. Wer an den Konstanten dreht, sollte diesen Zusammenhang kennen.

---

## Lizenz

Keine Lizenzdatei enthalten. Alle Rechte beim Autor, solange keine Lizenz ergänzt wird.

© 2026 — Dr. Pantaleon Fassbender — pantaleonfassbender@gmail.com
