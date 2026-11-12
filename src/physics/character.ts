/**
 * Collide-and-slide for an upright axis-aligned character box. Pure
 * geometry: it works on a pre-gathered list of colliders and reports what
 * it touched; the world applies pushes and the character's weight.
 */
import type { ColliderRef } from "../core/api";
import type { Body, Box } from "./body";
import { penetration, sweepBox, type SweepHit } from "./sweep";

export interface CharCollider {
  ref: ColliderRef;
  box: Box;
  /** The dynamic body behind this collider, if any. */
  body: Body | null;
}

export interface CharHit {
  collider: CharCollider;
  nx: number;
  ny: number;
  nz: number;
}

export interface CharResult {
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  gnx: number;
  gny: number;
  gnz: number;
  ground: CharCollider | null;
  hitCeiling: boolean;
  /** Everything hit while moving, in order. */
  hits: CharHit[];
}

/** Gap kept between the character and what it touches. */
export const SKIN = 0.002;
/** Overlaps shallower than this still block movement further in. */
const OVERLAP_TOLERANCE = 0.02;
/** Minimum normal Y of walkable ground (about 45 degrees). */
export const WALKABLE = 0.7;
const GROUND_PROBE = 0.02;
const MAX_BUMPS = 5;

interface Vec {
  x: number;
  y: number;
  z: number;
}

interface Found {
  hit: SweepHit;
  collider: CharCollider;
}

function sweepAll(
  colliders: readonly CharCollider[],
  p: Vec,
  he: Vec,
  dx: number,
  dy: number,
  dz: number,
): Found | null {
  let best: Found | null = null;
  for (const c of colliders) {
    const hit = sweepBox(
      p.x,
      p.y,
      p.z,
      he.x,
      he.y,
      he.z,
      dx,
      dy,
      dz,
      c.box,
      OVERLAP_TOLERANCE,
    );
    if (hit && (!best || hit.t < best.hit.t)) {
      best = { hit, collider: c };
    }
  }
  return best;
}

/** Removes the component of v going into each plane, handling creases. */
function clipToPlanes(v: Vec, planes: Vec[]): Vec {
  const last = planes[planes.length - 1];
  let out = clip(v, last);
  for (let i = 0; i < planes.length - 1; i++) {
    const p = planes[i];
    if (out.x * p.x + out.y * p.y + out.z * p.z < -1e-9) {
      // Slide along the crease between the two planes.
      let cx = last.y * p.z - last.z * p.y;
      let cy = last.z * p.x - last.x * p.z;
      let cz = last.x * p.y - last.y * p.x;
      const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (len < 1e-6) {
        out = clip(out, p);
        continue;
      }
      cx /= len;
      cy /= len;
      cz /= len;
      const d = v.x * cx + v.y * cy + v.z * cz;
      out = { x: cx * d, y: cy * d, z: cz * d };
      for (let j = 0; j < planes.length - 1; j++) {
        if (j === i) {
          continue;
        }
        const q = planes[j];
        if (out.x * q.x + out.y * q.y + out.z * q.z < -1e-9) {
          return { x: 0, y: 0, z: 0 };
        }
      }
      break;
    }
  }
  return out;
}

function clip(v: Vec, n: Vec): Vec {
  const d = v.x * n.x + v.y * n.y + v.z * n.z;
  if (d >= 0) {
    return v;
  }
  return { x: v.x - n.x * d, y: v.y - n.y * d, z: v.z - n.z * d };
}

interface SlideResult {
  pos: Vec;
  vel: Vec;
  hits: CharHit[];
  blockedSteep: boolean;
}

function slide(
  colliders: readonly CharCollider[],
  start: Vec,
  he: Vec,
  displacement: Vec,
  velocity: Vec,
  grounded: boolean,
): SlideResult {
  const pos = { ...start };
  let disp = { ...displacement };
  let vel = { ...velocity };
  const planes: Vec[] = [];
  const hits: CharHit[] = [];
  let blockedSteep = false;
  for (let bump = 0; bump < MAX_BUMPS; bump++) {
    const lenSq = disp.x * disp.x + disp.y * disp.y + disp.z * disp.z;
    if (lenSq < 1e-18) {
      break;
    }
    const found = sweepAll(colliders, pos, he, disp.x, disp.y, disp.z);
    if (!found) {
      pos.x += disp.x;
      pos.y += disp.y;
      pos.z += disp.z;
      disp = { x: 0, y: 0, z: 0 };
      break;
    }
    const { hit } = found;
    const approach = -(disp.x * hit.nx + disp.y * hit.ny + disp.z * hit.nz);
    const f = approach > 1e-12 ? Math.max(0, hit.t - SKIN / approach) : 0;
    pos.x += disp.x * f;
    pos.y += disp.y * f;
    pos.z += disp.z * f;
    disp = { x: disp.x * (1 - f), y: disp.y * (1 - f), z: disp.z * (1 - f) };
    hits.push({ collider: found.collider, nx: hit.nx, ny: hit.ny, nz: hit.nz });
    let n: Vec = { x: hit.nx, y: hit.ny, z: hit.nz };
    if (n.y < WALKABLE && n.y > -WALKABLE) {
      blockedSteep = true;
      if (grounded && n.y > 0) {
        // A steep slope acts as a wall for a grounded character.
        const h = Math.sqrt(n.x * n.x + n.z * n.z);
        if (h > 1e-6) {
          n = { x: n.x / h, y: 0, z: n.z / h };
        }
      }
    }
    planes.push(n);
    disp = clipToPlanes(disp, planes);
    vel = clipToPlanes(vel, planes);
  }
  return { pos, vel, hits, blockedSteep };
}

interface GroundProbe {
  dist: number;
  nx: number;
  ny: number;
  nz: number;
  collider: CharCollider;
}

function probeDown(
  colliders: readonly CharCollider[],
  pos: Vec,
  he: Vec,
  distance: number,
): GroundProbe | null {
  const found = sweepAll(colliders, pos, he, 0, -distance, 0);
  if (!found) {
    return null;
  }
  const { hit } = found;
  return {
    dist: hit.t * distance,
    nx: hit.nx,
    ny: hit.ny,
    nz: hit.nz,
    collider: found.collider,
  };
}

function depenetrate(
  colliders: readonly CharCollider[],
  start: Vec,
  he: Vec,
): Vec {
  const pos = { ...start };
  // Dynamic bodies first, then kinematics and statics, so world geometry
  // always has the final say.
  const ordered = [
    ...colliders.filter((c) => c.ref.kind === "body"),
    ...colliders.filter((c) => c.ref.kind === "kinematic"),
    ...colliders.filter((c) => c.ref.kind === "static"),
  ];
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const c of ordered) {
      const p = penetration(pos.x, pos.y, pos.z, he.x, he.y, he.z, c.box);
      if (p.sep < -1e-6) {
        const d = -p.sep + SKIN * 0.5;
        pos.x += p.nx * d;
        pos.y += p.ny * d;
        pos.z += p.nz * d;
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  return pos;
}

export function moveCharacterCore(
  colliders: readonly CharCollider[],
  center: Vec,
  he: Vec,
  velocity: Vec,
  dt: number,
  stepHeight: number,
): CharResult {
  const start = depenetrate(colliders, center, he);
  const startProbe = probeDown(colliders, start, he, GROUND_PROBE);
  const startGround =
    startProbe !== null && startProbe.ny >= WALKABLE && velocity.y <= 1e-6;

  const disp = { x: velocity.x * dt, y: velocity.y * dt, z: velocity.z * dt };
  let result = slide(colliders, start, he, disp, velocity, startGround);

  // Step up onto ledges no higher than stepHeight.
  if (startGround && result.blockedSteep && stepHeight > 0) {
    const stepped = stepMove(colliders, start, he, disp, velocity, stepHeight);
    if (stepped) {
      const a = Math.hypot(result.pos.x - start.x, result.pos.z - start.z);
      const b = Math.hypot(stepped.pos.x - start.x, stepped.pos.z - start.z);
      if (b > a + 1e-4) {
        result = stepped;
      }
    }
  }

  const pos = result.pos;
  let vel = result.vel;
  // Stick to the ground when walking down steps or over small bumps.
  if (startGround && velocity.y <= 1e-6) {
    const snap = probeDown(colliders, pos, he, stepHeight + SKIN * 2);
    if (snap && snap.ny >= WALKABLE && snap.dist > SKIN) {
      pos.y -= snap.dist - SKIN;
    }
  }

  const ground = probeDown(colliders, pos, he, GROUND_PROBE);
  const onGround = ground !== null && ground.ny >= WALKABLE && vel.y <= 1e-6;
  if (onGround && ground) {
    vel = clip(vel, { x: ground.nx, y: ground.ny, z: ground.nz });
  }
  let hitCeiling = false;
  for (const h of result.hits) {
    if (h.ny <= -WALKABLE) {
      hitCeiling = true;
    }
  }
  return {
    px: pos.x,
    py: pos.y,
    pz: pos.z,
    vx: vel.x,
    vy: vel.y,
    vz: vel.z,
    onGround,
    gnx: onGround && ground ? ground.nx : 0,
    gny: onGround && ground ? ground.ny : 1,
    gnz: onGround && ground ? ground.nz : 0,
    ground: onGround && ground ? ground.collider : null,
    hitCeiling,
    hits: result.hits,
  };
}

function stepMove(
  colliders: readonly CharCollider[],
  start: Vec,
  he: Vec,
  disp: Vec,
  velocity: Vec,
  stepHeight: number,
): SlideResult | null {
  const upDist = stepHeight + SKIN * 2;
  const up = sweepAll(colliders, start, he, 0, upDist, 0);
  const raise = up ? Math.max(0, up.hit.t * upDist - SKIN) : upDist;
  if (raise < 0.01) {
    return null;
  }
  const raised = { x: start.x, y: start.y + raise, z: start.z };
  const moved = slide(
    colliders,
    raised,
    he,
    { x: disp.x, y: 0, z: disp.z },
    { x: velocity.x, y: 0, z: velocity.z },
    true,
  );
  const downDist = raise + SKIN * 2;
  const down = probeDown(colliders, moved.pos, he, downDist);
  if (!down || down.ny < WALKABLE) {
    return null;
  }
  const pos = {
    x: moved.pos.x,
    y: moved.pos.y - Math.max(0, down.dist - SKIN),
    z: moved.pos.z,
  };
  return {
    pos,
    vel: { x: moved.vel.x, y: Math.min(0, velocity.y), z: moved.vel.z },
    hits: moved.hits,
    blockedSteep: moved.blockedSteep,
  };
}
