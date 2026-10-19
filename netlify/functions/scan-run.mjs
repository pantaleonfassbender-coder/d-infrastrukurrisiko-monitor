/*
 * The scan itself, as a background function: collectors, two model passes
 * (Claude, or Gemini as fallback – lib/llm.mjs) and geocoding take a few
 * minutes, well past the
 * 26-second ceiling on synchronous functions. scan-schedule.mjs is the daily
 * clock and scan-trigger.mjs the manual button; both only enqueue this
 * worker.
 *
 * Results live in Netlify Blobs (store "infra-monitor"):
 *   latest    - the full current Lagebild the site renders
 *   history   - one {date, score, sectors, incidentCount} entry per day
 *   articles  - rolling 30-day archive of collected headlines
 *   geocache  - place name -> coordinates, so recurring places skip Nominatim
 *   runstate  - throttle and status bookkeeping
 *
 * If SCAN_TOKEN is set in the environment, invocations must carry it in the
 * x-scan-token header; scan-schedule and scan-trigger forward it. Without the
 * variable the worker still runs but relies on the 10-minute throttle alone.
 */

import { getStore } from "@netlify/blobs";
import { collectAll, mergeArticles } from "../../lib/sources.mjs";
import { research, analysis as consolidate, providerOrder } from "../../lib/llm.mjs";
import { normalizeAnalysis, geocodeIncidents, updateHistory } from "../../lib/core.mjs";

const MIN_INTERVAL_MS = 10 * 60 * 1000;

/* How many archived headlines pass B may see. The archive itself keeps more. */
const PROMPT_ARTICLE_LIMIT = 150;

export default async (req) => {
  const token = process.env.SCAN_TOKEN;
  if (token && req.headers.get("x-scan-token") !== token) {
    console.warn("scan-run: refused an invocation without a valid token");
    return;
  }

  let source = "unknown";
  try {
    source = (await req.json()).source || "unknown";
  } catch {
    /* body is optional */
  }

  const store = getStore({ name: "infra-monitor", consistency: "strong" });

  const runstate = (await store.get("runstate", { type: "json" })) || {};
  if (runstate.startedAt && Date.now() - Date.parse(runstate.startedAt) < MIN_INTERVAL_MS) {
    console.log(`scan-run: last run started ${runstate.startedAt}, throttled, skipping`);
    return;
  }
  const startedAtIso = new Date().toISOString();
  await store.setJSON("runstate", { startedAt: startedAtIso, source, status: "running" });

  if (!providerOrder().length) {
    await failRun(store, "Kein Modellzugang: weder ANTHROPIC_API_KEY (Netlify AI Gateway) noch GEMINI_API_KEY gesetzt");
    return;
  }

  try {
    console.log(`scan-run: started (source: ${source})`);

    /* Research (pass A) does not need the collected material, so it runs while
       the collectors wait out GDELT's rate limit. Pass A is enrichment: if it
       fails everywhere, the deterministic material still carries the scan. */
    const llmNotes = [];
    const [collected, researched] = await Promise.all([
      collectAll(),
      research(llmNotes).catch((err) => {
        console.warn(`scan-run: research pass failed (${err.message}), continuing without it`);
        return null;
      }),
    ]);
    const { articles: fresh, warnings, errors, counts } = collected;

    /* Publisher feeds only show the current day, so the 30-day news window is
       an archive in Blobs that every scan tops up. GDELT backfills it. */
    const archive = mergeArticles(await store.get("articles", { type: "json" }), fresh);
    await store.setJSON("articles", archive);
    const articles = archive.slice(0, PROMPT_ARTICLE_LIMIT);

    console.log(
      `scan-run: collected ${counts.gdelt} GDELT + ${counts.news} feed articles, ` +
        `${archive.length} in the 30-day archive, ${warnings.length} NINA warnings` +
        (errors.length ? `, collector notes: ${errors.join("; ")}` : "")
    );

    const reportText = researched?.text || "";
    const groundedSources = researched?.sources || [];
    const groundedModel = researched?.model || "";
    if (researched) console.log(`scan-run: research via ${researched.provider}/${groundedModel}, ${groundedSources.length} sources`);

    /* The incidents of the last scan go back in as material D, so the list (and
       with it the index) does not jump because one run happened to miss a story.
       Only lists made under method v3 are carried; the model re-checks them. */
    const previous = await store.get("latest", { type: "json" });
    const known = previous?.index?.method === "v3" ? (previous.incidents || []).slice(0, 25) : [];

    const consolidated = await consolidate(
      { reportText, sources: groundedSources, articles, warnings, known, today: new Date().toISOString().slice(0, 10) },
      llmNotes
    );
    const model = consolidated.model;
    const analysis = normalizeAnalysis(consolidated.analysis);
    errors.push(...llmNotes);
    console.log(
      `scan-run: analysis via ${consolidated.provider}/${model}: index ${analysis.score} (load ${analysis.index.load}), ${analysis.incidents.length} incidents`
    );

    const geocache = (await store.get("geocache", { type: "json" })) || {};
    await geocodeIncidents(analysis.incidents, geocache);
    await store.setJSON("geocache", geocache);

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const latest = {
      generatedAt: now.toISOString(),
      date,
      ...analysis,
      report: reportText,
      sources: groundedSources,
      stats: {
        gdeltArticles: counts.gdelt,
        newsArticles: counts.news,
        archiveArticles: archive.length,
        ninaWarnings: warnings.length,
        model,
        groundedModel,
        provider: consolidated.provider,
        researchProvider: researched?.provider || "",
        collectorErrors: errors,
      },
    };
    await store.setJSON("latest", latest);

    const history = (await store.get("history", { type: "json" })) || [];
    const sectorScores = {};
    for (const s of analysis.sectors) sectorScores[s.key] = s.score;
    await store.setJSON(
      "history",
      updateHistory(history, {
        date,
        score: analysis.score,
        method: analysis.index.method,
        sectors: sectorScores,
        incidentCount: analysis.incidents.length,
      })
    );

    await store.setJSON("runstate", {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      source,
      status: "ok",
    });
    console.log(`scan-run: finished for ${date}`);
  } catch (err) {
    await failRun(store, err.message);
  }
};

async function failRun(store, detail) {
  console.error(`scan-run: failed: ${detail}`);
  /* startedAt is cleared so a follow-up attempt is not throttled away. */
  await store.setJSON("runstate", {
    finishedAt: new Date().toISOString(),
    status: "failed",
    detail,
  });
}

export const config = {
  path: "/api/scan/run",
  method: "POST",
  background: true,
};
