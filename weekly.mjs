#!/usr/bin/env node
// Weekly rollup: reads the history that brief.mjs accumulates and posts a
// week-over-week summary. Scheduled for Sunday mornings.
// `node weekly.mjs --dry` prints without posting.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, GAMES, DCL_WORLDS, webhookFor } from "./lib.mjs";

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

const dclLines = [];
for (const id of DCL_WORLDS) {
  const snaps = history[`dcl:${id}`];
  if (!snaps?.length) continue;
  const latest = snaps[snaps.length - 1];
  const weekAgo = closest(snaps, now - 7 * DAY);
  const name = latest.title ?? id;
  if (!weekAgo || weekAgo === latest) {
    dclLines.push(`**${name}** — not enough history yet (need ~a week of daily runs)`);
    continue;
  }
  const row = [
    `likes ${signed(latest.likes - weekAgo.likes)}👍 ${signed(latest.dislikes - weekAgo.dislikes)}👎`,
    `favorites ${signed(latest.favorites - weekAgo.favorites)}`,
  ];
  dclLines.push(`**${name}** — ${row.join(" · ")}`);
}

const msg = `📅 **Weekly rollup — ${new Date().toDateString()}**\n` + lines.join("\n");
console.log(msg);
const dclMsg = dclLines.length
  ? `📅 **DCL weekly — ${new Date().toDateString()}**\n` + dclLines.join("\n")
  : "";
if (dclMsg) console.log("\n" + dclMsg);

if (!process.argv.includes("--dry")) {
  const targets = [["weekly", msg, webhookFor("weekly")]];
  if (dclMsg) targets.push(["dcl", dclMsg, webhookFor("dcl", true)]);
  for (const [category, content, url] of targets) {
    if (!url) {
      console.log(`(No ${category} webhook — printed only.)`);
      continue;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error(`Discord ${category} webhook failed: ${res.status}`);
      process.exitCode = 1;
    } else {
      console.log(`Posted to Discord (${category}).`);
    }
  }
}
