/*
 * Which model runs the two passes.
 *
 * LLM_PROVIDER = "anthropic" | "gemini" | unset. Unset means: Claude when
 * Anthropic credentials are present (on Netlify the AI Gateway provides them),
 * otherwise Gemini. Whichever runs first, the other is the fallback for the
 * same pass, so a failed pass costs a second opinion rather than the scan.
 * Each result names the provider and model that produced it.
 */

import { claudeAvailable, claudeResearch, claudeAnalysis } from "./claude.mjs";
import { groundedReport, structuredAnalysis } from "./gemini.mjs";

export function providerOrder(env = process.env) {
  const gemini = Boolean(env.GEMINI_API_KEY);
  const claude = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const want = (env.LLM_PROVIDER || "").toLowerCase();
  const order = want === "gemini" ? ["gemini", "anthropic"] : ["anthropic", "gemini"];
  return order.filter((p) => (p === "gemini" ? gemini : claude));
}

async function inOrder(task, runners, notes) {
  const order = providerOrder();
  if (!order.length) throw new Error("Weder Anthropic- noch Gemini-Zugang konfiguriert");
  let lastErr = null;
  for (const p of order) {
    try {
      return { provider: p, ...(await runners[p]()) };
    } catch (err) {
      lastErr = err;
      notes.push(`${task}/${p}: ${err.message}`);
    }
  }
  throw lastErr;
}

/* Pass A. Returns { provider, text, sources, model }. */
export function research(notes) {
  return inOrder("recherche", {
    anthropic: () => claudeResearch(),
    gemini: () => groundedReport(process.env.GEMINI_API_KEY),
  }, notes);
}

/* Pass B. Returns { provider, analysis, model }. */
export function analysis(material, notes) {
  return inOrder("auswertung", {
    anthropic: () => claudeAnalysis(material),
    gemini: () => structuredAnalysis(process.env.GEMINI_API_KEY, material),
  }, notes);
}

export { claudeAvailable };
