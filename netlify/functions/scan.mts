import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

import { LIMITS, reserveScan } from "../lib/quota.mts";
import { SCAN_STORE, resolveRegion } from "../lib/scan-core.mts";

/*
 * Auslöser für einen Scan — und sonst nichts.
 *
 * Vorher rechnete diese Function den ganzen Lauf synchron durch und musste
 * damit in das Zeitlimit synchroner Netlify-Functions passen (10 s im
 * Standard, höchstens 26 s). Das ging für die Auswertung von 30 bis 45
 * Artikeln durch ein Sprachmodell nicht auf: Erst brach die Plattform mit
 * einem 504 ab, dann reichte auch ein sorgfältig aufgeteiltes Budget nicht,
 * weil das Modell schlicht länger denkt, als eine synchrone Function leben
 * darf. Jede weitere Sekunde wäre dem Limit abgetrotzt gewesen.
 *
 * Deshalb tut diese Function jetzt nur noch drei Dinge — Kontingent buchen,
 * Lauf als „running" vermerken, Hintergrund-Worker anstoßen — und antwortet
 * sofort. Der Worker (scan-run-background) hat bis zu 15 Minuten Zeit; die
 * Seite fragt den Fortschritt über /api/scan-status ab.
 */

// Wie lange ein als „running" vermerkter Lauf als lebend gilt. Stirbt ein
// Worker unbemerkt, bliebe die Region sonst dauerhaft als „läuft gerade"
// stehen und ließe sich nie wieder starten.
const RUN_STALE_MS = 6 * 60_000;

export default async (req: Request, context: Context) => {
  const store = getStore({ name: SCAN_STORE, consistency: "strong" });

  let region = resolveRegion(undefined);
  try {
    const body = await req.json();
    region = resolveRegion(body?.region);
  } catch {
    /* Kein/ungültiger Body → Standardregion Deutschland. */
  }

  // Läuft für diese Region schon etwas, wird nicht ein zweites Mal gestartet.
  // Das schützt das Budget besser als jede Ratenbegrenzung: Wer hektisch
  // mehrfach klickt, erzeugt genau einen Lauf.
  const current = (await store.get(region.cacheKey, { type: "json" })) as any;
  if (current?.status === "running" && current.startedAt) {
    const age = Date.now() - Date.parse(current.startedAt);
    if (Number.isFinite(age) && age < RUN_STALE_MS) {
      return Response.json({ status: "running", startedAt: current.startedAt, alreadyRunning: true });
    }
  }

  // Kontingent buchen, bevor der Worker Kosten verursacht.
  const reservation = await reserveScan(context.ip, context.site?.id ?? "local", Date.now());
  if (!reservation.allowed) {
    return Response.json(
      { error: reservation.message, scope: reservation.scope },
      { status: 429, headers: { "Retry-After": String(reservation.retryAfter) } },
    );
  }

  const startedAt = new Date().toISOString();
  // Den zuletzt erzeugten Bericht mitnehmen. Ohne das stünde die Seite
  // während jedes Laufs leer da, obwohl ein gültiger Stand vorliegt — und
  // wenn der Lauf scheitert, wäre er ganz verloren.
  await store.setJSON(region.cacheKey, {
    status: "running",
    startedAt,
    region: region.id,
    result: current?.result ?? null,
  });

  const base =
    (typeof (globalThis as any).Netlify !== "undefined"
      ? (globalThis as any).Netlify.env.get("URL")
      : undefined) ??
    context.site?.url ??
    "";

  if (!base) {
    await store.setJSON(region.cacheKey, {
      status: "error",
      message: "Die Adresse der Website ist der Function nicht bekannt; der Lauf konnte nicht gestartet werden.",
      result: current?.result ?? null,
    });
    return Response.json({ error: "Der Lauf konnte nicht gestartet werden." }, { status: 500 });
  }

  const secret =
    typeof (globalThis as any).Netlify !== "undefined"
      ? (globalThis as any).Netlify.env.get("SCAN_TRIGGER_SECRET")
      : undefined;

  try {
    // Absichtlich ohne await auf den Abschluss: Eine Background-Function
    // antwortet sofort mit 202 und läuft dann auf eigener Uhr weiter.
    const res = await fetch(`${base}/.netlify/functions/scan-run-background`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-scan-secret": secret } : {}),
      },
      body: JSON.stringify({ region: region.id, cacheKey: region.cacheKey }),
    });
    if (res.status >= 400) throw new Error(`Der Worker antwortete mit ${res.status}.`);
  } catch (error: any) {
    const message = error?.message || "Der Hintergrundlauf ließ sich nicht starten.";
    console.error("scan (Auslöser):", message);
    await store.setJSON(region.cacheKey, {
      status: "error",
      message,
      result: current?.result ?? null,
    });
    return Response.json({ error: message }, { status: 502 });
  }

  return Response.json(
    {
      status: "running",
      startedAt,
      region: region.id,
      quota: { remaining: reservation.visitorRemaining, dailyLimit: LIMITS.visitorPerDay },
    },
    { status: 202 },
  );
};

export const config: Config = {
  path: "/api/scan",
  method: "POST",
  // Bleibt als billigste Schicht erhalten, auch wenn der Auslöser jetzt kaum
  // noch etwas kostet: Sie greift am Edge, bevor die Function startet.
  rateLimit: {
    windowSize: 60,
    windowLimit: 5,
    aggregateBy: ["ip", "domain"],
  },
};
