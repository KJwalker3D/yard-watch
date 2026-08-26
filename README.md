# Morning Brief & Watchers

Stats digest + live alerts for your Roblox games. Plain Node scripts, zero
dependencies, no AI, no third-party services except Roblox's public API and
Discord webhooks. Yours forever.

Three scripts, sharing `config.json`:

| Script       | Schedule            | What it does                                              |
| ------------ | ------------------- | --------------------------------------------------------- |
| `brief.mjs`  | daily 8:30          | stats digest per game (visits, favorites, rating, deltas) |
| `watch.mjs`  | every 5 min         | pings when players are in-game, votes/favorites move, or a UGC item changes (on-sale, Limited flip, stock drops w/ alt-fleet warning) |
| `weekly.mjs` | Sunday 9:00         | week-over-week rollup from the brief's history            |

## Webhook categories

`config.json` → `webhooks` lets each stream post to its own Discord channel:
`daily`, `live` (player/vote alerts), `ugc` (drop alerts), `weekly`.
Leave any of them `""` and that stream falls back to the top-level
`discordWebhookUrl`. Test with `node watch.mjs --test`.

## Cloud mode (GitHub Actions) — runs 24/7, no Mac needed

The folder is a git repo with workflows for all three scripts. Webhook URLs
are NEVER committed (`config.json` is gitignored); in the cloud they live as
GitHub Actions Secrets, uploaded by `setup.sh`. One-time setup:

```
brew install gh
gh auth login
./setup.sh
```

`setup.sh` creates a PRIVATE repo named `yard-watch` (pass another name as an
argument), pushes, and sets the secrets. Note: private repos get 2,000 free
Actions minutes/month — the 5-minute watcher uses ~9,000, so either flip the
repo public (safe: it contains no secrets, only public game IDs and stats)
with `gh repo edit --visibility public --accept-visibility-change-consequences`
for unlimited free minutes, or slow the watcher's cron in
`.github/workflows/watch.yml`.

If cloud mode is on, do NOT also load the launchd jobs below — you'd get
double posts. Local manual runs (`node brief.mjs` etc.) are always fine.
GitHub cron isn't exact: expect the brief within ~15–30 min of the hour.

## What it reports, per game

- Playing now (live CCU)
- Visits, with delta since the last run and a visits/day pace over the last ~7 runs
- Favorites, with delta
- Like ratio and up/down vote deltas
- A 🆕 flag if the place was updated since the last run

History is stored in `data/history.json` (auto-created, last 120 runs per game).

## Setup

1. **Discord (optional but recommended):** in your Discord server →
   channel settings → Integrations → Webhooks → New Webhook → Copy URL.
   Paste it into `config.json` as `discordWebhookUrl`. Leave it `""` to
   print to the terminal/log only.

2. **Add more games:** append to `games` in `config.json`:
   `{ "name": "Night Raid", "universeId": 123456789 }`.
   Universe ID: Creator Hub → the experience → the number in the URL,
   or run `print(game.GameId)` in Studio's command bar.

3. **Test:**
   ```
   node brief.mjs
   ```

## Schedule (calendar jobs survive sleep — they run on next wake if missed)

```
cp com.kj.*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.kj.morning-brief.plist
launchctl load ~/Library/LaunchAgents/com.kj.player-watch.plist
launchctl load ~/Library/LaunchAgents/com.kj.weekly-rollup.plist
```

To change the time, edit Hour/Minute in the plist, then:

```
launchctl unload ~/Library/LaunchAgents/com.kj.morning-brief.plist && launchctl load ~/Library/LaunchAgents/com.kj.morning-brief.plist
```

To run it immediately once (test the schedule wiring):

```
launchctl start com.kj.morning-brief
```

Last run's output/errors: `data/last-run.log`.

Note: if you upgrade Node via nvm, the node path in the plist
(`/Users/kj/.nvm/versions/node/v22.22.2/bin/node`) may need updating.

## What it can't see

Public APIs don't expose D1 retention, session length, or funnels — those live
in Creator Hub → Analytics only. This brief covers the outside-view numbers
(traffic, sentiment, growth pace). During a campaign (e.g. the UGC push), the
visits/day pace + like-ratio delta is your fastest daily read on whether ad
traffic is landing.
