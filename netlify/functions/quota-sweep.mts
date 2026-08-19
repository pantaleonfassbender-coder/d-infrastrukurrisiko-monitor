/*
 * Aufräumen der Kontingentzähler. Jeder Besuchertag erzeugt einen Schlüssel,
 * und sonst löscht ihn nichts wieder — dieser Lauf entfernt einmal täglich
 * alles, was älter ist als das Fenster in LIMITS.retentionDays.
 *
 * Geplante Functions laufen nur auf veröffentlichten Produktions-Deployments.
 */

import type { Config } from "@netlify/functions";

import { sweepOldCounters } from "../lib/quota.mts";

export default async () => {
  const removed = await sweepOldCounters(Date.now());
  console.log(`quota-sweep: ${removed} veraltete(r) Zähler entfernt.`);
};

export const config: Config = {
  schedule: "@daily",
};
