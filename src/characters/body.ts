/**
 * Body geometry: one small rigid mesh per bone, built in character space in
 * the bind pose and then moved into the bone's space. Neighbouring parts
 * overlap at every joint (rounded ends tucked into each other) so nothing
 * opens up when a joint bends: the seams pinch and overlap instead, which is
 * the look of the era. Each part also lists "seam" points that must stay
 * inside a neighbour's solid, for the tests.
 */
import type { MaterialId } from "../core/materials";
import type { MeshData, MeshImage } from "../core/mesh";
import type { Vec3 } from "../math";
import { alongMinusZ, PartBuilder, type Piece, type Ring } from "./geometry";
import { ATLAS, HEAD_COLUMNS, HEAD_LEVELS, HEAD_ROWS, headRow } from "./layout";
import { BONE, type BodyMetrics, type Skeleton } from "./skeleton";
import type { CharacterSpec } from "./spec";

/** Material used for every character part (only decides surface kind). */
export const CHARACTER_MATERIAL: MaterialId = "plastic_white";

export interface Seam {
  /** Points in this part's bone space. */
  points: Vec3[];
  /** Bones whose parts' closed pieces must contain (or nearly) the points. */
  inside: number[];
}

export interface CharacterPart {
  bone: number;
  mesh: MeshData;
  /** Closed shells (and open ones) as triangle ranges of `mesh`. */
  pieces: Piece[];
  seams: Seam[];
}

/** Ellipse radii and centre of a trunk cross-section. */
interface Section {
  rx: number;
  rz: number;
  cz: number;
}

/** Row helpers shared with the painter: where heights land in the atlas. */
export interface AtlasRows {
  /** Torso band row for a height in character space. */
  torso(y: number): number;
  /** Skirt band row for a height; null when there is no coat. */
  skirt: ((y: number) => number) | null;
  /** Arm band row for a distance below the shoulder joint. */
  arm(d: number): number;
  /** Leg band row for a distance below the hip joint. */
  leg(d: number): number;
  waistY: number;
  hemY: number;
  /** Height of the belt line (top of the trousers). */
  beltY: number;
}

export function atlasRows(m: BodyMetrics, spec: CharacterSpec): AtlasRows {
  const torso = (y: number): number =>
    ATLAS.torso.y + 6 + ((m.shoulderY - y) / (m.shoulderY - m.crotchY)) * 56;
  const thigh = m.hipY - m.kneeY;
  const shin = m.kneeY - m.ankleY;
  const coat = spec.outfit.type === "scientist" ? spec.outfit : null;
  const skirtTop = m.waistY - 0.012 * m.height;
  const hemY = coat
    ? m.kneeY - 0.03 * m.scale + coat.coatLength * 0.3 * thigh
    : m.crotchY;
  return {
    torso,
    skirt: coat
      ? (y: number) =>
          ATLAS.skirt.y + ((skirtTop - y) / (skirtTop - hemY)) * ATLAS.skirt.h
      : null,
    arm: (d: number) =>
      Math.max(
        ATLAS.arm.y,
        Math.min(
          ATLAS.arm.y + ATLAS.arm.h,
          ATLAS.arm.y + 4 + (d / (m.upperArm + m.forearm)) * 42,
        ),
      ),
    leg: (d: number) =>
      Math.max(
        ATLAS.leg.y,
        Math.min(
          ATLAS.leg.y + ATLAS.leg.h,
          ATLAS.leg.y + 2 + (d / (thigh + shin)) * 36,
        ),
      ),
    waistY: skirtTop,
    hemY,
    beltY: m.waistY - 0.004 * m.height,
  };
}

function lerpKeys(keys: [number, Section][], y: number): Section {
  if (y <= keys[0][0]) {
    return keys[0][1];
  }
  for (let i = 0; i + 1 < keys.length; i++) {
    const [y0, a] = keys[i];
    const [y1, b] = keys[i + 1];
    if (y <= y1) {
      const t = (y - y0) / (y1 - y0);
      return {
        rx: a.rx + (b.rx - a.rx) * t,
        rz: a.rz + (b.rz - a.rz) * t,
        cz: a.cz + (b.cz - a.cz) * t,
      };
    }
  }
  return keys[keys.length - 1][1];
}

/** Trunk cross-sections from crotch to the base of the neck. */
function trunkProfile(
  m: BodyMetrics,
  spec: CharacterSpec,
): (y: number) => Section {
  const s = m.scale;
  const g = m.girth;
  const b = spec.build;
  const soft = m.softness;
  const hips = soft ? 1.1 : 1;
  const pad = spec.outfit.type === "scientist" ? 0.012 * s : 0.004 * s;
  const sec = (rx: number, rz: number, cz: number): Section => ({
    rx: rx + pad,
    rz: rz + pad,
    cz,
  });
  const keys: [number, Section][] = [
    [m.crotchY, sec(0.148 * s * g * hips, 0.1 * s * g, 0.004 * s)],
    [m.hipY, sec(0.172 * s * g * hips, 0.112 * s * g, 0.006 * s)],
    [
      m.hipY + 0.035 * m.height,
      sec(0.162 * s * g * hips * 0.98, 0.108 * s * g, 0.002 * s),
    ],
    [
      m.waistY,
      sec(
        0.146 * s * g * (soft ? 0.88 : 1),
        0.103 * s * (1 + 0.55 * b),
        -0.012 * b * s,
      ),
    ],
    [
      m.chestY,
      sec(
        0.156 * s * g * (soft ? 0.92 : 1),
        0.11 * s * (1 + 0.38 * b),
        -0.008 * b * s,
      ),
    ],
    [
      m.shoulderY - 0.12 * s,
      sec(
        m.shoulderHalf + 0.004 * s,
        0.118 * s * (1 + 0.25 * b) * (soft ? 1.04 : 1),
        -0.006 * s,
      ),
    ],
    // Squared-off shoulders that hold the top of the arm.
    [
      m.shoulderY - 0.01 * s,
      sec(
        m.shoulderHalf + 0.05 * s * m.limb,
        0.098 * s * (1 + 0.2 * b),
        0.01 * s,
      ),
    ],
    [
      m.shoulderY + 0.022 * s,
      sec(0.1 * s * (1 + 0.2 * b), 0.072 * s, 0.016 * s),
    ],
  ];
  return (y: number) => lerpKeys(keys, y);
}

interface HeadShape {
  /** Section of the head at a height fraction f (chin 0, crown 1), in metres. */
  at(f: number): Section;
  /** Character-space y of a height fraction. */
  y(f: number): number;
  z0: number;
  hl: number;
}

function headShape(m: BodyMetrics): HeadShape {
  const hl = m.headLength;
  const keys: [number, Section][] = [
    [HEAD_LEVELS.chin, { rx: 0.16, rz: 0.17, cz: -0.155 }],
    [HEAD_LEVELS.chinFront, { rx: 0.24, rz: 0.3, cz: -0.105 }],
    // The back of the skull comes down low, over the top of the neck.
    [HEAD_LEVELS.mouth, { rx: 0.25, rz: 0.375, cz: -0.045 }],
    [HEAD_LEVELS.nose, { rx: 0.285, rz: 0.41, cz: -0.035 }],
    [HEAD_LEVELS.eyes, { rx: 0.31, rz: 0.415, cz: -0.045 }],
    [HEAD_LEVELS.forehead, { rx: 0.3, rz: 0.4, cz: -0.035 }],
    [HEAD_LEVELS.crown, { rx: 0.19, rz: 0.26, cz: -0.03 }],
    [1, { rx: 0.0, rz: 0.0, cz: -0.03 }],
  ];
  const z0 = 0.01 * m.scale;
  return {
    hl,
    z0,
    at: (f) => {
      const k = lerpKeys(keys, f);
      return { rx: k.rx * hl, rz: k.rz * hl, cz: z0 + k.cz * hl };
    },
    y: (f) => m.chinY + f * hl,
  };
}

/** Points of an ellipse ring, `count` evenly spaced, scaled by `k`. */
function ringPoints(
  cx: number,
  y: number,
  sec: Section,
  count: number,
  k = 1,
): Vec3[] {
  const pts: Vec3[] = [];
  for (let j = 0; j < count; j++) {
    const phi = (j / count) * Math.PI * 2;
    pts.push({
      x: cx + sec.rx * k * Math.sin(phi),
      y,
      z: sec.cz + sec.rz * k * Math.cos(phi),
    });
  }
  return pts;
}

const sub = (p: Vec3, o: Vec3): Vec3 => ({
  x: p.x - o.x,
  y: p.y - o.y,
  z: p.z - o.z,
});

/** Builds every part of a character. */
export function buildBody(
  spec: CharacterSpec,
  skeleton: Skeleton,
  atlas: MeshImage,
): CharacterPart[] {
  const m = skeleton.metrics;
  const s = m.scale;
  const rows = atlasRows(m, spec);
  const trunk = trunkProfile(m, spec);
  const head = headShape(m);
  const bind = skeleton.bindPositions;
  const scientist = spec.outfit.type === "scientist" ? spec.outfit : null;
  const guard = spec.outfit.type === "guard" ? spec.outfit : null;
  const parts: CharacterPart[] = [];

  /** Finishes a part: moves it into bone space and builds the mesh. */
  const finish = (
    bone: number,
    pb: PartBuilder,
    seams: { points: Vec3[]; inside: number[] }[] = [],
  ): void => {
    const o = bind[bone];
    for (let i = 0; i < pb.positions.length; i += 3) {
      pb.positions[i] -= o.x;
      pb.positions[i + 1] -= o.y;
      pb.positions[i + 2] -= o.z;
    }
    parts.push({
      bone,
      mesh: pb.build(CHARACTER_MATERIAL, atlas),
      pieces: pb.pieces,
      seams: seams.map((seam) => ({
        points: seam.points.map((p) => sub(p, o)),
        inside: seam.inside,
      })),
    });
  };

  const trunkRing = (y: number, k = 1, extra = 0): Ring => {
    const sec = trunk(y);
    return {
      y,
      rx: sec.rx * k + extra,
      rz: sec.rz * k + extra,
      cz: sec.cz,
      v: rows.torso(y),
    };
  };

  // --- Pelvis (with the coat skirt or the guard's belt gear) ---------------
  {
    const pb = new PartBuilder();
    const topY = m.waistY + 0.02 * m.height;
    pb.loft({
      sides: 8,
      band: ATLAS.torso,
      rings: [
        trunkRing(m.crotchY),
        trunkRing(m.hipY),
        trunkRing(topY, 1, 0.012 * s),
      ],
      bottom: { kind: "flat", swatch: ATLAS.trouser },
      top: { kind: "flat", swatch: ATLAS.trouser },
    });
    if (scientist && rows.skirt) {
      const top = rows.waistY;
      const hem = rows.hemY;
      const gap = scientist.coatOpen ? 0.075 : 0.04;
      const ringAt = (y: number, extra: number, flare: number): Ring => {
        const sec = trunk(Math.max(y, m.crotchY));
        const hip = trunk(m.hipY);
        const rx = Math.max(sec.rx, y < m.hipY ? hip.rx : 0) * flare + extra;
        const rz = Math.max(sec.rz, y < m.hipY ? hip.rz : 0) * flare + extra;
        return { y, rx, rz, cz: sec.cz, v: rows.skirt!(y) };
      };
      pb.loft({
        sides: 6,
        turns: [0.5 + gap, 1.5 - gap],
        uCols: Array.from(
          { length: 7 },
          (_, j) => gap + ((1 - 2 * gap) * j) / 6,
        ),
        band: ATLAS.skirt,
        rings: [
          ringAt(hem, 0.03 * s, 1.08),
          ringAt(m.hipY, 0.014 * s, 1),
          ringAt(top, 0.01 * s, 1),
        ],
        lining: ATLAS.lining,
      });
    }
    if (guard) {
      const hip = trunk(m.hipY + 0.02 * m.height);
      const w = hip.rx;
      const yb = rows.beltY;
      if (guard.beltGear !== "torch") {
        pb.box(
          { x: w * 0.9 - 0.012 * s, y: yb - 0.1 * s, z: -0.035 * s },
          { x: w * 0.9 + 0.03 * s, y: yb + 0.012 * s, z: 0.025 * s },
          ATLAS.gear,
        );
      }
      if (guard.beltGear !== "radio") {
        pb.box(
          { x: -w * 0.92 - 0.028 * s, y: yb - 0.15 * s, z: -0.02 * s },
          { x: -w * 0.92 + 0.002 * s, y: yb + 0.02 * s, z: 0.014 * s },
          ATLAS.gearDark,
        );
      }
    }
    finish(BONE.pelvis, pb);
  }

  // --- Chest (waist to the shoulders) ---------------------------------------
  {
    const pb = new PartBuilder();
    const tuck = 0.93;
    pb.loft({
      sides: 8,
      band: ATLAS.torso,
      rings: [
        trunkRing(m.waistY - 0.03 * m.height, tuck),
        trunkRing(m.chestY),
        trunkRing(m.shoulderY - 0.12 * s),
        trunkRing(m.shoulderY - 0.01 * s),
        trunkRing(m.shoulderY + 0.022 * s),
      ],
      bottom: { kind: "flat", swatch: ATLAS.trouser },
      top: {
        kind: "pole",
        y: m.shoulderY + 0.045 * s,
        v: ATLAS.torso.y,
        cz: trunk(m.shoulderY).cz,
      },
    });
    const waist = trunk(m.waistY);
    finish(BONE.chest, pb, [
      {
        points: ringPoints(
          0,
          m.waistY,
          { ...waist, rx: waist.rx * tuck, rz: waist.rz * tuck },
          8,
        ),
        inside: [BONE.pelvis],
      },
    ]);
  }

  // --- Neck ------------------------------------------------------------------
  {
    const pb = new PartBuilder();
    const r = 0.056 * s * (1 + 0.15 * spec.build) * (m.softness ? 0.87 : 1);
    const cz = 0.006 * s;
    const sec: Section = { rx: r, rz: r * 1.05, cz };
    const neckRow = (y: number): number =>
      ATLAS.neck.y +
      ((head.y(0.3) - y) / (head.y(0.3) - (m.shoulderY - 0.02 * s))) *
        ATLAS.neck.h;
    const yBottom = m.shoulderY - 0.035 * s;
    const yTop = head.y(0.42);
    pb.loft({
      sides: 6,
      band: ATLAS.neck,
      rings: [
        { y: yBottom, ...sec, v: neckRow(yBottom) },
        { y: yTop, ...sec, rx: r * 0.95, rz: r * 0.95, v: neckRow(yTop) },
      ],
      // Both ends are buried in the chest and the head: no caps needed.
      bottom: { kind: "none" },
      top: { kind: "none" },
    });
    finish(BONE.neck, pb, [
      {
        points: ringPoints(0, m.shoulderY + 0.01 * s, sec, 6),
        inside: [BONE.chest],
      },
      {
        points: ringPoints(0, head.y(0.34), sec, 6, 0.95),
        inside: [BONE.head, BONE.jaw],
      },
    ]);
  }

  // --- Head ------------------------------------------------------------------
  const headRing = (f: number, v: number): Ring => {
    const sec = head.at(f);
    return { y: head.y(f), rx: sec.rx, rz: sec.rz, cz: sec.cz, v };
  };
  /** Atlas u on the face for a point x metres right of centre at height f. */
  const faceU = (x: number, f: number): number => {
    const half = head.at(f).rx * Math.SQRT1_2;
    // The front two segments span 12 px each either side of column 32;
    // the character's right (+x) is towards smaller u.
    return 32 - (x / half) * 12;
  };
  {
    const pb = new PartBuilder();
    pb.loft({
      sides: 8,
      band: ATLAS.head,
      uCols: HEAD_COLUMNS.map((c) => c / 64),
      rings: [
        headRing(HEAD_LEVELS.mouth, HEAD_ROWS.mouth),
        headRing(HEAD_LEVELS.nose, HEAD_ROWS.nose),
        headRing(HEAD_LEVELS.eyes, HEAD_ROWS.eyes),
        headRing(HEAD_LEVELS.forehead, HEAD_ROWS.forehead),
        headRing(HEAD_LEVELS.crown, HEAD_ROWS.crown),
      ],
      bottom: { kind: "flat", swatch: ATLAS.mouth },
      top: { kind: "pole", y: head.y(1), v: HEAD_ROWS.apex, cz: head.at(1).cz },
    });

    // Nose: a small pyramid on the front of the face.
    const front = (f: number): number => head.at(f).cz - head.at(f).rz;
    const hl = head.hl;
    const nose = (x: number, f: number, dz: number): Vec3 => ({
      x,
      y: head.y(f),
      z: front(f) + dz,
    });
    const T = nose(0, 0.6, 0.012 * hl);
    const P = nose(0, 0.425, -0.075 * hl);
    const L = nose(-0.06 * hl, 0.385, 0.01 * hl);
    const R = nose(0.06 * hl, 0.385, 0.01 * hl);
    const ng = pb.newGroup();
    const nv = (p: Vec3, f: number): number =>
      pb.vertex(p, faceU(p.x, f), headRow(f), ng);
    const t = nv(T, 0.6);
    const pt = nv(P, 0.43);
    const l = nv(L, 0.385);
    const rr = nv(R, 0.385);
    // Character's right is +x; the viewer sees it on their left.
    pb.triangle(t, rr, pt); // right side of the nose
    pb.triangle(t, pt, l); // left side
    pb.triangle(l, pt, rr); // underside
    pb.triangle(t, l, rr); // back, inside the head
    pb.endPiece(true);

    // Ears: flat cards on both sides, painted where the head band has ears.
    for (const side of [1, -1]) {
      const g1 = pb.newGroup();
      const g2 = pb.newGroup();
      const at = (f: number, back: number, out: number): Vec3 => {
        const sec = head.at(f);
        return {
          x: side * (sec.rx * 0.97 + out * hl),
          y: head.y(f),
          z: sec.cz + back * hl,
        };
      };
      const corners = [
        at(0.41, 0.02, 0.0),
        at(0.42, 0.13, 0.035),
        at(0.62, 0.15, 0.045),
        at(0.63, 0.02, 0.0),
      ];
      const earU = side > 0 ? 12 : 52;
      const uv = [
        [earU - 3 * side, headRow(0.41)],
        [earU + 3 * side, headRow(0.42)],
        [earU + 3 * side, headRow(0.62)],
        [earU - 3 * side, headRow(0.63)],
      ];
      const outer = corners.map((p, k) => pb.vertex(p, uv[k][0], uv[k][1], g1));
      const inner = corners.map((p, k) => pb.vertex(p, uv[k][0], uv[k][1], g2));
      if (side > 0) {
        pb.triangle(outer[0], outer[1], outer[2]);
        pb.triangle(outer[0], outer[2], outer[3]);
        pb.triangle(inner[0], inner[2], inner[1]);
        pb.triangle(inner[0], inner[3], inner[2]);
      } else {
        pb.triangle(outer[0], outer[2], outer[1]);
        pb.triangle(outer[0], outer[3], outer[2]);
        pb.triangle(inner[0], inner[1], inner[2]);
        pb.triangle(inner[0], inner[2], inner[3]);
      }
      pb.endPiece(false);
    }

    // Hair volume at the back of the head.
    const back = (f: number): number => head.at(f).cz + head.at(f).rz;
    if (spec.hair.style === "tied_back") {
      const z = back(0.62) + 0.03 * hl;
      pb.loft({
        sides: 4,
        band: ATLAS.hairPiece,
        rings: [
          {
            y: head.y(0.16),
            rx: 0.03 * hl,
            rz: 0.03 * hl,
            cz: z + 0.03 * hl,
            v: 126,
          },
          {
            y: head.y(0.42),
            rx: 0.05 * hl,
            rz: 0.045 * hl,
            cz: z + 0.015 * hl,
            v: 119,
          },
          { y: head.y(0.62), rx: 0.06 * hl, rz: 0.055 * hl, cz: z, v: 114 },
        ],
        bottom: { kind: "pole", y: head.y(0.08), v: 128, cz: z + 0.035 * hl },
        top: { kind: "pole", y: head.y(0.7), v: 112, cz: z - 0.02 * hl },
      });
    } else if (spec.hair.style === "long") {
      const sec = (f: number, w: number, d: number, inset: number): Ring => ({
        y: head.y(f),
        rx: head.at(Math.max(0.4, f)).rx * w,
        rz: d * hl,
        cz: back(Math.max(0.3, f)) - inset * hl,
        v: 112 + (1 - (f + 0.1) / 1.0) * 16,
      });
      pb.loft({
        sides: 4,
        band: ATLAS.hairPiece,
        rings: [
          sec(-0.08, 0.98, 0.07, 0.04),
          sec(0.35, 1.06, 0.11, 0.06),
          sec(0.8, 1.04, 0.12, 0.09),
        ],
        bottom: {
          kind: "pole",
          y: head.y(-0.12),
          v: 128,
          cz: back(0.3) - 0.03 * hl,
        },
        top: {
          kind: "pole",
          y: head.y(0.93),
          v: 112,
          cz: back(0.8) - 0.1 * hl,
        },
      });
    }

    // The guard's cap: a soft crown and a short brim.
    if (guard?.cap) {
      // A soft crown with straight-ish sides, sitting low on the brow.
      const f0 = 0.76;
      const c0 = head.at(f0);
      pb.loft({
        sides: 8,
        band: ATLAS.cap,
        rings: [
          {
            y: head.y(f0),
            rx: c0.rx * 1.08,
            rz: c0.rz * 1.07,
            cz: c0.cz,
            v: 79,
          },
          {
            y: head.y(0.96),
            rx: c0.rx * 0.98,
            rz: c0.rz * 0.98,
            cz: c0.cz + 0.01 * head.hl,
            v: 69,
          },
        ],
        top: {
          kind: "pole",
          y: head.y(1) + 0.015,
          v: 64,
          cz: c0.cz + 0.01 * head.hl,
        },
        bottom: { kind: "none" },
      });
      const z = c0.cz - c0.rz * 1.07;
      pb.box(
        { x: -c0.rx * 0.8, y: head.y(f0) - 0.006, z: z - 0.15 * head.hl },
        { x: c0.rx * 0.8, y: head.y(f0) + 0.004, z: z + 0.06 * head.hl },
        ATLAS.capBrim,
      );
    }
    finish(BONE.head, pb);
  }

  // --- Jaw -------------------------------------------------------------------
  {
    const pb = new PartBuilder();
    pb.loft({
      sides: 8,
      band: ATLAS.jaw,
      uCols: HEAD_COLUMNS.map((c) => c / 64),
      rings: [
        headRing(HEAD_LEVELS.chin, HEAD_ROWS.chin),
        headRing(HEAD_LEVELS.chinFront, HEAD_ROWS.chinFront),
        headRing(HEAD_LEVELS.mouth, HEAD_ROWS.mouth),
      ],
      bottom: { kind: "flat", swatch: ATLAS.skin },
      top: { kind: "flat", swatch: ATLAS.mouth },
    });
    finish(BONE.jaw, pb);
  }

  // --- Arms (built on the right, mirrored for the left) ----------------------
  const sleeve = scientist
    ? 0.007 * s
    : guard && !guard.sleevesRolled
      ? 0.003 * s
      : 0;
  const L = m.limb * s;
  for (const side of ["r", "l"] as const) {
    const upper = side === "r" ? BONE.upperarm_r : BONE.upperarm_l;
    const fore = side === "r" ? BONE.forearm_r : BONE.forearm_l;
    const hand = side === "r" ? BONE.hand_r : BONE.hand_l;
    const shoulder = bind[BONE.upperarm_r];
    const x = shoulder.x;
    const z = shoulder.z;
    const sy = shoulder.y;
    const U = m.upperArm;
    const F = m.forearm;
    const ring = (
      dy: number,
      rx: number,
      rz: number,
      extra = sleeve,
    ): Ring => ({
      y: sy - dy,
      rx: rx * L + extra,
      rz: rz * L + extra,
      cx: x,
      cz: z,
      v: rows.arm(dy),
    });
    // Upper arm.
    {
      const pb = new PartBuilder();
      pb.loft({
        sides: 6,
        band: ATLAS.arm,
        // A round elbow: the forearm turns inside it without opening a gap.
        rings: [
          ring(U + 0.036 * s, 0.028, 0.03),
          ring(U + 0.02 * s, 0.04, 0.042),
          ring(U, 0.043, 0.045),
          ring(0, 0.05, 0.054),
        ],
        bottom: {
          kind: "pole",
          y: sy - U - 0.052 * s,
          v: rows.arm(U + 0.052 * s),
          cx: x,
          cz: z,
        },
        top: {
          kind: "pole",
          y: sy + 0.056 * s,
          v: rows.arm(-0.056 * s),
          cx: x,
          cz: z,
        },
      });
      // The core of the shoulder ball stays inside the squared shoulder.
      const seam = ringPoints(
        x,
        sy,
        { rx: 0.026 * L, rz: 0.028 * L, cz: z },
        6,
      );
      if (side === "l") {
        pb.mirrorX();
      }
      finish(upper, pb, [
        {
          points: side === "l" ? seam.map((p) => ({ ...p, x: -p.x })) : seam,
          inside: [BONE.chest],
        },
      ]);
    }
    // Forearm.
    {
      const pb = new PartBuilder();
      const cuff = scientist ? 0.004 * s : 0;
      pb.loft({
        sides: 6,
        band: ATLAS.arm,
        rings: [
          ring(U + F, 0.028, 0.031, sleeve + cuff),
          ring(U + F * 0.32, 0.038, 0.04),
          ring(U, 0.036, 0.037),
        ],
        bottom: {
          kind: "pole",
          y: sy - U - F - 0.034 * s,
          v: rows.arm(U + F + 0.034 * s),
          cx: x,
          cz: z,
        },
        top: {
          kind: "pole",
          y: sy - U + 0.022 * s,
          v: rows.arm(U - 0.022 * s),
          cx: x,
          cz: z,
        },
      });
      const seam = ringPoints(
        x,
        sy - U,
        { rx: 0.034 * L + sleeve, rz: 0.036 * L + sleeve, cz: z },
        6,
      );
      if (side === "l") {
        pb.mirrorX();
      }
      finish(fore, pb, [
        {
          points: side === "l" ? seam.map((p) => ({ ...p, x: -p.x })) : seam,
          inside: [upper],
        },
      ]);
    }
    // Hand: a mitten with a thumb block, palm facing the thigh.
    {
      const pb = new PartBuilder();
      const wy = sy - U - F;
      const h = m.hand;
      const hs = s * (1 + 0.1 * spec.build);
      const hring = (d: number, rx: number, rz: number, v: number): Ring => ({
        y: wy - d,
        rx: rx * hs,
        rz: rz * hs,
        cx: x - 0.003 * s,
        cz: z,
        v,
      });
      const band = { x: ATLAS.hand.x, w: ATLAS.hand.w };
      pb.loft({
        sides: 5,
        band,
        rings: [
          hring(h * 0.7, 0.016, 0.041, 76),
          hring(h * 0.36, 0.021, 0.045, 71),
          hring(0, 0.021, 0.029, 65),
        ],
        bottom: {
          kind: "pole",
          y: wy - h,
          v: 80,
          cx: x - 0.004 * s,
          cz: z - 0.004 * s,
        },
        top: { kind: "pole", y: wy + 0.025 * s, v: 64, cx: x, cz: z },
      });
      // Thumb on the front edge, towards the palm.
      pb.box(
        { x: x - 0.02 * hs, y: wy - h * 0.55, z: z - 0.058 * hs },
        { x: x + 0.002 * hs, y: wy - h * 0.12, z: z - 0.03 * hs },
        { x: ATLAS.hand.x + 2, y: ATLAS.hand.y + 6, w: 4, h: 6 },
      );
      const seam = ringPoints(
        x,
        wy,
        { rx: 0.019 * hs, rz: 0.027 * hs, cz: z },
        6,
      );
      if (side === "l") {
        pb.mirrorX();
      }
      finish(hand, pb, [
        {
          points: side === "l" ? seam.map((p) => ({ ...p, x: -p.x })) : seam,
          inside: [fore],
        },
      ]);
    }
  }

  // --- Legs -------------------------------------------------------------------
  const thighLen = m.hipY - m.kneeY;
  const shinLen = m.kneeY - m.ankleY;
  const legG = s * (1 + 0.3 * spec.build) * (m.softness ? 1.05 : 1);
  const boots = guard !== null;
  for (const side of ["r", "l"] as const) {
    const thigh = side === "r" ? BONE.thigh_r : BONE.thigh_l;
    const shin = side === "r" ? BONE.shin_r : BONE.shin_l;
    const foot = side === "r" ? BONE.foot_r : BONE.foot_l;
    const hip = bind[BONE.thigh_r];
    const x = hip.x;
    const ring = (
      d: number,
      rx: number,
      rz: number,
      cz = 0,
      g = legG,
    ): Ring => ({
      y: hip.y - d,
      rx: rx * g,
      rz: rz * g,
      cx: x,
      cz,
      v: rows.leg(d),
    });
    {
      const pb = new PartBuilder();
      pb.loft({
        sides: 6,
        band: ATLAS.leg,
        // A round knee end that the shin turns inside.
        rings: [
          ring(thighLen + 0.044 * s, 0.04, 0.042),
          ring(thighLen + 0.022 * s, 0.053, 0.055),
          ring(thighLen, 0.056, 0.059),
          ring(0, 0.082, 0.086),
        ],
        bottom: {
          kind: "pole",
          y: m.kneeY - 0.066 * s,
          v: rows.leg(thighLen + 0.066 * s),
          cx: x,
        },
        top: {
          kind: "pole",
          y: hip.y + 0.08 * s,
          v: rows.leg(-0.08 * s),
          cx: x,
        },
      });
      const seam = ringPoints(
        x,
        hip.y,
        { rx: 0.072 * legG, rz: 0.076 * legG, cz: 0 },
        6,
      );
      if (side === "l") {
        pb.mirrorX();
      }
      finish(thigh, pb, [
        {
          points: side === "l" ? seam.map((p) => ({ ...p, x: -p.x })) : seam,
          inside: [BONE.pelvis],
        },
      ]);
    }
    {
      const pb = new PartBuilder();
      const d0 = thighLen;
      const bootPad = boots ? 0.006 * s : 0;
      // Ankles barely thicken with build (calves do).
      const ankleG = s * (1 + 0.1 * spec.build);
      pb.loft({
        sides: 6,
        band: ATLAS.leg,
        rings: [
          ring(d0 + shinLen + 0.022 * s, 0.03, 0.032, 0, ankleG),
          ring(
            d0 + shinLen,
            0.036 + bootPad / ankleG,
            0.04 + bootPad / ankleG,
            0,
            ankleG,
          ),
          ring(d0 + 0.12 * s, 0.054, 0.06, 0.008 * s),
          ring(d0, 0.051, 0.054),
        ],
        bottom: {
          kind: "pole",
          y: m.ankleY - 0.038 * s,
          v: rows.leg(d0 + shinLen + 0.038 * s),
          cx: x,
        },
        top: {
          kind: "pole",
          y: m.kneeY + 0.034 * s,
          v: rows.leg(d0 - 0.034 * s),
          cx: x,
        },
      });
      const knee = ringPoints(
        x,
        m.kneeY,
        { rx: 0.046 * legG, rz: 0.048 * legG, cz: 0 },
        6,
      );
      const ankle = ringPoints(
        x,
        m.ankleY,
        { rx: 0.03 * ankleG, rz: 0.032 * ankleG, cz: 0 },
        6,
      );
      const flip = (pts: Vec3[]): Vec3[] =>
        side === "l" ? pts.map((p) => ({ ...p, x: -p.x })) : pts;
      if (side === "l") {
        pb.mirrorX();
      }
      finish(shin, pb, [
        { points: flip(knee), inside: [thigh] },
        { points: flip(ankle), inside: [foot] },
      ]);
    }
    {
      // Shoe or boot, lofted from the heel to the toe and laid along -Z.
      const pb = new PartBuilder();
      const a = m.ankleY;
      const fz = bind[BONE.foot_r].z;
      const ay = a; // ankle height above the floor
      const fs = s * (1 + 0.05 * spec.build);
      // Canonical loft: y runs heel to toe (becomes -z), z is height (becomes y).
      const fring = (
        len: number,
        w: number,
        bottom: number,
        top: number,
        v: number,
      ): Ring => ({
        y: len,
        rx: w,
        rz: (top - bottom) / 2,
        cz: (top + bottom) / 2,
        cx: x,
        v,
      });
      // The top of the shoe rises above the ankle so the shin stays inside it.
      const shaft = boots ? 0.07 * s : 0.048 * s;
      const toLocal = (p: Vec3): Vec3 => {
        const q = alongMinusZ(p);
        return { x: q.x, y: q.y + ay, z: q.z + fz };
      };
      pb.loft({
        sides: 6,
        band: ATLAS.foot,
        rings: [
          fring(-0.062 * fs, 0.04 * fs, -ay, shaft, 89),
          fring(0.03 * fs, 0.047 * fs, -ay, boots ? 0.04 * s : 0.026 * s, 94),
          fring(0.13 * fs, 0.045 * fs, -ay, -ay + 0.055 * fs, 100),
        ],
        bottom: {
          kind: "pole",
          y: -0.08 * fs,
          v: 88,
          cx: x,
          cz: (shaft - ay) / 2,
        },
        top: {
          kind: "pole",
          y: 0.178 * fs,
          v: 104,
          cx: x,
          cz: -ay + 0.024 * fs,
        },
        transform: toLocal,
      });
      if (side === "l") {
        pb.mirrorX();
      }
      finish(foot, pb);
    }
  }
  return parts;
}

/**
 * Points on each sole (heel and toe) in the foot bone's space, for planting
 * the feet on the floor.
 */
export function solePoints(skeleton: Skeleton, spec: CharacterSpec): Vec3[] {
  const m = skeleton.metrics;
  const fs = m.scale * (1 + 0.05 * spec.build);
  return [
    { x: 0, y: -m.ankleY, z: 0.062 * fs },
    { x: 0, y: -m.ankleY, z: -0.13 * fs },
  ];
}
