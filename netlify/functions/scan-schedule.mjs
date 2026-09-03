/*
 * The daily clock. Netlify cron runs in UTC; 05:30 UTC is 06:30/07:30 in
 * Germany depending on DST — for a daily Lagebild the hour of drift does not
 * matter, so unlike a fixed-local-time publication this needs no DST
 * gymnastics. Scheduled functions have a ~30-second budget, so all this does
 * is hand the work to the background worker in scan-run.mjs.
 */

export default async (req, context) => {
  const base = process.env.URL || (context.site && context.site.url);
  if (!base) {
    console.error("scan-schedule: no site URL available, cannot enqueue");
    return;
  }

  const headers = { "content-type": "application/json" };
  if (process.env.SCAN_TOKEN) headers["x-scan-token"] = process.env.SCAN_TOKEN;

  const res = await fetch(`${base}/api/scan/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ source: "schedule" }),
  });

  /* A background function answers 202 as soon as it is accepted; anything
     else means the work never started. */
  if (res.status !== 202) {
    console.error(`scan-schedule: worker returned HTTP ${res.status}`);
    return;
  }
  console.log("scan-schedule: queued the daily scan");
};

export const config = {
  schedule: "30 5 * * *",
};
