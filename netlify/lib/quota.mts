/*
 * Ausgabenbremse für den einzigen teuren öffentlichen Endpunkt dieser Seite.
 *
 * Ein Scan ist kein billiger Aufruf: bis zu zehn Feed-Abrufe, ein Gemini-Lauf
 * und bis zu sechs zusätzliche Seitenabrufe für den Datumsabgleich. Der Knopf
 * dafür steht offen im Netz. Drei Grenzen greifen ineinander, jede fängt auf,
 * was die vorherige nicht kann:
 *
 *   1. Burst — `config.rateLimit` an der Function selbst, durchgesetzt am Edge,
 *      bevor die Function überhaupt startet. Die billigste Schicht, aber ihr
 *      Fenster endet bei 180 Sekunden; eine Tagesgrenze kann sie nicht
 *      ausdrücken.
 *   2. Pro Besucher — eine Tageszählung je Client, damit auch ein Skript, das
 *      sich brav unter der Burst-Grenze hält, irgendwann aufhört.
 *   3. Seitenweit — eine Tagesgrenze über alle Besucher. Sie ist die einzige
 *      der drei, die sich nicht durch wechselnde Adressen umgehen lässt, und
 *      damit die, die den schlimmstenfalls anfallenden Betrag begrenzt.
 *
 * Die Zähler liegen in Netlify Blobs mit starker Konsistenz, gebündelt nach
 * UTC-Datum — ein Schlüssel verfällt dadurch von selbst, indem er am nächsten
 * Tag nicht mehr der aktuelle ist.
 */

import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

export const LIMITS = {
  /** Scans, die ein Client pro UTC-Tag auslösen darf. */
  visitorPerDay: 20,
  /** Scans, die die gesamte Seite pro UTC-Tag auslösen darf. */
  sitePerDay: 400,
  /** Tage, die der Sweeper alte Zähler aufhebt, bevor er sie löscht. */
  retentionDays: 3,
};

export type Reservation =
  | { allowed: true; visitorRemaining: number }
  | { allowed: false; scope: "visitor" | "site"; retryAfter: number; message: string };

const STORE = "scan-quota";

function store() {
  // Die Zähler werden unmittelbar nach dem Schreiben wieder gelesen; die
  // voreingestellte eventuelle Konsistenz kann um bis zu eine Minute
  // nachhinken — lang genug, um das Tagesbudget in einem Schwung auszugeben.
  return getStore({ name: STORE, consistency: "strong" });
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight(now: number): number {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((midnight.getTime() - now) / 1000));
}

/*
 * Den Client wiedererkennen, ohne eine Adresse zu speichern. Die Site-ID salzt
 * den Hash, sodass der abgelegte Wert anderswo wertlos ist; der Zähler muss nur
 * „derselbe Aufrufer wie vorhin?" beantworten, nicht „wer ist das?".
 */
function fingerprint(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

const visitorKey = (day: string, id: string) => `visitor/${day}/${id}`;
const siteKey = (day: string) => `site/${day}`;

async function readCount(key: string): Promise<number> {
  const value = (await store().get(key, { type: "json" })) as { count?: unknown } | null;
  return typeof value?.count === "number" ? value.count : 0;
}

/*
 * Einen Scan gegen das Besucher- und das Seitenbudget buchen, oder begründen,
 * warum nicht.
 *
 * Lesen-dann-Schreiben ist nicht atomar; zwei Anfragen im selben Augenblick
 * können dieselbe Einheit buchen. Für eine Ausgabenbremse ist das ein
 * hinnehmbarer Rundungsfehler — über einen Tag kostet es ein paar Läufe zu
 * viel, und die Burst-Grenze begrenzt, wie viele sich überhaupt überlappen
 * können.
 *
 * Ist Blobs selbst nicht erreichbar, wird durchgelassen statt gesperrt: Die
 * Edge-Grenze deckelt einen Missbrauch weiterhin auf wenige Anfragen pro
 * Minute, und das ist ein deutlich besserer Ausgang als eine Seite, die für
 * alle nicht mehr funktioniert.
 */
export async function reserveScan(
  ip: string,
  salt: string,
  now: number,
): Promise<Reservation> {
  const day = utcDay(now);
  const visitor = visitorKey(day, fingerprint(ip, salt));
  const site = siteKey(day);

  let visitorUsed: number;
  let siteUsed: number;

  try {
    [visitorUsed, siteUsed] = await Promise.all([readCount(visitor), readCount(site)]);
  } catch (error) {
    console.warn("quota: Zähler nicht lesbar, Lauf wird zugelassen", error);
    return { allowed: true, visitorRemaining: LIMITS.visitorPerDay };
  }

  const retryAfter = secondsUntilUtcMidnight(now);

  if (siteUsed >= LIMITS.sitePerDay) {
    return {
      allowed: false,
      scope: "site",
      retryAfter,
      message:
        `Dieses Lagebild wertet live ein Sprachmodell aus und teilt sich deshalb ein Tagesbudget von ` +
        `${LIMITS.sitePerDay} Scans — für heute ist es aufgebraucht. Der zuletzt erzeugte Lagebericht bleibt ` +
        `sichtbar; das Budget setzt um Mitternacht UTC zurück.`,
    };
  }

  if (visitorUsed >= LIMITS.visitorPerDay) {
    return {
      allowed: false,
      scope: "visitor",
      retryAfter,
      message:
        `Sie haben die ${LIMITS.visitorPerDay} Scans aufgebraucht, die einem Besucher pro Tag zustehen. Der ` +
        `zuletzt erzeugte Lagebericht bleibt sichtbar; das Kontingent setzt um Mitternacht UTC zurück.`,
    };
  }

  try {
    await Promise.all([
      store().setJSON(visitor, { count: visitorUsed + 1 }),
      store().setJSON(site, { count: siteUsed + 1 }),
    ]);
  } catch (error) {
    console.warn("quota: Lauf konnte nicht verbucht werden", error);
  }

  return { allowed: true, visitorRemaining: Math.max(0, LIMITS.visitorPerDay - visitorUsed - 1) };
}

/*
 * Zähler von Tagen wegräumen, die nicht mehr der aktuelle sein können. Nichts
 * hängt davon ab — ein alter Schlüssel wird ohnehin nur an seinem eigenen Tag
 * gelesen — aber ohne das wächst der Store dauerhaft um einen Schlüssel je
 * Besucher und Tag.
 */
export async function sweepOldCounters(now: number): Promise<number> {
  const cutoff = utcDay(now - LIMITS.retentionDays * 86_400_000);
  const { blobs } = await store().list();

  const stale = blobs.filter(({ key }) => {
    const day = key.split("/")[1];
    return typeof day === "string" && day < cutoff;
  });

  await Promise.all(stale.map(({ key }) => store().delete(key)));
  return stale.length;
}
