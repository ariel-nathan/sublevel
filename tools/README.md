# tools/

Development-only Bun scripts for testing the game from what the player sees.
All of them launch their own private headless browser (`launchGame()` in
`browser.ts`), so any number can run in parallel. Output goes to `out/`
(git-ignored); open PNGs with the Read tool. Runs are deterministic: same
inputs, same frames, same transcripts.

Pure logic lives in separate modules with unit tests (`*.test.ts`, no browser):
`pilot-math.ts` (and `throw-plan.test.ts`, which checks the throw aim against
the real physics), `image.ts`, `lint-core.ts`, `replay-lib.ts`, `cli.ts`,
`png.ts`, `level-args.ts`, `auto-views.ts`, `doors.ts` (`plateStack`).
The geometry of solving (where to stand to press, carry, push, throw) is in
`src/level/rooms/solution.ts`, shared with the room module tests.

## Choosing the level

The game reads `?seed=N` (a generated run) and `?rooms=a,b` (named room
modules, for development) from its URL. Every tool that takes a level accepts
`--seed N` and `--rooms a,b` (`level-args.ts`); with neither it uses the
hand-built level (Kestrel Annex). `--seeds A..B` and `--count K [--from A]`
(default from 1) give a list of seeds to the tools that can run many
(`solve`, `check-seed`, `map`).

## Commands

| Command                                                                                                                              | What it does                                                                                                                                                                                                                                                                                                                               | Output                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run e2e`                                                                                                                        | Full playthrough of Kestrel Annex by hand-written steps, with assertions (timer, wedge, real input...). Exit 1 on any failed check. About 3 s.                                                                                                                                                                                             | transcript and PASS/FAIL list on stdout; `out/e2e/*.png` milestone frames, `out/e2e/sheet*.png` contact sheets, `out/e2e/14-exit-page.png` full page with HUD                                                                    |
| `bun run solve [--seed N \| --rooms a,b \| --seeds A..B \| --count K --from A] [--parallel P] [--keep-going] [--frames] [--verbose]` | Plays ANY level from its declared `LevelData.solution` alone (`solve.ts`, steps carried out by `solver.ts`) and checks it ends finished. Many seeds: a table (seed, level, steps, simulated time, wall time, result, failing step). Exit 1 if any fails. About 9 s a level.                                                                | transcript and PASS/FAIL on stdout; `out/solve/end.png` (`out/solve/seed-N/` for a chosen level); on failure `fail-step-N/` (see below)                                                                                          |
| `bun run fuzz`                                                                                                                       | `solve --count 20 --from 1 --parallel 4`: twenty seeds, four sessions at a time.                                                                                                                                                                                                                                                           | table on stdout                                                                                                                                                                                                                  |
| `bun tools/check-seed.ts --seed N` (or `--seeds A..B`, `--count K`)                                                                  | Everything checkable about one generated level, exit 1 on any failure: solve, visual lint on the automatic viewpoints (0 holes, 0 shimmer), generic coverage sweep (0 magenta px), tour sheets and overview map are saved. Prints one summary per seed with times.                                                                         | `out/check/<tag>/map.png`, `tour/sheet-*.png`, `lint/`, `coverage/`, `solve/fail-step-N/`                                                                                                                                        |
| `bun tools/map.ts [--seed N \| --rooms a,b]` (`bun run map`)                                                                         | Top-down plan of a whole level, without a browser: brushes at floor level, zones tinted (Z0...), doors cyan, buttons yellow (impact orange), plates magenta, props orange, lights pale dots, spawn green, exit box green, declared solution as a blue numbered polyline (suffix C carry, U push, P press, T throw).                        | `out/map/<annex\|seed-N\|rooms-a-b>.png`                                                                                                                                                                                         |
| `bun tools/coverage-sweep.ts [--seed N] [--step 1.5]`                                                                                | Generic hole finder: eye positions over the open floor of every zone (grid of `--step` m, eight directions plus up and down, crouch and eye height) in the `coverage` view, doors closed then every door opened; counts magenta pixels. Exit 1 if any.                                                                                     | counts on stdout; `out/coverage/<tag>/hole-*.png` for the first holes                                                                                                                                                            |
| `bun tools/push-check.ts`                                                                                                            | Proves the solver's `push` step: plays to the storage room and pushes the 60 kg metal crate out from the shelves, up to and onto the (flush) pressure plate, and checks that `plate_down` and door B's opening follow.                                                                                                                     | transcript; `out/push-check/end.png`                                                                                                                                                                                             |
| `bun tools/room-plan.ts [module\|annex] [--facing +x\|-x\|+z\|-z] [--mirror] [--seed N]`                                             | Top-down plan of a room module (default: every registered module) or of Kestrel Annex, without a browser. (`--seed` here seeds the module's parameters; for a whole generated level use `map.ts`.)                                                                                                                                         | `out/room-plan/<name>.png`: brushes grey by height, props orange, buttons yellow, doors cyan, plates magenta, footprint red, doorways green, solution path blue                                                                  |
| `bun run tour [--seed N \| --rooms a,b \| --auto] [--only s] [--view v] [--out dir]`                                                 | Renders viewpoints with contact sheets. No level chosen: the 64 fixed viewpoints of the hand-built level (`views.ts`, each view states whether doors are closed or open). With `--seed`/`--rooms`/`--auto`: automatic viewpoints derived from the level, sheets per room. `--view` = `none\|coverage\|material\|depth\|normals\|lighting`. | `out/tour/<name>.png`, `out/tour/sheet-N.png` (3 columns, labelled `NN name`, 12 per sheet), index of grid positions on stdout. Automatic: `out/tour/<tag>/sheet-z03.png` (one per room), `sheet-doors.png`, `sheet-targets.png` |
| `bun run tour --diff <dirA> <dirB> [--out dir]`                                                                                      | Compares two tour outputs view by view.                                                                                                                                                                                                                                                                                                    | table of changed-pixel % on stdout; `out/tour-diff/diff-sheet-N.png` rows of `A \| B \| difference x8`, worst first                                                                                                              |
| `bun tools/lint-visual.ts [--seed N \| --rooms a,b \| --auto] [--only s] [--out dir] [--self-test]`                                  | Detects z-fighting and geometry holes from every viewpoint (fixed list, or automatic ones for a chosen level) in both door states. About 3 min on the 87 automatic viewpoints of the hand-built level. Exit 1 if anything is flagged.                                                                                                      | summary table and cluster bounding boxes on stdout; `out/lint/<view>-<doors>-shimmer.png` (flagged pixels red, clusters boxed), `...-holes.png` (`out/lint/<tag>/` for a chosen level)                                           |
| `bun tools/replay.ts <file.json> [--every N] [--from s] [--to s] [--view v] [--out dir]`                                             | Reproduces a replay saved with F8 in normal play.                                                                                                                                                                                                                                                                                          | `out/replay/<step>.png` every N steps (default 30), `out/replay/sheet-N.png` filmstrips labelled `STEP n`; stdout: position over time, event log with step numbers                                                               |
| `bun tools/replay.ts <file.json> --at <step> [--window 20]`                                                                          | Saves every frame from step-window to step+window.                                                                                                                                                                                                                                                                                         | same                                                                                                                                                                                                                             |

Viewpoints of the hand-built level (name, position, yaw, pitch, door state)
are the table `VIEWS` in `views.ts`; add a line there to extend both the tour
and the lint for that level.

## Any level: automatic viewpoints and doors

`auto-views.ts` (`autoViews(level)`, pure, unit-tested on the hand-built
level) derives viewpoints from `LevelData` alone, so a generated facility is
looked at without hand-placing cameras. Positions are eye height (1.65 m) on
open floor: candidate points on a 0.5 m grid inside the zone, kept only if
there is floor under them and clearance (0.4 m) from brushes, props and closed
doors. Names are deterministic (zone, door and button order of the data).

| Name                                | Where                                                                                          | Door state |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | ---------- |
| `zNN-corner-ne\|nw\|se\|sw`         | near each corner of acoustic zone NN, looking at the centre (skipped if the view is under 1 m) | closed     |
| `zNN-center-e\|w\|n\|s`             | at the centre, looking at each wall (skipped if the wall is under 1 m away)                    | closed     |
| `zNN-ceiling`, `zNN-floor`          | at the centre, looking up 60 degrees and down 55                                               | closed     |
| `door-<id>-a`, `door-<id>-b`        | 2 m (nearer if blocked) from each side of the door, looking at it                              | closed     |
| `door-<id>-through`                 | from side a, looking straight through                                                          | open       |
| `button-<id>`, `plate-<id>`, `exit` | nearest standing point (1.3-4.2 m) with a clear line of sight to it                            | closed     |

At most 12 per room (the scheme gives at most 10). The hand-built level gets
87 (7 rooms, 4 doors, 4 buttons, 1 plate and the exit). The lint runs every
view in both door states regardless; the tour renders each in its own state.

`doors.ts` (`openAllDoors(session)`) puts the game in the "every door open"
state without playing the level, because the game has no hook to force a
door: toggle buttons through `__game.world.use` with a synthetic ray (once per
door: a door may have two buttons); plates by teleporting the lightest prop
that is heavy enough (else the heaviest stacked) onto them with
`physics.setBodyPose`; impact buttons by teleporting a prop in front of them
with 8 m/s into the button; timed buttons last, all together, then stepping
until open (nothing steps afterwards, so the countdown never runs out). Each
door is then checked (its slab no longer fills the middle of its closed box)
and the report lists any that stayed shut (a warning in the tools, not a
failure). A hook that would make this trivial and exact: a
`WorldObjects.forceDoors(open)` (latch every door open or released).

## Visual lint, how to read it

`bun tools/lint-visual.ts [--only s] [--out dir]` checks every view in both
door states (128 view-states for the 64 fixed viewpoints, 174 for the 87
automatic ones; a few minutes). Exit code 0: nothing flagged; 1: something
flagged; 2: the tool itself failed. Output: one table line per viewpoint
(closed and open doors), then bounding boxes of anything flagged. Annotated
images (`out/lint/<view>-<doors>-shimmer.png`, `...-holes.png`) are written
only for flagged view-states.

- Holes: in the `coverage` debug view any pure magenta pixel is a place with
  no geometry. None are expected in the sealed level.
- Z-fighting: each view is rendered in the flat `material` view at the base
  pose and at five poses moved by 1 mm right, 1 mm forward, 3 mm right, 3 mm
  forward and 2 mm left. Pixels whose material changes in any frame are
  "unstable". Almost all of them are edge aliasing, so they are explained
  away using the base pose's `depth` and `normals` views (`findShimmer` in
  `lint-core.ts`):
  - within 2 px of a depth edge (second difference, so slanted floors count
    as smooth) or a normals edge,
  - within 2 px of a stable material boundary (neighbouring pixels that are
    both stable and different),
  - within 2 px of a see-through material (the grate, an alpha cut-out whose
    holes show whatever is behind), in any frame.

  What remains must still contain a solid area at least 3 px thick (opening
  with a 3x3 box, after closing 1 px gaps) and at least 12 px to count. On the
  current level the largest leftover after the edge rules is 1 px thick,
  while a real z-fight is a block of hundreds or thousands of pixels. The
  "(N edge px)" in the table is the number of unstable pixels that were
  explained; it is not a defect count.

- `--self-test` (positive control, not for normal use; hand-built level
  only): injects, through `__game.renderer.createMesh` and a wrapper of
  `__game.world.drawItems` (no change to `src/`), a quad on the plane of the
  wall seen from `lab-spawn`, in another material and a few hundredths of a
  millimetre behind it, so that the winner of the depth test flips with
  sub-millimetre camera moves. Every variant that really flips must be flagged
  and the clean view must stay clean; then the quad is removed. See
  `lint-selftest.ts`.
- Limits: a defect thinner than 3 px, or within 2 px of an edge (for example
  z-fighting along a narrow ledge or a skirting board), is not reported;
  neither is z-fighting on the grate itself. Z-fighting between surfaces of
  the same material is invisible in the `material` view. The lint cannot see
  "seeing through a wall into another room" (geometry is drawn, just the
  wrong one); find those in the tour sheets. It needs the renderer's
  `coverage` and `material` debug views and stops with an error without them.

## The solver bot

`solve.ts` plays `LevelData.solution` with `solver.ts` (header of that file
says how each step is done). Honoured step fields: `carry.from` (where to
stand to let go) and `carry.holdY` (release height; either may be given alone,
the other is planned), `throw.from` (where to stand to throw), `wait.for`
(absent: a plain delay). Throws: `pilot.throwAt` first solves the view from
the hold geometry (`planThrow` in `pilot-math.ts`: eye height, the prop's hold
distance, HOLD_LOWER, the throw's 1 m/s upward bias and the mass-dependent
speed, iterated to a fixed point; `throw-plan.test.ts` checks the arc against
the real physics to within 3 cm), waits for the held prop to stop swinging,
then refines from where it actually hangs. The first throw of the hand-built
level hits (and from every standing spot tried); retries (at most 3) aim 10 cm
higher and then 10 cm lower, because a tumbling crate that grazes the target's
rim does not count.

When a step fails, `<out>/fail-step-N/` (`out/solve/` or `out/solve/<tag>/`)
has what is needed to diagnose it without re-running:

- `eyes.png`: the frame from the player's eyes;
- `plan.png`: top-down plan around the player and the step's target (red disc
  player with its facing, white ring the target, yellow squares and labels the
  props nearby, grey tint zones, the declared solution as numbered blue lines);
- `events.txt`: the last 30 events (no footsteps), one JSON per line;
- `step.txt`: the step number, the step as JSON, the problem, the player, the
  target and every nearby body.

`--keep-going` carries on after a failed step (every failure is listed);
`--frames` saves a frame after every step; `--parallel P` (capped at 8) runs P
sessions at once.

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

const session = await launchGame(); // { query: "harness&seed=7" } for a generated level
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
  the hand-built level's corridor spine (`direct: true` to skip, and the
  solver always does). Returns `{ arrived, x, z, distance, steps }`.
  It stops after 5 batches with no progress, so a blocked walk returns `arrived: false`.
- `jump()` (waits to land), `crouch(steps)`, `use()`, `primary()` (throw/shove).
- `pickUp(bodyId)`: walks to 1.3 m, looks at the centre, presses use, verifies `heldBody`.
- `dropAt(x, y, z, from?)`: carries the held body over the point and lets go so
  that its centre rests at height `y`. `from` is a point giving the side to
  stand on. The player weighs 80 kg on plates, so choose `from` so the pilot
  does not stand on a plate. Carry height follows view pitch; the pilot sets it
  before walking so the body does not sweep through other props.
- `pressButtonAt(x, y, z, from?)`: walks within 1.2 m, presses use, checks for
  a `button_press` event. `pressHere(x, y, z)`: the same without walking.
- `holdOver(x, y, z, settle?)`: turns so the held body hangs at that point
  (as nearly as the hold distance allows); `release(wait?)` lets go of it.
- `throwAt(x, y, z, lift = 0)`: faces the point and throws the held body with
  the pitch solved for a ballistic arc from where it hangs once settled (speed
  by mass); `lift` aims that many metres above the point.
- `setDown(x, y, z, stand, pitchDeg)`: tilts to `pitchDeg` first (so the body
  is carried at that height), walks straight to `stand`, faces the point and
  lets go; returns where the body came to rest. The solver gets `stand` and
  the pitch from `carryPlan` (src/level/rooms/solution.ts) or from the step.
- `pushTo(bodyId, x, z, approach, tolerance)`: stands behind a body
  (`approach(position)` says where) and walks into it towards the point, a
  stretch at a time, re-approaching when it drifts; returns its final position.
- `waitForEvent(what, match, maxSteps?)`: idles until a matching event.
- `frame(name)` saves the exact rendered frame; `page(name)` the whole page with HUD.

`Solver` (`solver.ts`) carries out `SolutionStep`s with these: `await
Solver.create(session, pilot)` (before any step, to map prop spawn indices to
body ids), then `await solver.run(step)` returns null or what went wrong. The
file's header says exactly how each kind of step is done.

Raw access: `session.evaluate("__harness.step(30, { moveZ: 1 })")`, `__game.physics`,
`__game.physics.setBodyPose(id, {x, y, z})` (teleport a body), `__harness.setCamera`,
`__harness.setDebugView`. Real input: `session.keyDown("KeyW")`,
`session.mouseMove(dx, dy)`, then `__harness.stepReal(n)`.

`views.ts` also exports `openDoors(pilot)` (hand-built level only: door A via
its button, door B by putting the metal crate on the plate), `grabFrame(session)`
(decoded image without writing a file), `setPose`, `setDebugView`. For any
other level use `openAllDoors(session)` from `doors.ts`.

## Facts a scenario writer needs

- Level (Kestrel Annex; `bun tools/map.ts` draws it): lab
  x -4..4, z -3..3; door A at x 4..4.3 (z -0.7..0.7); corridor to (9.55,
  z 0..7); storage x 5.5..13.5, z 8..16; plate x 7.9..9.1, z 11.4..12.6 (45 kg,
  a crate on it counts, and so does the player); door B at x 13.5..13.8;
  filtration hall x 14.1..25.1, z 8..16 (timed button at (25.02, 1.2, 13),
  door T at x 25.1..25.4, z 8.9..10.9, at the end of the lane behind the
  screen); valve chamber x 25.4..31.4 (impact target at (31.31, 4.2, 9.8),
  exit door at x 31.4..31.7); egress lock with the exit box x 32.7..34.7,
  z 8.3..11.3. `__game.level.data.solution` is a known way through.
- Pressure plates are flush with the floor: no collider, drawn as a 6 mm
  inlay (4 mm when pressed), so a pushed crate slides onto one and a thrown or
  carried one rests on the floor over it. `PressurePlateDef.box` is read as
  a footprint standing on the floor at `box.min.y` (`src/props/plates.ts`).
- Run speed 5.6 m/s = 0.093 m per step; reach 2.2 m; carry limit 40 kg;
  held crates hover about 1.24 m ahead of the eye.
- The harness step count is `state().step`; events carry the step they happened on.
- Impact buttons fire once and stay (`triggered`): a second throw at one that
  already fired gives impact events but no `button_press`.
