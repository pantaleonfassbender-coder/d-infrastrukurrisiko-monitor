/* Offline unit tests for the collector layer: node tests/sources.test.mjs */

import assert from "node:assert/strict";
import { parseFeed, isInfraRelevant, mergeArticles } from "../lib/sources.mjs";

// --- parseFeed: RSS 2.0 ---
{
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item>
      <title><![CDATA[Sabotage an Umspannwerk in Bergheim]]></title>
      <link>https://example.de/artikel-1</link>
      <pubDate>Thu, 03 Sep 2026 08:15:00 +0200</pubDate>
      <description>Die Polizei ermittelt wegen &lt;b&gt;Sabotage&lt;/b&gt;.</description>
    </item>
    <item><title>Ohne Link</title><pubDate>Thu, 03 Sep 2026 08:15:00 +0200</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 1, "items without a usable link are dropped");
  assert.equal(items[0].title, "Sabotage an Umspannwerk in Bergheim", "CDATA is unwrapped");
  assert.equal(items[0].url, "https://example.de/artikel-1");
  assert.equal(items[0].date, "2026-09-03T06:15:00.000Z", "pubDate becomes ISO/UTC");
  assert.equal(items[0].summary, "Die Polizei ermittelt wegen Sabotage .", "markup is stripped");
}

// --- parseFeed: Atom with href links and numeric entities ---
{
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>Drohnensichtung &#252;ber Flughafen</title>
      <link rel="alternate" href="https://example.de/atom-1"/>
      <updated>2026-09-02T10:00:00+02:00</updated>
      <summary>Kurzfassung</summary>
    </entry>
  </feed>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Drohnensichtung über Flughafen", "numeric entities are decoded");
  assert.equal(items[0].url, "https://example.de/atom-1", "href links are used");
}

assert.deepEqual(parseFeed(""), [], "an empty document yields no items");
assert.deepEqual(parseFeed("<rss><channel></channel></rss>"), []);

// --- isInfraRelevant ---
{
  assert.ok(isInfraRelevant("Sabotage an Umspannwerken in NRW"), "strong wording alone counts");
  assert.ok(isInfraRelevant("Brandanschlag auf Kabelschacht der Bahn"));
  assert.ok(isInfraRelevant("Drohne über Bundeswehr-Gelände gesichtet"), "weak wording plus attack wording");
  assert.ok(!isInfraRelevant("Neue Drohne von DJI im Test"), "weak wording alone is not enough");
  assert.ok(!isInfraRelevant("BGH klärt Sampling-Streit um Kraftwerk-Beat"));
  assert.ok(
    !isInfraRelevant("Ukrainische Geheimdienstzentrale von russischer Drohne getroffen"),
    "incidents abroad are dropped"
  );
  assert.ok(
    isInfraRelevant("Frankreich und Polen stellen sich nach Drohnen-Vorfall hinter Deutschland"),
    "a story abroad that is about Germany stays"
  );
  assert.ok(!isInfraRelevant(""), "empty text is never relevant");
}

// --- mergeArticles ---
{
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const archive = [
    { title: "Sabotage an Umspannwerk", url: "https://example.de/a", domain: "example.de", date: iso(4), origin: "news" },
    { title: "Sehr alte Meldung", url: "https://example.de/old", domain: "example.de", date: iso(40), origin: "gdelt" },
  ];
  const fresh = [
    /* Same story, seen again today: the earlier date must win. */
    { title: "Sabotage an   Umspannwerk!", url: "https://example.de/a", domain: "example.de", date: iso(0), origin: "news" },
    { title: "Kabel durchtrennt in Aachen", url: "https://example.de/b", domain: "example.de", date: iso(1), origin: "gdelt" },
    { title: "Ohne gültige URL", url: "javascript:alert(1)", date: iso(0), origin: "news" },
    { title: "Ohne Datum", url: "https://example.de/c", date: null, origin: "news" },
    null,
  ];
  const merged = mergeArticles(archive, fresh);
  const titles = merged.map((a) => a.title);
  assert.ok(!titles.includes("Sehr alte Meldung"), "entries beyond the 30-day window are pruned");
  assert.ok(!titles.includes("Ohne gültige URL"), "non-http URLs are rejected");
  assert.ok(titles.includes("Ohne Datum"), "an undated entry is kept");
  assert.equal(merged.filter((a) => /sabotage an\s+umspannwerk/i.test(a.title)).length, 1, "the story is deduplicated");
  const dedup = merged.find((a) => /sabotage an\s+umspannwerk/i.test(a.title));
  assert.equal(dedup.date, archive[0].date, "the earliest known date is kept");
  assert.equal(merged[0].title, "Kabel durchtrennt in Aachen", "newest first");
  assert.equal(mergeArticles(null, null).length, 0, "missing input is tolerated");
  assert.equal(mergeArticles([], fresh, { maxItems: 1 }).length, 1, "the archive is capped");
}

console.log("sources tests passed");
