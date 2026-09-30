# Turbo Kart Rally

**An arcade kart racer in the spirit of Mario Kart, built entirely with Three.js. Every mesh, texture, sound effect and music track is generated in code at load time. There are no asset files and no build step.**

The whole game was produced by five Claude Opus 5.5 sub-agents working in parallel from a single prompt, without a single follow-up question. The prompt is reproduced below.

<p align="center">
  <a href="https://bridge-mind.github.io/turbo-kart-rally/"><img src="docs/screenshots/title.jpg" alt="Turbo Kart Rally title screen" width="800"></a>
</p>

<p align="center">
  <a href="https://bridge-mind.github.io/turbo-kart-rally/"><strong>▶ Play it in your browser</strong></a>
</p>

## Play

Open **https://bridge-mind.github.io/turbo-kart-rally/** in a desktop browser with WebGL2 (Chrome, Edge, Firefox or Safari). Click or press Enter on the title screen, choose one of eight racers, pick a class (50cc, 100cc or 150cc) and a lap count, then hit RACE!. A keyboard or a gamepad works.

Race seven AI drivers around Palm Cove Circuit. Drift through corners and release for a mini-turbo. Grab item boxes and fire shells, drop bananas, pop mushrooms, or call down lightning on the field.

## The prompt that built this

This is the complete, verbatim prompt given to Claude Code. Nothing else was specified.

> I need you to launch five opus 5.5 sub-agents and help me build a triple A quality game that is a clone of Mario Kart. What I want you to do is I want you to launch these sub-agents, build the game without asking me any questions at all, and use 3JS to build the game. And once you're done, report back to me.

## How it was built

The orchestrating agent wrote an architecture contract first ([ARCHITECTURE.md](ARCHITECTURE.md)), plus the shared config and event bus, then launched five sub-agents that each owned one slice of the codebase. No sub-agent edited another's files. Each one tested its slice in a real browser against stubs, and the game and UI agent then integrated and play-tested the whole thing.

| Agent | Owns | Delivers |
| --- | --- | --- |
| 1 · World | `track.js`, `environment.js`, `track-textures.js` | Procedural circuit, barriers, boost pads, jump ramps, water, sky, scenery, grandstands, lighting |
| 2 · Driving | `kart.js`, `ai.js`, `input.js` | Arcade kart physics, drift and mini-turbo, AI drivers, keyboard and gamepad input |
| 3 · Items and FX | `items.js`, `effects.js` | Item boxes, roulette and eight items, pooled particle effects |
| 4 · Art and camera | `models.js`, `camera.js` | Karts, drivers, item models, portraits, chase camera |
| 5 · Game and UI | `main.js`, `race.js`, `hud.js`, `menu.js`, `audio.js`, `styles.css` | Game loop, race manager, HUD, menus, results, procedural audio and music |

`src/config.js` (roster, physics tuning, items, difficulty, key bindings) and `src/events.js` (the event bus) were written before the sub-agents started.

## Features

- **Eight racers**, each with their own hat, look and stats for speed, acceleration, handling and weight: Blaze, Zippy, Bella, Toadly, Rex, Grumbo, Koopz and Dotty.
- **Palm Cove Circuit**, about 2.1 km, with a long start straight, sweepers, an S-bend, a bridge over a lagoon, a hairpin, 8 boost pads, 2 jump ramps and 30 item boxes.
- **Arcade handling** with hop, drift, three-stage mini-turbo, a rocket start, trick boosts off ramps, off-road slowdown, wall bumps and kart-to-kart collisions resolved by weight.
- **Eight items**: mushroom, triple mushroom, banana, green shell, homing red shell, star, lightning and blue shell. Item odds are weighted by race position.
- **AI drivers** that follow a racing line, drift on corners, dodge hazards, use items tactically and rubber-band toward the player.
- **Fully synthesised audio**: engine, drift and item sounds, and a sequenced chiptune soundtrack with separate menu and race music that speeds up on the final lap.
- **Effects**: pooled drift sparks, boost flames, dust, star sparkles, explosions, confetti and speed lines, with bloom.
- **Presentation**: live demo race behind the title screen, intro flyover, 3-2-1-GO with start lights, position and lap HUD, item roulette, minimap, speedometer, final-lap and wrong-way banners, results screen.

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Accelerate | W or Up | A or right trigger |
| Brake / reverse | S or Down | B or left trigger |
| Steer | A and D, or Left and Right | Left stick |
| Hop / drift | Space | RB or X |
| Use item | E, X or Left Shift | LB or Y |
| Look back | C | Click either stick |
| Pause | Esc or P | Start |
| Mute | M | |

Hold drift through a corner. Sparks turn blue, then orange, then purple. Release for a bigger boost the longer you held it. Hold accelerate as the countdown reaches GO for a rocket start.

## Run it locally

There is no build step. Serve the folder with any static server:

```bash
git clone https://github.com/bridge-mind/turbo-kart-rally.git
cd turbo-kart-rally
python3 -m http.server 8080
```

Then open http://localhost:8080. Three.js r170 is loaded from jsDelivr through an import map, so an internet connection is needed.

## Project layout

```
turbo-kart-rally/
├── index.html            entry page and import map
├── ARCHITECTURE.md       contract the five sub-agents built against
├── src/
│   ├── main.js           renderer, post-processing, state machine, game loop
│   ├── config.js         roster, physics tuning, items, difficulty, key bindings
│   ├── events.js         shared event bus
│   ├── track.js          circuit, surfaces, walls, racing line
│   ├── environment.js    sky, lights, water, terrain, scenery
│   ├── kart.js           kart physics
│   ├── ai.js             AI drivers
│   ├── input.js          keyboard and gamepad
│   ├── items.js          item boxes, roulette, items
│   ├── effects.js        particles and bursts
│   ├── models.js         karts, drivers, item models, portraits
│   ├── camera.js         chase camera
│   ├── race.js           laps, positions, countdown, finish
│   ├── hud.js            in-race HUD and results
│   ├── menu.js           title, character select, pause
│   ├── audio.js          Web Audio sound and music
│   └── styles.css        UI styling
├── dev/                  per-module test harnesses the sub-agents used
└── docs/screenshots/     images used in this README
```

Open `window.__game` in the browser console for debug hooks such as `startRace()`, `toFinalLap()`, `finishPlayer()` and `debug.autopilot = true`.

## Screenshots

| | |
| --- | --- |
| ![Character select](docs/screenshots/character-select.jpg) | ![Racing](docs/screenshots/race.jpg) |
| ![Items and grandstands](docs/screenshots/items.jpg) | ![Results](docs/screenshots/results.jpg) |

## Disclaimer

Turbo Kart Rally is an original, fan-made homage to the kart-racing genre. It is not affiliated with, endorsed by, or associated with Nintendo. All characters, circuits, names, art, music and code in this repository are original.

## Multiplayer (play with friends)

Live server: **https://turbo-kart-rally.onrender.com** — open it on any device,
pick a character, click MULTIPLAYER, and race: same room code, anywhere in
the world.

Everyone opens the same server address (e.g. `http://192.168.1.5:8080` on
your Wi-Fi — this PC's address works for phones on the same network):

1. Pick your character on the select screen, then click **MULTIPLAYER**.
2. Enter your name and **Create Room** — the lobby shows a 4-letter code.
3. Friends enter the code and **Join Room**.
4. The host (room creator) picks the class and lap count, then **Start Race**.

Up to 8 racers per room. Humans only online (no AI fill). Karts, items,
hits, laps, and results are all synced; if someone disconnects mid-race
their kart is removed and the race goes on. No pausing online.

Multiplayer needs the Node game server (it hosts the rooms + race sync).
Single-player also runs under any static server:

```powershell
cd turbo-kart-rally
npm install   # once, for the 'ws' package
npm start     # serves on http://localhost:8080
```

`npm test` runs the multiplayer protocol tests.

## Install as app (PWA)

The game is installable: open it in Chrome/Edge/Safari and use
**Install app** (or Add to Home Screen). It runs fullscreen standalone
with an icon, works offline after the first visit (service worker), and
locks out browser double-tap zoom, pinch zoom, and pull-to-refresh during
races — menus still scroll. Touch controls (steer, GAS, BRAKE, DRIFT,
ITEM, pause, mute) appear on touch devices. After shipping game updates,
bump `VERSION` in `sw.js` so old caches are purged.

## Deploy (Render)

The game deploys as one always-on Docker web service (`render.yaml`,
`Dockerfile`, `.dockerignore` are committed). Rooms live in server memory,
so keep exactly **1 instance** — with 2+, players can land on different
instances and never see each other's rooms. The free plan sleeps after
inactivity and drops all rooms, so use **Starter** or higher.

1. Push this repo to your own GitHub/GitLab account.
2. In the Render dashboard: **New → Blueprint**, pick the repo, and apply
   `render.yaml` (or **New → Web Service**, runtime **Docker**, health check
   path `/health`).
3. Render sets `PORT` automatically; `server.js` reads it.

Verify: `https://<service>.onrender.com/health` returns `{"ok":true,...}`.
Redeploys happen on every push to the default branch.

## License

[MIT](LICENSE) © 2026 BridgeMind
