/* Offline unit tests for the validation layer: node tests/core.test.mjs */

import assert from "node:assert/strict";
import { normalizeAnalysis, updateHistory, riskLevel, computeIndex, incidentWeight } from "../lib/core.mjs";

const today = new Date().toISOString().slice(0, 10);
const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
const ancient = "2020-01-01";

// --- normalizeAnalysis: the index is computed from the incidents, never taken from the model ---
{
  const out = normalizeAnalysis({
    score: 99,
    assessment: "Mehrere Vorfälle an Bahnanlagen in den letzten Wochen deuten auf eine erhöhte Bedrohungslage hin.",
    sectors: [{ key: "cyber", score: 150 }],
    incidents: [
      { date: recent, ort: "Hamburg", lat: 53.55, lon: 9.99, sektor: "bahn", schweregrad: 4, bestaetigt: true,
        titel: "Brandanschlag auf Kabelschacht", beschreibung: "x".repeat(1000), quelleUrl: "https://example.org/artikel" },
      { date: ancient, ort: "Alt", sektor: "bahn", schweregrad: 3, titel: "Zu alt" },
      { date: recent, ort: "", sektor: "bahn", schweregrad: 3, titel: "Ohne Ort" },
      { date: recent, ort: "Paris", lat: 48.85, lon: 2.35, sektor: "sonstige", schweregrad: 2, bestaetigt: false, titel: "Koordinaten außerhalb" },
      { date: recent, ort: "Deutschland", lat: 51.16, lon: 10.45, sektor: "cyber", schweregrad: 3, bestaetigt: true, titel: "Bundesweit" },
    ],
  });
  assert.equal(out.incidents.length, 3, "old and place-less incidents are dropped");
  assert.equal(out.incidents[0].beschreibung.length, 600, "description is capped");
  const paris = out.incidents.find((i) => i.ort === "Paris");
  assert.equal(paris.lat, null, "non-German coordinates are cleared");
  const de = out.incidents.find((i) => i.ort === "Deutschland");
  assert.equal(de.lat, null, "a generic place gets no map point");
  assert.equal(de.generic, true);
  assert.notEqual(out.score, 99, "the model's score is ignored");
  const expected = computeIndex(out.incidents).score;
  assert.equal(out.score, expected);
  assert.equal(out.level, riskLevel(expected));
  assert.equal(out.sectors.length, 6, "always the six known sectors");
  assert.ok(out.sectors.find((s) => s.key === "bahn").score > 35, "a sector with an incident rises above the baseline");
  assert.equal(out.sectors.find((s) => s.key === "energie").score, 35, "a sector without incidents stays at the baseline");
  assert.equal(out.index.method, "v3");
  assert.ok(out.incidents[0].gewicht >= out.incidents[1].gewicht, "incidents are sorted by weight");
}

// --- computeIndex: baseline, suspicion counts half, age decays ---
{
  assert.equal(computeIndex([]).score, 35, "no incidents: the baseline");
  const now = Date.parse("2026-10-19T12:00:00Z");
  const conf = { date: "2026-10-19", schweregrad: 5, bestaetigt: true, sektor: "energie" };
  const susp = { ...conf, bestaetigt: false };
  const old = { ...conf, date: "2026-10-05" };
  assert.ok(incidentWeight(susp, now) < incidentWeight(conf, now) * 0.6, "a suspicion counts half");
  assert.ok(incidentWeight(old, now) < incidentWeight(conf, now) * 0.3, "two weeks old: a quarter");
  const one = computeIndex([conf], now).score, two = computeIndex([conf, { ...conf, sektor: "bahn" }], now).score;
  assert.ok(one > 60 && one < 72, "one fresh severity-5 attack: high, not yet critical");
  assert.ok(two > 75, "two of them: critical");
  assert.ok(computeIndex(Array.from({ length: 40 }, () => conf), now).score <= 100);
}

// --- normalizeAnalysis: rejects thin output ---
assert.throws(() => normalizeAnalysis(null));
assert.throws(() => normalizeAnalysis({ score: 40, assessment: "zu kurz", sectors: [], incidents: [] }));

// --- unsafe URLs are dropped ---
{
  const out = normalizeAnalysis({
    score: 50,
    assessment: "Ein Vorfall mit einer nicht vertrauenswürdigen Quelle wird aufgenommen, die URL aber verworfen.",
    sectors: [],
    incidents: [
      { date: recent, ort: "Berlin", sektor: "cyber", schweregrad: 2, titel: "Test", quelleUrl: "javascript:alert(1)" },
    ],
  });
  assert.equal(out.incidents[0].quelleUrl, "");
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
