# ⚔ Tribal Conquest

An **offline, singleplayer** strategy game in the spirit of Tribal Wars / Travian / Ikariam.
Build your first village from nothing, farm barbarian villages, train noblemen, and conquer
the world — against AI opponents that play by the same rules you do.

No account, no internet, no waiting on other players. The whole world lives in a single
SQLite file on your machine.

## Features

- 60×60 world with your village, 55 barbarian villages, and 3 AI opponents
- Economy: wood / clay / iron fields, farms, warehouse storage caps, wheat upkeep
- 13 building types with per-level costs and build times (build queue)
- 8 unit types: spearmen, swordsmen, axemen, archers, scouts, light cavalry, rams, noblemen
- Send **attacks** (fight + loot), **raids** (loot, retreat if outmatched), and **scouts**
- Real-time troop travel across the map, battle reports, scouting reports, warning reports
- Walls give defenders a bonus; rams knock walls down
- **Conquest**: noblemen lower loyalty on victory; the village is yours at 0
- AI opponents that build, farm barbarians, expand with noble trains, and (on Normal+)
  will attack you — including retaliating when you hit them
- Barbarian villages grow stronger over time, so farming and conquest stay challenging
- Pause / 1× / 10× / 100× game speed — it's singleplayer, so skip the boring waits
- Autosaves continuously to `save/tribalconquest.db`

## Requirements

- **Node.js 22.5 or newer** (Node 24 recommended — uses the built-in `node:sqlite` module)

## Quick start

```sh
npm install
npm start
```

Then open **http://localhost:3210** in your browser.

## How to play

1. **Build your economy** — upgrade Timber Camp / Clay Pit / Iron Mine first, then the
   Warehouse (storage) and Farm (wheat). Use the ⏸ / 10× / 100× buttons freely.
2. **Build an army** — Barracks (infantry), Stable (scouts + light cavalry). The Smithy
   unlocks better units (level 1 for most).
3. **Farm barbarian villages** — pick a grey village on the map and send a *raid* with
   axemen / light cavalry. Winning raids haul loot home.
4. **Prepare for conquest** — build a Smithy to level 5, then the Academy. Train 3+ Noblemen.
5. **Conquer** — send an *attack* including noblemen. If you win, each nobleman lowers the
   village's loyalty by 20–35. Loyalty below 0 = the village is yours (loyalty resets to 25 —
   defend it!). The AI does exactly the same, and on Normal/Hard difficulty it will come for you.

Tips:
- Watch the **Reports** tab — scouting reports show enemy garrisons.
- Incoming attacks are announced; walls and defensive troops (spears, swords, archers) help.
- Defeated? Start a new world from the World tab and try a lower difficulty.

## Commands

| Action | Where |
| --- | --- |
| Pause / 1× / 10× / 100× | Header buttons |
| Send troops | Map → click target village |
| Upgrade buildings | Village tab |
| Train units | Village tab |
| New world / difficulty | World tab |

## Configuration

- **Port:** `PORT=4000 npm start` (default 3210)
- **Dev cheats:** start with `TC_CHEATS=1 npm start` to get a “+10k resources” button in the
  World tab (handy for testing balance).
- **Balance:** all game numbers (buildings, units, combat, AI behavior, map size) live in
  [`src/game/constants.js`](src/game/constants.js) — tweak and restart.

## Saving / resetting

The save is `save/tribalconquest.db`. Delete that folder (or just the `.db` file) to start
fresh; the server also auto-generates a new world when no save exists.

## Project structure

```
src/
  server.js           HTTP server + game loop
  game/
    constants.js      every gameplay number (balance)
    db.js             SQLite persistence (node:sqlite)
    world.js          world generation
    combat.js         battle resolution
    ai.js             AI opponents
    engine.js         simulation tick, actions, conquest
public/
  index.html          UI
  style.css           retro parchment theme
  app.js              frontend logic
```

## License

MIT
