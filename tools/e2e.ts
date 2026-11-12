/**
 * `bun run e2e`: the full playthrough as an automated test, driven by the
 * pilot. Prints a step-by-step transcript (deterministic: identical on every
 * run) and a PASS/FAIL summary, saves milestone frames and a contact sheet
 * under out/e2e/, and exits non-zero on any failed check.
 */
import { launchGame } from "./browser";
import { contactSheets } from "./image";
import { Pilot } from "./pilot";
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

    // 5. Into the exit alcove.
    const toAlcove = await pilot.walkTo(14.8, 12, { tolerance: 0.4 });
    check(
      "reached the exit alcove (x > 14)",
      toAlcove.arrived && toAlcove.x > 14,
      `(${toAlcove.x.toFixed(2)}, ${toAlcove.z.toFixed(2)})`,
    );
    await pilot.wait(30);
    await milestone("08-exit-alcove");
    await pilot.page("08-exit-alcove");

    const errors = session.consoleLines.filter((line) =>
      /^(exception|error)/.test(line),
    );
    check("no console errors", errors.length === 0, errors.join(" | "));

    // Contact sheet of the milestones.
    const items = [];
    for (const { name, path } of milestones) {
      items.push({ image: await readPng(path), label: name });
    }
    const [sheet] = contactSheets(items, { cols: 3, rows: 3 });
    if (sheet) {
      await writePng(
        `${OUT}/${RUN}/sheet.png`,
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
