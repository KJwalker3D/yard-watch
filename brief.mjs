#!/usr/bin/env node
// Morning brief for Roblox games. Zero dependencies, Node 18+.
// Pulls public stats, diffs against the previous run, prints a report,
// and posts it to a Discord webhook if one is configured in config.json.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, GAMES, webhookFor } from "./lib.mjs";

const HISTORY_PATH = join(ROOT, "data", "history.json");
const HISTORY_KEEP = 120; // snapshots kept per game (~4 months of daily runs)

let history = {};
try {
  history = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
} catch {
  // first run
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const ids = GAMES.map((g) => g.universeId).join(",");
const [gamesRes, votesRes] = await Promise.all([
  getJson(`https://games.roblox.com/v1/games?universeIds=${ids}`),
  getJson(`https://games.roblox.com/v1/games/votes?universeIds=${ids}`),
]);
const gameById = new Map(gamesRes.data.map((g) => [g.id, g]));
const votesById = new Map(votesRes.data.map((v) => [v.id, v]));

const now = new Date();
const fmt = (n) => n.toLocaleString("en-US");
const signed = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));

const lines = [];
const embeds = [];

for (const { name, universeId } of GAMES) {
  const g = gameById.get(universeId);
  const v = votesById.get(universeId);
  if (!g) {
    lines.push(`${name}: no data returned (universeId ${universeId})`);
    continue;
  }

  const snap = {
    at: now.toISOString(),
    visits: g.visits ?? 0,
    playing: g.playing ?? 0,
    favorites: g.favoritedCount ?? 0,
    upVotes: v?.upVotes ?? 0,
    downVotes: v?.downVotes ?? 0,
    updated: g.updated,
  };

  const past = history[universeId] ?? [];
  const prev = past[past.length - 1];

  // trend: average visits/day over up to the last 7 snapshots
  let trend = "";
  if (past.length >= 2) {
    const window = past.slice(-7);
    const days =
      (new Date(snap.at) - new Date(window[0].at)) / 86_400_000 || 1;
    const perDay = Math.round((snap.visits - window[0].visits) / days);
    trend = `${fmt(perDay)}/day over last ${window.length} runs`;
  }

  const totalVotes = snap.upVotes + snap.downVotes;
  const likePct = totalVotes
    ? `${Math.round((snap.upVotes / totalVotes) * 100)}%`
    : "n/a";

  const rows = [];
  rows.push(`Playing now: ${fmt(snap.playing)}`);
  rows.push(
    prev
      ? `Visits: ${fmt(snap.visits)} (${signed(snap.visits - prev.visits)} since last run)`
      : `Visits: ${fmt(snap.visits)}`
  );
  if (trend) rows.push(`Pace: ${trend}`);
  rows.push(
    prev
      ? `Favorites: ${fmt(snap.favorites)} (${signed(snap.favorites - prev.favorites)})`
      : `Favorites: ${fmt(snap.favorites)}`
  );
  rows.push(
    `Rating: ${likePct} 👍 (${fmt(snap.upVotes)} up / ${fmt(snap.downVotes)} down` +
      (prev
        ? `, ${signed(snap.upVotes - prev.upVotes)} up / ${signed(snap.downVotes - prev.downVotes)} down)`
        : ")")
  );
  if (prev && snap.updated !== prev.updated) {
    rows.push(`🆕 Place updated since last run (${new Date(snap.updated).toUTCString()})`);
  }

  lines.push(`## ${g.name}`, ...rows.map((r) => `  ${r}`), "");
  embeds.push({
    title: g.name,
    url: `https://www.roblox.com${g.canonicalUrlPath ?? ""}`,
    description: rows.join("\n"),
    color: 0x57f287,
  });

  history[universeId] = [...past, snap].slice(-HISTORY_KEEP);
}

const header = `☀️ Morning brief — ${now.toDateString()}`;
console.log(header + "\n");
console.log(lines.join("\n"));

mkdirSync(dirname(HISTORY_PATH), { recursive: true });
writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

const webhook = webhookFor("daily");
if (webhook) {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `**${header}**`, embeds }),
  });
  if (!res.ok) {
    console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log("Posted to Discord.");
} else {
  console.log("(No webhook configured — printed only.)");
}
