import { describe, expect, test } from "bun:test";
import { mat4 } from "../math";
import {
  BONE,
  boneMatrices,
  CharacterAnimator,
  characterDrawItems,
  generateCharacter,
  placementMatrix,
  randomSpec,
  restPose,
  type Character,
  type CharacterKind,
} from "./index";
import { ATLAS_SIZE } from "./layout";
import { pieceVolume } from "./measure";

const KINDS: CharacterKind[] = ["scientist", "guard"];
const SEEDS = Array.from({ length: 24 }, (_, i) => i * 37 + 1);
const people: Character[] = KINDS.flatMap((kind) =>
  SEEDS.map((seed) => generateCharacter(seed, kind)),
);

describe("generated parts", () => {
  test("indices are valid, normals unit, UVs inside the atlas", () => {
    for (const c of people) {
      for (const part of c.parts) {
        const m = part.mesh;
        const n = m.positions.length / 3;
        expect(m.indices.length % 3).toBe(0);
        for (const i of m.indices) {
          expect(i).toBeLessThan(n);
        }
        for (let i = 0; i < n; i++) {
          const len = Math.hypot(
            m.normals[i * 3],
            m.normals[i * 3 + 1],
            m.normals[i * 3 + 2],
          );
          expect(Math.abs(len - 1)).toBeLessThan(1e-4);
        }
        for (const uv of m.uvs) {
          expect(uv).toBeGreaterThanOrEqual(0);
          expect(uv).toBeLessThanOrEqual(1);
        }
        expect(m.image).toBe(c.atlas);
      }
    }
  });

  test("every closed shell winds outwards", () => {
    for (const c of people) {
      for (const part of c.parts) {
        for (const piece of part.pieces) {
          if (piece.closed) {
            expect(pieceVolume(part.mesh, piece)).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  test("triangle count per character is 500 to 900", () => {
    const counts = people.map((c) => c.triangleCount);
    console.log(
      `triangles per character: ${Math.min(...counts)} to ${Math.max(...counts)}`,
    );
    for (const n of counts) {
      expect(n).toBeGreaterThanOrEqual(500);
      expect(n).toBeLessThanOrEqual(900);
    }
  });
});

describe("atlas", () => {
  test("is 128 x 128, fully opaque and deterministic", () => {
    for (const c of people.slice(0, 6)) {
      expect(c.atlas.size).toBe(ATLAS_SIZE);
      expect(c.atlas.pixels.length).toBe(ATLAS_SIZE * ATLAS_SIZE * 4);
      for (let i = 3; i < c.atlas.pixels.length; i += 4) {
        expect(c.atlas.pixels[i]).toBe(255);
      }
      const again = generateCharacter(c.spec.seed, c.spec.kind);
      expect(again.atlas.pixels).toEqual(c.atlas.pixels);
      expect(again.parts.map((p) => Array.from(p.mesh.positions))).toEqual(
        c.parts.map((p) => Array.from(p.mesh.positions)),
      );
    }
  });

  test("different seeds give measurably different people", () => {
    const a = generateCharacter(11, "scientist");
    const b = generateCharacter(12, "scientist");
    let differing = 0;
    for (let i = 0; i < a.atlas.pixels.length; i += 4) {
      if (
        a.atlas.pixels[i] !== b.atlas.pixels[i] ||
        a.atlas.pixels[i + 1] !== b.atlas.pixels[i + 1] ||
        a.atlas.pixels[i + 2] !== b.atlas.pixels[i + 2]
      ) {
        differing++;
      }
    }
    expect(differing / (ATLAS_SIZE * ATLAS_SIZE)).toBeGreaterThan(0.2);
    // Across many seeds the specs spread over the ranges.
    const specs = SEEDS.map((s) => randomSpec(s, "scientist"));
    const heights = specs.map((s) => s.height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.12);
    expect(new Set(specs.map((s) => s.skin)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(specs.map((s) => s.hair.style)).size).toBeGreaterThanOrEqual(
      4,
    );
    expect(specs.some((s) => s.glasses !== null)).toBe(true);
    expect(specs.some((s) => s.glasses === null)).toBe(true);
    expect(
      specs.some((s) => s.figure === "a") &&
        specs.some((s) => s.figure === "b"),
    ).toBe(true);
    for (const s of specs) {
      expect(s.height).toBeGreaterThanOrEqual(1.6);
      expect(s.height).toBeLessThanOrEqual(1.92);
    }
  });
});

describe("skeleton", () => {
  test("bind pose: feet on y = 0 and the top of the head at the spec height", () => {
    for (const c of people) {
      const mats = boneMatrices(c.skeleton, restPose());
      let low = Infinity;
      let high = -Infinity;
      for (const part of c.parts) {
        const m = part.mesh;
        for (let i = 0; i < m.positions.length; i += 3) {
          const p = mat4.transformPoint(mats[part.bone], {
            x: m.positions[i],
            y: m.positions[i + 1],
            z: m.positions[i + 2],
          });
          low = Math.min(low, p.y);
          if (part.bone === BONE.head) high = Math.max(high, p.y);
        }
      }
      expect(Math.abs(low)).toBeLessThan(0.01);
      const cap = c.spec.outfit.type === "guard" && c.spec.outfit.cap;
      if (cap) {
        expect(high - c.spec.height).toBeLessThan(0.02);
        expect(high - c.spec.height).toBeGreaterThan(-0.01);
      } else {
        expect(Math.abs(high - c.spec.height)).toBeLessThan(0.01);
      }
    }
  });

  test("heads are slightly large but not cartoonish", () => {
    for (const c of people) {
      const ratio = c.skeleton.metrics.headLength / c.spec.height;
      expect(ratio).toBeGreaterThan(0.124);
      expect(ratio).toBeLessThan(0.15);
    }
  });
});

describe("cost", () => {
  test("generation takes a few milliseconds and posing is cheap", () => {
    for (let i = 0; i < 5; i++) generateCharacter(900 + i, "guard");
    const n = 30;
    let t0 = performance.now();
    for (let i = 0; i < n; i++)
      generateCharacter(500 + i, i % 2 ? "guard" : "scientist");
    const gen = (performance.now() - t0) / n;
    const c = people[0];
    const anim = new CharacterAnimator(c);
    anim.setAuto(true);
    const meshes = c.parts.map((_, i) => ({ id: i + 1 }));
    const placement = { position: { x: 0, y: 0, z: 0 }, yaw: 0.3 };
    const root = placementMatrix(placement);
    anim.setLookTarget({ x: 1, y: 1.6, z: -2 });
    const frames = 2000;
    t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      anim.update(1 / 60, placement);
      characterDrawItems(c, meshes, anim.pose(), root);
    }
    const pose = (performance.now() - t0) / frames;
    console.log(
      `generation ${gen.toFixed(2)} ms per character; update+pose+draw items ${(pose * 1000).toFixed(1)} us per frame`,
    );
    expect(gen).toBeLessThan(15);
    expect(pose).toBeLessThan(0.5);
  });
});
