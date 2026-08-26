#!/usr/bin/env node
// Live watcher: runs every few minutes via launchd. Alerts Discord when
// someone starts playing, when votes/favorites move, and when a tracked
// UGC item changes state (on-sale flip, Limited conversion, stock drops).
// Shares config.json with brief.mjs. State in data/watch-state.json.
// `node watch.mjs --test` sends a test ping to verify the webhook.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, GAMES, UGC_ITEMS, webhookFor, setting } from "./lib.mjs";

const STATE_PATH = join(ROOT, "data", "watch-state.json");
const VELOCITY_ALERT = Number(setting("VELOCITY_ALERT", 5)) || 5;

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function post(category, content) {
  const url = webhookFor(category);
  if (!url) {
    console.log(`[no ${category} webhook] ` + content);
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Discord ${category} webhook failed: ${res.status}`);
}

if (process.argv.includes("--test")) {
  await post("live", "👀 Watcher test ping (live channel) — wiring works.");
  await post("ugc", "👀 Watcher test ping (ugc channel) — wiring works.");
  console.log("Test pings sent.");
  process.exit(0);
}

let state = {};
try {
  state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
} catch {
  // first run
}
state.games ??= {};
state.items ??= {};

const alerts = []; // live game events
const ugcAlerts = []; // UGC item events
const fmt = (n) => n.toLocaleString("en-US");

// ---- games: CCU / votes / favorites ----
const ids = GAMES.map((g) => g.universeId).join(",");
const [gamesRes, votesRes] = await Promise.all([
  getJson(`https://games.roblox.com/v1/games?universeIds=${ids}`),
  getJson(`https://games.roblox.com/v1/games/votes?universeIds=${ids}`),
]);
const votesById = new Map(votesRes.data.map((v) => [v.id, v]));

for (const g of gamesRes.data) {
  const prev = state.games[g.id] ?? {};
  const v = votesById.get(g.id) ?? {};
  const cur = {
    playing: g.playing ?? 0,
    favorites: g.favoritedCount ?? 0,
    up: v.upVotes ?? 0,
    down: v.downVotes ?? 0,
  };
  const name = g.name;

  if (cur.playing > 0 && (prev.playing ?? 0) === 0) {
    alerts.push(
      `🎮 **${name}** — ${cur.playing} player${cur.playing === 1 ? "" : "s"} in RIGHT NOW`
    );
  }
  if (prev.favorites !== undefined && cur.favorites > prev.favorites) {
    alerts.push(`⭐ **${name}** — +${cur.favorites - prev.favorites} favorite(s) (${fmt(cur.favorites)} total)`);
  }
  if (prev.up !== undefined && cur.up > prev.up) {
    alerts.push(`👍 **${name}** — +${cur.up - prev.up} like(s)`);
  }
  if (prev.down !== undefined && cur.down > prev.down) {
    alerts.push(`👎 **${name}** — +${cur.down - prev.down} dislike(s)`);
  }
  state.games[g.id] = cur;
}

// ---- UGC items: sale state / Limited conversion / stock ----
for (const item of UGC_ITEMS) {
  let d;
  try {
    d = await getJson(`https://economy.roblox.com/v2/assets/${item.assetId}/details`);
  } catch (e) {
    console.error(`ugc ${item.name}: ${e.message}`);
    continue;
  }
  const prev = state.items[item.assetId] ?? {};
  const cur = {
    forSale: !!d.IsForSale,
    limited: !!(d.IsLimited || d.IsLimitedUnique),
    remaining: d.Remaining,
    sales: d.Sales ?? 0,
  };
  const name = item.name;

  if (prev.limited === false && cur.limited) {
    ugcAlerts.push(`💎 **${name}** is now LIMITED${cur.remaining != null ? ` — ${cur.remaining} copies` : ""}`);
  }
  if (prev.forSale !== undefined && cur.forSale !== prev.forSale) {
    ugcAlerts.push(cur.forSale ? `🟢 **${name}** went ON SALE` : `🔴 **${name}** went off sale`);
  }
  if (prev.remaining != null && cur.remaining != null && cur.remaining < prev.remaining) {
    const gone = prev.remaining - cur.remaining;
    const speed = gone >= VELOCITY_ALERT ? " ⚠️ FAST — possible alt fleet" : "";
    ugcAlerts.push(`📦 **${name}** — ${gone} claimed since last check, **${cur.remaining} left**${speed}`);
  }
  if (prev.remaining == null && cur.remaining != null) {
    ugcAlerts.push(`📦 **${name}** stock now visible: ${cur.remaining} remaining`);
  }
  state.items[item.assetId] = cur;
}

mkdirSync(dirname(STATE_PATH), { recursive: true });
writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

if (alerts.length) {
  await post("live", alerts.join("\n"));
  console.log(`Sent ${alerts.length} live alert(s):\n` + alerts.join("\n"));
}
if (ugcAlerts.length) {
  await post("ugc", ugcAlerts.join("\n"));
  console.log(`Sent ${ugcAlerts.length} UGC alert(s):\n` + ugcAlerts.join("\n"));
}
if (!alerts.length && !ugcAlerts.length) {
  console.log("No events.");
}
