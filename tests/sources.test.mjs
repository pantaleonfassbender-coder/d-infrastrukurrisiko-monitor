/* Offline unit tests for the collector layer: node tests/sources.test.mjs */

import assert from "node:assert/strict";
import { GDELT_QUERY, interpretGdeltBody, normalizeGdeltArticles } from "../lib/sources.mjs";

// --- the query itself, whose two constraints are invisible until it fails ---
{
  /* GDELT rejects anything past 250 characters with "Your query was too short
     or too long", and answers an ISO language code with "Invalid/Unsupported
     Language." Both come back as a healthy-looking HTTP 200. */
  assert.ok(
    GDELT_QUERY.length <= 250,
    `the GDELT query must stay within 250 characters, is ${GDELT_QUERY.length}`
  );
  assert.match(GDELT_QUERY, /sourcelang:german\b/, "sourcelang takes the language name");
  assert.doesNotMatch(GDELT_QUERY, /sourcelang:ger\b/, "sourcelang:ger is rejected by GDELT");
  assert.match(GDELT_QUERY, /sourcecountry:germany/);
}

// --- interpretGdeltBody: the failure mode that kept GDELT empty ---
{
  /* GDELT answers a rejected parameter with HTTP 200 and prose. Treating that
     as JSON is what turned a fixable query bug into an opaque parse error. */
  const out = interpretGdeltBody(200, "Invalid/Unsupported Language.\n");
  assert.equal(out.articles, undefined, "prose is not a result set");
  assert.equal(out.error, "Invalid/Unsupported Language.", "GDELT's own wording is kept, unprefixed");
  assert.equal(out.retriable, false, "a rejected query must not be retried");
}

// --- interpretGdeltBody: throttling is worth another attempt ---
{
  const throttled = interpretGdeltBody(429, "Please limit requests to one every 5 seconds or contact ...");
  assert.equal(throttled.retriable, true);
  /* GDELT sometimes serves the same sentence with a 200. */
  const throttled200 = interpretGdeltBody(200, "Please limit requests to one every 5 seconds");
  assert.equal(throttled200.retriable, true);
  assert.equal(interpretGdeltBody(503, "backend down").retriable, true);
}

// --- interpretGdeltBody: valid JSON is authoritative, even when empty ---
{
  assert.deepEqual(interpretGdeltBody(200, '{"articles":[]}').articles, []);
  assert.deepEqual(interpretGdeltBody(200, "{}").articles, [], "no articles key means no matches");
  const ok = interpretGdeltBody(200, '{"articles":[{"url":"https://a.de/1","title":"T"}]}');
  assert.equal(ok.articles.length, 1);
  assert.equal(ok.error, undefined);
}

// --- interpretGdeltBody: an empty body still reports something usable ---
assert.equal(interpretGdeltBody(502, "").error, "HTTP 502", "an empty body still names the status");

// --- normalizeGdeltArticles: dedupe, shaping, caps ---
{
  const out = normalizeGdeltArticles([
    { url: "https://a.de/1", title: "Sabotage an Bahnkabel", domain: "a.de", seendate: "20260903T053000Z" },
    { url: "https://a.de/1", title: "Sabotage an Bahnkabel", domain: "a.de", seendate: "20260903T053000Z" },
    { url: "https://b.de/2", title: "Sabotage an Bahnkabel!", domain: "b.de", seendate: "20260903T060000Z" },
    { url: "https://c.de/3", title: "Drohne über Werk", domain: "c.de", seendate: "kaputt" },
    { url: "", title: "Ohne URL" },
    { url: "https://d.de/4", title: "" },
    null,
  ]);
  assert.equal(out.length, 2, "duplicate URLs and near-identical headlines collapse");
  assert.equal(out[0].date, "2026-09-03T05:30:00Z", "seendate becomes ISO");
  assert.equal(out[1].date, null, "an unparseable seendate is null, not a crash");
  assert.equal(out[1].title, "Drohne über Werk", "umlauts survive the dedupe key");
}

// --- normalizeGdeltArticles: hostile input ---
{
  assert.deepEqual(normalizeGdeltArticles(null), []);
  assert.deepEqual(normalizeGdeltArticles("nope"), []);
  const long = normalizeGdeltArticles([
    { url: "https://a.de/x", title: "x".repeat(500), seendate: "20260903T053000Z" },
  ]);
  assert.equal(long[0].title.length, 200, "titles are capped");
}

// --- normalizeGdeltArticles: the 120-article cap holds ---
{
  const many = Array.from({ length: 250 }, (_, i) => ({
    url: `https://a.de/${i}`,
    title: `Vorfall Nummer ${i}`,
    seendate: "20260903T053000Z",
  }));
  assert.equal(normalizeGdeltArticles(many).length, 120);
}

console.log("sources.test.mjs: all assertions passed");
