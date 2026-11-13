/**
 * `bun run e2e`: the full playthrough as an automated test, driven by the
 * pilot: lab, door A, corridor, the plate puzzle, door B, the timer of the
 * timed door, wedging it with a crate, the impact target, and the exit. Prints a step-by-step transcript (deterministic: identical on every
 * run) and a PASS/FAIL summary, saves milestone frames and a contact sheet
 * under out/e2e/, and exits non-zero on any failed check.
 */
import type { Aabb, ButtonDef, DoorDef } from "../src/core/api";
import { launchGame } from "./browser";
import { contactSheets } from "./image";
import { Pilot, type PilotEvent } from "./pilot";
import type { Point3 } from "./pilot-math";
import { readPng, writePng } from "./png";

const OUT = "out";
const RUN = "e2e";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const milestones: { name: string; path: string }[] = [];

function check(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  return ok;
}

async function main(): Promise<boolean> {
  const started = Date.now();
  const session = await launchGame();
  const pilot = new Pilot(session, { run: RUN, outDir: OUT });
  const milestone = async (name: string): Promise<void> => {
    milestones.push({ name, path: await pilot.frame(name) });
  };
  const eventTypes = async (since: number): Promise<string[]> =>
    (await pilot.events(since)).map((e) => e.type);

  let mark = 0;
  try {
    // 1. Spawn state (after a moment to settle onto the floor).
    await pilot.wait(20);
    const spawn = await pilot.state();
    check(
      "spawn position",
      Math.abs(spawn.player.feet.x + 2) < 0.01 &&
        Math.abs(spawn.player.feet.z - 1.6) < 0.01,
      JSON.stringify(spawn.player.feet),
    );
    check("spawn faces +X", Math.abs(spawn.player.yawDeg + 90) < 0.5);
    check("spawn on ground", spawn.player.onGround === true);
    check("spawn holds nothing", spawn.player.heldBody === null);
    check(
      "level has props",
      spawn.bodies.length > 10,
      `${spawn.bodies.length}`,
    );
    pilot.log("spawn state checked");
    await milestone("01-spawn");

    // Throw a small crate across the lab (towards -Z, away from the route).
    const smalls = await pilot.bodies("crate_wood_small");
    const small = smalls.find((b) => b.position.x < -3);
    if (small && check("small crate found", true, `#${small.id}`)) {
      check("picked up small crate", await pilot.pickUp(small.id));
      await pilot.look(0, 8);
      await pilot.wait(20);
      const held = (await pilot.bodies()).find((b) => b.id === small.id)!;
      mark = (await pilot.state()).step;
      await pilot.primary();
      const feet = (await pilot.state()).player.feet;
      const startDistance = Math.hypot(
        held.position.x - feet.x,
        held.position.z - feet.z,
      );
      await pilot.wait(30);
      const after = (await pilot.bodies()).find((b) => b.id === small.id);
      check("throw event", (await eventTypes(mark - 1)).includes("throw"));
      const endDistance = after
        ? Math.hypot(after.position.x - feet.x, after.position.z - feet.z)
        : 0;
      check(
        "thrown crate moved away",
        endDistance > startDistance + 1.5,
        `${startDistance.toFixed(2)} -> ${endDistance.toFixed(2)} m`,
      );
      await milestone("02-after-throw");
    } else {
      check("small crate found", false);
    }

    // Real input path: hold W and move the mouse with trusted events.
    {
      const before = (await pilot.state()).player;
      await session.keyDown("KeyW");
      await session.mouseMove(150, -40);
      await session.evaluate("__harness.stepReal(30)");
      await session.keyUp("KeyW");
      await session.evaluate("__harness.stepReal(20)");
      const after = (await pilot.state()).player;
      const moved = Math.hypot(
        after.feet.x - before.feet.x,
        after.feet.z - before.feet.z,
      );
      const turned = after.yawDeg - before.yawDeg;
      check(
        "real input: W moves the player",
        moved > 0.5,
        `moved ${moved.toFixed(2)} m`,
      );
      check(
        "real input: mouse right turns right",
        turned < -5,
        `yaw changed ${turned.toFixed(1)} deg`,
      );
      check(
        "real input: mouse up looks up",
        after.pitchDeg > 2,
        `pitch ${after.pitchDeg.toFixed(1)}`,
      );
      pilot.log(
        `real input: moved ${moved.toFixed(2)} m, yaw ${turned.toFixed(1)}, pitch ${after.pitchDeg.toFixed(1)}`,
      );
    }
    await pilot.look(-90, 0);

    // 2. Lab button, door A, corridor.
    mark = (await pilot.state()).step;
    const pressed = await pilot.pressButtonAt(3.91, 1.2, 1.2, {
      x: -2,
      z: 1.2,
    });
    check("lab button pressed", pressed);
    check(
      "door A opens (door_open)",
      (await eventTypes(mark - 1)).includes("door_open"),
    );
    await pilot.wait(100);
    await milestone("03-door-a-open");
    const toCorridor = await pilot.walkTo(6.5, 0);
    check("walked into the corridor", toCorridor.arrived && toCorridor.x > 4.5);
    await milestone("04-corridor");

    // 3. Corridor to the storage room.
    const toStorage = await pilot.walkTo(9.55, 9.6);
    check(
      "walked into the storage room",
      toStorage.arrived && toStorage.z > 8,
      `(${toStorage.x.toFixed(2)}, ${toStorage.z.toFixed(2)})`,
    );
    await milestone("05-storage-entry");

    // 6. Jump and crouch (in the storage room, before the puzzle).
    mark = (await pilot.state()).step;
    await pilot.jump();
    const jumpEvents = await eventTypes(mark - 1);
    check(
      "jump then land events",
      jumpEvents.indexOf("jump") >= 0 &&
        jumpEvents.indexOf("land") > jumpEvents.indexOf("jump"),
      jumpEvents.filter((t) => t !== "footstep").join(","),
    );

    await pilot.crouch(30);
    const crouched = (await pilot.state()).player;
    check("crouched", crouched.crouched === true);
    const lowEye = await pilot.eye();
    await pilot.wait(30);
    const risen = await pilot.eye();
    check(
      "standing again after releasing crouch",
      risen.y > lowEye.y + 0.4,
      `eye ${lowEye.y.toFixed(2)} -> ${risen.y.toFixed(2)}`,
    );

    // 4. Two wooden crates onto the pressure plate. The pilot stays off the
    // plate itself (the player weighs it down too).
    const crates = (await pilot.bodies("crate_wood")).filter(
      (b) =>
        Math.abs(b.position.x - 11) < 0.1 &&
        Math.abs(b.position.z - 15.5) < 0.1,
    );
    crates.sort((a, b) => b.position.y - a.position.y); // top of the stack first
    check("found the stacked crates", crates.length === 2, `${crates.length}`);
    mark = (await pilot.state()).step;
    const targets = [
      // Floor of the plate, from the south; then stacked on it, from the east.
      { x: 8.5, y: 0.4, z: 12, from: { x: 8.5, z: 20 } },
      { x: 8.5, y: 1.2, z: 12, from: { x: 20, z: 12 } },
    ];
    for (const [i, crate] of crates.entries()) {
      const target = targets[i];
      check(`picked up crate #${crate.id}`, await pilot.pickUp(crate.id));
      if (i === 0) {
        await milestone("06-carrying-crate");
      }
      check(
        `dropped crate #${crate.id} on the plate`,
        await pilot.dropAt(target.x, target.y, target.z, target.from),
      );
      if (i === 0) {
        check(
          "one crate alone does not press the plate",
          !(await eventTypes(mark - 1)).includes("plate_down"),
        );
      }
    }
    await pilot.wait(40);
    const plateEvents = await eventTypes(mark - 1);
    check("plate_down", plateEvents.includes("plate_down"));
    check("door B opens (door_open)", plateEvents.includes("door_open"));
    check("objective", plateEvents.includes("objective"));
    await milestone("07-plate-down");

    // 5. Through door B into the filtration hall.
    const facts = await session.evaluate<{
      buttons: ButtonDef[];
      doors: DoorDef[];
      exit: Aabb;
    }>(
      "(() => { const d = __game.level.data; return { buttons: d.buttons, doors: d.doors, exit: d.exit }; })()",
    );
    const timed = facts.buttons.find(
      (b) => b.mode === "timed" && b.facing.x < 0,
    )!;
    const target = facts.buttons.find((b) => b.mode === "impact")!;
    const doorT = facts.doors.find((d) => d.id === timed.target)!;
    const exitDoor = facts.doors.find((d) => d.id === target.target)!;
    const seconds = timed.seconds ?? 8;
    // Door events carry the slab's centre, which slides along z only.
    const at = (door: DoorDef) => (e: PilotEvent) =>
      Math.abs(
        (e.position as Point3).x - (door.closed.min.x + door.closed.max.x) / 2,
      ) < 0.3;
    const ofDoor = (events: PilotEvent[], type: string, door: DoorDef) =>
      events.filter((e) => e.type === type && at(door)(e));

    const toHall = await pilot.walkTo(14.8, 12, { tolerance: 0.4 });
    check(
      "walked through door B into the hall (x > 14.1)",
      toHall.arrived && toHall.x > 14.1,
      `(${toHall.x.toFixed(2)}, ${toHall.z.toFixed(2)})`,
    );
    await milestone("08-hall");

    // 6. The timer by itself: press, watch it count down and the door close.
    const button = timed.position;
    const pressSide = { x: 20, z: button.z };
    mark = (await pilot.state()).step;
    check(
      "timed button pressed",
      await pilot.pressButtonAt(button.x, button.y, button.z, pressSide),
    );
    const pressStep =
      (await pilot.events(mark - 1)).find((e) => e.type === "button_press")
        ?.step ?? -1;
    await pilot.wait(Math.round(seconds * 60) + 60);
    {
      const events = await pilot.events(pressStep - 1);
      const ticks = events
        .filter((e) => e.type === "timer_tick")
        .map((e) => e.remaining as number);
      check(
        "timer_tick events count down from the button's seconds",
        ticks.length >= 4 &&
          ticks[0] === seconds &&
          ticks.every((r, i) => i === 0 || r < ticks[i - 1]),
        ticks.join(","),
      );
      const opened = ofDoor(events, "door_open", doorT);
      const closed = ofDoor(events, "door_close", doorT);
      check("door T opens", opened.length === 1);
      const after = closed.length > 0 ? closed[0].step - pressStep : -1;
      check(
        "door T closes when the countdown ends",
        closed.length === 1 && Math.abs(after - seconds * 60) <= 3,
        `closed ${after} steps after the press`,
      );
    }
    await milestone("09-timer-closed");

    // 7. Puzzle A: press, carry a small crate through the screen's slot and
    // drop it in the doorway; the closing door meets it and reopens.
    mark = (await pilot.state()).step;
    check(
      "timed button pressed again",
      await pilot.pressButtonAt(button.x, button.y, button.z, pressSide),
    );
    const near = (await pilot.bodies("crate_wood_small"))
      .filter((b) => b.position.x > 21 && b.position.z > 11.3)
      .sort(
        (p, q) =>
          Math.hypot(p.position.x - button.x, p.position.z - button.z) -
          Math.hypot(q.position.x - button.x, q.position.z - button.z),
      );
    check("small crate by the button", near.length > 0);
    const wedge = near[0];
    check("picked up the wedge crate", await pilot.pickUp(wedge.id));
    // Slot height, ahead and a little right; walk up to the screen with the
    // crate leading, through the slot; then swing it into the doorway.
    const slotY = 1.88;
    const doorX = (doorT.closed.min.x + doorT.closed.max.x) / 2;
    const jamb = doorT.closed.max.z;
    await pilot.holdOver(button.x - 0.26, slotY, jamb - 0.6, 10);
    const stand = await pilot.walkTo(button.x - 0.62, jamb + 0.42, {
      direct: true,
      tolerance: 0.08,
    });
    check("stood at the screen holding the crate", stand.arrived);
    await milestone("10-crate-in-slot");
    await pilot.holdOver(doorX - 0.04, slotY, jamb - 0.3, 20);
    check("let go of the crate in the doorway", await pilot.release(40));
    await pilot.waitForEvent(
      "door T blocked",
      (e) => e.type === "door_blocked" && at(doorT)(e),
      Math.round(seconds * 60) + 200,
    );
    await pilot.waitForEvent(
      "door T reopens",
      (e) => e.type === "door_open" && at(doorT)(e),
      120,
    );
    {
      const events = await pilot.events(mark - 1);
      const closes = ofDoor(events, "door_close", doorT);
      const blocked = ofDoor(events, "door_blocked", doorT);
      const reopened = ofDoor(events, "door_open", doorT).filter(
        (e) => blocked.length > 0 && e.step > blocked[0].step,
      );
      check(
        "the closing door meets the crate (door_blocked) and reopens",
        closes.length >= 1 && blocked.length >= 1 && reopened.length >= 1,
        `close@${closes[0]?.step} blocked@${blocked[0]?.step} open@${reopened[0]?.step}`,
      );
      const crate = (await pilot.bodies()).find((b) => b.id === wedge.id);
      check(
        "the crate stays in the doorway",
        crate !== undefined &&
          crate.position.x > doorT.closed.min.x - 0.25 &&
          crate.position.z > doorT.closed.min.z &&
          crate.position.z < doorT.closed.max.z,
        crate ? `(${crate.position.x}, ${crate.position.z})` : "gone",
      );
    }
    await milestone("11-door-t-wedged");

    // Round the screen and through the wedged door, timing the passage
    // with the door's cycle (it keeps trying to close every few seconds).
    const approach = await pilot.walkTo(24.4, 9.6);
    check("walked round the screen to door T", approach.arrived);
    await pilot.waitForEvent(
      "door T open again",
      (e) => e.type === "door_open" && at(doorT)(e),
      400,
    );
    await pilot.wait(75);
    const intoChamber = await pilot.walkTo(26.3, 9.6, { direct: true });
    check(
      "walked through door T into the chamber",
      intoChamber.arrived && intoChamber.x > doorT.closed.max.x + 0.3,
      `(${intoChamber.x.toFixed(2)}, ${intoChamber.z.toFixed(2)})`,
    );
    await pilot.look(-90, 8);
    await milestone("12-chamber");

    // 8. Puzzle B: throw props at the impact target until it latches.
    const goal = target.position;
    const tried = new Set<number>();
    let hitTarget = false;
    for (let attempt = 0; attempt < 4 && !hitTarget; attempt++) {
      const here = (await pilot.state()).player.feet;
      const throwables = (await pilot.bodies())
        .filter(
          (b) =>
            ["crate_wood_small", "chair", "monitor"].includes(b.tag) &&
            b.position.x > doorT.closed.max.x &&
            b.position.x < goal.x &&
            !tried.has(b.id),
        )
        .sort(
          (p, q) =>
            Math.hypot(p.position.x - here.x, p.position.z - here.z) -
            Math.hypot(q.position.x - here.x, q.position.z - here.z),
        );
      if (throwables.length === 0) {
        break;
      }
      const prop = throwables[0];
      tried.add(prop.id);
      if (!(await pilot.pickUp(prop.id))) {
        continue;
      }
      await pilot.walkTo(goal.x - 3.3, goal.z, {
        direct: true,
        tolerance: 0.2,
      });
      mark = (await pilot.state()).step;
      // Aim the prop's centre at a point a crate's half-width in front of
      // the target, where its leading face meets it.
      const f = target.facing;
      await pilot.throwAt(goal.x + f.x * 0.3, goal.y, goal.z + f.z * 0.3);
      hitTarget =
        (await pilot.waitForEvent(
          "target hit",
          (e) =>
            e.type === "button_press" &&
            Math.abs((e.position as Point3).y - goal.y) < 0.05,
          90,
        )) !== null;
      pilot.log(
        `throw ${attempt + 1} (${prop.tag}): ${hitTarget ? "hit" : "missed"}`,
      );
    }
    check("a thrown prop latches the impact target", hitTarget);
    await pilot.wait(90);
    check(
      "the exit door opens",
      ofDoor(await pilot.events(mark - 1), "door_open", exitDoor).length === 1,
    );
    await milestone("13-target-hit");

    // 9. Into the egress lock and the exit.
    const e = facts.exit;
    const toExit = await pilot.walkTo(
      (e.min.x + e.max.x) / 2,
      (e.min.z + e.max.z) / 2,
      { tolerance: 0.3 },
    );
    const feet = (await pilot.state()).player.feet;
    check(
      "the player's feet are inside the exit box",
      toExit.arrived &&
        feet.x >= e.min.x &&
        feet.x <= e.max.x &&
        feet.z >= e.min.z &&
        feet.z <= e.max.z &&
        feet.y >= e.min.y - 0.01 &&
        feet.y <= e.max.y,
      `(${feet.x.toFixed(2)}, ${feet.y.toFixed(2)}, ${feet.z.toFixed(2)})`,
    );
    await pilot.look(-90, 0);
    await pilot.wait(30);
    await milestone("14-exit");
    await pilot.page("14-exit");

    const errors = session.consoleLines.filter((line) =>
      /^(exception|error)/.test(line),
    );
    check("no console errors", errors.length === 0, errors.join(" | "));

    // Contact sheet of the milestones.
    const items = [];
    for (const { name, path } of milestones) {
      items.push({ image: await readPng(path), label: name });
    }
    const sheets = contactSheets(items, { cols: 3, rows: 3 });
    for (const [i, sheet] of sheets.entries()) {
      await writePng(
        `${OUT}/${RUN}/sheet${i === 0 ? "" : `-${i + 1}`}.png`,
        sheet.image.width,
        sheet.image.height,
        sheet.image.rgba,
      );
    }

    console.log(pilot.transcript.join("\n"));
    console.log("");
    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) {
      console.log(
        `${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`,
      );
    }
    console.log("");
    console.log(
      `${failed.length === 0 ? "PASS" : "FAIL"}: ${checks.length - failed.length}/${checks.length} checks. Frames and sheet.png in ${OUT}/${RUN}/`,
    );
    console.error(`(took ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return failed.length === 0;
  } catch (error) {
    console.log(pilot.transcript.join("\n"));
    throw error;
  } finally {
    await session.close();
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    console.error("FAIL: e2e crashed:", error);
    process.exit(1);
  },
);
