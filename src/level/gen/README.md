# src/level/gen — seeded runs

`?seed=N` in the game, `buildLevel({ seed })` in code: the seed becomes a
facility of the authored lab, eight generated puzzle rooms joined by
corridors, and an exit lock. The same seed (and config) always gives the
same facility.

| File                                                       | What                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `index.ts`                                                 | `planRun(seed)` (mission and pieces, no geometry), `assembleRun`, `generateLevel`              |
| `config.ts`                                                | `GeneratorConfig` and `DEFAULT_CONFIG`                                                         |
| `mission.ts`                                               | Which puzzle rooms, in what order (the rules below); `missionProblems` checks them             |
| `layout.ts`                                                | Placement: the search and the straight continuation                                            |
| `plans.ts`                                                 | Plans a module once at a canonical doorway and moves the plan rigidly to candidates            |
| `names.ts`                                                 | The facility's name                                                                            |
| `checks.ts`                                                | Level-wide checks of a run (seal, mesh seal, z-fighting, props, lights, zones, walk, solution) |
| `modules/`                                                 | The generator's own module: the doorway adapter                                                |
| `gen.test.ts`, `fuzz.test.ts`, `modules/contract.test.ts`  | Tests (fuzz: `SUBLEVEL_FUZZ=1`)                                                                |
| `plan-image.ts`, `bench.ts`, `solve-seeds.ts`, `joints.ts` | Development scripts (below)                                                                    |

## How a run is made

1. **Mission** (`mission.ts`, pure, seeded). The pool is read when the run is
   generated: `config.pool()` (default: the shared registry,
   `rooms/registry.ts`), filtered to modules with role `"middle"`, a real
   lock (`teaches` not `"none"`), empty `requires` (each chosen room supplies
   its own keys; requirements are not yet carried between rooms) and
   exactly one exit; a module whose `after` names a mechanic nothing else
   teaches is left out. Today that is the nine parametric puzzle rooms of
   `rooms/puzzles/` and three authored set pieces of Kestrel Annex (storage
   room, filtration hall, valve chamber: `setPiece: true`). The lab is the
   fixed opening and the exit lock the fixed finish. Rules, by precedence
   (a later rule gives way to an earlier one):
   1. no module twice in a run (unless the pool is too small, then none
      twice in a row); one or two set pieces per run (`setPieces`, the seed
      chooses how many and which), each once;
   2. teach, then test: a mechanic's first room is one of its easiest
      modules; a module's `after` mechanics (decon lock: plate and timed
      door) are taught by earlier rooms; a `position: "first"` module (the
      records office, the gentlest teacher) is the first room;
   3. every mechanic the pool offers (up to the room count), none more than
      `maxPerMechanic` (2) times unless there are too few mechanics;
   4. no two rooms in a row with the same mechanic or the same `idea`;
   5. a `position: "early"` module (the freight passage) in the first half;
   6. difficulty never drops from room to room;
   7. preferably not two modules with the same `idea` in one run (a set
      piece and its parametric re-take: filtration hall and pump gallery,
      valve chamber and generator hall, storage room and goods bay).

   The set pieces are drawn first; then every set of eight modules from the
   pool without the undrawn set pieces that can satisfy 1-3 is listed (a
   few dozen of at most 165), the sets with fewest shared ideas first in a
   seeded random order, and each is ordered by a depth-first search with 2,
   4, 5 and 6 as hard constraints (lowest difficulty first, random among
   equals); if none orders, again without 5 and 6, then without 4.
   `missionProblems` checks 1-5 and 7 on every generated run, `ramps` 6 (the
   tests: every one of 200 seeds ramps). Each room's parameters come from
   `module.random` on a seed derived from the run seed.

2. **Placement** (`layout.ts`). The chain is start, then for each room a
   _link_ and the room, then a link and the finish. A link is the registry
   corridor (bend none/left/right, length, second leg), preceded by a
   doorway adapter if the corridor cannot take the doorway, and followed by
   one if the room takes another doorway size or has an open entry (the
   adapter's exit wall is widened to cover the open end's outline). Each
   step tries every corridor shape in `corridorLengths` x `corridorLegs` and
   both mirrorings of the room; a candidate fits if no footprint overlaps
   the piece it attaches to and every other footprint is at least
   `clearance` (0.5 m) away in plan. Fitting candidates are ranked by the
   area of the facility's bounding box (times 1 + `jitter` x random), and
   the best `branching` are tried depth first, backing up on dead ends.
   Past `searchBudget` candidates the search gives up and the _straight
   continuation_ lays the run out again: each corridor turns the chain back
   to the start's heading and the next room goes wholly ahead of everything
   placed (shortest corridor first), with a little back-tracking. Plans are
   moved from cached canonical plans (`plans.ts`), so a candidate costs
   microseconds.

3. **Assembly**: the pieces become `place(...)` placements for
   `assembleLevel` (names `lab`, `c3`, `a3`, `r3-<module>`, `exit`; ids are
   prefixed with them), with the hand-built level's ambient and fog, the
   seed and the facility name. Steady lights get `bounds` (their piece's
   footprint box) so that they do not light other rooms' props through
   walls and the renderer's 32-light choice favours nearby rooms.

## Config (`DEFAULT_CONFIG`)

| Field                 | Default                   | Meaning                                     |
| --------------------- | ------------------------- | ------------------------------------------- |
| `rooms`               | 8                         | puzzle rooms                                |
| `start`, `finish`     | `LAB`, `EXIT_LOCK`        | anchors                                     |
| `corridor`, `adapter` | `CORRIDOR`, `ADAPTER`     | link modules                                |
| `pool`                | `ROOM_MODULES` (registry) | read at run time                            |
| `maxPerMechanic`      | 2                         | variety cap                                 |
| `setPieces`           | [1, 2]                    | authored set pieces per run, least and most |
| `clearance`           | 0.5 m                     | gap between non-neighbouring footprints     |
| `corridorLengths`     | 3, 4.5, 6, 8              | tried by the search                         |
| `corridorLegs`        | 0, 1.5, 3                 | second leg of a bent corridor               |
| `branching`           | 4                         | candidates tried per step before backing up |
| `searchBudget`        | 4000                      | candidates evaluated before the fallback    |
| `jitter`              | 0.35                      | randomness against compactness              |

## Adding a rule

Mission rule: add the check to `missionProblems` (tests run it over many
seeds and every generated run), then enforce it in `chooseMission`: a hard
constraint in `order`'s filter, or a preference in its sort. Placement
rule: add it to `misfit` (or a scoring term in `LayoutSearch.search`), and
to `chainProblems` in `checks.ts`.

## Debugging a seed

- `bun src/level/gen/plan-image.ts 17 [--rooms 12] [--straight]`: top-down
  plan, `out/gen/plan-17.png` (footprints by kind, doorways, the solution
  path, names).
- `bun tools/check-seed.ts --seed 17`: everything at once (bot, visual lint
  on automatic viewpoints, coverage sweep, tour sheets, map) with a summary
  and an exit code; `--seeds 1..6 --parallel 3` for several.
- `bun tools/solve.ts --seed 17`: plays the declared solution in the game;
  a failed step leaves `out/solve/seed-17/fail-step-N/` (eyes, plan, events,
  state). `bun tools/solve.ts --seeds 1..40 --parallel 4`: a table.
- `bun tools/map.ts --seed 17`: the whole facility from above.
- `bun src/level/gen/joints.ts 17`: visual lint (holes, z-fighting) from
  both sides of every doorway, doors closed and open, contact sheets in
  `out/joints/17/` (about 2.5 minutes a seed at the game's default
  resolution; at a smaller window the button fixtures' edges were flagged).
- In code: `planRun(17)` gives the mission and pieces; `allProblems(...)`
  from `checks.ts` runs every level check.
- `bun src/level/gen/bench.ts`: build times with a breakdown.

## Performance

A run is planned in 3-8 ms. `buildLevelFrom` was made to scale (results
identical to before; `src/level/reference.ts` keeps the old versions and
`pipeline.test.ts` compares): the reachable-air flood stores only 8 x 8
voxel columns under brushes and floods vertical runs of air; face cutting
asks a brush grid for neighbours instead of every brush; light baking finds
lights through a light grid and walks a per-light blocker grid along each
shadow ray; mesh vertices are keyed by numbers instead of strings. An
8-room run builds in about 0.3 s, a 12-room run in about 0.55 s; the air
flood is the largest share.

## Known limits

- Linear chains on one floor; no branches, no level changes.
- `requires` is not carried between rooms: modules that need keys from
  earlier rooms are left out of the pool.
- The straight continuation is guaranteed only for modules whose exit does
  not face back the way they were entered (no such module exists yet).
- Nine parametric rooms and eight slots: the records office, the freight
  passage and the maintenance loft (the only rooms of their mechanics) are
  in every run, and the records office always opens it. Variety comes from
  which plate, impact and timed-door rooms (and set pieces) are chosen, the
  order, the parameters, mirroring and the layout (see the statistics in
  `fuzz.test.ts`, `SUBLEVEL_FUZZ=1`).
- Fog and ambient are the hand-built level's (fog far 40 m in a facility
  50 x 35 m on average).
