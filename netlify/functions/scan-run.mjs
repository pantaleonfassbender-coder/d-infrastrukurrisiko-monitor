/*
 * The scan itself, as a background function: collectors, two Gemini passes
 * and geocoding together take a low number of minutes, well past the
 * 26-second ceiling on synchronous functions. scan-schedule.mjs is the daily
 * clock and scan-trigger.mjs the manual button; both only enqueue this
 * worker.
 *
 * Results live in Netlify Blobs (store "infra-monitor"):
 *   latest    - the full current Lagebild the site renders
 *   history   - one {date, score, sectors, incidentCount} entry per day
 *   geocache  - place name -> coordinates, so recurring places skip Nominatim
 *   runstate  - throttle and status bookkeeping
 *
 * If SCAN_TOKEN is set in the environment, invocations must carry it in the
 * x-scan-token header; scan-schedule and scan-trigger forward it. Without the
 * variable the worker still runs but relies on the 10-minute throttle alone.
 */

import { getStore } from "@netlify/blobs";
import { collectAll } from "../../lib/sources.mjs";
import { groundedReport, structuredAnalysis, resolveGemini } from "../../lib/gemini.mjs";
import { normalizeAnalysis, geocodeIncidents, updateHistory } from "../../lib/core.mjs";

const MIN_INTERVAL_MS = 10 * 60 * 1000;

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

  /* Key and endpoint together: a key from Netlify AI Gateway is only valid
     against the gateway URL, so resolving them apart is what produces the
     "API key not valid" dead end. */
  const gemini = resolveGemini(process.env);
  if (!gemini) {
    await failRun(
      store,
      "Kein Gemini-Zugang konfiguriert: GEMINI_API_KEY in den Netlify-Umgebungsvariablen setzen (Scope: Functions) und neu deployen."
    );
    return;
  }

  try {
    console.log(`scan-run: started (source: ${source}, gemini via ${gemini.origin})`);

    const { articles, warnings, errors } = await collectAll();
    console.log(
      `scan-run: collected ${articles.length} GDELT articles, ${warnings.length} NINA warnings` +
        (errors.length ? `, collector errors: ${errors.join("; ")}` : "")
    );

    /* Pass A is enrichment: if grounding fails, the deterministic material
       still carries the scan. Pass B is the product and must succeed. */
    let reportText = "";
    let groundedSources = [];
    let groundedModel = "";
    try {
      const grounded = await groundedReport(gemini);
      reportText = grounded.text;
      groundedSources = grounded.sources;
      groundedModel = grounded.model;
      console.log(`scan-run: grounded report via ${groundedModel}, ${groundedSources.length} sources`);
    } catch (err) {
      errors.push(`grounding: ${err.message}`);
      console.warn(`scan-run: grounded pass failed (${err.message}), continuing without it`);
    }

    const { analysis: rawAnalysis, model } = await structuredAnalysis(gemini, {
      reportText,
      articles,
      warnings,
    });
    const analysis = normalizeAnalysis(rawAnalysis);
    console.log(
      `scan-run: structured analysis via ${model}: score ${analysis.score}, ${analysis.incidents.length} incidents`
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
        gdeltArticles: articles.length,
        ninaWarnings: warnings.length,
        model,
        groundedModel,
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
