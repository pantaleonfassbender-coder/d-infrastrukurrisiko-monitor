/* Offline unit tests for the collector layer: node tests/sources.test.mjs */

import assert from "node:assert/strict";
import {
  dedupeArticles,
  parseGoogleNewsRss,
  mapTagesschauResults,
  collectNews,
} from "../lib/sources.mjs";

const recentIso = new Date(Date.now() - 2 * 86400000).toUTCString();

// --- Google News RSS parsing ---
{
  const xml = `<rss><channel>
    <item>
      <title>Sabotage &amp; Spionage: Verfassungsschutz warnt - Spiegel</title>
      <link>https://news.google.com/rss/articles/ABC?oc=5</link>
      <pubDate>${recentIso}</pubDate>
      <source url="https://www.spiegel.de">Spiegel</source>
    </item>
    <item>
      <title><![CDATA[Drohnen über Kaserne gesichtet]]></title>
      <link>https://news.google.com/rss/articles/DEF?oc=5</link>
      <pubDate>not a date</pubDate>
      <source url="https://www1.ndr.de">NDR.de</source>
    </item>
  </channel></rss>`;

  const out = parseGoogleNewsRss(xml);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "Sabotage & Spionage: Verfassungsschutz warnt", "entities decoded, outlet suffix stripped");
  assert.equal(out[0].domain, "spiegel.de", "domain comes from <source url>");
  assert.equal(out[0].date, new Date(recentIso).toISOString());
  assert.equal(out[1].title, "Drohnen über Kaserne gesichtet", "CDATA unwrapped");
  assert.equal(out[1].domain, "ndr.de", "www1. prefix stripped");
  assert.equal(out[1].date, null, "an unparsable pubDate yields no date");
  assert.equal(parseGoogleNewsRss("").length, 0, "an empty body is not an error");
}

// --- tagesschau mapping ---
{
  const out = mapTagesschauResults({
    searchResults: [
      {
        title: '"Sensible Gegenstände" bei Umspannwerk',
        topline: "Nordrhein-Westfalen",
        date: "2026-09-03T23:08:00.000+02:00",
        detailsweb: "https://www.tagesschau.de/inland/regional/beispiel-100.html",
        shareURL: "https://www1.wdr.de/nrw/beispiel-100.html",
      },
      { title: "Ohne Region", date: "2026-09-01T10:00:00.000+02:00", shareURL: "https://www.tagesschau.de/x.html" },
    ],
  });
  assert.equal(out[0].title, 'Nordrhein-Westfalen: "Sensible Gegenstände" bei Umspannwerk');
  assert.equal(out[0].domain, "tagesschau.de", "detailsweb wins over shareURL");
  assert.equal(out[1].title, "Ohne Region");
  assert.equal(mapTagesschauResults(null).length, 0);
  assert.equal(mapTagesschauResults({}).length, 0);
}

// --- dedupe, age filter and cap ---
{
  const iso = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const out = dedupeArticles([
    { title: "Anschlag auf Umspannwerk", url: "https://a.example/1", date: iso(1) },
    { title: "anschlag auf umspannwerk!", url: "https://b.example/2", date: iso(2) },
    { title: "Alter Vorfall", url: "https://c.example/3", date: iso(120) },
    { title: "Ohne URL", url: "", date: iso(1) },
    { title: "", url: "https://d.example/4", date: iso(1) },
    { title: "Ohne Datum", url: "https://e.example/5" },
  ]);
  assert.equal(out.length, 2, "duplicates, URL-less, title-less and stale entries drop out");
  assert.equal(out[0].domain, "a.example", "the domain is derived from the URL when absent");
  assert.equal(out[1].title, "Ohne Datum", "an undated headline is kept as a candidate");
  assert.equal(out[1].date, null);

  const many = Array.from({ length: 90 }, (_, i) => ({
    title: `Vorfall ${i}`,
    url: `https://x.example/${i}`,
    date: iso(1),
  }));
  assert.equal(dedupeArticles(many).length, 60, "the list is capped");
  assert.equal(dedupeArticles(many, 5).length, 5);
}

// --- the news tier walks past failing and empty providers ---
{
  const article = [{ title: "Treffer", url: "https://ok.example/1", date: new Date().toISOString() }];
  const first = await collectNews([
    ["gdelt", async () => { throw new Error("HTTP 429 from api.gdeltproject.org"); }],
    ["googlenews", async () => []],
    ["tagesschau", async () => article],
  ]);
  assert.equal(first.provider, "tagesschau");
  assert.equal(first.articles.length, 1);
  assert.deepEqual(first.errors, [
    "gdelt: HTTP 429 from api.gdeltproject.org",
    "googlenews: no articles",
  ]);

  const primary = await collectNews([
    ["gdelt", async () => article],
    ["googlenews", async () => { throw new Error("must not be called"); }],
  ]);
  assert.equal(primary.provider, "gdelt", "a working primary short-circuits the chain");
  assert.deepEqual(primary.errors, []);

  const none = await collectNews([["gdelt", async () => { throw new Error("down"); }]]);
  assert.equal(none.provider, "none", "a total news outage is reported, not thrown");
  assert.equal(none.articles.length, 0);
}

console.log("sources.test.mjs: all assertions passed");
