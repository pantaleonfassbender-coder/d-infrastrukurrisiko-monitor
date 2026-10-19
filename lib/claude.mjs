/*
 * The two analysis passes on Claude, through the Anthropic SDK.
 *
 * Credentials come from the environment: on Netlify the AI Gateway injects
 * ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL into every function, so no key of
 * our own is needed; the SDK reads both. A direct key works the same way.
 *
 * Pass A uses Anthropic's server-side web search: the sources are the real
 * article URLs the model read and cited (unlike Gemini's grounding links,
 * which are expiring redirects). Pass B uses structured outputs, so the
 * answer always matches ANALYSIS_SCHEMA.
 *
 * Refusal fallbacks are switched on (fallbacks: "default"): should a safety
 * classifier decline a request, the API re-runs it on a fallback model inside
 * the same call. If a gateway or account does not accept the beta, the call is
 * repeated without it, and the basic web-search tool is tried before giving up.
 */

import Anthropic from "@anthropic-ai/sdk";
import { PASS_A_SYSTEM, PASS_A_USER, PASS_B_SYSTEM, passBUser, ANALYSIS_SCHEMA } from "./prompts.mjs";

export const CLAUDE_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function claudeAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function client() {
  return new Anthropic({ timeout: 8 * 60 * 1000, maxRetries: 2 });
}

/* One request, with the fallbacks beta if it is accepted. */
async function create(c, params, state) {
  if (state.fallbacks !== false) {
    try {
      return await c.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      state.fallbacks = false;               // not accepted here: the same request without it
    }
  }
  return c.messages.create(params);
}

function checkStop(res, pass) {
  if (res.stop_reason === "refusal") {
    throw new Error(`${pass}: Claude lehnte ab (${res.stop_details?.category || "ohne Kategorie"})`);
  }
  if (res.stop_reason === "max_tokens") throw new Error(`${pass}: Antwort abgeschnitten (max_tokens)`);
}

/* Pass A: researched prose report with its sources. Returns { text, sources, model }. */
export async function claudeResearch() {
  const c = client();
  const state = {};
  let lastErr = null;
  for (const toolType of ["web_search_20260209", "web_search_20250305"]) {
    const messages = [{ role: "user", content: PASS_A_USER }];
    try {
      let res;
      for (let turn = 0; turn < 5; turn += 1) {
        res = await create(c, {
          model: CLAUDE_MODEL,
          max_tokens: 16000,
          system: PASS_A_SYSTEM,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          tools: [{ type: toolType, name: "web_search", max_uses: 15, user_location: { type: "approximate", country: "DE", timezone: "Europe/Berlin" } }],
          messages,
        }, state);
        if (res.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: res.content });   // a long search turn paused: let it continue
      }
      checkStop(res, "Recherche");
      return { ...readResearch(res), model: res.model || CLAUDE_MODEL };
    } catch (err) {
      lastErr = err;
      if (!(err instanceof Anthropic.BadRequestError)) throw err;     // only a rejected tool type is worth a second try
    }
  }
  throw lastErr;
}

/* Text of the report, and its sources. The report ends with a "QUELLEN:" list,
   one line per incident ("Kurztitel – URL"): those are the sources it rests
   on, together with any citations. Plain search results are only a fallback when
   nothing is cited, and reference works or mailing lists are left out of it. */
const NOT_A_SOURCE = /(^|\.)(wikipedia\.org|wikimedia\.org|lists\.openstreetmap\.org)$/i;
export function readResearch(res) {
  const text = [];
  const cited = [];
  const found = [];
  for (const block of res.content || []) {
    if (block.type === "text") {
      text.push(block.text);
      for (const ct of block.citations || []) if (ct.url) cited.push({ uri: ct.url, title: ct.title || ct.url });
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === "web_search_result" && r.url) found.push({ uri: r.url, title: r.title || r.url });
    }
  }
  let body = text.join("").trim();
  const listed = [];
  const m = /\n\s*\**QUELLEN:?\**\s*\n([\s\S]*)$/i.exec(body);
  if (m) {
    body = body.slice(0, m.index).trim();
    for (const line of m[1].split("\n")) {
      const u = /(https?:\/\/[^\s)\]>]+)/.exec(line);
      if (!u) continue;
      const title = line.slice(0, u.index).replace(/^[\s\-–*•\d.]+/, "").replace(/[\s–:\-(\[]+$/, "").trim();
      listed.push({ uri: u[1].replace(/[.,;]+$/, ""), title: title || u[1] });
    }
  }
  const host = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
  const seen = new Set();
  const sources = [];
  const add = (s, origin) => {
    if (!s.uri || seen.has(s.uri) || sources.length >= 15) return;
    seen.add(s.uri);
    sources.push({ uri: s.uri, title: s.title, origin });
  };
  listed.forEach((s) => add(s, "zitiert"));
  cited.forEach((s) => add(s, "zitiert"));
  if (!sources.length) found.filter((s) => !NOT_A_SOURCE.test(host(s.uri))).forEach((s) => add(s, "gefunden"));
  return { text: body, sources };
}

/* Pass B: incidents in the fixed schema. Returns { analysis, model }. */
export async function claudeAnalysis(material) {
  const c = client();
  const res = await create(c, {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: PASS_B_SYSTEM,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
    messages: [{ role: "user", content: passBUser(material) }],
  }, {});
  checkStop(res, "Auswertung");
  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { analysis: JSON.parse(text), model: res.model || CLAUDE_MODEL };
}
