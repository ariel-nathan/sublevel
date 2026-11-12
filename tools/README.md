# tools/

Development-only Bun scripts for testing the game from what the player sees.
All of them launch their own private headless browser (`launchGame()` in
`browser.ts`), so any number can run in parallel. Output goes to `out/`
(git-ignored); open PNGs with the Read tool. Runs are deterministic: same
inputs, same frames, same transcripts.

Pure logic lives in separate modules with unit tests (`*.test.ts`, no browser):
`pilot-math.ts`, `image.ts`, `lint-core.ts`, `replay-lib.ts`, `cli.ts`, `png.ts`.

## Commands

| Command                                                                                  | What it does                                                                                                                                                                           | Output                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run e2e`                                                                            | Full playthrough with assertions. Exit 1 on any failed check. About 2 s.                                                                                                               | transcript and PASS/FAIL list on stdout; `out/e2e/*.png` milestone frames, `out/e2e/sheet.png` contact sheet, `out/e2e/08-exit-alcove-page.png` full page with HUD |
| `bun run tour [--only s] [--view v] [--out dir]`                                         | Renders ~36 named viewpoints (every room, doors closed then open). `--only` = name substring; `--view` = `none\|coverage\|material\|depth\|normals\|lighting`; default out `out/tour`. | `out/tour/<name>.png`, `out/tour/sheet-N.png` (3 columns, labelled `NN name`, 12 per sheet), index of grid positions on stdout                                     |
| `bun run tour --diff <dirA> <dirB> [--out dir]`                                          | Compares two tour outputs view by view.                                                                                                                                                | table of changed-pixel % on stdout; `out/tour-diff/diff-sheet-N.png` rows of `A \| B \| difference x8`, worst first                                                |
| `bun tools/lint-visual.ts [--only s] [--out dir]`                                        | Detects z-fighting/shimmer and geometry holes from every viewpoint in both door states. Exit 1 if anything is flagged.                                                                 | summary table and cluster bounding boxes on stdout; `out/lint/<view>-<doors>-shimmer.png` (flagged pixels red, clusters boxed), `...-holes.png`                    |
| `bun tools/replay.ts <file.json> [--every N] [--from s] [--to s] [--view v] [--out dir]` | Reproduces a replay saved with F8 in normal play.                                                                                                                                      | `out/replay/<step>.png` every N steps (default 30), `out/replay/sheet-N.png` filmstrips labelled `STEP n`; stdout: position over time, event log with step numbers |
| `bun tools/replay.ts <file.json> --at <step> [--window 20]`                              | Saves every frame from step-window to step+window.                                                                                                                                     | same                                                                                                                                                               |

Viewpoints (name, position, yaw, pitch, door state) are the table `VIEWS` in
`views.ts`; add a line there to extend both the tour and the lint.

### Visual lint, how to read it

- Shimmer: each view is rendered in the flat `material` debug view, then with
  the camera moved 1 mm and 3 mm along its right and forward vectors. Pixels
  whose material changes are "unstable"; one-pixel silhouette crawl is
  discarded; remaining clusters of at least 4 px are reported.
  Open `out/lint/<view>-<doors>-shimmer.png`.
- Holes: in the `coverage` view any pure magenta pixel is a place with no
  geometry. None are expected in the sealed level.
- If the renderer has no debug views (it prints "debug views not available
  in this build"), the lint falls back to comparing lit frames with a large
  tolerance and skips the hole check. Treat fallback results as hints.
- The lint cannot see "seeing through a wall into another room" (geometry
  is drawn, just the wrong one); find those in the tour sheets.

## Reproducing a player's bug

1. In normal play press F8 at the moment of the bug: the browser downloads
   `sublevel-replay-<steps>.json` (every input since the game started).
2. `bun tools/replay.ts sublevel-replay-1234.json` for the overview: filmstrip,
   position over time, event log. Note the step of the first wrong thing.
3. `bun tools/replay.ts file.json --at <step> --window 15` for every frame
   around it; add `--view depth` (or `material`, `normals`, `lighting`) to
   see the same frames diagnostically.
4. To inspect more than frames, write a scenario (below) and replay inside
   it: `await session.evaluate("__harness.replay(" + JSON.stringify(replay) + ", 600)")`
   steps the first 600 inputs; then use `pilot.state()`, `__game.physics`, etc.
   (`replay` continues from the current state, so slice with
   `sliceReplay(replay, from, to)` from `replay-lib.ts` to go in chunks.)

## Writing a scenario with the pilot

```ts
import { launchGame } from "./browser";
import { Pilot } from "./pilot";

const session = await launchGame();
const pilot = new Pilot(session, { run: "myscenario" }); // frames go to out/myscenario/
try {
  await pilot.pressButtonAt(3.91, 1.2, 1.2, { x: -2, z: 1.2 }); // stand on the lab side
  await pilot.walkTo(9.55, 9.6); // routes through door A and the corridor
  const [crate] = await pilot.bodies("crate_wood");
  await pilot.pickUp(crate.id);
  await pilot.dropAt(8.5, 0.4, 12, { x: 8.5, z: 20 }); // rest centre y=0.4, stand south of it
  await pilot.frame("after-drop"); // out/myscenario/after-drop.png
  const s = await pilot.state(); // player, hud, bodies
  const ev = await pilot.events(); // [{step, type, ...}]
} finally {
  console.log(pilot.transcript.join("\n")); // one line per action: step, position, new events
  await session.close();
}
```

Pilot actions (all deterministic, built on `__harness.step`):

- `state()`, `events(sinceStep?)`, `eye()`, `bodies(tag?)`, `wait(steps)`, `log(text)`.
- `look(yawDeg, pitchDeg)`, `lookAt(x, y, z)`: absolute view, converged to 0.2 degrees.
  Yaw 0 faces -Z, positive yaw turns left, so yaw -90 faces +X. Pitch is clamped to +-89.
- `walkTo(x, z, { tolerance = 0.3, timeoutSteps = 600, jump, crouch, direct })`:
  faces the target, runs, re-aims every few steps; between rooms it follows
  the corridor spine (`direct: true` to skip). Returns `{ arrived, x, z, distance, steps }`.
  It stops after 5 batches with no progress, so a blocked walk returns `arrived: false`.
- `jump()` (waits to land), `crouch(steps)`, `use()`, `primary()` (throw/shove).
- `pickUp(bodyId)`: walks to 1.3 m, looks at the centre, presses use, verifies `heldBody`.
- `dropAt(x, y, z, from?)`: carries the held body over the point and lets go so
  that its centre rests at height `y`. `from` is a point giving the side to
  stand on. The player weighs 80 kg on plates, so choose `from` so the pilot
  does not stand on a plate. Carry height follows view pitch; the pilot sets it
  before walking so the body does not sweep through other props.
- `pressButtonAt(x, y, z, from?)`: walks within 1.2 m, presses use, checks for
  a `button_press` event.
- `frame(name)` saves the exact rendered frame; `page(name)` the whole page with HUD.

Raw access: `session.evaluate("__harness.step(30, { moveZ: 1 })")`, `__game.physics`,
`__game.physics.setBodyPose(id, {x, y, z})` (teleport a body), `__harness.setCamera`,
`__harness.setDebugView`. Real input: `session.keyDown("KeyW")`,
`session.mouseMove(dx, dy)`, then `__harness.stepReal(n)`.

`views.ts` also exports `openDoors(pilot)` (door A via its button, door B by
putting the metal crate on the plate), `grabFrame(session)` (decoded image
without writing a file), `setPose`, `setDebugView`.

## Facts a scenario writer needs

- Level: lab x -4..4, z -3..3; door A at x 4..4.3 (z -0.7..0.7); corridor to
  (9.55, z 0..7); storage x 5.5..13.5, z 8..16; plate x 7.9..9.1, z 11.4..12.6
  (45 kg, a crate on it counts, and so does the player); door B at x 13.5;
  exit alcove x > 13.8.
- Run speed 5.6 m/s = 0.093 m per step; reach 2.2 m; carry limit 40 kg;
  held crates hover about 1.24 m ahead of the eye.
- The harness step count is `state().step`; events carry the step they happened on.
