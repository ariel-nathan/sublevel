/**
 * The first-person player: Quake-style movement on top of the physics
 * character controller, mouse look, an eye camera with period-appropriate
 * feel, and carrying/throwing props.
 */
import type {
  Aabb,
  BodyState,
  Camera,
  CharacterMoveResult,
  ColliderRef,
  PhysicsWorld,
  Player,
  PlayerEvent,
  PlayerInput,
  PlayerOptions,
  RayHit,
} from "../core/api";
import { PLAYER } from "../core/props";
import { clamp, quat, v3, type Quat, type Vec3 } from "../math";
import { accelerate, applyFriction, wishDirection } from "./movement";
import * as T from "./tuning";

const UP: Vec3 = { x: 0, y: 1, z: 0 };
/** Shrinks stand-up test boxes so merely touching geometry does not block. */
const OVERLAP_EPSILON = 0.005;

function yawQuat(yaw: number): Quat {
  return quat.fromAxisAngle(UP, yaw);
}

/** Distance from a box centre to its surface along a unit direction. */
function boxSupport(body: BodyState, dir: Vec3): number {
  const q = body.orientation;
  const he = body.halfExtents;
  const ax = quat.rotate(q, { x: 1, y: 0, z: 0 });
  const ay = quat.rotate(q, { x: 0, y: 1, z: 0 });
  const az = quat.rotate(q, { x: 0, y: 0, z: 1 });
  return (
    Math.abs(v3.dot(ax, dir)) * he.x +
    Math.abs(v3.dot(ay, dir)) * he.y +
    Math.abs(v3.dot(az, dir)) * he.z
  );
}

function boundingRadius(he: Vec3): number {
  return Math.hypot(he.x, he.y, he.z);
}

/** Rotation vector (axis * angle) of a unit quaternion, shortest arc. */
function rotationVector(q: Quat): Vec3 {
  let { x, y, z, w } = q;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) {
    return { x: 0, y: 0, z: 0 };
  }
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s;
  return { x: x * k, y: y * k, z: z * k };
}

function clampLength(v: Vec3, max: number): Vec3 {
  const len = v3.length(v);
  return len > max ? v3.scale(v, max / len) : v;
}

interface Held {
  id: number;
  /** Orientation relative to the player's yaw when picked up. */
  relative: Quat;
  stuckTime: number;
}

export function createPlayer(options: PlayerOptions): Player {
  const physics: PhysicsWorld = options.physics;
  const spawn = options.spawn.position;

  let crouched = false;
  let height: number = PLAYER.standHeight;
  let center: Vec3 = { x: spawn.x, y: spawn.y + height / 2, z: spawn.z };
  /**
   * The player's own velocity. While on the ground it is relative to the
   * ground, which carries the player along with `groundVelocity`; in the air
   * it is the velocity in the world.
   */
  let velocity: Vec3 = { x: 0, y: 0, z: 0 };
  /** Velocity of the ground under the player (zero when airborne). */
  let groundVelocity: Vec3 = { x: 0, y: 0, z: 0 };
  let yaw = options.spawn.yaw;
  let pitch = 0;
  let onGround = false;
  let standingOn: ColliderRef | null = null;
  let held: Held | null = null;
  let aim: RayHit | null = null;

  // Camera feel.
  let eyeOffset: number = T.STAND_EYE_HEIGHT;
  let stepOffset = 0;
  let dip = 0;
  let dipVelocity = 0;
  let bobDistance = 0;
  let bobAmount = 0;
  let stepDistance = T.FOOTSTEP_STRIDE * 0.5;

  const halfExtents = (): Vec3 => ({
    x: PLAYER.halfWidth,
    y: height / 2,
    z: PLAYER.halfWidth,
  });
  const feet = (): Vec3 => ({
    x: center.x,
    y: center.y - height / 2,
    z: center.z,
  });

  /** Eye without view effects, for aiming and holding. */
  const logicalEye = (): Vec3 => {
    const f = feet();
    return { x: f.x, y: f.y + eyeOffset, z: f.z };
  };
  const renderEye = (): Vec3 => {
    const e = logicalEye();
    const phase = (2 * Math.PI * bobDistance) / T.FOOTSTEP_STRIDE;
    const bob = -T.VIEW_BOB * bobAmount * (0.5 + 0.5 * Math.cos(phase));
    e.y += stepOffset + dip + bob;
    return e;
  };
  const forward = (): Vec3 =>
    quat.rotate(quat.fromYawPitch(yaw, pitch), { x: 0, y: 0, z: -1 });

  let prevEye = renderEye();
  let currEye = prevEye;

  const boxAt = (c: Vec3, h: number): Aabb => ({
    min: {
      x: c.x - PLAYER.halfWidth,
      y: c.y - h / 2,
      z: c.z - PLAYER.halfWidth,
    },
    max: {
      x: c.x + PLAYER.halfWidth,
      y: c.y + h / 2,
      z: c.z + PLAYER.halfWidth,
    },
  });

  /** True if a box of height `h` centred at `c` is free of colliders. */
  const isClear = (c: Vec3, h: number): boolean => {
    const b = boxAt(c, h);
    const e = OVERLAP_EPSILON;
    const hits = physics.overlapBox({
      min: { x: b.min.x + e, y: b.min.y + e, z: b.min.z + e },
      max: { x: b.max.x - e, y: b.max.y - e, z: b.max.z - e },
    });
    return hits.every((r) => r.kind === "body" && r.id === held?.id);
  };

  const sameRef = (a: ColliderRef | null, kind: string, id: number): boolean =>
    a !== null && a.kind === kind && a.id === id;

  /** The player's velocity in the world, ground motion included. */
  const worldVelocity = (): Vec3 => ({
    x: velocity.x + groundVelocity.x,
    y: velocity.y,
    z: velocity.z + groundVelocity.z,
  });

  /**
   * How fast the ground carries the player. Statics and kinematics are
   * ridden exactly. Dynamic bodies are ridden only when heavy enough
   * (RIDE_MIN_MASS) and moving faster than RIDE_DEADBAND, clamped to
   * RIDE_MAX_SPEED. The player only presses down on what it stands on and
   * never pushes it along, so riding cannot speed a crate up (no surfing
   * loop); a light prop squirming under the player's weight does not carry
   * the player around, and a loaded crate's slight give does not make the
   * player creep.
   */
  function rideVelocity(result: CharacterMoveResult): Vec3 {
    const on = result.standingOn;
    const gv = result.groundVelocity;
    if (!result.onGround || !on || on.kind === "static") {
      return { x: 0, y: 0, z: 0 };
    }
    if (on.kind === "kinematic") {
      return { ...gv };
    }
    const body = physics.getBody(on.id);
    const speed = v3.length(gv);
    if (
      !body ||
      body.mass < T.RIDE_MIN_MASS ||
      !(speed > T.RIDE_DEADBAND) ||
      !Number.isFinite(speed)
    ) {
      return { x: 0, y: 0, z: 0 };
    }
    return clampLength(gv, T.RIDE_MAX_SPEED);
  }

  function updateCrouch(want: boolean, airborne: boolean): void {
    const diff = PLAYER.standHeight - PLAYER.crouchHeight;
    if (want && !crouched) {
      crouched = true;
      height = PLAYER.crouchHeight;
      if (airborne) {
        // Centre stays: the feet come up by half the difference.
        eyeOffset -= diff / 2;
      } else {
        center = { ...center, y: center.y - diff / 2 };
      }
    } else if (!want && crouched) {
      const candidates: { c: Vec3; feetShift: number }[] = airborne
        ? [
            { c: center, feetShift: -diff / 2 },
            { c: { ...center, y: center.y + diff / 2 }, feetShift: 0 },
          ]
        : [{ c: { ...center, y: center.y + diff / 2 }, feetShift: 0 }];
      for (const { c, feetShift } of candidates) {
        if (isClear(c, PLAYER.standHeight)) {
          crouched = false;
          height = PLAYER.standHeight;
          center = c;
          eyeOffset -= feetShift;
          return;
        }
      }
    }
  }

  function heldBody(): BodyState | undefined {
    return held ? physics.getBody(held.id) : undefined;
  }

  function release(): number | null {
    const id = held?.id ?? null;
    held = null;
    return id;
  }

  function drop(events: PlayerEvent[]): void {
    const body = heldBody();
    const id = release();
    if (body && id !== null) {
      const v = body.linearVelocity;
      const clamped = clampLength(v, T.DROP_MAX_SPEED);
      if (clamped !== v) {
        physics.setBodyVelocity(id, clamped, body.angularVelocity);
      }
      events.push({ type: "drop", body: id });
    }
  }

  function throwHeld(events: PlayerEvent[]): void {
    const body = heldBody();
    const id = release();
    if (!body || id === null) {
      return;
    }
    const fwd = forward();
    const right = quat.rotate(yawQuat(yaw), { x: 1, y: 0, z: 0 });
    const speed = T.throwSpeed(body.mass);
    const linear = v3.add(
      v3.add(worldVelocity(), v3.scale(fwd, speed)),
      v3.scale(UP, T.THROW_UP),
    );
    physics.setBodyVelocity(id, linear, v3.scale(right, -T.THROW_SPIN));
    events.push({ type: "throw", body: id });
  }

  function tryUse(events: PlayerEvent[]): void {
    if (held) {
      drop(events);
      return;
    }
    const hit = physics.raycast(logicalEye(), forward(), PLAYER.reach);
    if (hit && hit.collider.kind === "body") {
      const id = hit.collider.id;
      const body = physics.getBody(id);
      if (
        body &&
        body.mass <= PLAYER.maxCarryMass &&
        !sameRef(standingOn, "body", id)
      ) {
        held = {
          id,
          relative: quat.multiply(
            quat.conjugate(yawQuat(yaw)),
            body.orientation,
          ),
          stuckTime: 0,
        };
        events.push({ type: "pickup", body: id });
        return;
      }
    }
    events.push({ type: "use", hit });
  }

  function shove(): void {
    const hit = physics.raycast(logicalEye(), forward(), PLAYER.reach);
    if (!hit || hit.collider.kind !== "body") {
      return;
    }
    const body = physics.getBody(hit.collider.id);
    if (!body) {
      return;
    }
    const j = Math.min(T.SHOVE_IMPULSE, body.mass * T.SHOVE_MAX_DELTA_V);
    physics.applyImpulse(body.id, v3.scale(forward(), j), hit.point);
  }

  /** Where the held body should be this step. */
  function holdTarget(body: BodyState): Vec3 {
    const eye = logicalEye();
    const fwd = forward();
    const radius = boundingRadius(body.halfExtents);
    let distance = Math.max(T.HOLD_DISTANCE, radius + T.HOLD_CLEARANCE);
    let target = v3.add(v3.scale(fwd, distance), {
      x: 0,
      y: -T.HOLD_LOWER,
      z: 0,
    });

    // Looking steeply down must not put the prop inside the player's box.
    const top = center.y + height / 2;
    const horizontalRadius = Math.hypot(body.halfExtents.x, body.halfExtents.z);
    if (eye.y + target.y - radius < top) {
      const flat = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
      const along = v3.dot(target, flat);
      const minAlong = PLAYER.halfWidth + horizontalRadius + 0.05;
      if (along < minAlong) {
        target = v3.addScaled(target, flat, minAlong - along);
      }
    }

    // Pull it in short of walls so it never gets pushed into them.
    distance = v3.length(target);
    const dir = v3.scale(target, 1 / distance);
    const hit = physics.raycast(eye, dir, distance, { ignoreBody: body.id });
    if (hit) {
      const allowed = hit.distance - boxSupport(body, dir) - T.HOLD_WALL_MARGIN;
      distance = Math.max(T.HOLD_MIN_DISTANCE, Math.min(distance, allowed));
    }
    return v3.addScaled(eye, dir, distance);
  }

  function driveHeld(dt: number, events: PlayerEvent[]): void {
    if (!held) {
      return;
    }
    const body = heldBody();
    if (!body) {
      held = null;
      return;
    }
    if (sameRef(standingOn, "body", held.id)) {
      drop(events);
      return;
    }
    const target = holdTarget(body);
    const error = v3.sub(target, body.position);
    if (v3.length(error) > T.HOLD_STUCK_DISTANCE) {
      held.stuckTime += dt;
      if (held.stuckTime > T.HOLD_STUCK_TIME) {
        drop(events);
        return;
      }
    } else {
      held.stuckTime = 0;
    }
    const k = T.carryLightness(body.mass);
    const linear = v3.add(
      clampLength(v3.scale(error, T.HOLD_GAIN * k), T.HOLD_MAX_SPEED * k),
      worldVelocity(),
    );
    // Cancel this step's gravity so the prop does not sag below the target.
    linear.x -= physics.gravity.x * dt;
    linear.y -= physics.gravity.y * dt;
    linear.z -= physics.gravity.z * dt;
    const want = quat.multiply(yawQuat(yaw), held.relative);
    const turn = rotationVector(
      quat.multiply(want, quat.conjugate(body.orientation)),
    );
    const angular = clampLength(
      v3.scale(turn, T.HOLD_ANGULAR_GAIN * k),
      T.HOLD_MAX_ANGULAR * k,
    );
    physics.setBodyVelocity(held.id, linear, angular);
  }

  function update(dt: number, input: PlayerInput): PlayerEvent[] {
    const events: PlayerEvent[] = [];
    prevEye = currEye;

    // Look.
    yaw -= input.lookDx * T.LOOK_SENSITIVITY;
    pitch = clamp(
      pitch - input.lookDy * T.LOOK_SENSITIVITY,
      -T.MAX_PITCH,
      T.MAX_PITCH,
    );
    if (yaw > Math.PI || yaw < -Math.PI) {
      yaw -= 2 * Math.PI * Math.round(yaw / (2 * Math.PI));
    }

    // Carried body may have been removed by the game.
    if (held && !heldBody()) {
      held = null;
    }

    // Interact, before moving so a picked-up body is ignored by this move.
    if (input.usePressed) {
      tryUse(events);
    }
    if (input.primaryPressed) {
      if (held) {
        throwHeld(events);
      } else {
        shove();
      }
    }

    // Jump decision first: crouch+jump together from the ground is a crouch-jump.
    const jumping = onGround && input.jump;
    updateCrouch(input.crouch, !onGround || jumping);

    const wish = wishDirection(input.moveX, input.moveZ, yaw);
    const startedOnGround = onGround;
    const startFeetY = center.y - height / 2;
    if (jumping) {
      // Leaving the ground: keep its horizontal motion (momentum carries).
      velocity = worldVelocity();
      groundVelocity = { x: 0, y: 0, z: 0 };
      velocity.y = T.JUMP_VELOCITY;
      events.push({ type: "jump" });
    }
    if (onGround && !jumping) {
      velocity.y = 0;
      applyFriction(velocity, T.FRICTION, T.STOP_SPEED, dt);
      const wishSpeed = (crouched ? T.CROUCH_SPEED : T.RUN_SPEED) * wish.amount;
      accelerate(velocity, wish.dir, wishSpeed, T.GROUND_ACCEL, Infinity, dt);
    } else {
      const wishSpeed = T.RUN_SPEED * wish.amount;
      accelerate(
        velocity,
        wish.dir,
        wishSpeed,
        T.AIR_ACCEL,
        T.AIR_SPEED_CAP,
        dt,
      );
      // Half the gravity before the move, half after: exact parabolas.
      velocity.y -= (T.GRAVITY * dt) / 2;
    }
    const fallSpeed = velocity.y;

    // Ride the ground: its horizontal motion, and its downward motion so a
    // descending lift is followed. Upward motion needs no help (the ground
    // lifts the character out of itself), and adding it would make the
    // character leave the ground.
    const carry: Vec3 =
      onGround && !jumping
        ? {
            x: groundVelocity.x,
            y: Math.min(0, groundVelocity.y),
            z: groundVelocity.z,
          }
        : { x: 0, y: 0, z: 0 };
    const previousGround = standingOn;
    const result = physics.moveCharacter(
      center,
      halfExtents(),
      v3.add(velocity, carry),
      dt,
      {
        stepHeight: PLAYER.stepHeight,
        ignoreBody: held?.id,
      },
    );
    center = result.position;
    velocity = { ...result.velocity };
    onGround = result.onGround;
    standingOn = result.standingOn;
    const nextGroundVelocity = rideVelocity(result);
    if (onGround) {
      // Back to a velocity relative to the ground. On the same ground take
      // off exactly what was added, so a platform that changes speed still
      // carries the player exactly; on new ground (landing, stepping across)
      // the world velocity is kept and friction takes over.
      const same =
        startedOnGround &&
        !jumping &&
        previousGround !== null &&
        result.standingOn !== null &&
        previousGround.kind === result.standingOn.kind &&
        previousGround.id === result.standingOn.id;
      const off = same ? carry : nextGroundVelocity;
      velocity.x -= off.x;
      velocity.z -= off.z;
    }
    // How far the ground itself moved up since the last step.
    const groundRise =
      onGround && startedOnGround ? result.groundVelocity.y * dt : 0;
    groundVelocity = onGround ? nextGroundVelocity : { x: 0, y: 0, z: 0 };
    if (result.hitCeiling && velocity.y > 0) {
      velocity.y = 0;
    }
    if (!onGround) {
      velocity.y -= (T.GRAVITY * dt) / 2;
    } else {
      velocity.y = 0;
    }
    velocity.y = Math.max(velocity.y, -T.MAX_FALL_SPEED);

    // Landing.
    const feetY = center.y - height / 2;
    if (onGround && !startedOnGround) {
      const impact = -fallSpeed;
      if (impact > T.LAND_EVENT_SPEED) {
        events.push({ type: "land", speed: impact, on: standingOn });
      }
      if (impact > 0) {
        dipVelocity -= impact * T.LAND_DIP_PER_SPEED;
      }
      stepDistance = 0;
    } else if (onGround && startedOnGround && !jumping) {
      // Only the player's own climbing is smoothed, not riding a lift.
      const dy = feetY - startFeetY - groundRise;
      if (Math.abs(dy) > T.STEP_SMOOTH_MIN) {
        stepOffset = clamp(stepOffset - dy, -0.5, 0.5);
      }
    }

    // Footsteps and view bob, from distance walked on the ground.
    const speed = Math.hypot(velocity.x, velocity.z);
    if (onGround && speed > T.FOOTSTEP_MIN_SPEED) {
      const d = speed * dt;
      stepDistance += d;
      bobDistance += d;
      const stride = crouched ? T.CROUCH_STRIDE : T.FOOTSTEP_STRIDE;
      if (stepDistance >= stride) {
        stepDistance -= stride;
        events.push({ type: "footstep", on: standingOn });
      }
    } else if (onGround) {
      stepDistance = Math.min(stepDistance, T.FOOTSTEP_STRIDE * 0.5);
    }
    const bobTarget = onGround ? Math.min(1, speed / T.RUN_SPEED) : 0;
    bobAmount += (bobTarget - bobAmount) * (1 - Math.exp(-dt / 0.1));

    // Eye smoothing.
    const eyeTarget = crouched ? T.CROUCH_EYE_HEIGHT : T.STAND_EYE_HEIGHT;
    eyeOffset +=
      (eyeTarget - eyeOffset) * (1 - Math.exp(-dt / T.EYE_SMOOTH_TIME));
    stepOffset *= Math.exp(-dt / T.STEP_SMOOTH_TIME);
    // Critically damped spring for the landing dip (semi-implicit Euler).
    const w = T.LAND_DIP_STIFFNESS;
    dipVelocity += (-w * w * dip - 2 * w * dipVelocity) * dt;
    dip += dipVelocity * dt;

    driveHeld(dt, events);

    aim = physics.raycast(logicalEye(), forward(), PLAYER.reach, {
      ignoreBody: held?.id,
    });
    currEye = renderEye();
    return events;
  }

  return {
    get feet() {
      return feet();
    },
    get velocity() {
      return worldVelocity();
    },
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
    get onGround() {
      return onGround;
    },
    get crouched() {
      return crouched;
    },
    get standingOn() {
      return standingOn;
    },
    get heldBody() {
      return held?.id ?? null;
    },
    get aim() {
      return aim;
    },
    box: () => boxAt(center, height),
    update,
    camera(alpha: number): Camera {
      const t = clamp(alpha, 0, 1);
      return {
        position: v3.lerp(prevEye, currEye, t),
        orientation: quat.fromYawPitch(yaw, pitch),
        fovY: T.FOV_Y,
        near: T.NEAR,
        far: T.FAR,
      };
    },
    releaseHeld() {
      held = null;
    },
  };
}
