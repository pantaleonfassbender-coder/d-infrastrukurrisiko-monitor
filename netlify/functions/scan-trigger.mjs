/*
 * The manual "Scan aktualisieren" button. Synchronous on purpose: the browser
 * gets a clear 202 (queued) or 429 (throttled) instead of the opaque 202 a
 * background function always returns. The 10-minute throttle here mirrors the
 * authoritative one inside scan-run.mjs; this copy only exists so the UI can
 * tell the user immediately.
 */

import { getStore } from "@netlify/blobs";

const MIN_INTERVAL_MS = 10 * 60 * 1000;

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export default async (req, context) => {
  const store = getStore({ name: "infra-monitor", consistency: "strong" });
  const runstate = (await store.get("runstate", { type: "json" })) || {};

  if (runstate.startedAt) {
    const elapsed = Date.now() - Date.parse(runstate.startedAt);
    if (elapsed < MIN_INTERVAL_MS) {
      const retryAfterSec = Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000);
      return new Response(
        JSON.stringify({
          queued: false,
          error: "Ein Scan lief bereits vor kurzem.",
          retryAfterSec,
        }),
        { status: 429, headers: { ...JSON_HEADERS, "retry-after": String(retryAfterSec) } }
      );
    }
  }

  const base = process.env.URL || (context.site && context.site.url);
  if (!base) {
    return new Response(JSON.stringify({ queued: false, error: "Site-URL unbekannt." }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }

  const headers = { "content-type": "application/json" };
  if (process.env.SCAN_TOKEN) headers["x-scan-token"] = process.env.SCAN_TOKEN;

  const res = await fetch(`${base}/api/scan/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ source: "manual" }),
  });

  if (res.status !== 202) {
    return new Response(
      JSON.stringify({ queued: false, error: `Worker antwortete mit HTTP ${res.status}.` }),
      { status: 502, headers: JSON_HEADERS }
    );
  }
  return new Response(JSON.stringify({ queued: true }), { status: 202, headers: JSON_HEADERS });
};

export const config = {
  path: "/api/scan/trigger",
  method: "POST",
};
