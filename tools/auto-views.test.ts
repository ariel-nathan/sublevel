import { describe, expect, test } from "bun:test";
import { PLAYER } from "../src/core/props";
import { buildLevel } from "../src/level";
import { boxOf, boxesOverlap } from "../src/level/geometry";
import { autoViews, rayDistance } from "./auto-views";
import { viewBasis } from "./pilot-math";

const level = buildLevel().data;
const views = autoViews(level);

describe("rayDistance", () => {
  const box = { x0: 2, x1: 3, y0: -1, y1: 1, z0: -1, z1: 1 };
  test("hits the near face; misses sideways; ignores a start inside", () => {
    expect(
      rayDistance({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, [box]),
    ).toBeCloseTo(2);
    expect(rayDistance({ x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, [box])).toBe(
      Infinity,
    );
    expect(
      rayDistance({ x: 2.5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, [box]),
    ).toBe(Infinity);
    expect(
      rayDistance({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, [box], 1),
    ).toBe(Infinity);
  });
});

describe("autoViews on the hand-built level", () => {
  test("is deterministic and has unique names", () => {
    expect(autoViews(level)).toEqual(views);
    const names = views.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("covers every zone, door, button, plate and the exit", () => {
    const names = new Set(views.map((v) => v.name));
    level.zones.forEach((_, i) => {
      const tag = `z${String(i).padStart(2, "0")}`;
      expect([...names].some((n) => n.startsWith(`${tag}-`))).toBe(true);
    });
    for (const d of level.doors) {
      expect(names.has(`door-${d.id}-a`) || names.has(`door-${d.id}-b`)).toBe(
        true,
      );
      expect(names.has(`door-${d.id}-through`)).toBe(true);
    }
    for (const b of level.buttons)
      expect(names.has(`button-${b.id}`)).toBe(true);
    for (const p of level.plates) expect(names.has(`plate-${p.id}`)).toBe(true);
    expect(names.has("exit")).toBe(true);
  });

  test("at most 12 views per room", () => {
    level.zones.forEach((_, i) => {
      const tag = `z${String(i).padStart(2, "0")}-`;
      expect(
        views.filter((v) => v.name.startsWith(tag)).length,
      ).toBeLessThanOrEqual(12);
    });
  });

  test("no viewpoint stands inside geometry, a prop or a closed door, or stares at a wall from close up", () => {
    const solids = [
      ...level.brushes.map(boxOf).filter((b) => b.y1 > 0.1),
      ...level.props.map((p) =>
        boxOf({
          min: {
            x: p.position.x - 0.2,
            y: p.position.y - 0.2,
            z: p.position.z - 0.2,
          },
          max: {
            x: p.position.x + 0.2,
            y: p.position.y + 0.2,
            z: p.position.z + 0.2,
          },
        }),
      ),
      ...level.doors.map((d) => boxOf(d.closed)),
    ];
    for (const v of views) {
      const [x, y, z] = v.pos;
      const eye = {
        x0: x - 0.1,
        x1: x + 0.1,
        y0: y - 0.1,
        y1: y + 0.1,
        z0: z - 0.1,
        z1: z + 0.1,
      };
      for (const s of solids) expect(boxesOverlap(s, eye)).toBe(false);
      // Eye height above the floor (the grate floors sit 4 cm low).
      expect(Math.abs(y - PLAYER.eyeHeight)).toBeLessThan(0.05);
      const { forward } = viewBasis({ yawDeg: v.yaw, pitchDeg: v.pitch });
      const blockers = [
        ...level.brushes.map(boxOf),
        ...level.doors.map((d) => boxOf(d.closed)),
      ];
      const dist = rayDistance({ x, y, z }, forward, blockers);
      // Room views must not stare at something within 1 m (the ceiling and
      // floor views look at surfaces about 2 m away by design).
      if (v.name.startsWith("z") && !/ceiling|floor/.test(v.name)) {
        expect(dist).toBeGreaterThanOrEqual(1);
      }
      expect(dist).toBeGreaterThan(0.5);
    }
  });

  test("only the through-door views are in the open state", () => {
    for (const v of views) {
      expect(v.doors).toBe(v.name.endsWith("-through") ? "open" : "closed");
    }
  });
});
