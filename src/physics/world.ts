import type {
  Aabb,
  BodyDesc,
  BodyState,
  CharacterMoveOptions,
  CharacterMoveResult,
  ColliderRef,
  ContactEvent,
  PhysicsOptions,
  PhysicsWorld,
  RayHit,
} from "../core/api";
import type { Quat, Vec3 } from "../math";
import { aabbBox, Body } from "./body";
import { type CharCollider, moveCharacterCore, WALKABLE } from "./character";
import { collideBoxes, type RawManifold } from "./collide";
import {
  applyRestitution,
  ContactPoint,
  makeSoft,
  Manifold,
  PairKind,
  prepareManifold,
  type Softness,
  solveManifold,
  warmStart,
} from "./solver";
import { StaticStore } from "./statics";

/** Sub-steps per step; each does one biased solve and one relax pass. */
const SUBSTEPS = 8;
const CONTACT_HERTZ = 60;
/** Sweeps over a manifold's normal constraints per biased / relax pass. */
const SOLVE_NORMAL_ITERATIONS = 4;
const RELAX_NORMAL_ITERATIONS = 4;
const CONTACT_DAMPING_RATIO = 10;
/** Contacts are kept up to this separation even for slow bodies. */
const SPECULATIVE_DISTANCE = 0.02;
const MAX_MARGIN = 2;
const MAX_LINEAR_SPEED = 100;
const MAX_ANGULAR_SPEED = 50;
const LINEAR_DAMPING = 0.02;
const ANGULAR_DAMPING = 0.1;
const SLEEP_VELOCITY = 0.05;
const TIME_TO_SLEEP = 0.5;
/** A kinematic moving further than this in one step is treated as a teleport. */
const KINEMATIC_TELEPORT = 1;
/** Penetration at which a kinematic pinning a body gives way (see isCrushed). */
const CRUSH_DEPTH = 0.05;
/** Friction multiplier for contacts of the body the character carries. */
const HELD_FRICTION_SCALE = 0.2;
/** Minimum impulse (N·s) for a contact event. */
const EVENT_MIN_IMPULSE = 0.1;
/** Approach speed (m/s) for an existing contact to count as a new impact. */
const EVENT_IMPACT_SPEED = 0.5;
/** Fraction of the character's weight it can push with. */
const PUSH_FORCE_FACTOR = 0.5;

interface Kinematic {
  id: number;
  minx: number;
  miny: number;
  minz: number;
  sx: number;
  sy: number;
  sz: number;
  /** Min corner at the end of the previous step. */
  pminx: number;
  pminy: number;
  pminz: number;
  proxy: Body;
}

interface CharacterObstacle {
  px: number;
  py: number;
  pz: number;
  hx: number;
  hy: number;
  hz: number;
  vx: number;
  vy: number;
  vz: number;
  ignoreBody: number;
  standingOn: number;
}

function overlaps(
  a: {
    minx: number;
    miny: number;
    minz: number;
    maxx: number;
    maxy: number;
    maxz: number;
  },
  minx: number,
  miny: number,
  minz: number,
  maxx: number,
  maxy: number,
  maxz: number,
): boolean {
  return (
    a.minx <= maxx &&
    a.maxx >= minx &&
    a.miny <= maxy &&
    a.maxy >= miny &&
    a.minz <= maxz &&
    a.maxz >= minz
  );
}

function pairKey(aId: number, otherId: number, kind: PairKind): number {
  return (aId * 2097152 + otherId) * 4 + kind;
}

/** Slab test of a ray against a centred box in its own frame. */
function raySlab(
  o: number[],
  d: number[],
  h: number[],
  maxT: number,
): { t: number; axis: number; sign: number } | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < -h[i] || o[i] > h[i]) {
        return null;
      }
      continue;
    }
    const inv = 1 / d[i];
    let t0 = (-h[i] - o[i]) * inv;
    let t1 = (h[i] - o[i]) * inv;
    let s = -1;
    if (t0 > t1) {
      const tmp = t0;
      t0 = t1;
      t1 = tmp;
      s = 1;
    }
    if (t0 > tMin) {
      tMin = t0;
      axis = i;
      sign = s;
    }
    if (t1 < tMax) {
      tMax = t1;
    }
  }
  // Misses, boxes behind the origin and boxes containing it are skipped.
  if (axis < 0 || tMin > tMax || tMin < 0 || tMin > maxT) {
    return null;
  }
  return { t: tMin, axis, sign };
}

export class World implements PhysicsWorld {
  gravity: Vec3;

  private readonly statics = new StaticStore();
  private readonly kinematics = new Map<number, Kinematic>();
  private nextKinematicId = 0;
  private readonly bodyMap = new Map<number, Body>();
  /** Bodies in id order. */
  private bodyList: Body[] = [];
  private nextBodyId = 0;
  private readonly staticProxy = new Body(-1, 0, 0, 0, 0, false);
  private readonly characterProxy = new Body(-2, 0.3, 0.9, 0.3, 0, false);
  private character: CharacterObstacle | null = null;
  private lastStandingOn = -1;
  private manifolds = new Map<number, Manifold>();
  private events: ContactEvent[] = [];
  private contactSoft: Softness = makeSoft(0, 0, 1);
  private staticSoft: Softness = makeSoft(0, 0, 1);
  private softDt = 0;
  /** Test hook: when false, islands never fall asleep. */
  allowSleep = true;

  constructor(options?: PhysicsOptions) {
    const g = options?.gravity ?? { x: 0, y: -9.81, z: 0 };
    this.gravity = { x: g.x, y: g.y, z: g.z };
    this.staticProxy.friction = 0.6;
    this.characterProxy.friction = 0.6;
  }

  // -------------------------------------------------------------------------
  // Colliders
  // -------------------------------------------------------------------------

  addStatic(box: Aabb): number {
    return this.statics.add(
      box.min.x,
      box.min.y,
      box.min.z,
      box.max.x,
      box.max.y,
      box.max.z,
    );
  }

  addKinematic(box: Aabb): number {
    const id = this.nextKinematicId++;
    const proxy = new Body(id, 0, 0, 0, 0, false);
    proxy.friction = 0.6;
    const k: Kinematic = {
      id,
      minx: box.min.x,
      miny: box.min.y,
      minz: box.min.z,
      sx: box.max.x - box.min.x,
      sy: box.max.y - box.min.y,
      sz: box.max.z - box.min.z,
      pminx: box.min.x,
      pminy: box.min.y,
      pminz: box.min.z,
      proxy,
    };
    proxy.hx = k.sx * 0.5;
    proxy.hy = k.sy * 0.5;
    proxy.hz = k.sz * 0.5;
    this.kinematics.set(id, k);
    return id;
  }

  moveKinematic(id: number, min: Vec3): void {
    const k = this.kinematics.get(id);
    if (!k) {
      return;
    }
    k.minx = min.x;
    k.miny = min.y;
    k.minz = min.z;
  }

  removeKinematic(id: number): void {
    const k = this.kinematics.get(id);
    if (!k) {
      return;
    }
    this.kinematics.delete(id);
    this.wakeInBox(
      Math.min(k.minx, k.pminx) - 0.05,
      Math.min(k.miny, k.pminy) - 0.05,
      Math.min(k.minz, k.pminz) - 0.05,
      Math.max(k.minx, k.pminx) + k.sx + 0.05,
      Math.max(k.miny, k.pminy) + k.sy + 0.05,
      Math.max(k.minz, k.pminz) + k.sz + 0.05,
    );
  }

  addBody(desc: BodyDesc): number {
    const id = this.nextBodyId++;
    const h = desc.halfExtents;
    const b = new Body(id, h.x, h.y, h.z, desc.mass, true);
    b.tag = desc.tag ?? "";
    b.friction = desc.friction ?? 0.6;
    b.restitution = desc.restitution ?? 0.1;
    b.px = desc.position.x;
    b.py = desc.position.y;
    b.pz = desc.position.z;
    const q = desc.orientation;
    if (q) {
      b.qx = q.x;
      b.qy = q.y;
      b.qz = q.z;
      b.qw = q.w;
    }
    const v = desc.linearVelocity;
    if (v) {
      b.vx = v.x;
      b.vy = v.y;
      b.vz = v.z;
    }
    const w = desc.angularVelocity;
    if (w) {
      b.wx = w.x;
      b.wy = w.y;
      b.wz = w.z;
    }
    b.updateRotation();
    b.updateBounds();
    this.bodyMap.set(id, b);
    this.bodyList.push(b);
    return id;
  }

  removeBody(id: number): void {
    const b = this.bodyMap.get(id);
    if (!b) {
      return;
    }
    this.wake(b);
    this.bodyMap.delete(id);
    this.bodyList = this.bodyList.filter((x) => x !== b);
    this.wakeInBox(
      b.minx - 0.05,
      b.miny - 0.05,
      b.minz - 0.05,
      b.maxx + 0.05,
      b.maxy + 0.05,
      b.maxz + 0.05,
    );
    if (this.lastStandingOn === id) {
      this.lastStandingOn = -1;
    }
  }

  getBody(id: number): BodyState | undefined {
    const b = this.bodyMap.get(id);
    return b ? snapshot(b) : undefined;
  }

  bodies(): readonly BodyState[] {
    return this.bodyList.map(snapshot);
  }

  setBodyVelocity(id: number, linear: Vec3, angular?: Vec3): void {
    const b = this.bodyMap.get(id);
    if (!b) {
      return;
    }
    this.wake(b);
    b.vx = linear.x;
    b.vy = linear.y;
    b.vz = linear.z;
    if (angular) {
      b.wx = angular.x;
      b.wy = angular.y;
      b.wz = angular.z;
    }
  }

  setBodyPose(id: number, position: Vec3, orientation?: Quat): void {
    const b = this.bodyMap.get(id);
    if (!b) {
      return;
    }
    this.wake(b);
    // Whatever rested on or against the old pose must react.
    this.wakeInBox(
      b.minx - 0.05,
      b.miny - 0.05,
      b.minz - 0.05,
      b.maxx + 0.05,
      b.maxy + 0.05,
      b.maxz + 0.05,
    );
    b.px = position.x;
    b.py = position.y;
    b.pz = position.z;
    if (orientation) {
      b.qx = orientation.x;
      b.qy = orientation.y;
      b.qz = orientation.z;
      b.qw = orientation.w;
    }
    b.updateRotation();
    b.updateBounds();
  }

  applyImpulse(id: number, impulse: Vec3, worldPoint?: Vec3): void {
    const b = this.bodyMap.get(id);
    if (!b) {
      return;
    }
    this.wake(b);
    const p = worldPoint ?? { x: b.px, y: b.py, z: b.pz };
    b.applyImpulseAt(
      impulse.x,
      impulse.y,
      impulse.z,
      p.x - b.px,
      p.y - b.py,
      p.z - b.pz,
    );
  }

  drainContacts(): ContactEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // -------------------------------------------------------------------------
  // Sleeping
  // -------------------------------------------------------------------------

  private wake(b: Body): void {
    if (b.asleep && b.island) {
      for (const m of b.island) {
        m.asleep = false;
        m.sleepTime = 0;
        m.island = null;
      }
    }
    b.asleep = false;
    b.island = null;
    b.sleepTime = 0;
  }

  private wakeInBox(
    minx: number,
    miny: number,
    minz: number,
    maxx: number,
    maxy: number,
    maxz: number,
  ): void {
    for (const b of this.bodyList) {
      if (overlaps(b, minx, miny, minz, maxx, maxy, maxz)) {
        this.wake(b);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  step(dt: number): void {
    if (!(dt > 0)) {
      return;
    }
    const h = dt / SUBSTEPS;
    const invH = 1 / h;
    const g = this.gravity;
    if (dt !== this.softDt) {
      this.softDt = dt;
      this.contactSoft = makeSoft(CONTACT_HERTZ, CONTACT_DAMPING_RATIO, h);
      this.staticSoft = makeSoft(2 * CONTACT_HERTZ, CONTACT_DAMPING_RATIO, h);
    }

    // Kinematics: velocity from the motion since the last step. Contacts
    // see the box at its previous position moving with that velocity.
    const movingKinematics: Kinematic[] = [];
    for (const k of this.kinematics.values()) {
      let vx = (k.minx - k.pminx) / dt;
      let vy = (k.miny - k.pminy) / dt;
      let vz = (k.minz - k.pminz) / dt;
      if (Math.hypot(vx, vy, vz) * dt > KINEMATIC_TELEPORT) {
        k.pminx = k.minx;
        k.pminy = k.miny;
        k.pminz = k.minz;
        vx = 0;
        vy = 0;
        vz = 0;
      }
      const p = k.proxy;
      p.px = k.pminx + k.sx * 0.5;
      p.py = k.pminy + k.sy * 0.5;
      p.pz = k.pminz + k.sz * 0.5;
      p.vx = vx;
      p.vy = vy;
      p.vz = vz;
      p.beginStep();
      p.minx = Math.min(k.pminx, k.minx);
      p.miny = Math.min(k.pminy, k.miny);
      p.minz = Math.min(k.pminz, k.minz);
      p.maxx = Math.max(k.pminx, k.minx) + k.sx;
      p.maxy = Math.max(k.pminy, k.miny) + k.sy;
      p.maxz = Math.max(k.pminz, k.minz) + k.sz;
      p.margin = Math.hypot(vx, vy, vz) * dt;
      if (vx !== 0 || vy !== 0 || vz !== 0) {
        movingKinematics.push(k);
        this.wakeInBox(
          p.minx - 0.05,
          p.miny - 0.05,
          p.minz - 0.05,
          p.maxx + 0.05,
          p.maxy + 0.05,
          p.maxz + 0.05,
        );
      }
    }

    const ch = this.character;
    const cp = this.characterProxy;
    if (ch) {
      cp.px = ch.px;
      cp.py = ch.py;
      cp.pz = ch.pz;
      cp.hx = ch.hx;
      cp.hy = ch.hy;
      cp.hz = ch.hz;
      cp.vx = ch.vx;
      cp.vy = ch.vy;
      cp.vz = ch.vz;
      cp.beginStep();
      const m = Math.hypot(ch.vx, ch.vy, ch.vz) * dt;
      cp.minx = ch.px - ch.hx - m;
      cp.miny = ch.py - ch.hy - m;
      cp.minz = ch.pz - ch.hz - m;
      cp.maxx = ch.px + ch.hx + m;
      cp.maxy = ch.py + ch.hy + m;
      cp.maxz = ch.pz + ch.hz + m;
      cp.margin = m;
    }

    // Awake bodies, their speculative margins, and wake-ups by proximity.
    const setMargin = (b: Body): void => {
      const lin = Math.hypot(b.vx, b.vy, b.vz);
      const ang = Math.hypot(b.wx, b.wy, b.wz);
      b.margin = Math.min(
        MAX_MARGIN,
        SPECULATIVE_DISTANCE + (lin + ang * b.radius) * dt,
      );
    };
    const pending: Body[] = [];
    for (const b of this.bodyList) {
      if (!b.asleep) {
        setMargin(b);
        pending.push(b);
      }
    }
    // Only bodies that are actually moving wake sleeping neighbours. A slow
    // awake body next to a sleeping one simply collides with it as if it
    // were immovable; waking on mere proximity would let two adjacent,
    // non-touching islands keep waking each other forever.
    for (let i = 0; i < pending.length; i++) {
      const a = pending[i];
      if (sleepVelocity(a) <= SLEEP_VELOCITY) {
        continue;
      }
      const m = a.margin + SPECULATIVE_DISTANCE;
      for (const s of this.bodyList) {
        if (
          s.asleep &&
          overlaps(
            s,
            a.minx - m,
            a.miny - m,
            a.minz - m,
            a.maxx + m,
            a.maxy + m,
            a.maxz + m,
          )
        ) {
          const group = s.island ?? [s];
          this.wake(s);
          for (const w of group) {
            setMargin(w);
            pending.push(w);
          }
        }
      }
    }
    const awake = this.bodyList.filter((b) => !b.asleep);

    // Collision detection.
    const previous = this.manifolds;
    const byKind: Manifold[][] = [[], [], [], []];
    for (const a of awake) {
      const m = a.margin;
      for (const s of this.statics.query(
        a.minx - m,
        a.miny - m,
        a.minz - m,
        a.maxx + m,
        a.maxy + m,
        a.maxz + m,
      )) {
        const raw = collideBoxes(a, s.box, m, s.blocked);
        if (raw) {
          byKind[PairKind.Static].push(
            this.makeManifold(
              a,
              this.staticProxy,
              PairKind.Static,
              s.id,
              raw,
              previous,
            ),
          );
        }
      }
      for (const k of this.kinematics.values()) {
        const p = k.proxy;
        if (
          !overlaps(
            p,
            a.minx - m,
            a.miny - m,
            a.minz - m,
            a.maxx + m,
            a.maxy + m,
            a.maxz + m,
          )
        ) {
          continue;
        }
        const raw = collideBoxes(a, p, m + p.margin);
        if (raw) {
          byKind[PairKind.Kinematic].push(
            this.makeManifold(a, p, PairKind.Kinematic, k.id, raw, previous),
          );
        }
      }
      if (
        ch &&
        a.id !== ch.ignoreBody &&
        a.id !== ch.standingOn &&
        overlaps(
          cp,
          a.minx - m,
          a.miny - m,
          a.minz - m,
          a.maxx + m,
          a.maxy + m,
          a.maxz + m,
        )
      ) {
        const raw = collideBoxes(a, cp, m + cp.margin);
        // Bodies under the character carry its weight instead.
        if (raw && raw.ny <= WALKABLE) {
          byKind[PairKind.Character].push(
            this.makeManifold(a, cp, PairKind.Character, 0, raw, previous),
          );
        }
      }
    }
    // Body pairs with at least one awake body; a sleeping partner is
    // immovable in the solver.
    const list = this.bodyList;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const ma = a.asleep ? 0 : a.margin;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (a.asleep && b.asleep) {
          continue;
        }
        const m = ma + (b.asleep ? 0 : b.margin);
        if (
          !overlaps(
            b,
            a.minx - m,
            a.miny - m,
            a.minz - m,
            a.maxx + m,
            a.maxy + m,
            a.maxz + m,
          )
        ) {
          continue;
        }
        const raw = collideBoxes(a, b, m);
        if (raw) {
          byKind[PairKind.Body].push(
            this.makeManifold(a, b, PairKind.Body, b.id, raw, previous),
          );
        }
      }
    }
    byKind[PairKind.Kinematic] = byKind[PairKind.Kinematic].filter(
      (k) => !this.isCrushed(k, byKind),
    );
    const all = ([] as Manifold[]).concat(...byKind);

    // Solve.
    for (const b of awake) {
      b.beginStep();
    }
    for (const m of all) {
      prepareManifold(m);
    }
    const kinematicList = [...this.kinematics.values()];
    const linDamp = 1 / (1 + h * LINEAR_DAMPING);
    const angDamp = 1 / (1 + h * ANGULAR_DAMPING);
    for (let sub = 0; sub < SUBSTEPS; sub++) {
      for (const b of awake) {
        const im = b.invMass;
        b.vx = (b.vx + h * (g.x + b.fx * im)) * linDamp;
        b.vy = (b.vy + h * (g.y + b.fy * im)) * linDamp;
        b.vz = (b.vz + h * (g.z + b.fz * im)) * linDamp;
        const ii = b.ii;
        b.wx =
          (b.wx + h * (ii[0] * b.tx + ii[1] * b.ty + ii[2] * b.tz)) * angDamp;
        b.wy =
          (b.wy + h * (ii[3] * b.tx + ii[4] * b.ty + ii[5] * b.tz)) * angDamp;
        b.wz =
          (b.wz + h * (ii[6] * b.tx + ii[7] * b.ty + ii[8] * b.tz)) * angDamp;
      }
      for (const m of all) {
        warmStart(m);
      }
      for (const m of all) {
        solveManifold(
          m,
          m.rigidB ? this.staticSoft : this.contactSoft,
          true,
          invH,
          SOLVE_NORMAL_ITERATIONS,
        );
      }
      for (const b of awake) {
        clampVelocity(b);
        b.px += h * b.vx;
        b.py += h * b.vy;
        b.pz += h * b.vz;
        b.dpx += h * b.vx;
        b.dpy += h * b.vy;
        b.dpz += h * b.vz;
        const hw = 0.5 * h;
        const wx = b.wx * hw;
        const wy = b.wy * hw;
        const wz = b.wz * hw;
        const qx = b.qx;
        const qy = b.qy;
        const qz = b.qz;
        const qw = b.qw;
        b.qx = qx + wx * qw + wy * qz - wz * qy;
        b.qy = qy - wx * qz + wy * qw + wz * qx;
        b.qz = qz + wx * qy - wy * qx + wz * qw;
        b.qw = qw - wx * qx - wy * qy - wz * qz;
        b.updateRotation();
        b.updateDeltaRotation();
      }
      for (const k of kinematicList) {
        const p = k.proxy;
        p.dpx += h * p.vx;
        p.dpy += h * p.vy;
        p.dpz += h * p.vz;
      }
      if (ch) {
        cp.dpx += h * cp.vx;
        cp.dpy += h * cp.vy;
        cp.dpz += h * cp.vz;
      }
      for (const m of all) {
        solveManifold(
          m,
          m.rigidB ? this.staticSoft : this.contactSoft,
          false,
          invH,
          RELAX_NORMAL_ITERATIONS,
        );
      }
      for (const m of all) {
        for (const c of m.points) {
          c.totalImpulse += c.normalImpulse;
        }
      }
    }
    for (const m of all) {
      applyRestitution(m);
    }
    for (const b of awake) {
      clampVelocity(b);
      b.updateBounds();
    }

    // Events and persistence.
    const next = new Map<number, Manifold>();
    for (const m of all) {
      let total = 0;
      let approach = 0;
      let wx = 0;
      let wy = 0;
      let wz = 0;
      for (const c of m.points) {
        total += c.totalImpulse;
        approach = Math.max(approach, -c.relativeVelocity);
        wx += c.px * c.totalImpulse;
        wy += c.py * c.totalImpulse;
        wz += c.pz * c.totalImpulse;
      }
      m.total = total;
      next.set(m.key, m);
      if (m.kind === PairKind.Character) {
        continue;
      }
      const old = previous.get(m.key);
      if (old?.pending) {
        // An impact often spans two steps (the speculative contact catches
        // the first part): report it once with the combined impulse.
        const event = old.pending;
        if (total > event.impulse) {
          event.point = { x: wx / total, y: wy / total, z: wz / total };
        }
        event.impulse += total;
        this.events.push(event);
        continue;
      }
      if (total < EVENT_MIN_IMPULSE) {
        continue;
      }
      const prevTotal = old ? old.total : 0;
      const isNew = prevTotal <= 0;
      const isImpact =
        approach > EVENT_IMPACT_SPEED &&
        total > 2 * prevTotal + EVENT_MIN_IMPULSE;
      if (isNew || isImpact) {
        const kind =
          m.kind === PairKind.Static
            ? "static"
            : m.kind === PairKind.Kinematic
              ? "kinematic"
              : "body";
        m.pending = {
          a: { kind: "body", id: m.a.id },
          b: { kind, id: m.otherId },
          point: { x: wx / total, y: wy / total, z: wz / total },
          normal: { x: m.nx, y: m.ny, z: m.nz },
          impulse: total,
        };
      }
    }
    // Impacts whose contact ended right away.
    for (const [key, m] of previous) {
      if (m.pending && !next.has(key)) {
        this.events.push(m.pending);
      }
      m.pending = null;
    }
    // Keep the contact memory of sleeping bodies so waking them is quiet.
    for (const [key, m] of previous) {
      if (
        !next.has(key) &&
        m.a.asleep &&
        this.bodyMap.has(m.a.id) &&
        (m.kind !== PairKind.Body || (m.b.asleep && this.bodyMap.has(m.b.id)))
      ) {
        next.set(key, m);
      }
    }
    this.manifolds = next;

    this.updateSleep(
      awake,
      byKind[PairKind.Body],
      byKind[PairKind.Kinematic],
      dt,
    );

    for (const b of this.bodyList) {
      b.fx = 0;
      b.fy = 0;
      b.fz = 0;
      b.tx = 0;
      b.ty = 0;
      b.tz = 0;
    }
    for (const k of this.kinematics.values()) {
      k.pminx = k.minx;
      k.pminy = k.miny;
      k.pminz = k.minz;
    }
    this.character = null;
  }

  /**
   * A kinematic contact is "crushing" when it is already deep and the body
   * is pinned by another immovable collider on the opposite side. Such a
   * contact cannot be satisfied; dropping it lets the kinematic pass
   * through the body instead of squeezing it into a wall or launching it.
   */
  private isCrushed(k: Manifold, byKind: Manifold[][]): boolean {
    let deepest = 0;
    for (const c of k.points) {
      deepest = Math.min(deepest, c.sep);
    }
    if (deepest > -CRUSH_DEPTH) {
      return false;
    }
    const opposing = (m: Manifold): boolean =>
      m !== k &&
      m.a === k.a &&
      m.nx * k.nx + m.ny * k.ny + m.nz * k.nz < -0.5 &&
      m.points.some((c) => c.sep < 0.01);
    return (
      byKind[PairKind.Static].some(opposing) ||
      byKind[PairKind.Kinematic].some(opposing)
    );
  }

  private makeManifold(
    a: Body,
    b: Body,
    kind: PairKind,
    otherId: number,
    raw: RawManifold,
    previous: Map<number, Manifold>,
  ): Manifold {
    const key = pairKey(a.id, otherId, kind);
    const m = new Manifold(key, a, b, kind, otherId);
    const nx = raw.nx;
    const ny = raw.ny;
    const nz = raw.nz;
    m.nx = nx;
    m.ny = ny;
    m.nz = nz;
    const old = previous.get(key);
    // Tangent basis: reuse last frame's when possible so friction warm
    // starting stays consistent.
    let tx = 0;
    let ty = 0;
    let tz = 0;
    if (old) {
      const d = old.t1x * nx + old.t1y * ny + old.t1z * nz;
      tx = old.t1x - nx * d;
      ty = old.t1y - ny * d;
      tz = old.t1z - nz * d;
    }
    let len = Math.hypot(tx, ty, tz);
    if (len < 0.5) {
      if (Math.abs(nx) < 0.57) {
        // cross(n, x)
        tx = 0;
        ty = nz;
        tz = -ny;
      } else {
        // cross(n, y)
        tx = -nz;
        ty = 0;
        tz = nx;
      }
      len = Math.hypot(tx, ty, tz);
    }
    m.t1x = tx / len;
    m.t1y = ty / len;
    m.t1z = tz / len;
    m.t2x = ny * m.t1z - nz * m.t1y;
    m.t2y = nz * m.t1x - nx * m.t1z;
    m.t2z = nx * m.t1y - ny * m.t1x;
    m.friction = Math.sqrt(a.friction * b.friction);
    // A carried body (the character's ignoreBody) is driven by velocity
    // every step; full friction would glue it to whatever it is pressed
    // against instead of letting it slide along.
    const held = this.character?.ignoreBody ?? -1;
    if (held >= 0 && (a.id === held || (b.dynamic && b.id === held))) {
      m.friction *= HELD_FRICTION_SCALE;
    }
    m.restitution = Math.max(a.restitution, b.restitution);
    for (const rp of raw.points) {
      const c = new ContactPoint();
      c.id = rp.id;
      c.px = rp.x;
      c.py = rp.y;
      c.pz = rp.z;
      c.sep = rp.sep;
      c.rax = rp.x - a.px;
      c.ray = rp.y - a.py;
      c.raz = rp.z - a.pz;
      if (b === this.staticProxy) {
        c.rbx = rp.x;
        c.rby = rp.y;
        c.rbz = rp.z;
      } else {
        c.rbx = rp.x - b.px;
        c.rby = rp.y - b.py;
        c.rbz = rp.z - b.pz;
      }
      if (old) {
        for (const o of old.points) {
          if (o.id === c.id) {
            c.normalImpulse = o.normalImpulse;
            break;
          }
        }
      }
      m.points.push(c);
    }
    if (old) {
      m.tangentImpulse1 = old.tangentImpulse1;
      m.tangentImpulse2 = old.tangentImpulse2;
      m.twistImpulse = old.twistImpulse;
    }
    return m;
  }

  private updateSleep(
    awake: Body[],
    bodyPairs: Manifold[],
    kinematicPairs: Manifold[],
    dt: number,
  ): void {
    const index = new Map<number, number>();
    for (let i = 0; i < awake.length; i++) {
      awake[i].parent = i;
      index.set(awake[i].id, i);
    }
    const find = (i: number): number => {
      while (awake[i].parent !== i) {
        awake[i].parent = awake[awake[i].parent].parent;
        i = awake[i].parent;
      }
      return i;
    };
    for (const m of bodyPairs) {
      if (m.total <= 0 && !m.points.some((c) => c.sep < 0.005)) {
        continue;
      }
      const ia = index.get(m.a.id);
      const ib = index.get(m.b.id);
      if (ia === undefined || ib === undefined) {
        // Contact with a sleeping (immovable) body does not join islands.
        continue;
      }
      const ra = find(ia);
      const rb = find(ib);
      if (ra !== rb) {
        if (ra < rb) {
          awake[rb].parent = ra;
        } else {
          awake[ra].parent = rb;
        }
      }
    }
    for (const b of awake) {
      b.sleepTime = sleepVelocity(b) > SLEEP_VELOCITY ? 0 : b.sleepTime + dt;
    }
    for (const m of kinematicPairs) {
      if (m.total > 0 && (m.b.vx !== 0 || m.b.vy !== 0 || m.b.vz !== 0)) {
        m.a.sleepTime = 0;
      }
    }
    const minSleep = new Map<number, number>();
    for (let i = 0; i < awake.length; i++) {
      const r = find(i);
      const t = minSleep.get(r);
      const s = awake[i].sleepTime;
      minSleep.set(r, t === undefined ? s : Math.min(t, s));
    }
    const groups = new Map<number, Body[]>();
    for (let i = 0; i < awake.length; i++) {
      const r = find(i);
      if (!this.allowSleep || (minSleep.get(r) ?? 0) < TIME_TO_SLEEP) {
        continue;
      }
      let group = groups.get(r);
      if (!group) {
        group = [];
        groups.set(r, group);
      }
      group.push(awake[i]);
    }
    for (const group of groups.values()) {
      for (const b of group) {
        b.asleep = true;
        b.island = group;
        // Sleeping bodies act as immovable in contacts: no motion this step.
        b.beginStep();
        b.vx = 0;
        b.vy = 0;
        b.vz = 0;
        b.wx = 0;
        b.wy = 0;
        b.wz = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    options?: { ignoreBody?: number },
  ): RayHit | null {
    const ignore = options?.ignoreBody;
    let best = maxDistance;
    let hit: RayHit | null = null;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = direction.x;
    const dy = direction.y;
    const dz = direction.z;
    const testAabb = (
      minx: number,
      miny: number,
      minz: number,
      maxx: number,
      maxy: number,
      maxz: number,
      ref: ColliderRef,
    ): void => {
      const cx = (minx + maxx) * 0.5;
      const cy = (miny + maxy) * 0.5;
      const cz = (minz + maxz) * 0.5;
      const r = raySlab(
        [ox - cx, oy - cy, oz - cz],
        [dx, dy, dz],
        [(maxx - minx) * 0.5, (maxy - miny) * 0.5, (maxz - minz) * 0.5],
        best,
      );
      if (r && r.t <= best) {
        best = r.t;
        const n = { x: 0, y: 0, z: 0 };
        if (r.axis === 0) n.x = r.sign;
        else if (r.axis === 1) n.y = r.sign;
        else n.z = r.sign;
        hit = {
          collider: ref,
          point: { x: ox + dx * r.t, y: oy + dy * r.t, z: oz + dz * r.t },
          normal: n,
          distance: r.t,
        };
      }
    };
    for (const s of this.statics.list) {
      testAabb(s.minx, s.miny, s.minz, s.maxx, s.maxy, s.maxz, {
        kind: "static",
        id: s.id,
      });
    }
    for (const k of this.kinematics.values()) {
      testAabb(
        k.minx,
        k.miny,
        k.minz,
        k.minx + k.sx,
        k.miny + k.sy,
        k.minz + k.sz,
        {
          kind: "kinematic",
          id: k.id,
        },
      );
    }
    for (const b of this.bodyList) {
      if (b.id === ignore) {
        continue;
      }
      const r = b.r;
      const lx = ox - b.px;
      const ly = oy - b.py;
      const lz = oz - b.pz;
      // Into body space: R^T * v.
      const res = raySlab(
        [
          r[0] * lx + r[3] * ly + r[6] * lz,
          r[1] * lx + r[4] * ly + r[7] * lz,
          r[2] * lx + r[5] * ly + r[8] * lz,
        ],
        [
          r[0] * dx + r[3] * dy + r[6] * dz,
          r[1] * dx + r[4] * dy + r[7] * dz,
          r[2] * dx + r[5] * dy + r[8] * dz,
        ],
        [b.hx, b.hy, b.hz],
        best,
      );
      if (res && res.t <= best) {
        best = res.t;
        const a = res.axis;
        hit = {
          collider: { kind: "body", id: b.id },
          point: { x: ox + dx * res.t, y: oy + dy * res.t, z: oz + dz * res.t },
          normal: {
            x: r[a] * res.sign,
            y: r[3 + a] * res.sign,
            z: r[6 + a] * res.sign,
          },
          distance: res.t,
        };
      }
    }
    return hit;
  }

  overlapBox(box: Aabb): ColliderRef[] {
    const { min, max } = box;
    const out: ColliderRef[] = [];
    for (const s of this.statics.query(
      min.x,
      min.y,
      min.z,
      max.x,
      max.y,
      max.z,
    )) {
      out.push({ kind: "static", id: s.id });
    }
    for (const k of this.kinematics.values()) {
      if (
        k.minx <= max.x &&
        k.minx + k.sx >= min.x &&
        k.miny <= max.y &&
        k.miny + k.sy >= min.y &&
        k.minz <= max.z &&
        k.minz + k.sz >= min.z
      ) {
        out.push({ kind: "kinematic", id: k.id });
      }
    }
    for (const b of this.bodyList) {
      if (overlaps(b, min.x, min.y, min.z, max.x, max.y, max.z)) {
        out.push({ kind: "body", id: b.id });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Character
  // -------------------------------------------------------------------------

  moveCharacter(
    center: Vec3,
    halfExtents: Vec3,
    velocity: Vec3,
    dt: number,
    options?: CharacterMoveOptions,
  ): CharacterMoveResult {
    const stepHeight = options?.stepHeight ?? 0.3;
    const ignore = options?.ignoreBody ?? -1;
    const pushMass = options?.pushMass ?? 80;
    const he = halfExtents;

    // Gather everything the move could touch.
    const reach =
      Math.hypot(velocity.x, velocity.y, velocity.z) * dt + stepHeight + 0.1;
    const minx = center.x - he.x - reach;
    const miny = center.y - he.y - reach;
    const minz = center.z - he.z - reach;
    const maxx = center.x + he.x + reach;
    const maxy = center.y + he.y + reach;
    const maxz = center.z + he.z + reach;
    const colliders: CharCollider[] = [];
    for (const b of this.bodyList) {
      if (b.id !== ignore && overlaps(b, minx, miny, minz, maxx, maxy, maxz)) {
        colliders.push({ ref: { kind: "body", id: b.id }, box: b, body: b });
      }
    }
    for (const k of this.kinematics.values()) {
      if (
        k.minx <= maxx &&
        k.minx + k.sx >= minx &&
        k.miny <= maxy &&
        k.miny + k.sy >= miny &&
        k.minz <= maxz &&
        k.minz + k.sz >= minz
      ) {
        colliders.push({
          ref: { kind: "kinematic", id: k.id },
          box: aabbBox(
            k.minx,
            k.miny,
            k.minz,
            k.minx + k.sx,
            k.miny + k.sy,
            k.minz + k.sz,
          ),
          body: null,
        });
      }
    }
    for (const s of this.statics.query(minx, miny, minz, maxx, maxy, maxz)) {
      colliders.push({
        ref: { kind: "static", id: s.id },
        box: s.box,
        body: null,
      });
    }

    const res = moveCharacterCore(
      colliders,
      center,
      he,
      velocity,
      dt,
      stepHeight,
    );
    const groundBody = res.ground?.body ?? null;

    // Push dynamic bodies the character walked or jumped into.
    const g = Math.hypot(this.gravity.x, this.gravity.y, this.gravity.z);
    const maxPush = PUSH_FORCE_FACTOR * pushMass * g * dt;
    const pushed = new Set<number>();
    for (const hit of res.hits) {
      const b = hit.collider.body;
      if (!b || b === groundBody || hit.ny >= WALKABLE || pushed.has(b.id)) {
        continue;
      }
      let dx = -hit.nx;
      let dy = -hit.ny;
      let dz = -hit.nz;
      if (hit.ny > -WALKABLE) {
        // Side push: keep it horizontal.
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) {
          continue;
        }
        dx /= len;
        dz /= len;
        dy = 0;
      }
      // Contact point: on the body, at the body's centre height clamped to
      // the character's vertical extent.
      const py = Math.max(res.py - he.y, Math.min(res.py + he.y, b.py));
      const p = closestPointOnBody(b, res.px, py, res.pz);
      const rx = p.x - b.px;
      const ry = p.y - b.py;
      const rz = p.z - b.pz;
      const bvx = b.vx + b.wy * rz - b.wz * ry;
      const bvy = b.vy + b.wz * rx - b.wx * rz;
      const bvz = b.vz + b.wx * ry - b.wy * rx;
      const approach =
        velocity.x * dx +
        velocity.y * dy +
        velocity.z * dz -
        (bvx * dx + bvy * dy + bvz * dz);
      if (approach <= 0) {
        continue;
      }
      const k = b.inverseMassAt(dx, dy, dz, rx, ry, rz);
      const mEff = 1 / k;
      const j = Math.min(
        (approach * pushMass * mEff) / (pushMass + mEff),
        maxPush,
      );
      pushed.add(b.id);
      this.wake(b);
      b.applyImpulseAt(dx * j, dy * j, dz * j, rx, ry, rz);
    }

    // The character's weight rests on what it stands on.
    if (groundBody) {
      const landed = this.lastStandingOn !== groundBody.id || velocity.y < -1;
      if (landed) {
        this.wake(groundBody);
      }
      if (!groundBody.asleep) {
        const p = closestPointOnBody(groundBody, res.px, res.py - he.y, res.pz);
        const fx = this.gravity.x * pushMass;
        const fy = this.gravity.y * pushMass;
        const fz = this.gravity.z * pushMass;
        const rx = p.x - groundBody.px;
        const ry = p.y - groundBody.py;
        const rz = p.z - groundBody.pz;
        groundBody.fx += fx;
        groundBody.fy += fy;
        groundBody.fz += fz;
        groundBody.tx += ry * fz - rz * fy;
        groundBody.ty += rz * fx - rx * fz;
        groundBody.tz += rx * fy - ry * fx;
      }
    }
    this.lastStandingOn = groundBody ? groundBody.id : -1;

    // For the coming step the character is an immovable box at its new
    // position. It is deliberately motionless: the character's own pushing
    // is the bounded impulse above, and an obstacle moving with the
    // character's velocity would shove bodies with infinite mass.
    this.character = {
      px: res.px,
      py: res.py,
      pz: res.pz,
      hx: he.x,
      hy: he.y,
      hz: he.z,
      vx: 0,
      vy: 0,
      vz: 0,
      ignoreBody: ignore,
      standingOn: groundBody ? groundBody.id : -1,
    };

    return {
      position: { x: res.px, y: res.py, z: res.pz },
      velocity: { x: res.vx, y: res.vy, z: res.vz },
      onGround: res.onGround,
      groundNormal: { x: res.gnx, y: res.gny, z: res.gnz },
      standingOn: res.ground
        ? { kind: res.ground.ref.kind, id: res.ground.ref.id }
        : null,
      hitCeiling: res.hitCeiling,
    };
  }
}

/** Speed of the fastest point of the body (approximately). */
function sleepVelocity(b: Body): number {
  return Math.max(
    Math.hypot(b.vx, b.vy, b.vz),
    Math.hypot(b.wx, b.wy, b.wz) * b.radius,
  );
}

function clampVelocity(b: Body): void {
  const v = Math.hypot(b.vx, b.vy, b.vz);
  if (v > MAX_LINEAR_SPEED) {
    const s = MAX_LINEAR_SPEED / v;
    b.vx *= s;
    b.vy *= s;
    b.vz *= s;
  }
  const w = Math.hypot(b.wx, b.wy, b.wz);
  if (w > MAX_ANGULAR_SPEED) {
    const s = MAX_ANGULAR_SPEED / w;
    b.wx *= s;
    b.wy *= s;
    b.wz *= s;
  }
}

/** Closest point on the oriented box of a body to a world point. */
function closestPointOnBody(b: Body, x: number, y: number, z: number): Vec3 {
  const r = b.r;
  const lx = x - b.px;
  const ly = y - b.py;
  const lz = z - b.pz;
  const u = Math.max(-b.hx, Math.min(b.hx, r[0] * lx + r[3] * ly + r[6] * lz));
  const v = Math.max(-b.hy, Math.min(b.hy, r[1] * lx + r[4] * ly + r[7] * lz));
  const w = Math.max(-b.hz, Math.min(b.hz, r[2] * lx + r[5] * ly + r[8] * lz));
  return {
    x: b.px + r[0] * u + r[1] * v + r[2] * w,
    y: b.py + r[3] * u + r[4] * v + r[5] * w,
    z: b.pz + r[6] * u + r[7] * v + r[8] * w,
  };
}

function snapshot(b: Body): BodyState {
  return {
    id: b.id,
    position: { x: b.px, y: b.py, z: b.pz },
    orientation: { x: b.qx, y: b.qy, z: b.qz, w: b.qw },
    linearVelocity: { x: b.vx, y: b.vy, z: b.vz },
    angularVelocity: { x: b.wx, y: b.wy, z: b.wz },
    halfExtents: { x: b.hx, y: b.hy, z: b.hz },
    mass: b.mass,
    asleep: b.asleep,
    tag: b.tag,
  };
}
