#!/usr/bin/env node
// Weekly rollup: reads the history that brief.mjs accumulates and posts a
// week-over-week summary. Scheduled for Sunday mornings.
// `node weekly.mjs --dry` prints without posting.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, GAMES, webhookFor } from "./lib.mjs";

const history = JSON.parse(readFileSync(join(ROOT, "data", "history.json"), "utf8"));

const now = Date.now();
const DAY = 86_400_000;
const fmt = (n) => n.toLocaleString("en-US");
const signed = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));

// closest snapshot to a target time, or null if none within 2 days of it
function closest(snaps, target) {
  let best = null;
  for (const s of snaps) {
    const dist = Math.abs(new Date(s.at) - target);
    if (dist < 2 * DAY && (!best || dist < best.dist)) best = { s, dist };
  }
  return best?.s ?? null;
}

const lines = [];
for (const { name, universeId } of GAMES) {
  const snaps = history[universeId];
  if (!snaps?.length) continue;
  const latest = snaps[snaps.length - 1];
  const weekAgo = closest(snaps, now - 7 * DAY);
  const twoWeeksAgo = closest(snaps, now - 14 * DAY);

  if (!weekAgo || weekAgo === latest) {
    lines.push(`**${name}** — not enough history yet (need ~a week of daily runs)`);
    continue;
  }

  const thisWeek = latest.visits - weekAgo.visits;
  const row = [`visits ${signed(thisWeek)}`];
  if (twoWeeksAgo && twoWeeksAgo !== weekAgo) {
    const lastWeek = weekAgo.visits - twoWeeksAgo.visits;
    if (lastWeek > 0) {
      const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
      row.push(`${pct >= 0 ? "+" : ""}${pct}% vs last week`);
    }
  }
  const favD = latest.favorites - weekAgo.favorites;
  if (favD) row.push(`favorites ${signed(favD)}`);
  const upD = latest.upVotes - weekAgo.upVotes;
  const downD = latest.downVotes - weekAgo.downVotes;
  if (upD || downD) row.push(`votes ${signed(upD)}👍 ${signed(downD)}👎`);
  const total = latest.upVotes + latest.downVotes;
  if (total) row.push(`rating ${Math.round((latest.upVotes / total) * 100)}%`);

  lines.push(`**${name}** — ${row.join(" · ")}`);
}

const msg = `📅 **Weekly rollup — ${new Date().toDateString()}**\n` + lines.join("\n");
console.log(msg);

const webhook = webhookFor("weekly");
if (!process.argv.includes("--dry") && webhook) {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: msg }),
  });
  if (!res.ok) {
    console.error(`Discord webhook failed: ${res.status}`);
    process.exit(1);
  }
  console.log("\nPosted to Discord.");
}
