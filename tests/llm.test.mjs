/* Offline tests for the model layer: provider order, schema dialect, reading Claude's research. node tests/llm.test.mjs */
import assert from "node:assert/strict";
import { providerOrder } from "../lib/llm.mjs";
import { toGeminiSchema } from "../lib/gemini.mjs";
import { readResearch } from "../lib/claude.mjs";
import { ANALYSIS_SCHEMA } from "../lib/prompts.mjs";

assert.deepEqual(providerOrder({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" }), ["anthropic", "gemini"], "Claude first when both are there");
assert.deepEqual(providerOrder({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", LLM_PROVIDER: "gemini" }), ["gemini", "anthropic"]);
assert.deepEqual(providerOrder({ GEMINI_API_KEY: "g" }), ["gemini"], "Gemini alone without Anthropic credentials");
assert.deepEqual(providerOrder({}), []);

const g = toGeminiSchema(ANALYSIS_SCHEMA);
assert.equal(g.type, "OBJECT");
assert.equal(g.properties.incidents.items.properties.bestaetigt.type, "BOOLEAN");
assert.ok(!JSON.stringify(g).includes("additionalProperties"), "Gemini's dialect has no additionalProperties");

const r = readResearch({ content: [
  { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
  { type: "web_search_tool_result", tool_use_id: "s1", content: [
    { type: "web_search_result", url: "https://a.example/1", title: "A" },
    { type: "web_search_result", url: "https://b.example/2", title: "B" } ] },
  { type: "text", text: "Am 3. Oktober ", citations: null },
  { type: "text", text: "brannte ein Kabelschacht.", citations: [{ type: "web_search_result_location", url: "https://b.example/2", title: "B", cited_text: "…" }] },
] });
assert.equal(r.text, "Am 3. Oktober brannte ein Kabelschacht.");
assert.equal(r.sources[0].uri, "https://b.example/2", "cited sources come first");
assert.equal(r.sources[0].origin, "zitiert");
assert.equal(r.sources.length, 2, "no duplicates");
const q = readResearch({ content: [
  { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://de.wikipedia.org/wiki/X", title: "W" }] },
  { type: "text", text: "Bericht über zwei Vorfälle.\n\nQUELLEN:\n- Brand Marzahn – https://www.tagesspiegel.de/berlin/brand.html\n- Drohne BER – https://www.rbb24.de/drohne.html." },
] });
assert.equal(q.text, "Bericht über zwei Vorfälle.", "the source list is cut from the report");
assert.deepEqual(q.sources.map((s) => s.uri), ["https://www.tagesspiegel.de/berlin/brand.html", "https://www.rbb24.de/drohne.html"]);
assert.equal(q.sources[0].title, "Brand Marzahn");
assert.ok(q.sources.every((s) => s.origin === "zitiert"));
console.log("llm tests passed");
