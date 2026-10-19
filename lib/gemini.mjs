/*
 * The two analysis passes on Gemini – the fallback when Claude is not
 * available (see lib/llm.mjs). Same prompts and schema as lib/claude.mjs.
 *
 * Pass A runs Google-Search grounding. Its source links are
 * vertexaisearch.cloud.google.com redirects that stop working after a while,
 * so they are resolved to the article URL at scan time (resolveRedirects).
 * Pass B returns JSON against the schema; the Gemini API does not allow the
 * google_search tool and a response schema in one call, hence two passes.
 *
 * The API key comes from the caller; this module never reads the environment.
 */

import { PASS_A_SYSTEM, PASS_A_USER, PASS_B_SYSTEM, passBUser, ANALYSIS_SCHEMA } from "./prompts.mjs";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/* Ordered fallback. 404/429/5xx moves to the next candidate; anything else
   (bad key, bad request) aborts, because retrying cannot fix it. */
const MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.5-pro"];

async function callModel(apiKey, payload) {
  let lastError = null;
  for (const model of MODEL_CANDIDATES) {
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p.text || "").join("");
      return { model, text, data };
    }
    let detail = "";
    try {
      detail = (await res.json())?.error?.message || "";
    } catch {
      /* body already consumed or not JSON */
    }
    lastError = new Error(`${model}: HTTP ${res.status} ${detail}`.trim());
    const retriable = res.status === 404 || res.status === 429 || res.status >= 500;
    if (!retriable) throw lastError;
  }
  throw lastError || new Error("no model candidates configured");
}

/* The JSON Schema in Gemini's OpenAPI dialect: upper-case types, no additionalProperties. */
export function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "additionalProperties") continue;
    if (k === "type" && typeof v === "string") out.type = v.toUpperCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === "items") out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}

/* A grounding link is a redirect; follow it once and keep where it points. */
export async function resolveRedirects(sources, { timeoutMs = 8000 } = {}) {
  return Promise.all(
    sources.map(async (s) => {
      if (!/grounding-api-redirect/.test(s.uri)) return s;
      try {
        const res = await fetch(s.uri, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        const loc = res.headers.get("location");
        if (loc && /^https?:\/\//i.test(loc)) return { ...s, uri: loc };
      } catch {
        /* keep the redirect: better a link that may expire than none */
      }
      return s;
    })
  );
}

/* Pass A: grounded prose report. Returns { text, sources, model }. */
export async function groundedReport(apiKey) {
  const { model, text, data } = await callModel(apiKey, {
    contents: [{ parts: [{ text: PASS_A_USER }] }],
    systemInstruction: { parts: [{ text: PASS_A_SYSTEM }] },
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
  });

  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const raw = chunks
    .map((c) => c.web)
    .filter((w) => w && w.uri)
    .slice(0, 12)
    .map((w) => ({ uri: w.uri, title: w.title || w.uri, origin: "grounding" }));

  return { text: text.trim(), sources: await resolveRedirects(raw), model };
}

/* Pass B: structured consolidation. Returns { analysis, model }. */
export async function structuredAnalysis(apiKey, material) {
  const { model, text } = await callModel(apiKey, {
    contents: [{ parts: [{ text: passBUser(material) }] }],
    systemInstruction: { parts: [{ text: PASS_B_SYSTEM }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(ANALYSIS_SCHEMA),
    },
  });
  return { analysis: JSON.parse(text), model };
}
