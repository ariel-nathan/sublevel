/**
 * Positive control for tools/lint-visual.ts: puts a real z-fighting defect
 * into the running game from the page context (no change to src/), so the
 * lint can prove that it still sees one.
 *
 * The defect is a quad lying exactly on the plane of a wall face, in another
 * material and with a different triangulation, appended to the world's draw
 * list by wrapping `__game.world.drawItems`.
 */
import { MATERIAL_IDS } from "../src/core/materials";
import { SEE_THROUGH_MATERIALS } from "../src/level/meshgen";
import type { GameSession } from "./browser";
import { viewBasis } from "./pilot-math";
import type { Viewpoint } from "./views";

interface BrushJson {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  material: string;
  faces?: Record<string, string>;
}

export interface Injected {
  material: string;
  /** Material of the wall face that was duplicated. */
  wall: string;
  plane: string;
}

const AXES = ["x", "y", "z"] as const;

/** First brush face hit by a ray (the origin must be outside every brush). */
export function castAtBrushes(
  origin: readonly number[],
  dir: readonly number[],
  brushes: readonly BrushJson[],
): {
  axis: number;
  /** Direction the face looks: -1 or +1 along `axis`. */
  normal: number;
  coord: number;
  point: number[];
  brush: BrushJson;
  face: string;
} | null {
  let best: ReturnType<typeof castAtBrushes> = null;
  let bestT = Infinity;
  for (const brush of brushes) {
    const lo = AXES.map((a) => brush.min[a]);
    const hi = AXES.map((a) => brush.max[a]);
    let tNear = 0;
    let tFar = Infinity;
    let axis = -1;
    let normal = 0;
    let ok = true;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-12) {
        if (origin[a] < lo[a] || origin[a] > hi[a]) {
          ok = false;
          break;
        }
        continue;
      }
      let t0 = (lo[a] - origin[a]) / dir[a];
      let t1 = (hi[a] - origin[a]) / dir[a];
      let n = dir[a] > 0 ? -1 : 1;
      if (t0 > t1) {
        [t0, t1] = [t1, t0];
      }
      if (t0 > tNear) {
        tNear = t0;
        axis = a;
        normal = n;
      }
      tFar = Math.min(tFar, t1);
      if (tNear > tFar) {
        ok = false;
        break;
      }
    }
    if (!ok || axis < 0 || tNear <= 0 || tNear >= bestT) {
      continue;
    }
    bestT = tNear;
    const face = `${normal > 0 ? "p" : "n"}${AXES[axis]}`;
    best = {
      axis,
      normal,
      coord: normal > 0 ? hi[axis] : lo[axis],
      point: origin.map((o, i) => o + dir[i] * tNear),
      brush,
      face,
    };
  }
  return best;
}

/**
 * Appends a quad (about 1 m square, centred where the view's centre ray meets
 * a wall) lying `behind` metres behind the wall's plane, to the world's draw
 * list. Undo with removeInjected.
 *
 * Whether such a quad fights with the wall depends on `behind` relative to
 * the depth buffer's resolution at that distance (about 0.05 mm here): at 0
 * the later draw always wins, and beyond a quantum the wall always does. In
 * between the winner depends on how the camera position rounds, so the
 * whole quad flips with sub-millimetre camera moves. The lint's self-test
 * tries a few offsets in that range.
 */
export async function injectCoplanarQuad(
  session: GameSession,
  view: Viewpoint,
  behind = 0,
): Promise<Injected> {
  const brushes = await session.evaluate<BrushJson[]>(
    "JSON.parse(JSON.stringify(__game.level.data.brushes))",
  );
  const basis = viewBasis({ yawDeg: view.yaw, pitchDeg: view.pitch });
  const dir = [basis.forward.x, basis.forward.y, basis.forward.z];
  const hit = castAtBrushes([...view.pos], dir, brushes);
  if (!hit) {
    throw new Error(`self-test: the centre ray of ${view.name} hits no wall`);
  }
  const wall = hit.brush.faces?.[hit.face] ?? hit.brush.material;
  const material = MATERIAL_IDS.find(
    (id) => id !== wall && !SEE_THROUGH_MATERIALS.has(id),
  )!;
  const spec = {
    axis: hit.axis,
    normal: hit.normal,
    coord: hit.coord,
    centre: hit.point,
    material,
    behind,
  };
  await session.evaluate(`(() => {
    const spec = ${JSON.stringify(spec)};
    const g = __game;
    const a = spec.axis;
    const p = (a + 1) % 3;
    const q = (a + 2) % 3;
    // Orientation: (e_p x e_q) is +e_a, so the normal is +e_a; flip winding if
    // the face looks the other way.
    const N = 4;
    const half = 0.5;
    const positions = [];
    const normals = [];
    const uvs = [];
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const v = [0, 0, 0];
        v[a] = spec.coord - spec.normal * spec.behind;
        v[p] = spec.centre[p] - half + (2 * half * i) / N;
        v[q] = spec.centre[q] - half + (2 * half * j) / N;
        positions.push(v[0], v[1], v[2]);
        const n = [0, 0, 0];
        n[a] = spec.normal;
        normals.push(n[0], n[1], n[2]);
        uvs.push(i / N, j / N);
      }
    }
    const indices = [];
    const row = N + 1;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v00 = j * row + i;
        const v10 = v00 + 1;
        const v01 = v00 + row;
        const v11 = v01 + 1;
        // Alternate the diagonal so the interpolation differs from the wall's.
        const tris = (i + j) % 2 === 0
          ? [[v00, v10, v11], [v00, v11, v01]]
          : [[v00, v10, v01], [v10, v11, v01]];
        for (const t of tris) {
          indices.push(...(spec.normal > 0 ? t : [t[0], t[2], t[1]]));
        }
      }
    }
    const mesh = g.renderer.createMesh({
      material: spec.material,
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(indices),
    });
    const identity = new Float32Array(16);
    identity[0] = identity[5] = identity[10] = identity[15] = 1;
    const original = g.world.drawItems;
    g.world.drawItems = function (alpha) {
      return original.call(this, alpha).concat([{ mesh, transform: identity }]);
    };
    window.__lintInjected = { mesh, original };
  })()`);
  return {
    material,
    wall,
    plane: `${AXES[hit.axis]}=${hit.coord.toFixed(3)}, facing ${hit.normal > 0 ? "+" : "-"}${AXES[hit.axis]}`,
  };
}

/** Removes what injectCoplanarQuad added. Safe to call when nothing is injected. */
export async function removeInjected(session: GameSession): Promise<void> {
  await session.evaluate(`(() => {
    const injected = window.__lintInjected;
    if (!injected) return;
    __game.world.drawItems = injected.original;
    __game.renderer.destroyMesh(injected.mesh);
    delete window.__lintInjected;
  })()`);
}
