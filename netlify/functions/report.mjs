/*
 * Read side of the site: the latest Lagebild plus the score history, straight
 * from Blobs. Served no-store so the page always sees the newest scan.
 */

import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore({ name: "infra-monitor", consistency: "strong" });
  const [latest, history, runstate] = await Promise.all([
    store.get("latest", { type: "json" }),
    store.get("history", { type: "json" }),
    store.get("runstate", { type: "json" }),
  ]);

  /* The full runstate is exposed on purpose: a failed run must be visible to
     the page (and to whoever debugs it), otherwise a broken scan looks like a
     scan that never ends. It contains only status metadata, never secrets. */
  return new Response(
    JSON.stringify({
      latest: latest || null,
      history: Array.isArray(history) ? history : [],
      running: runstate?.status === "running" ? { startedAt: runstate.startedAt } : null,
      lastRun: runstate
        ? {
            status: runstate.status || null,
            detail: runstate.detail || null,
            startedAt: runstate.startedAt || null,
            finishedAt: runstate.finishedAt || null,
          }
        : null,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }
  );
};

export const config = {
  path: "/api/report",
  method: "GET",
};
