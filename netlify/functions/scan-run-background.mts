import { getStore } from "@netlify/blobs";

import { SCAN_STORE, resolveRegion, runScan } from "../lib/scan-core.mts";

/*
 * Hintergrund-Worker: führt den eigentlichen Scan aus.
 *
 * Netlify erkennt Background-Functions an der Endung `-background` im
 * Dateinamen. Sie antworten dem Aufrufer sofort mit 202 und laufen danach auf
 * eigener Uhr weiter — bis zu 15 Minuten statt der 26 Sekunden, die einer
 * synchronen Function höchstens bleiben. Genau daran war die vorherige
 * Bauweise gescheitert: Das Modell braucht für 40 Artikel schlicht länger, als
 * eine synchrone Function leben darf.
 *
 * Aufgerufen wird der Worker vom Auslöser /api/scan, nicht von Besuchern. Ist
 * SCAN_TRIGGER_SECRET gesetzt, wird es verlangt — der Endpunkt ist sonst
 * öffentlich erreichbar und verursacht echte Kosten.
 */

export default async (req: Request) => {
  const required =
    typeof (globalThis as any).Netlify !== "undefined"
      ? (globalThis as any).Netlify.env.get("SCAN_TRIGGER_SECRET")
      : undefined;

  let body: any = {};
  try {
    body = await req.clone().json();
  } catch {
    /* leerer Body → Standardregion */
  }

  if (required) {
    const provided = req.headers.get("x-scan-secret") || body?.secret || "";
    if (provided !== required) return new Response("Forbidden", { status: 403 });
  }

  const region = resolveRegion(body?.region);
  const store = getStore({ name: SCAN_STORE, consistency: "strong" });

  // Den bisherigen Stand lesen, um ihn im Fehlerfall nicht zu verlieren. Ein
  // gescheiterter Lauf darf einen gültigen älteren Bericht nicht löschen.
  const previous = (await store.get(region.cacheKey, { type: "json" })) as any;

  try {
    const result = await runScan(region.id);
    await store.setJSON(region.cacheKey, { status: "done", result });
    console.log(
      `scan-run-background: "${region.label}" fertig — ${result.incidents?.length ?? 0} Vorfall/Vorfälle, ` +
        `${result.sources?.length ?? 0} Quellen, Modell ${result.model}.`,
    );
  } catch (error: any) {
    const message = error?.message || "Unbekannter Fehler bei der Analyse.";
    console.error(`scan-run-background: "${region.label}" fehlgeschlagen:`, message);
    await store.setJSON(region.cacheKey, {
      status: "error",
      message,
      failedAt: new Date().toISOString(),
      // Der zuletzt gültige Bericht bleibt erhalten und weiterhin sichtbar.
      result: previous?.result ?? null,
    });
  }
};
