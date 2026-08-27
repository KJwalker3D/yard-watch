#!/usr/bin/env node
// Morning brief for Roblox games. Zero dependencies, Node 18+.
// Pulls public stats, diffs against the previous run, prints a report,
// and posts it to a Discord webhook if one is configured in config.json.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, GAMES, DCL_WORLDS, webhookFor, setting } from "./lib.mjs";

const DRY = process.argv.includes("--dry");

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

// ---- Decentraland worlds ----
const dclEmbeds = [];
if (DCL_WORLDS.length) {
  const qs = DCL_WORLDS.map((n) => `names=${encodeURIComponent(n)}`).join("&");
  const dclRes = await getJson(`https://places.decentraland.org/api/worlds?${qs}`);
  for (const w of dclRes.data ?? []) {
    const key = `dcl:${w.id}`;
    const past = history[key] ?? [];
    const prev = past[past.length - 1];
    const snap = {
      at: now.toISOString(),
      title: w.title,
      likes: w.likes ?? 0,
      dislikes: w.dislikes ?? 0,
      favorites: w.favorites ?? 0,
      users: w.user_count ?? 0,
      deployedAt: w.deployed_at,
    };
    const rows = [];
    rows.push(`In-world now: ${fmt(snap.users)}`);
    rows.push(
      `Likes: ${fmt(snap.likes)}👍 / ${fmt(snap.dislikes)}👎` +
        (prev ? ` (${signed(snap.likes - prev.likes)}👍 ${signed(snap.dislikes - prev.dislikes)}👎)` : "")
    );
    rows.push(
      `Favorites: ${fmt(snap.favorites)}` + (prev ? ` (${signed(snap.favorites - prev.favorites)})` : "")
    );
    if (typeof w.like_score === "number") rows.push(`Like score: ${Math.round(w.like_score * 100)}%`);
    if (prev && snap.deployedAt !== prev.deployedAt) {
      rows.push(`🚀 New deploy since last run (${new Date(snap.deployedAt).toUTCString()})`);
    }
    lines.push(`## ${w.title} (DCL)`, ...rows.map((r) => `  ${r}`), "");
    dclEmbeds.push({
      title: `${w.title} (DCL)`,
      url: `https://decentraland.org/jump/?realm=${w.id}`,
      description: rows.join("\n"),
      color: 0xff2d55,
    });
    history[key] = [...past, snap].slice(-HISTORY_KEEP);
  }
}

// ---- Self-owned session telemetry (Supabase, Yard Wars) ----
const SB_URL = setting("SUPABASE_URL", "");
const SB_KEY = setting("SUPABASE_KEY", "");
let statsEmbed = null;
if (SB_URL && SB_KEY) {
  try {
    const since = new Date(now.getTime() - 8 * 86400000).toISOString();
    const res = await fetch(
      `${SB_URL}/rest/v1/yw_sessions?select=at,user_id,is_new,secs,step,platform&at=gte.${since}&limit=10000`,
      { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } }
    );
    if (!res.ok) throw new Error(`supabase ${res.status}`);
    const rows = await res.json();
    const day = (iso) => iso.slice(0, 10);
    const yest = day(new Date(now.getTime() - 86400000).toISOString());
    const before = day(new Date(now.getTime() - 2 * 86400000).toISOString());
    const yRows = rows.filter((r) => day(r.at) === yest);
    const newY = new Set(yRows.filter((r) => r.is_new).map((r) => r.user_id));
    const newB = new Set(rows.filter((r) => day(r.at) === before && r.is_new).map((r) => r.user_id));
    const returnedY = new Set(yRows.filter((r) => newB.has(r.user_id)).map((r) => r.user_id));
    const d1 = newB.size ? Math.round((returnedY.size / newB.size) * 100) : null;
    const firstSecs = yRows.filter((r) => r.is_new).map((r) => r.secs).sort((a, b) => a - b);
    const median = firstSecs.length ? firstSecs[Math.floor(firstSecs.length / 2)] : null;
    const ORDER = { Quit_BeforeYard: 0, Quit_NoSetYet: 1, Quit_AfterCoach: 2, Quit_AfterSet: 3, Quit_AfterLaunch: 4 };
    const best = new Map();
    for (const r of yRows) {
      if (!newY.has(r.user_id)) continue;
      const o = ORDER[r.step] ?? 0;
      if (o > (best.get(r.user_id) ?? -1)) best.set(r.user_id, o);
    }
    const reached = (lvl) => [...best.values()].filter((o) => o >= lvl).length;
    const mob = yRows.filter((r) => r.platform === "Mobile").length;
    const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? (s % 60) + "s" : ""}` : `${s}s`);
    const t = [];
    t.push(`New players: ${newY.size}`);
    if (d1 !== null) t.push(`D1: ${returnedY.size}/${newB.size} of ${before}'s new players returned (${d1}%)`);
    if (median !== null) t.push(`Median first session: ${fmtSecs(median)}`);
    if (newY.size) t.push(`Funnel: coach ${reached(2)}/${newY.size} · first set ${reached(3)} · first launch ${reached(4)}`);
    if (yRows.length) t.push(`Sessions: ${yRows.length} (${Math.round((mob / yRows.length) * 100)}% mobile)`);
    if (yRows.length || newB.size) {
      lines.push(`## 📊 Yesterday (Yard Wars telemetry)`, ...t.map((r) => `  ${r}`), "");
      statsEmbed = { title: "📊 Yesterday — Yard Wars", description: t.join("\n"), color: 0x4caf50 };
    } else {
      console.log("(telemetry: connected, no session rows for yesterday yet)");
    }
  } catch (e) {
    console.error("telemetry: " + e.message);
  }
}
if (statsEmbed) embeds.push(statsEmbed);

const header = `☀️ Morning brief — ${now.toDateString()}`;
console.log(header + "\n");
console.log(lines.join("\n"));

mkdirSync(dirname(HISTORY_PATH), { recursive: true });
writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

async function postEmbeds(category, content, embedList, noFallback = false) {
  const url = webhookFor(category, noFallback);
  if (!url) {
    console.log(`(No ${category} webhook — printed only.)`);
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, embeds: embedList }),
  });
  if (!res.ok) {
    console.error(`Discord ${category} webhook failed: ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Posted to Discord (${category}).`);
}

if (!DRY) {
  await postEmbeds("daily", `**${header}**`, embeds);
  if (dclEmbeds.length) {
    await postEmbeds("dcl", `**🪩 DCL brief — ${now.toDateString()}**`, dclEmbeds, true);
  }
}
