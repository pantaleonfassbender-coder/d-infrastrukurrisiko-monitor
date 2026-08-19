import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

import { SCAN_STORE, resolveRegion } from "../lib/scan-core.mts";

/*
 * Statusabfrage je Region.
 *
 * Sie hat jetzt zwei Aufgaben: Beim Öffnen der Seite liefert sie den zuletzt
 * erzeugten Lagebericht, und während eines Laufs ist sie die Leitung, über die
 * der Browser den Fortschritt verfolgt. Der Datensatz trägt deshalb immer ein
 * `status`-Feld:
 *
 *   empty    — für diese Region liegt noch nichts vor
 *   running  — ein Hintergrundlauf ist unterwegs (`startedAt`)
 *   done     — `result` ist der fertige Lagebericht
 *   error    — `message` sagt warum; `result` ist, sofern vorhanden, der
 *              zuletzt gültige Bericht und bleibt anzeigbar
 *
 * In den Fällen `running` und `error` wird ein vorhandener älterer Bericht
 * mitgeschickt. Ohne ihn stünde die Seite während jedes Laufs leer da und
 * behauptete damit etwas, das nicht stimmt.
 */

export default async (req: Request, _context: Context) => {
  const region = resolveRegion(new URL(req.url).searchParams.get("region"));
  const store = getStore({ name: SCAN_STORE, consistency: "strong" });
  const record = await store.get(region.cacheKey, { type: "json" });

  if (!record) return Response.json({ status: "empty", region: region.id });

  return Response.json({ region: region.id, ...(record as object) });
};

export const config: Config = {
  path: "/api/scan-status",
  method: "GET",
};
