# sublevel

A small first-person physics puzzle game in the style of late-90s research-facility shooters, built entirely from code. There are no image, model or audio files and no runtime dependencies: textures, geometry, lighting and every sound are generated when the page loads.

You wake up in a lab in an underground annex. Find the way out.

## Play

You need [Bun](https://bun.sh) and a browser with WebGPU (current Edge or Chrome).

```sh
bun install
bun run dev
```

Open <http://localhost:3210> and click to capture the mouse.

To build the whole game into one self-contained HTML file that runs straight from disk:

```sh
bun run dist
```

The result is `dist/index.html`.

### Controls

| Key        | Action                                         |
| ---------- | ---------------------------------------------- |
| W A S D    | Move                                           |
| Mouse      | Look                                           |
| Space      | Jump                                           |
| C or Shift | Crouch                                         |
| E          | Pick up, drop, press                           |
| Left click | Throw what you hold, or shove what you look at |
| F          | Fullscreen                                     |
| Esc        | Release the mouse                              |
| F8         | Save a replay of the session                   |
| R          | Restart, after escaping                        |

Props up to 40 kg can be carried. Heavier ones have to be pushed.

## How it is made

- **Rendering**: raw WebGPU. The scene is drawn at three times the output size and averaged down to a low internal resolution, then scaled up by a whole factor so pixels stay square and steady.
- **Textures**: 23 materials painted by code from seeded noise and simple drawing primitives.
- **Level**: axis-aligned boxes turned into meshes, with hidden faces removed and lighting baked into vertex colours with shadow rays at load.
- **Physics**: a box-only rigid-body engine written for this game: stacking, sleeping, sliding contacts, kinematic doors, and a character controller with Quake-style movement.
- **Audio**: Web Audio, with every sound synthesised from noise and resonances, including scrape and roll sounds that follow the physics, muffling behind walls, and reverb per room.

The only tool is Bun: dev server, type checker, formatter, test runner and bundler. The only package is `@types/bun`, for development.

## Layout

```
src/math        vectors, quaternions, matrices
src/core        contracts between modules, shared helpers
src/textures    procedural textures
src/render      WebGPU renderer
src/level       level definition, mesh generation, baked lighting
src/physics     rigid bodies and character movement
src/player      player controller, carrying and throwing
src/props       props, doors, buttons, pressure plates, breakables
src/audio       sound synthesis and playback
src/hud         on-screen overlay
src/harness     in-game test interface
src/game.ts     wires the modules into a steppable game
src/main.ts     browser entry point
tools/          development scripts (never shipped)
demos/          standalone pages for single modules
```

Each module implements an interface from `src/core/api.ts` and imports only from `src/math` and `src/core`.

## Testing

```sh
bun run gate    # type check, format check, unit tests
bun run e2e     # plays the game start to finish in a headless browser
bun run tour    # renders named viewpoints to out/tour as contact sheets
bun tools/lint-visual.ts    # looks for missing surfaces and z-fighting
```

Opening the game with `?harness` hands control to a test interface: the simulation advances only when told to, so runs are deterministic, and the exact rendered frame can be captured. The scripts in `tools/` drive it through a headless copy of the installed Edge or Chrome. See `tools/README.md`.

A replay saved with F8 records every input of a session and can be played back exactly with `bun tools/replay.ts <file>`.

## Status

A demo: a few rooms and two puzzles. The sounds were designed without being heard by their author and tuned from a small amount of listening, so the audio is the least finished part.
