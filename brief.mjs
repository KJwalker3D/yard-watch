#!/usr/bin/env node
// Morning brief for Roblox games. Zero dependencies, Node 18+.
// Pulls public stats, diffs against the previous run, prints a report,
// and posts it to a Discord webhook if one is configured in config.json.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, GAMES, DCL_WORLDS, webhookFor, setting } from "./lib.mjs";

const DRY = process.argv.includes("--dry");

// --if-due: exit quietly unless today's (UTC) brief hasn't been sent yet. Lets the watch loop
// deliver the brief when GitHub's scheduler drops the dedicated cron (it drops most of them).
const IF_DUE = process.argv.includes("--if-due");
const BRIEF_STATE = join(ROOT, "data", "brief-state.json");
const todayUTC = new Date().toISOString().slice(0, 10);
if (IF_DUE) {
  try {
    if (JSON.parse(readFileSync(BRIEF_STATE, "utf8")).lastDate === todayUTC) {
      console.log("brief already sent today — skipping");
      process.exit(0);
    }
  } catch {
    // no state yet — due
  }
}

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

// ---- Self-owned session telemetry (Supabase) ----
// Every game that mirrors its session ends into the table (Yard Wars' built-in sender, or the
// drop-in SessionTelemetry script) shows up here, grouped by game slug, and is folded into that
// game's own embed below (separate embeds would blow Discord's 10-per-message cap).
const SB_URL = setting("SUPABASE_URL", "");
const SB_KEY = setting("SUPABASE_KEY", "");
const telRows = new Map(); // slug -> session rows from the last 8 days
if (SB_URL && SB_KEY) {
  try {
    const since = new Date(now.getTime() - 8 * 86400000).toISOString();
    const page = (cols, offset) =>
      fetch(
        `${SB_URL}/rest/v1/yw_sessions?select=${cols}&at=gte.${since}&order=at.asc&limit=1000&offset=${offset}`,
        { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } }
      );
    // Until the `game` column exists every row is Yard Wars', so fall back to the old column list.
    let cols = "at,user_id,is_new,secs,step,platform,game";
    let first = await page(cols, 0);
    if (!first.ok) {
      cols = "at,user_id,is_new,secs,step,platform";
      first = await page(cols, 0);
    }
    if (!first.ok) throw new Error(`supabase ${first.status}`);
    let batch = await first.json();
    for (let offset = 0, n = 0; ; n++) {
      for (const r of batch) {
        const slug = r.game ?? "yard-wars";
        if (!telRows.has(slug)) telRows.set(slug, []);
        telRows.get(slug).push(r);
      }
      if (batch.length < 1000 || n >= 30) break;
      offset += 1000;
      const res = await page(cols, offset);
      if (!res.ok) throw new Error(`supabase ${res.status}`);
      batch = await res.json();
    }
  } catch (e) {
    console.error("telemetry: " + e.message);
  }
}

const dayOf = (iso) => iso.slice(0, 10);
const yest = dayOf(new Date(now.getTime() - 86400000).toISOString());
const before = dayOf(new Date(now.getTime() - 2 * 86400000).toISOString());
const FUNNEL_ORDER = { Quit_BeforeYard: 0, Quit_NoSetYet: 1, Quit_AfterCoach: 2, Quit_AfterSet: 3, Quit_AfterLaunch: 4 };
const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? (s % 60) + "s" : ""}` : `${s}s`);

// "newBy: datastore" games decide is_new from a first-visit stamp that only starts existing the day
// tracking is installed, so for the first week "new" also counts veterans on their first tracked visit.
function telemetryLines(slug, newBy) {
  const rows = telRows.get(slug);
  if (!rows?.length) return [];
  const yRows = rows.filter((r) => dayOf(r.at) === yest);
  const newY = new Set(yRows.filter((r) => r.is_new).map((r) => r.user_id));
  const newB = new Set(rows.filter((r) => dayOf(r.at) === before && r.is_new).map((r) => r.user_id));
  if (!yRows.length && !newB.size) return [];
  const returnedY = new Set(yRows.filter((r) => newB.has(r.user_id)).map((r) => r.user_id));
  const firstSecs = yRows.filter((r) => r.is_new).map((r) => r.secs).sort((a, b) => a - b);
  const t = [`New players: ${newY.size}`];
  if (newB.size) {
    t.push(`D1: ${returnedY.size}/${newB.size} of ${before}'s new players returned (${Math.round((returnedY.size / newB.size) * 100)}%)`);
  }
  if (firstSecs.length) t.push(`Median first session: ${fmtSecs(firstSecs[Math.floor(firstSecs.length / 2)])}`);
  const best = new Map();
  for (const r of yRows) {
    if (!newY.has(r.user_id) || !(r.step in FUNNEL_ORDER)) continue;
    best.set(r.user_id, Math.max(best.get(r.user_id) ?? -1, FUNNEL_ORDER[r.step]));
  }
  if (best.size) {
    const reached = (lvl) => [...best.values()].filter((o) => o >= lvl).length;
    t.push(`Funnel: coach ${reached(2)}/${newY.size} · first set ${reached(3)} · first launch ${reached(4)}`);
  }
  const known = yRows.filter((r) => r.platform);
  const mobile = known.filter((r) => r.platform === "Mobile").length;
  t.push(
    `Sessions: ${yRows.length}` +
      (known.length ? ` (${Math.round((mobile / known.length) * 100)}% mobile)` : "")
  );
  if (newBy === "datastore") {
    const key = `tel:${slug}`;
    history[key] ??= rows.reduce((min, r) => (dayOf(r.at) < min ? dayOf(r.at) : min), todayUTC);
    const dayN = Math.floor((new Date(todayUTC) - new Date(history[key])) / 86400000) + 1;
    if (dayN <= 7) t.push(`⏳ Calibrating (day ${dayN}/7): "new" also counts returning veterans on their first tracked visit`);
  }
  return t;
}

for (const { name, universeId, slug, newBy } of GAMES) {
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
  const tel = slug ? telemetryLines(slug, newBy) : [];
  if (tel.length) rows.push("", "**📊 Yesterday**", ...tel);

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
  if (!process.exitCode) {
    writeFileSync(BRIEF_STATE, JSON.stringify({ lastDate: todayUTC }));
  }
}
