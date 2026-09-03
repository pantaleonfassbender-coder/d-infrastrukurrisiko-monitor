/* Offline unit tests for the validation layer: node tests/core.test.mjs */

import assert from "node:assert/strict";
import { normalizeAnalysis, updateHistory, riskLevel } from "../lib/core.mjs";

const today = new Date().toISOString().slice(0, 10);
const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
const ancient = "2020-01-01";

/* Stands in for the GDELT articles of a run: only these URLs may be cited. */
const POOL = [
  "https://example.org/artikel",
  "https://www.beispiel.de/news/kabelbrand?utm_source=gdelt",
  "not a url",
];
const opts = { sourceUrls: POOL };

// --- normalizeAnalysis: happy path ---
{
  const out = normalizeAnalysis(
    {
      score: 62,
      assessment: "Mehrere Vorfälle an Bahnanlagen in den letzten Wochen deuten auf eine erhöhte Bedrohungslage hin.",
      sectors: [
        { key: "bahn", score: 70 },
        { key: "unbekannt", score: 99 },
        { key: "cyber", score: 150 },
      ],
      incidents: [
        {
          date: recent,
          ort: "Hamburg",
          lat: 53.55,
          lon: 9.99,
          sektor: "bahn",
          schweregrad: 4,
          titel: "Brandanschlag auf Kabelschacht",
          beschreibung: "x".repeat(1000),
          quelleUrl: "https://example.org/artikel",
        },
        { date: ancient, ort: "Alt", sektor: "bahn", schweregrad: 3, titel: "Zu alt", quelleUrl: POOL[0] },
        { date: recent, ort: "", sektor: "bahn", schweregrad: 3, titel: "Ohne Ort", quelleUrl: POOL[0] },
        {
          date: recent,
          ort: "Paris",
          lat: 48.85,
          lon: 2.35,
          sektor: "sonstige",
          schweregrad: 2,
          titel: "Koordinaten außerhalb",
          quelleUrl: POOL[0],
        },
      ],
    },
    opts
  );
  assert.equal(out.score, 62);
  assert.equal(out.level, "ERHÖHT");
  assert.equal(out.incidents.length, 2, "old and place-less incidents are dropped");
  assert.equal(out.incidents[0].beschreibung.length, 600, "description is capped");
  assert.equal(out.incidents[1].lat, null, "non-German coordinates are cleared");
  assert.equal(out.sectors.length, 6, "always the six known sectors");
  const cyber = out.sectors.find((s) => s.key === "cyber");
  assert.equal(cyber.score, 100, "sector scores are clamped");
  const energie = out.sectors.find((s) => s.key === "energie");
  assert.equal(energie.score, 35, "missing sectors fall to baseline");
}

// --- normalizeAnalysis: baseline enforcement with no incidents ---
{
  const out = normalizeAnalysis(
    {
      score: 95,
      assessment: "Keine Vorfälle in den letzten 30 Tagen; die Lage bleibt auf dem bekannten Grundniveau angespannt.",
      sectors: [],
      incidents: [],
    },
    opts
  );
  assert.equal(out.score, 45, "no incidents caps the score at the baseline band");
  const low = normalizeAnalysis(
    {
      score: 5,
      assessment: "Keine Vorfälle in den letzten 30 Tagen; die Lage bleibt auf dem bekannten Grundniveau angespannt.",
      sectors: [],
      incidents: [],
    },
    opts
  );
  assert.equal(low.score, 35, "no incidents lifts the score to the baseline band");
}

// --- normalizeAnalysis: rejects thin output ---
assert.throws(() => normalizeAnalysis(null, opts));
assert.throws(() =>
  normalizeAnalysis({ score: 40, assessment: "zu kurz", sectors: [], incidents: [] }, opts)
);

// --- source obligation: only incidents citing a GDELT article survive ---
{
  const assessment =
    "Die Quellenpflicht wird geprüft: Vorfälle ohne Beleg aus dem GDELT-Material fallen aus dem Lagebild heraus.";
  const base = { date: recent, ort: "Berlin", sektor: "cyber", schweregrad: 2 };
  const out = normalizeAnalysis(
    {
      score: 60,
      assessment,
      sectors: [],
      incidents: [
        { ...base, titel: "Ohne Quelle" },
        { ...base, titel: "Leere Quelle", quelleUrl: "" },
        { ...base, titel: "Unsichere Quelle", quelleUrl: "javascript:alert(1)" },
        { ...base, titel: "Fremde Quelle", quelleUrl: "https://erfunden.example/story" },
        { ...base, titel: "Domain statt Artikel", quelleUrl: "https://example.org" },
        { ...base, titel: "Belegt", quelleUrl: "https://example.org/artikel" },
        { ...base, titel: "Belegt, URL variiert", quelleUrl: "http://beispiel.de/news/kabelbrand/" },
      ],
    },
    opts
  );
  assert.deepEqual(
    out.incidents.map((i) => i.titel),
    ["Belegt", "Belegt, URL variiert"],
    "unsourced, invented and unsafe citations are dropped"
  );
  assert.equal(
    out.incidents[1].quelleUrl,
    POOL[1],
    "a citation with a different scheme, www or query resolves to the collector's URL"
  );
  assert.equal(out.unsourcedDropped, 5, "dropped incidents are counted for the stats");
}

// --- without a GDELT pool the run fails instead of publishing a baseline ---
{
  const raw = {
    score: 60,
    assessment: "Ohne GDELT-Material lässt sich die Quellenpflicht nicht prüfen, der Lauf muss scheitern.",
    sectors: [],
    incidents: [
      { date: recent, ort: "Berlin", sektor: "cyber", schweregrad: 2, titel: "Belegt", quelleUrl: POOL[0] },
    ],
  };
  assert.throws(() => normalizeAnalysis(raw), /source pool/);
  assert.throws(() => normalizeAnalysis(raw, { sourceUrls: [] }), /source pool/);
  assert.throws(() => normalizeAnalysis(raw, { sourceUrls: ["nonsense", "ftp://x/y"] }), /source pool/);
}

// --- updateHistory ---
{
  const h1 = updateHistory([], { date: today, score: 40, sectors: {}, incidentCount: 0 });
  assert.equal(h1.length, 1);
  const h2 = updateHistory(h1, { date: today, score: 55, sectors: {}, incidentCount: 2 });
  assert.equal(h2.length, 1, "same-day rescan replaces the entry");
  assert.equal(h2[0].score, 55);
  const big = Array.from({ length: 450 }, (_, i) => ({
    date: new Date(Date.now() - (450 - i) * 86400000).toISOString().slice(0, 10),
    score: 40,
  }));
  const h3 = updateHistory(big, { date: today, score: 41 });
  assert.equal(h3.length, 400, "history is capped");
  assert.equal(h3[h3.length - 1].date, today);
}

// --- riskLevel bands ---
assert.equal(riskLevel(80), "KRITISCH");
assert.equal(riskLevel(60), "ERHÖHT");
assert.equal(riskLevel(38), "LATENT");
assert.equal(riskLevel(10), "RUHIG");

console.log("core.test.mjs: all assertions passed");
