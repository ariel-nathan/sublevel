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
| `modules/`                                                 | The generator's own modules: exit lock, doorway adapter, three stand-in puzzle rooms           |
| `gen.test.ts`, `fuzz.test.ts`, `modules/contract.test.ts`  | Tests (fuzz: `SUBLEVEL_FUZZ=1`)                                                                |
| `plan-image.ts`, `bench.ts`, `solve-seeds.ts`, `joints.ts` | Development scripts (below)                                                                    |

## How a run is made

1. **Mission** (`mission.ts`, pure, seeded). The pool is read when the run is
   generated: `config.pool()` (default: the shared registry plus the
   stand-ins), filtered to modules with role `"middle"`, a real lock
   (`teaches` not `"none"`), empty `requires` (each chosen room supplies its
   own keys; requirements are not yet carried between rooms) and exactly
   one exit. Rules:
   1. as many distinct mechanics as the pool offers (up to the room count);
   2. no mechanic more than `maxPerMechanic` (2) times, unless the pool has
      too few mechanics to fill the rooms;
   3. the first room of each mechanic is one of its easiest modules, later
      ones no easier (teach, then test);
   4. difficulty never drops from room to room (where 5 allows);
   5. no module twice in a row (and preferably no mechanic twice in a row).

   Mechanics are shuffled, rooms allotted to them, modules picked (easiest
   first, then unused ones), and a depth-first search orders them with 3
   and 5 as hard constraints, preferring low difficulty first. Each room's
   parameters come from `module.random` on a seed derived from the run seed.

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

| Field                 | Default                      | Meaning                                     |
| --------------------- | ---------------------------- | ------------------------------------------- |
| `rooms`               | 8                            | puzzle rooms                                |
| `start`, `finish`     | `LAB`, `EXIT_LOCK`           | anchors                                     |
| `corridor`, `adapter` | `CORRIDOR`, `ADAPTER`        | link modules                                |
| `pool`                | registry + `STANDIN_MODULES` | read at run time                            |
| `maxPerMechanic`      | 2                            | variety cap                                 |
| `clearance`           | 0.5 m                        | gap between non-neighbouring footprints     |
| `corridorLengths`     | 3, 4.5, 6, 8                 | tried by the search                         |
| `corridorLegs`        | 0, 1.5, 3                    | second leg of a bent corridor               |
| `branching`           | 4                            | candidates tried per step before backing up |
| `searchBudget`        | 4000                         | candidates evaluated before the fallback    |
| `jitter`              | 0.35                         | randomness against compactness              |

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
- `bun tools/solve.ts --seed 17`: plays the declared solution in the game.
  `bun src/level/gen/solve-seeds.ts 1 12`: twelve seeds, four at a time.
- `bun src/level/gen/joints.ts 17`: visual lint (holes, z-fighting) from
  both sides of every doorway, doors closed and open, contact sheets in
  `out/joints/17/`.
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
- With few modules per mechanic, runs look alike (the stand-ins: four
  mechanics, six modules).
- Fog and ambient are the hand-built level's (fog far 40 m in a facility
  50 x 35 m on average).
