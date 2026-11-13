/**
 * Pure logic for continuous contact sounds (scraping and rolling), for the
 * game to call once per fixed step with `physics.slidingContacts()`:
 *
 * - `contactLoopParams`: how loud and at what playback rate a scrape or roll
 *   loop plays for a given speed and contact force.
 * - `contactMaterialOf`: which loop family a prop belongs to, from its tag.
 * - `createContactVoicePool`: a small fixed pool of loop voices. The loudest
 *   contacts get a voice; a voice keeps its body until the body stops (no
 *   swapping or chatter between contacts of similar strength); gains and
 *   pitches are smoothed against the step-to-step jitter of the physics;
 *   a body that stops releases its voice smoothly. The pool returns, per
 *   step, the loop parameters to apply with `AudioSystem.setLoopParams`.
 *
 * No Web Audio here; everything is tested under `bun test`.
 */
import type { Vec3 } from "../math";

export type ContactKind = "scrape" | "roll";
export type ContactMaterial = "wood" | "metal" | "plastic";
export type ContactLoop =
  "scrape_wood" | "scrape_metal" | "scrape_plastic" | "roll_metal";

export const CONTACT_LOOPS: readonly ContactLoop[] = [
  "scrape_wood",
  "scrape_metal",
  "scrape_plastic",
  "roll_metal",
];

/** Shape of `contactLoopParams` (see there). */
export const CONTACT_CURVE = {
  /** Below this speed (m/s) a contact is silent: creep and solver jitter. */
  minSpeed: 0.08,
  /** Speed above `minSpeed` (m/s) at which the level reaches 63 %. */
  speedScale: { scrape: 0.35, roll: 0.6 },
  /** Contact force (N) at which pressure counts half: a 25 kg crate. */
  refForce: 250,
  /** Level at vanishing pressure and the extra level at full pressure. */
  baseLevel: 0.25,
  pressureLevel: 1,
  /** Playback rate at the threshold, and how far it rises with speed. */
  pitchLow: { scrape: 0.8, roll: 0.72 },
  pitchRise: { scrape: 0.45, roll: 0.6 },
  /** Speed above threshold (m/s) for 63 % of the pitch rise. */
  pitchScale: { scrape: 0.6, roll: 1 },
  /** Pressure lowers the pitch: x (pressureHigh - pressureDrop * p). */
  pressureHigh: 1.12,
  pressureDrop: 0.25,
} as const;

/**
 * Gain (0..1) and playback rate (pitch) of a scrape or roll loop for a
 * contact sliding (or rolling) at `speed` m/s and pressed together with
 * `force` newtons.
 *
 * - Silent at and below 0.08 m/s; above it the level rises quickly and
 *   saturates: `1 - exp(-(speed - 0.08) / 0.35)` for scrapes (29 % at
 *   0.2 m/s, 70 % at 0.5 m/s, 93 % at 1 m/s), a little slower for rolls.
 * - Pressure `p = force / (force + 250 N)` (0.5 for a 25 kg crate resting on
 *   its base, 0.7 for the 60 kg steel case, 0.24 for an 8 kg crate) scales
 *   the level by `0.25 + p`: heavier is louder (the steel case at full speed
 *   reaches about 0.95, a small crate about 0.5).
 * - Pitch rises with speed (0.8 to 1.25 for scrapes, 0.72 to 1.32 for rolls,
 *   so a rolling drum's knocks come faster), and heavier pressure lowers it
 *   by up to about 12 %: overall roughly 0.68 to 1.48, within the 0.6-1.6
 *   the loops are designed for.
 *
 * Bad input (NaN, negative) is treated as zero.
 */
export function contactLoopParams(
  kind: ContactKind,
  speed: number,
  force: number,
): { gain: number; pitch: number } {
  const c = CONTACT_CURVE;
  const s = speed > 0 ? speed : 0;
  const f = force > 0 ? force : 0;
  const v = Math.max(0, s - c.minSpeed);
  const p = f / (f + c.refForce);
  const level = 1 - Math.exp(-v / c.speedScale[kind]);
  const gain = Math.min(1, level * (c.baseLevel + c.pressureLevel * p));
  const rise = 1 - Math.exp(-v / c.pitchScale[kind]);
  const pitch =
    (c.pitchLow[kind] + c.pitchRise[kind] * rise) *
    (c.pressureHigh - c.pressureDrop * p);
  return { gain, pitch };
}

/**
 * Loop family of a prop from its physics tag (the prop kind): the steel
 * case and the drum are metal, the chair and the monitor plastic, crates
 * wood. Unknown tags are wood.
 */
export function contactMaterialOf(tag: string): ContactMaterial {
  if (tag === "barrel" || tag.includes("metal")) return "metal";
  if (tag === "chair" || tag === "monitor" || tag.includes("plastic"))
    return "plastic";
  return "wood";
}

/**
 * The loop a contact plays, and the gain and pitch factors applied on top
 * of `contactLoopParams`. Only metal has its own roll: a wooden or plastic
 * object turning over uses the drum's roll pitched up and softer (a light,
 * hollow tumble); its knocks come mostly from impact sounds anyway.
 */
export function contactLoopFor(
  material: ContactMaterial,
  kind: ContactKind,
): { sound: ContactLoop; gain: number; pitch: number } {
  if (kind === "roll")
    return material === "metal"
      ? { sound: "roll_metal", gain: 1, pitch: 1 }
      : { sound: "roll_metal", gain: 0.5, pitch: 1.35 };
  return { sound: `scrape_${material}`, gain: 1, pitch: 1 };
}

/** One sliding or rolling body, as the game feeds it to the pool. */
export interface ContactInput {
  /** Physics body id. */
  body: number;
  material: ContactMaterial;
  /** From `SlidingContact`. */
  slipSpeed: number;
  rollSpeed: number;
  force: number;
  /** Where to play it: the contact point. */
  position: Vec3;
}

/** Loop parameters for one voice's loop, to pass to `setLoopParams`. */
export interface ContactLoopCommand {
  /**
   * Stable name of the loop instance (`contact<slot>:<sound>`): start one
   * loop per key the first time it appears (at gain 0) and keep it.
   */
  key: string;
  slot: number;
  sound: ContactLoop;
  /** Body currently driving this voice, or null once released. */
  body: number | null;
  gain: number;
  pitch: number;
  position: Vec3;
  /** Glide time for `setLoopParams`, seconds. */
  fade: number;
}

export interface ContactVoicePoolOptions {
  /** Number of voices. Default 4. */
  voices?: number;
  /** Smoothing (1/e) of rising gain, seconds. Default 0.03. */
  attack?: number;
  /** Smoothing of falling gain, seconds. Default 0.12. */
  release?: number;
  /** Smoothing of pitch, seconds. Default 0.08. */
  pitchSmoothing?: number;
  /** A contact needs this target gain to claim a voice. Default 0.03. */
  startGain?: number;
  /** A released voice is free again once its gain is below this. Default 0.002. */
  stopGain?: number;
  /** A voice is kept at least this long before it can be taken. Default 0.3 s. */
  minHold?: number;
  /** A new contact takes a busy voice only if this many times louder. Default 2. */
  stealRatio?: number;
  /** Release time constant of a voice being taken over, s. Default 0.04. */
  stealRelease?: number;
  /**
   * A voice switches between scrape and roll only when the other kind has
   * been this many times louder for `switchTime`. Defaults 1.5 and 0.12 s.
   */
  switchRatio?: number;
  switchTime?: number;
  /** Glide time handed to `setLoopParams`. Default 0.05 s. */
  fade?: number;
}

interface Target {
  input: ContactInput;
  kind: ContactKind;
  sound: ContactLoop;
  gain: number;
  pitch: number;
  /** Target gain of the other kind, for switching. */
  otherGain: number;
}

interface Slot {
  body: number | null;
  kind: ContactKind;
  sound: ContactLoop;
  gain: number;
  pitch: number;
  position: Vec3;
  held: number;
  /** True while fading out to hand the voice to a louder contact. */
  stealing: boolean;
  switchTimer: number;
  /** The loop faded out after a scrape/roll switch. */
  previous: { sound: ContactLoop; gain: number } | null;
}

export interface ContactVoiceState {
  body: number | null;
  sound: ContactLoop;
  gain: number;
  pitch: number;
  stealing: boolean;
}

export interface ContactVoicePool {
  /**
   * Advances the pool by `dt` seconds with this step's contacts (at most
   * one per body) and returns the loop parameters to apply: every voice
   * that is sounding, plus one final gain-0 command for each loop that
   * just fell silent.
   */
  update(contacts: readonly ContactInput[], dt: number): ContactLoopCommand[];
  /** Snapshot of the voices, for tests and debugging. */
  voices(): ContactVoiceState[];
}

/** Small per-body detune (Â±3 %) so two equal crates do not sound identical. */
export function bodyDetune(body: number): number {
  const u = (((body + 1) * 0.6180339887) % 1) - 0.5;
  return 1 + 0.06 * u;
}

function targetFor(c: ContactInput, kind: ContactKind): Target {
  const other: ContactKind = kind === "scrape" ? "roll" : "scrape";
  const speed = (k: ContactKind) =>
    k === "scrape" ? c.slipSpeed : c.rollSpeed;
  const loop = contactLoopFor(c.material, kind);
  const base = contactLoopParams(kind, speed(kind), c.force);
  const otherLoop = contactLoopFor(c.material, other);
  const otherBase = contactLoopParams(other, speed(other), c.force);
  return {
    input: c,
    kind,
    sound: loop.sound,
    gain: Math.min(1, base.gain * loop.gain),
    pitch: base.pitch * loop.pitch * bodyDetune(c.body),
    otherGain: Math.min(1, otherBase.gain * otherLoop.gain),
  };
}

/** The kind a new contact starts with: whichever is louder. */
function initialKind(c: ContactInput): ContactKind {
  const s = targetFor(c, "scrape");
  return s.otherGain > s.gain ? "roll" : "scrape";
}

export function createContactVoicePool(
  options: ContactVoicePoolOptions = {},
): ContactVoicePool {
  const o = {
    voices: 4,
    attack: 0.03,
    release: 0.12,
    pitchSmoothing: 0.08,
    startGain: 0.03,
    stopGain: 0.002,
    minHold: 0.3,
    stealRatio: 2,
    stealRelease: 0.04,
    switchRatio: 1.5,
    switchTime: 0.12,
    fade: 0.05,
    ...options,
  };
  const slots: Slot[] = Array.from({ length: o.voices }, () => ({
    body: null,
    kind: "scrape",
    sound: "scrape_wood",
    gain: 0,
    pitch: 1,
    position: { x: 0, y: 0, z: 0 },
    held: 0,
    stealing: false,
    switchTimer: 0,
    previous: null,
  }));
  const approach = (from: number, to: number, tc: number, dt: number) =>
    tc <= 0 ? to : from + (to - from) * (1 - Math.exp(-dt / tc));

  return {
    update(contacts, dt) {
      const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
      const byBody = new Map<number, ContactInput>();
      for (const c of contacts) byBody.set(c.body, c);
      const commands: ContactLoopCommand[] = [];
      const emit = (
        index: number,
        slot: Slot,
        sound: ContactLoop,
        gain: number,
      ) =>
        commands.push({
          key: `contact${index}:${sound}`,
          slot: index,
          sound,
          body: slot.body,
          gain,
          pitch: slot.pitch,
          position: slot.position,
          fade: o.fade,
        });

      // 1. Voices that have a body follow it, or release.
      slots.forEach((slot, index) => {
        if (slot.body === null) return;
        slot.held += step;
        const input = byBody.get(slot.body);
        let target = 0;
        if (input && !slot.stealing) {
          let t = targetFor(input, slot.kind);
          // Scrape <-> roll only after the other kind has clearly won for
          // a while: one voice, cross-faded between its two loops.
          if (t.otherGain > o.switchRatio * Math.max(t.gain, o.startGain)) {
            slot.switchTimer += step;
            if (slot.switchTimer >= o.switchTime) {
              slot.switchTimer = 0;
              slot.kind = slot.kind === "scrape" ? "roll" : "scrape";
              t = targetFor(input, slot.kind);
              if (t.sound !== slot.sound) {
                slot.previous = { sound: slot.sound, gain: slot.gain };
                slot.sound = t.sound;
                slot.gain = 0;
              }
            }
          } else {
            slot.switchTimer = 0;
          }
          target = t.gain;
          if (t.gain > 0)
            slot.pitch = approach(slot.pitch, t.pitch, o.pitchSmoothing, step);
          slot.position = input.position;
        }
        const tc =
          target > slot.gain
            ? o.attack
            : slot.stealing
              ? o.stealRelease
              : o.release;
        slot.gain = approach(slot.gain, target, tc, step);
        if (slot.previous) {
          slot.previous.gain = approach(slot.previous.gain, 0, o.release, step);
          const done = slot.previous.gain < o.stopGain;
          emit(index, slot, slot.previous.sound, done ? 0 : slot.previous.gain);
          if (done) slot.previous = null;
        }
        if (target === 0 && slot.gain < o.stopGain) {
          // Released: one last zero, then the voice is free.
          slot.gain = 0;
          emit(index, slot, slot.sound, 0);
          slot.body = null;
          slot.stealing = false;
          slot.held = 0;
          return;
        }
        emit(index, slot, slot.sound, slot.gain);
      });

      // 2. Contacts without a voice claim a free one, loudest first, or
      // take over a much quieter voice that has been held long enough.
      const assigned = new Set<number>();
      for (const s of slots) if (s.body !== null) assigned.add(s.body);
      const waiting: Target[] = [];
      for (const c of contacts) {
        if (assigned.has(c.body)) continue;
        const t = targetFor(c, initialKind(c));
        if (t.gain >= o.startGain) waiting.push(t);
      }
      waiting.sort((a, b) => b.gain - a.gain || a.input.body - b.input.body);
      let stolen = false;
      for (const t of waiting) {
        const index = slots.findIndex((s) => s.body === null);
        if (index >= 0) {
          const slot = slots[index]!;
          slot.body = t.input.body;
          slot.kind = t.kind;
          slot.sound = t.sound;
          slot.pitch = t.pitch;
          slot.position = t.input.position;
          slot.held = 0;
          slot.switchTimer = 0;
          slot.stealing = false;
          slot.gain = approach(0, t.gain, o.attack, step);
          emit(index, slot, slot.sound, slot.gain);
          continue;
        }
        if (stolen) break;
        // Busy: mark the weakest eligible voice for release; the waiting
        // contact gets it once it has faded (a few steps).
        let weakest = -1;
        slots.forEach((s, i) => {
          if (s.stealing || s.held < o.minHold) return;
          if (weakest < 0 || s.gain < slots[weakest]!.gain) weakest = i;
        });
        if (weakest >= 0 && slots[weakest]!.gain * o.stealRatio < t.gain) {
          slots[weakest]!.stealing = true;
          stolen = true;
        }
      }
      return commands;
    },

    voices() {
      return slots.map((s) => ({
        body: s.body,
        sound: s.sound,
        gain: s.gain,
        pitch: s.pitch,
        stealing: s.stealing,
      }));
    },
  };
}
