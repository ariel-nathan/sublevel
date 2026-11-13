# src/level

A level is a chain of **room modules** joined at doorways. The **assembler**
(`assemble.ts`) places them, checks the rules below and gathers what they
build into one `LevelData`; `buildLevel` / `buildLevelFrom` (`index.ts`) then
bakes meshes and colliders from it. The hand-built level, Kestrel Annex, is
six modules (`define.ts`); the generator (`gen/`, `?seed=N`) chains modules
from a seed.

| File                                | What                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `rooms/room.ts`                     | The contract: `RoomModule`, `RoomContext`, `RoomPlan`, `Connector`, `Lock`, frames, the doorway rule |
| `rooms/kit.ts`                      | Builders in design coordinates: walls with openings, frames, doors, buttons, lights, props           |
| `rooms/solution.ts`                 | Where the bot stands to press, carry, push, throw; `verifySolution` checks a solution on paper       |
| `rooms/registry.ts`                 | Every module. Add yours here                                                                         |
| `rooms/corridor.ts`                 | The reference parametric module: a plain corridor                                                    |
| `rooms/lab.ts` ... `egress-lock.ts` | Kestrel Annex's six modules                                                                          |
| `rooms/contract.ts`                 | `contractProblems(module, options)`: the contract as a reusable check (8 orientations)               |
| `rooms/contract.test.ts`            | The contract, checked for every registered module                                                    |
| `rooms/puzzles/`                    | The library of parametric puzzle rooms (see "Puzzle rooms")                                          |
| `dev.ts`                            | `buildRoomsLevel`: development levels from module names (`?rooms=`)                                  |
| `assemble.ts`                       | `assembleLevel(plan)`, `buildRoom`, `planRoom`, `place`                                              |
| `define.ts`                         | `KESTREL_ANNEX`, the hand-built level's plan                                                         |
| `fingerprint.ts`                    | Hashes of the built level; `fingerprint.json` pins Kestrel Annex                                     |

## Writing a room module

```ts
export const MY_ROOM: RoomModule<MyParams> = {
  name: "my-room",            // unique
  role: "middle",             // "start" (spawn, no entry) | "middle" | "finish" (exit box, no exits)
  teaches: "weighted-plate",  // the mechanic it is about
  difficulty: 1,              // 0..3
  requires: {},               // e.g. { carryMass: 45 } if the key must be brought in
  entrySize: { width: [1.2, 2.0], height: [2.2, 2.6] }, // doorways it can be built from
  // Optional, for the generator's mission (gen/mission.ts):
  after: ["timed-door"],      // mechanics an earlier room must have taught
  position: "early",          // "first" (first puzzle room when in the run) | "early" (first half)
  idea: "my-idea",            // shared with a re-take: never adjacent, preferably not both in a run
  setPiece: false,            // an authored set piece: at most once, a few per run
  defaults: { ... },
  random: (rng) => ({ ... }), // a random choice within the stated ranges
  build(ctx, at, params) { ...; return plan; },
};
```

`build` adds everything through `ctx` (`box`, `light`, `prop`, `door`,
`button`, `plate`, `emitter`, `zone`), in **world** coordinates, reads nothing
but its arguments, and returns a `RoomPlan`. Same `at`, params and seed:
same result (use `ctx.rng` for any randomness, never `Math.random`).
`planRoom(module, at, options)` runs it without keeping the parts: that is
how the generator asks for a footprint before placing anything.

**Frame.** Write the room in design coordinates and map them with
`roomFrame(at, ctx.mirror, DESIGN)`; `createKit(ctx, frame)` gives helpers that
take design numbers. `LOCAL_DESIGN` means x = metres in from the entry plane,
z = metres to the right looking in, y = up from the threshold (the corridor
and the filtration hall use it). A hand-built room may instead keep the
coordinates it was drawn in and name the entry's design position and facing
(`LAB_DESIGN`, `STORAGE_DESIGN`, ...). The frame handles all four facings and
the mirror: never compute world positions by hand, and give yaws through
`frame.yaw` (absolute design yaw) or `frame.turn` (relative to the facing).
Positions are snapped to 1 µm so that walls meet exactly.

**Ids.** Name every door, button and plate `ctx.id("door_t")`: the
assembler prefixes it per placement (`hall2.door_t`), so two instances of a
module coexist. A button for the door of your entry doorway targets
`at.door` (already a final id).

**Props.** `ctx.prop` returns the module-local index (0, 1, ...). Solutions
and locks use those indices; the assembler adds the module's offset.

**Footprint.** `plan.footprint` is one or more boxes whose union holds
everything you emit: walls, floor slab, ceiling, anything sunk below the
floor (pits, channels). The assembler throws if anything is outside, and if
two modules' footprints overlap (touching is fine). Exits must lie on the
footprint's boundary, facing out.

### The doorway rule

Two modules meet on a plane: A's exit connector is B's entry (`at`). Each
footprint ends on the plane.

```
  walled / walled          walled / open           open / walled
  A ====|==== B            A ====|  B              A     |==== B
      ::|                      ::|                       |
  A ====|==== B            A ====|  B              A     |==== B
  (==== wall, :: door slab in A's wall, | the connector plane)
```

1. At each doorway a module either has **its own wall** against the plane
   (`end.wall: true`, the opening exactly the connector's width x height from
   the floor, sill filled under it), or an **open end** (its floor, walls and
   ceiling just stop at the plane, closed by the neighbour's wall). An open
   end's `extent` is its whole outline; the walled side's `extent` is its
   wall's face, which must cover that outline. Two open ends may not meet.
   Two walls stand back to back (a 0.6 m deep doorway).
2. A **door** belongs to the module you leave through it (the exit side),
   recessed in its own wall (`kit.door`: inset `DOOR_INSET`, slides into the
   wall `DOOR_OVERTRAVEL` past the jamb), with whatever opens it. The entry
   side may add buttons for it (`at.door`).
3. Each module **frames its own side** of the opening (`kit.frameX/Z`), on
   its own wall's face or, through an open end, the neighbour's.
4. Only zones (`ZONE_REACH`, 0.3 m) and dynamic light bounds (`LIGHT_REACH`,
   0.8 m, to light the reveal) may reach across a doorway's plane.

Walled ends join anything of the right size; use them in new modules. Open
ends exist for Kestrel Annex's hand-built joints (the corridor and the
chamber and lock are open-ended against the lab's, storage room's, hall's
and chamber's walls) and only fit a neighbour whose wall is big enough: the
generator must check (the assembler throws).

### Lock, solution, zones, lights

- `plan.lock`: `kind` (`Mechanic`), the doors that stay shut until solved,
  the buttons and plates involved, and the props meant as keys with where
  they start. `NO_LOCK` if nothing bars the way.
- `plan.solution`: `SolutionStep`s in world space, using only what the
  module provides. It starts at `doorwayPoints(at).after` (start modules: the
  spawn) and ends with a `walk` to `doorwayPoints(exit).before` with the
  exit's door open (finish modules: inside the exit box). The assembler
  walks the player through each doorway on its axis, so keep the axis clear
  of anything you leave in a doorway. Rules the bot (tools/solver.ts)
  relies on and `verifySolution` checks:
  - `walk`: a straight line on the floor (a brush top, or a prop's top, at
    the feet's height) clear of brushes and of props where they are then.
    Add as many points as it takes to get round furniture. A `walk` to a
    lower point steps off an edge (a drop of up to 2.5 m, landing within
    0.6 m of it); up more than a step is a `climb`.
  - `climb`: jump onto a surface at most `PLAYER.jumpHeight` (1 m) above
    the feet and 1.6 m away, with a 0.3 m square of it to land on and
    headroom all the way (`to` is where the feet end).
  - `press`: from where the player stands, the button within
    `PLAYER.reach - 0.3` of the eye and in front of it (`canPress`).
  - `carry`: the player fetches the prop (walks to 1.3 m of it if farther
    than 1.7 m), then sets it down at `to` (its resting centre) standing on
    the side of `to` facing where the step began, as `carryPlan` works out.
    Walk somewhere sensible first: that position picks the side.
  - `throw`: fetch, come back to where the step began, throw at `at`; the
    arc must be clear (`throwClear`).
  - `push`: the player stands behind (`pushApproach`) and walks into it; the
    prop's straight path must be clear and the approach point reachable by a
    straight walk. Pushed props do not climb anything, not even a plate.
  - `wait`: for an event since the previous step began.
- Zones must cover all the walkable floor (bar 0.3 m either side of a
  doorway plane). Every dynamic light (`flicker` not "none") needs `bounds`
  with itself 0.3 m inside, kept inside the footprint (plus `LIGHT_REACH`
  across doorways): it has no shadows and would shine into the neighbours.
- Buttons sit `BUTTON_DEPTH` (impact targets `IMPACT_BUTTON_DEPTH`) in front
  of a wall; nothing else may occupy the button unit.

### Registering and checking

Add the module to `rooms/registry.ts`. Then:

- `bun test src/level`: the contract tests (`contractProblems` in
  `rooms/contract.ts`) build it in each facing, mirrored and not, with its
  defaults and 4 random parameter sets, at its smallest and largest entry
  size, and check: footprint containment, doorways on the boundary, the
  exit reachable from the entry once the lock is open and not before (flood
  fill at 0.1 m), props (none in a brush or another prop, each resting on
  something), the solution (`verifySolution`), zones, light bounds, unique
  ids across two instances, determinism. A module outside the registry can
  call `contractProblems` from its own test (`gen/modules/contract.test.ts`).
- `bun tools/room-plan.ts my-room [--facing -z] [--mirror] [--seed 3]`: a
  top-down plan in `out/room-plan/` (brushes, props, footprint in red,
  doorways in green, the solution's path in blue). `annex` draws the level.
- Assembling a chain with it (see `assemble.test.ts`) checks the level-wide
  rules: sealed (voxel flood and rays from the spawn), no coplanar faces,
  props supported, solution walkable from spawn to exit.
- In the game: `?rooms=my-room` (see "Development levels" below) builds
  the lab, your module and an exit. To play it with the solver bot:
  `bun src/level/rooms/puzzles/prove.ts my-room --seeds 0,1,2,3`; and
  `bun src/level/rooms/puzzles/look.ts my-room --seed 0 [--view coverage]`
  renders viewpoints in it; `bun tools/solve.ts --rooms my-room --seed 1`
  plays it once with failure artefacts. `bun tools/solve.ts --seed N` plays
  a whole generated run, `bun tools/check-seed.ts --seed N` checks one
  completely (see tools/README.md).

## Puzzle rooms

`rooms/puzzles/` is the library the generator chains: each module is a
parametric room in the shell of `shell.ts` (`buildShell`: a rectangular
room in `LOCAL_DESIGN`, walled at both doorways, the standard exit
doorway 1.6 x 2.4 m in the far or a side wall, optionally with a door
that slides into that wall, extra `holes` for alcoves, and a timed
way-back button for the previous module's door), dressed with `dress.ts`.
Every puzzle room takes entries of 1.4-1.8 x 2.2-2.6 m (`ENTRY_SIZE`) and
leaves by the standard doorway. Each file's header has its layout, its
puzzle and its softlock analysis; `puzzles.test.ts` checks what makes each
one a puzzle and what makes it solvable across its parameter range, and
`levels.test.ts` checks sealing, z-fighting, props and lights in assembled
development levels.

| Module             | Mechanic                             | Difficulty |
| ------------------ | ------------------------------------ | ---------- |
| `records-office`   | toggle button behind a counter       | 1          |
| `goods-bay`        | weighted plate, gather light props   | 1          |
| `parts-store`      | weighted plate, fetch from a store   | 2          |
| `freight-passage`  | push the metal crate out of a tunnel | 1          |
| `generator-hall`   | impact target high across open floor | 2          |
| `fan-room`         | impact target through a window       | 3          |
| `pump-gallery`     | timed door, wedge it through a hatch | 2          |
| `decon-lock`       | plate holds door 1, timed door 2     | 3          |
| `maintenance-loft` | climb a crate staircase              | 2          |
| `exit-lock`        | finish (walled entry, sealed hatch)  | 0          |

The mission's ordering advice is data on the modules: `records-office` has
`position: "first"`, `freight-passage` `position: "early"`, `decon-lock`
`after: ["weighted-plate", "timed-door"]`; `pump-gallery` shares the idea
`timed-door-wedge` with the filtration hall, `generator-hall` `high-target`
with the valve chamber, `goods-bay` `crates-on-plate` with the storage room.
Teach-first ordering (each mechanic's first room is its easiest) follows
from `difficulty`. `PENDING_MODULES` is for complete rooms not yet ready for
the generator (development levels can name them); it is empty.

Things learned writing them: a carry is one straight walk from where the
prop is picked up to where it is let go, so carrying round a corner takes
two carries (set it down on the way); `wait` counts events since the
previous step began, so put it straight after the step that causes the
event. A prop the solution has moved is checked as an axis-aligned box of
its largest horizontal half-extent (the bot sets props down at whatever
turn they end up with). Leave 0.3 m between crates set down next to each
other: one set down a little off can knock the other.

## Development levels

`buildRoomsLevel(rooms, seed)` (`dev.ts`, `?rooms=a,b&seed=N` in the game):
the lab, then each named module (any registered or pending middle module)
behind a connecting corridor, then a corridor and the exit lock (the same
finish as generated runs). A module that takes another doorway size or has
an open entry (the authored set pieces: `?rooms=valve-chamber`) gets the
generator's doorway adapter after its corridor. Each module gets random
parameters from the seed, or its defaults for `name!default`;
`name@mirror` mirrors it. Corridors are picked from a fixed list
(straight, then bends back towards +X, lengths 3-10 m) as the first that
keeps every footprint apart; if none fits, the assembler's overlap error
is thrown. Same names and seed, same level.

## The assembler

```ts
const { data, rooms } = assembleLevel({
  name,
  root: { position, facing },
  ambient,
  fog,
  seed,
  placements: [
    place(LAB, { name: "lab" }),
    place(CORRIDOR, {
      name: "c1",
      params: { ...CORRIDOR.defaults, bend: "left" },
      seed: 7,
      mirror: true,
    }),
    place(EGRESS_LOCK, { name: "end" }), // attach: { to, exit } defaults to the previous one's exit 0
  ],
});
const built = buildLevelFrom(data);
```

It builds each placement from its `attach`ed exit and throws, naming the
placement, on: a start module not first (or two finish modules, or none);
an exit used twice or left unattached (a hole); a doorway size outside the
module's `entrySize`; an entry the module reports differently from the
connector it was given; two open ends, an open end not covered, a door in a
wall-less exit; anything emitted outside the footprint; overlapping
footprints; duplicate ids; buttons or plates targeting no door; solutions
using props or buttons that do not exist. The solution is the start module's
plus, for each module on the way to the finish, a walk through its entry
doorway and its own steps (props remapped).

What it does not check, and the generator must: that the level as a whole
is sealed and free of coplanar faces in practice (the rules make it so, the
level tests prove it), that requirements (`requires`) are met by earlier
rooms, that timed doors leave time for the doorway crossing, that a dynamic
light near a doorway does not light a neighbour's interior, total size and
brush count (the level tests allow 150 to 400 brushes for the annex).

## Kestrel Annex

`define.ts`: lab (start, door A with a toggle button), service corridor
(open ends, grate over a pit), storage (pressure plate holds door B: two
stacked crates), filtration hall (door T, timed: a crate through the
screen's slot wedges it), valve chamber (open entry; an impact target opens
the exit door), egress lock (finish, open entry). Ids are unprefixed
(`prefix: ""`). `fingerprint.test.ts` pins the built level: if you change
it on purpose, `bun src/level/fingerprint.ts --write` and commit the fixture
with the change. `bun tools/solve.ts` plays it from the declared solution;
`bun run e2e` plays it by hand-written steps.
