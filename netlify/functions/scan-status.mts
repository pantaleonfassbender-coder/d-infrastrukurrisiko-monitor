import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Muss zum Store-Namen und den regionsspezifischen Schlüsseln aus scan.mts passen.
const SCAN_STORE = "scans";
const CACHE_KEYS: Record<string, string> = {
  de: "latest",
  "baltics-poland": "latest-baltics-poland",
  eu: "latest-eu",
};

// Liefert den zuletzt gecachten Lagebericht der angefragten Region. Der Client
// lädt ihn beim Öffnen der Seite je Tab, damit sofort der jüngste bekannte
// Stand sichtbar ist, ohne einen neuen Modelllauf auszulösen. Der Scan selbst
// läuft synchron über /api/scan.
export default async (req: Request, _context: Context) => {
  const region = new URL(req.url).searchParams.get("region") ?? "de";
  const key = CACHE_KEYS[region] ?? CACHE_KEYS.de;

  const store = getStore({ name: SCAN_STORE, consistency: "strong" });
  const record = await store.get(key, { type: "json" });

  if (!record) {
    return Response.json({ status: "empty" });
  }

  return Response.json(record);
};

export const config: Config = {
  path: "/api/scan-status",
  method: "GET",
};
