/**
 * Round 2: continuous contact loops, the voice pool that drives them,
 * occlusion, rooms and the three new one-shots.
 */
import { describe, expect, test } from "bun:test";
import type { AcousticZone, SoundId } from "../core/api";
import { createRng } from "../core/rng";
import {
  bandSplit,
  centroidOf,
  db,
  describe as describeSound,
  envelope,
  eventSpectrum,
  loopEnvelopeStats,
  powerSpectrum,
  seamDiscontinuity,
  shortTermMaxRms,
  tonalPeak,
} from "./analysis";
import {
  circularFilter,
  contactLoopLength,
  deswell,
  poissonTimes,
  startInLull,
} from "./contact";
import {
  CONTACT_LOOPS,
  bodyDetune,
  contactLoopFor,
  contactLoopParams,
  contactMaterialOf,
  createContactVoicePool,
  type ContactInput,
  type ContactLoopCommand,
} from "./contactVoices";
import { BLOCK_HIT, BLOCK_RELEASE } from "./cues";
import { biquad } from "./dsp";
import { renderSound } from "./index";
import { LOUDNESS } from "./mix";
import {
  DEFAULT_ROOM,
  ROOMS,
  ROOM_PRESETS,
  decayTime,
  roomAt,
  roomImpulse,
  roomImpulseFor,
} from "./rooms";
import {
  OCCLUSION,
  clampOcclusion,
  measureOcclusion,
  occlusionParams,
  type Vec3Like,
} from "./voices";

const SR = 44100;
const cache = new Map<string, Float32Array>();
function render(id: SoundId, sr = SR): Float32Array {
  const key = `${id}@${sr}`;
  let b = cache.get(key);
  if (!b) {
    b = renderSound(id, sr);
    cache.set(key, b);
  }
  return b;
}

/** The loop played at `pitch` (linear interpolation, wrapping), one cycle. */
function playAt(buf: Float32Array, pitch: number): Float32Array {
  const n = Math.floor(buf.length / pitch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * pitch;
    const k = Math.floor(x);
    const f = x - k;
    out[i] = buf[k % buf.length]! * (1 - f) + buf[(k + 1) % buf.length]! * f;
  }
  return out;
}

/**
 * Strongest repetition of the level envelope (5 ms frames, 10 ms windows)
 * at lags from 50 ms to 2 s, as a correlation coefficient: 1 would be a
 * perfectly regular pattern (a rhythm or, when played fast, a buzz).
 */
function envelopePeriodicity(buf: Float32Array, sr: number): number {
  const env = envelope(buf, sr, 0.005, 0.01);
  const n = env.length;
  let m = 0;
  for (const v of env) m += v / n;
  const x = Float64Array.from(env, (v) => v - m);
  let v0 = 0;
  for (const v of x) v0 += v * v;
  let best = 0;
  for (let lag = 10; lag <= Math.min(400, n >> 1); lag++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i]! * x[(i + lag) % n]!;
    best = Math.max(best, s / v0);
  }
  return best;
}

describe("contact loops", () => {
  for (const id of CONTACT_LOOPS) {
    test(`${id}: 4-8 s, seamless, no loop swell`, () => {
      for (const sr of [44100, 48000]) {
        const buf = render(id, sr);
        expect(buf.length).toBe(contactLoopLength(sr));
        expect(buf.length / sr).toBeGreaterThanOrEqual(4);
        expect(buf.length / sr).toBeLessThanOrEqual(8);
        expect(seamDiscontinuity(buf)).toBeLessThan(3);
      }
      const stats = loopEnvelopeStats(render(id), SR);
      expect(stats.loopModulation).toBeLessThan(0.05);
    });

    test(`${id}: no dominant periodicity and no pitch, at pitch 0.6-1.6`, () => {
      const buf = render(id);
      expect(envelopePeriodicity(buf, SR)).toBeLessThan(0.35);
      for (const pitch of [0.6, 0.8, 1, 1.25, 1.6]) {
        const played = playAt(buf, pitch);
        const tonal = tonalPeak(
          powerSpectrum(played, 0, played.length, 8192),
          SR,
        );
        // Shaped noise reads a few dB; the rejected ringing designs 15-30.
        expect(tonal.db).toBeLessThan(7);
      }
    });
  }

  test("scrape characters: metal brightest, wood mid-band, roll low", () => {
    const d = (id: SoundId) => describeSound(render(id), SR);
    const wood = d("scrape_wood");
    const metal = d("scrape_metal");
    const plastic = d("scrape_plastic");
    const roll = d("roll_metal");
    expect(metal.centroid).toBeGreaterThan(1.8 * wood.centroid);
    expect(metal.bands.high).toBeGreaterThan(0.15);
    // Wood: most energy between 250 Hz and 4 kHz, little above.
    expect(wood.bands.lowMid + wood.bands.highMid).toBeGreaterThan(0.85);
    expect(wood.bands.high + wood.bands.air).toBeLessThan(0.1);
    expect(plastic.bands.high + plastic.bands.air).toBeLessThan(0.1);
    // The roll is a low rumble.
    expect(roll.centroid).toBeLessThan(400);
    expect(roll.bands.sub + roll.bands.low).toBeGreaterThan(0.6);
    // The roll's knocks stand out of the rumble; the scrapes are textures.
    expect(
      loopEnvelopeStats(render("roll_metal"), SR).spreadDb,
    ).toBeGreaterThan(loopEnvelopeStats(render("scrape_metal"), SR).spreadDb);
  });

  test("scrapes sit well under impacts", () => {
    for (const id of CONTACT_LOOPS) {
      expect(LOUDNESS[id].rmsDb).toBeLessThanOrEqual(
        LOUDNESS.impact_wood.rmsDb - 9,
      );
      expect(
        Math.abs(db(rmsAll(render(id))) - LOUDNESS[id].rmsDb),
      ).toBeLessThan(1);
    }
  });

  test("render budget: all four loops at 48 kHz", () => {
    const t0 = performance.now();
    for (const id of CONTACT_LOOPS) renderSound(id, 48000);
    // Typically ~150-250 ms in total; generous for slow machines. They
    // render in the background after start-up (see index.ts).
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

function rmsAll(b: Float32Array): number {
  let s = 0;
  for (const v of b) s += v * v;
  return Math.sqrt(s / b.length);
}

describe("loop building blocks", () => {
  test("circular filtering is seamless", () => {
    const rng = createRng(5);
    const n = 1 << 14;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = rng.next() * 2 - 1;
    // Reference: the signal repeated three times, filtered straight through;
    // the last copy is the steady state the circular result must match.
    const three = new Float32Array(3 * n);
    for (let c = 0; c < 3; c++) three.set(x, c * n);
    const filters = [
      ["bp", 500, 8],
      ["lp", 900, 0.707],
    ] as const;
    const stages = filters.map(([m, f, q]) => biquad(m, f, q, 16000));
    for (let i = 0; i < three.length; i++) {
      let v = three[i]!;
      for (const s of stages) v = s(v);
      three[i] = v;
    }
    circularFilter(x, 16000, filters);
    const ref = three.subarray(2 * n);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(x[i]! - ref[i]!));
    expect(err).toBeLessThan(1e-5);
    expect(seamDiscontinuity(x)).toBeLessThan(3);
  });

  test("deswell removes a once-per-loop swell; startInLull rotates only", () => {
    const rng = createRng(6);
    const n = 1 << 16;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++)
      x[i] = (rng.next() * 2 - 1) * (1 + 0.5 * Math.sin((2 * Math.PI * i) / n));
    expect(loopEnvelopeStats(x, 16000).loopModulation).toBeGreaterThan(0.3);
    deswell(x);
    expect(loopEnvelopeStats(x, 16000).loopModulation).toBeLessThan(0.03);
    const r = startInLull(x, 16000);
    expect(r.length).toBe(n);
    const sorted = (b: Float32Array) => Array.from(b).sort((a, c) => a - c);
    expect(sorted(r)).toEqual(sorted(x));
  });

  test("poisson times respect the rate and the minimum gap", () => {
    const rng = createRng(7);
    const sr = 1000;
    const n = 60 * sr;
    const times = poissonTimes(rng, n, sr, () => 5, 5, 0.1);
    expect(times.length).toBeGreaterThan(150);
    expect(times.length).toBeLessThan(330);
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(100);
    expect(n - times[times.length - 1]! + times[0]!).toBeGreaterThanOrEqual(
      100,
    );
  });
});

describe("contactLoopParams", () => {
  test("silent below 0.08 m/s, rising quickly, saturating", () => {
    for (const kind of ["scrape", "roll"] as const) {
      expect(contactLoopParams(kind, 0, 300).gain).toBe(0);
      expect(contactLoopParams(kind, 0.08, 300).gain).toBe(0);
      expect(contactLoopParams(kind, 0.1, 300).gain).toBeGreaterThan(0);
      let last = 0;
      for (let v = 0.1; v <= 5; v += 0.05) {
        const g = contactLoopParams(kind, v, 300).gain;
        expect(g).toBeGreaterThanOrEqual(last);
        expect(g).toBeLessThanOrEqual(1);
        last = g;
      }
      // Saturates: the last metre per second adds little.
      const g3 = contactLoopParams(kind, 3, 300).gain;
      const g4 = contactLoopParams(kind, 4, 300).gain;
      expect(g4 - g3).toBeLessThan(0.02);
    }
    // Rises quickly: a 25 kg crate at 0.5 m/s is past half its full level.
    const full = contactLoopParams("scrape", 4, 245).gain;
    expect(contactLoopParams("scrape", 0.5, 245).gain).toBeGreaterThan(
      0.6 * full,
    );
  });

  test("heavier pressure is louder and slightly lower", () => {
    for (const kind of ["scrape", "roll"] as const) {
      const light = contactLoopParams(kind, 1, 80);
      const heavy = contactLoopParams(kind, 1, 600);
      expect(heavy.gain).toBeGreaterThan(light.gain * 1.4);
      expect(heavy.pitch).toBeLessThan(light.pitch);
      expect(heavy.pitch).toBeGreaterThan(light.pitch * 0.8);
    }
  });

  test("pitch rises with speed and stays within the loops' range", () => {
    for (const kind of ["scrape", "roll"] as const) {
      expect(contactLoopParams(kind, 2, 250).pitch).toBeGreaterThan(
        contactLoopParams(kind, 0.2, 250).pitch,
      );
      for (const v of [0, 0.1, 0.5, 1, 3, 20])
        for (const f of [0, 50, 250, 1000, 1e5]) {
          const { pitch } = contactLoopParams(kind, v, f);
          expect(pitch).toBeGreaterThanOrEqual(0.6);
          expect(pitch).toBeLessThanOrEqual(1.6);
        }
    }
  });

  test("bad input is silent, never NaN", () => {
    for (const [v, f] of [
      [Number.NaN, 100],
      [1, Number.NaN],
      [-3, 100],
      [1, -50],
    ]) {
      const p = contactLoopParams("scrape", v!, f!);
      expect(Number.isFinite(p.gain)).toBe(true);
      expect(Number.isFinite(p.pitch)).toBe(true);
    }
    expect(contactLoopParams("scrape", Number.NaN, 100).gain).toBe(0);
  });

  test("materials and loops", () => {
    expect(contactMaterialOf("crate_metal")).toBe("metal");
    expect(contactMaterialOf("barrel")).toBe("metal");
    expect(contactMaterialOf("chair")).toBe("plastic");
    expect(contactMaterialOf("monitor")).toBe("plastic");
    expect(contactMaterialOf("crate_wood_small")).toBe("wood");
    expect(contactMaterialOf("crate_weak")).toBe("wood");
    expect(contactMaterialOf("")).toBe("wood");
    expect(contactLoopFor("wood", "scrape").sound).toBe("scrape_wood");
    expect(contactLoopFor("metal", "roll").sound).toBe("roll_metal");
    expect(contactLoopFor("plastic", "roll").gain).toBeLessThan(1);
    for (let b = 0; b < 50; b++) {
      expect(Math.abs(bodyDetune(b) - 1)).toBeLessThanOrEqual(0.03);
    }
  });
});

describe("contact voice pool", () => {
  const DT = 1 / 60;
  const at = { x: 0, y: 0, z: 0 };
  const contact = (
    body: number,
    slipSpeed: number,
    force = 250,
    rollSpeed = 0,
    material: ContactInput["material"] = "wood",
  ): ContactInput => ({
    body,
    material,
    slipSpeed,
    rollSpeed,
    force,
    position: at,
  });

  function run(
    pool: ReturnType<typeof createContactVoicePool>,
    steps: number,
    contacts: (step: number) => ContactInput[],
  ): ContactLoopCommand[][] {
    const out: ContactLoopCommand[][] = [];
    for (let s = 0; s < steps; s++) out.push(pool.update(contacts(s), DT));
    return out;
  }

  test("a sliding crate gets a voice, glides up and releases when it stops", () => {
    const pool = createContactVoicePool();
    const moving = run(pool, 30, () => [contact(7, 1)]);
    const first = moving[0]![0]!;
    expect(first.sound).toBe("scrape_wood");
    expect(first.key).toBe("contact0:scrape_wood");
    expect(first.body).toBe(7);
    // Smooth attack, not a jump; reaches the target within half a second.
    expect(first.gain).toBeLessThan(contactLoopParams("scrape", 1, 250).gain);
    const last = moving[29]!.find((c) => c.key === first.key)!;
    expect(last.gain).toBeCloseTo(contactLoopParams("scrape", 1, 250).gain, 2);
    // Stops: the gain falls smoothly to exactly 0, one final command, then
    // nothing more, and the voice is free.
    const stopping = run(pool, 120, () => []);
    const gains = stopping.flatMap((cmds) => cmds.map((c) => c.gain));
    for (let i = 1; i < gains.length; i++)
      expect(gains[i]!).toBeLessThanOrEqual(gains[i - 1]!);
    expect(gains[0]!).toBeGreaterThan(0.3);
    expect(gains[gains.length - 1]).toBe(0);
    expect(stopping[stopping.length - 1]!.length).toBe(0);
    expect(pool.voices().every((v) => v.body === null)).toBe(true);
  });

  test("never more voices than the pool, and the loudest contacts win", () => {
    const pool = createContactVoicePool({ voices: 4 });
    const speeds = [0.3, 2, 0.15, 1.5, 0.9, 0.5, 2.5];
    const cmds = run(pool, 10, () => speeds.map((v, i) => contact(i, v)));
    for (const step of cmds) {
      const slots = new Set(step.map((c) => c.slot));
      expect(slots.size).toBeLessThanOrEqual(4);
    }
    const bodies = pool
      .voices()
      .map((v) => v.body)
      .sort();
    expect(bodies).toEqual([1, 3, 4, 6]);
  });

  test("hysteresis: near-equal contacts never swap voices", () => {
    const pool = createContactVoicePool({ voices: 1 });
    // Two crates whose speeds alternate around each other every step.
    const owners = new Set<number | null>();
    run(pool, 200, (s) => [
      contact(1, s % 2 ? 1.0 : 1.1),
      contact(2, s % 2 ? 1.1 : 1.0),
    ]);
    for (let s = 0; s < 200; s++) {
      pool.update(
        [contact(1, s % 2 ? 1.0 : 1.2), contact(2, s % 2 ? 1.2 : 1.0)],
        DT,
      );
      owners.add(pool.voices()[0]!.body);
    }
    expect(owners.size).toBe(1);
  });

  test("a much louder contact takes over a held voice, via a short release", () => {
    const pool = createContactVoicePool({ voices: 1, minHold: 0.3 });
    run(pool, 5, () => [contact(1, 0.15, 80)]);
    // Too early to steal (held < 0.3 s).
    run(pool, 5, () => [contact(1, 0.15, 80), contact(2, 2, 600)]);
    expect(pool.voices()[0]!.body).toBe(1);
    expect(pool.voices()[0]!.stealing).toBe(false);
    // Later it is taken: the old body fades out first, then the new one starts.
    const cmds = run(pool, 40, () => [
      contact(1, 0.15, 80),
      contact(2, 2, 600),
    ]);
    expect(pool.voices()[0]!.body).toBe(2);
    const flat = cmds.flat();
    const lastOld = flat.map((c) => c.body).lastIndexOf(1);
    const firstNew = flat.findIndex((c) => c.body === 2);
    expect(firstNew).toBeGreaterThan(lastOld);
    // The old body's last command is a zero: no cut.
    expect(flat[lastOld]!.gain).toBe(0);
  });

  test("a barely louder contact does not take a voice", () => {
    const pool = createContactVoicePool({ voices: 1 });
    run(pool, 60, () => [contact(1, 0.6)]);
    run(pool, 120, () => [contact(1, 0.6), contact(2, 0.9)]);
    expect(pool.voices()[0]!.body).toBe(1);
  });

  test("silent and creeping contacts never claim a voice", () => {
    const pool = createContactVoicePool();
    const cmds = run(pool, 30, () => [contact(1, 0.05), contact(2, 0.09, 5)]);
    expect(cmds.flat().length).toBe(0);
  });

  test("scrape/roll switching is debounced and cross-faded", () => {
    const pool = createContactVoicePool({ voices: 1 });
    run(pool, 30, () => [contact(1, 1, 300, 0, "metal")]);
    expect(pool.voices()[0]!.sound).toBe("scrape_metal");
    // A one-step blip of rolling does not switch.
    run(pool, 1, () => [contact(1, 0.1, 300, 1.5, "metal")]);
    run(pool, 5, () => [contact(1, 1, 300, 0, "metal")]);
    expect(pool.voices()[0]!.sound).toBe("scrape_metal");
    // Sustained rolling does, and the scrape fades out on its own key.
    const cmds = run(pool, 60, () => [contact(1, 0, 300, 1.5, "metal")]);
    expect(pool.voices()[0]!.sound).toBe("roll_metal");
    const scrape = cmds.flat().filter((c) => c.sound === "scrape_metal");
    expect(scrape.length).toBeGreaterThan(1);
    expect(scrape[scrape.length - 1]!.gain).toBe(0);
    for (let i = 1; i < scrape.length; i++)
      expect(scrape[i]!.gain).toBeLessThanOrEqual(scrape[i - 1]!.gain);
    // Same slot, different loop instance.
    const roll = cmds.flat().filter((c) => c.sound === "roll_metal");
    expect(roll[0]!.slot).toBe(scrape[0]!.slot);
    expect(roll[0]!.key).not.toBe(scrape[0]!.key);
  });

  test("pitch and gain follow jittery physics smoothly", () => {
    const pool = createContactVoicePool({ voices: 1 });
    run(pool, 60, () => [contact(1, 1)]);
    const rng = createRng(3);
    const cmds = run(pool, 120, () => [
      contact(1, 1 + (rng.next() - 0.5) * 0.6),
    ]);
    const gains = cmds.map((c) => c[0]!.gain);
    for (let i = 1; i < gains.length; i++)
      expect(Math.abs(gains[i]! - gains[i - 1]!)).toBeLessThan(0.05);
  });

  test("deterministic", () => {
    const go = () => {
      const pool = createContactVoicePool();
      return run(pool, 50, (s) => [contact(1, s / 20), contact(2, 1 - s / 60)]);
    };
    expect(go()).toEqual(go());
  });
});

describe("occlusion", () => {
  test("mapping is monotonic and bounded", () => {
    const open = occlusionParams(0);
    expect(open).toEqual({ cutoff: OCCLUSION.maxCutoff, gain: 1, send: 1 });
    const shut = occlusionParams(1);
    expect(shut.cutoff).toBeCloseTo(OCCLUSION.minCutoff, 6);
    expect(shut.cutoff).toBeGreaterThanOrEqual(600);
    expect(shut.cutoff).toBeLessThanOrEqual(900);
    expect(db(shut.gain)).toBeCloseTo(-14, 6);
    let last = open;
    for (let o = 0.02; o <= 1.0001; o += 0.02) {
      const p = occlusionParams(o);
      expect(p.cutoff).toBeLessThan(last.cutoff);
      expect(p.gain).toBeLessThan(last.gain);
      expect(p.send).toBeLessThan(last.send);
      // The reverb falls less than the direct sound: relatively wetter.
      expect(p.send / p.gain).toBeGreaterThan(last.send / last.gain);
      last = p;
    }
    expect(occlusionParams(5)).toEqual(shut);
    expect(occlusionParams(-1)).toEqual(open);
    expect(occlusionParams(Number.NaN)).toEqual(open);
    expect(occlusionParams(undefined)).toEqual(open);
    expect(clampOcclusion(0.4)).toBe(0.4);
  });

  test("measured by rays through walls", () => {
    const listener: Vec3Like = { x: 0, y: 1.6, z: 0 };
    const source: Vec3Like = { x: 0, y: 0.5, z: -8 };
    const clear = () => null;
    expect(measureOcclusion(listener, source, clear)).toBe(0);
    // A wall across the whole line of sight at z = -4.
    const wall = (o: Vec3Like, d: Vec3Like, max: number) => {
      if (d.z >= 0) return null;
      const t = (-4 - o.z) / d.z;
      return t < max ? t : null;
    };
    expect(measureOcclusion(listener, source, wall)).toBe(1);
    // Only a thin pillar on the direct line: partial.
    let call = 0;
    const pillar = () => (call++ % 4 === 0 ? 4 : null);
    const p = measureOcclusion(listener, source, pillar);
    expect(p).toBeGreaterThan(0.2);
    expect(p).toBeLessThan(0.6);
    // One grazing offset ray (a crate against a wall): no occlusion.
    call = 0;
    const graze = () => (call++ % 4 === 1 ? 7 : null);
    expect(measureOcclusion(listener, source, graze)).toBe(0);
    // A hit at the source itself does not count.
    expect(measureOcclusion(listener, source, (_o, _d, max) => max - 0.1)).toBe(
      0,
    );
  });
});

describe("rooms", () => {
  test("decay times are ordered small < lab < corridor < hall", () => {
    const rt = ROOMS.map((r) => decayTime(roomImpulseFor(r, SR)[0], SR));
    for (let i = 1; i < rt.length; i++)
      expect(rt[i]!).toBeGreaterThan(rt[i - 1]! * 1.3);
    // Each near its designed mid-band decay.
    ROOMS.forEach((r, i) => {
      expect(rt[i]!).toBeGreaterThan(ROOM_PRESETS[r].rt60Mid * 0.6);
      expect(rt[i]!).toBeLessThan(ROOM_PRESETS[r].rt60Low * 1.4);
    });
  });

  test("spectral tilt: small brightest, corridor and hall darker, hall low-mid heavy", () => {
    const tail = (r: (typeof ROOMS)[number]) => {
      const ir = roomImpulseFor(r, SR)[0];
      const from = Math.round(SR * (ROOM_PRESETS[r].preDelay + 0.03));
      const to = Math.min(ir.length, from + Math.round(SR * 0.25));
      return powerSpectrum(ir, from, to, 2048);
    };
    const centroid = (r: (typeof ROOMS)[number]) => centroidOf(tail(r), SR);
    expect(centroid("small")).toBeGreaterThan(centroid("lab"));
    expect(centroid("lab")).toBeGreaterThan(centroid("corridor"));
    expect(centroid("lab")).toBeGreaterThan(centroid("hall"));
    const lowShare = (r: (typeof ROOMS)[number]) => {
      const b = bandSplit(tail(r), SR);
      return b.low + b.lowMid;
    };
    expect(lowShare("hall")).toBeGreaterThan(lowShare("lab"));
    expect(lowShare("hall")).toBeGreaterThan(lowShare("corridor"));
    expect(centroid("hall")).toBeLessThan(centroid("corridor"));
  });

  test("impulse responses: pre-delay, unit energy, decorrelated, no ringing tail", () => {
    for (const r of ROOMS) {
      const preset = ROOM_PRESETS[r];
      const [l, rr] = roomImpulseFor(r, SR);
      expect(l.length).toBe(Math.round(SR * preset.seconds));
      expect(l).not.toEqual(rr);
      let e = 0;
      for (const v of l) e += v * v;
      expect(e).toBeCloseTo(1, 3);
      const pre = Math.round(SR * preset.preDelay);
      for (let i = 0; i < pre - 1; i++) expect(l[i]).toBe(0);
      // The late tail is dense noise (the corridor's flutter dies early).
      const from = Math.round(SR * (preset.preDelay + 0.15));
      const late = l.subarray(
        from,
        Math.min(l.length, from + Math.round(SR * 0.1)),
      );
      expect(describeSound(late, SR).flatness).toBeGreaterThan(0.25);
      expect(roomImpulse(SR, preset, 1)[0]).not.toEqual(l);
    }
    // Cached: the same arrays every time.
    expect(roomImpulseFor("hall", SR)).toBe(roomImpulseFor("hall", SR));
  });

  test("corridor has a flutter echo; the others do not", () => {
    // Energy near multiples of the corridor's flutter period (after the
    // pre-delay) against the energy half-way between them, over the first
    // 25-100 ms, summed over several seeds.
    const flutterRatio = (r: (typeof ROOMS)[number]) => {
      const p = ROOM_PRESETS.corridor.flutter!.period;
      const w = Math.round(0.0008 * SR);
      let on = 0;
      let off = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const ir = roomImpulse(SR, ROOM_PRESETS[r], seed)[0];
        const pre = Math.round(SR * ROOM_PRESETS[r].preDelay);
        const energy = (centre: number) => {
          let e = 0;
          for (let i = centre - w; i <= centre + w; i++) e += ir[i]! ** 2;
          return e;
        };
        for (let k = 2; k <= 7; k++) {
          on += energy(pre + Math.round(k * p * SR));
          off += energy(pre + Math.round((k + 0.5) * p * SR));
        }
      }
      return on / off;
    };
    expect(flutterRatio("corridor")).toBeGreaterThan(1.5);
    expect(flutterRatio("lab")).toBeLessThan(1.5);
  });

  test("generating all four is cheap", () => {
    const t0 = performance.now();
    for (const r of ROOMS) roomImpulse(48000, ROOM_PRESETS[r], 99);
    // Typically 20-40 ms.
    expect(performance.now() - t0).toBeLessThan(400);
  });

  test("roomAt: zones, the default, and hysteresis at boundaries", () => {
    const box = (x0: number, x1: number) => ({
      min: { x: x0, y: 0, z: -5 },
      max: { x: x1, y: 4, z: 5 },
    });
    const zones: AcousticZone[] = [
      { box: box(0, 10), room: "lab" },
      { box: box(10, 30), room: "hall" },
    ];
    const p = (x: number) => ({ x, y: 1.6, z: 0 });
    expect(roomAt(zones, p(5))).toBe("lab");
    expect(roomAt(zones, p(20))).toBe("hall");
    expect(roomAt(zones, p(-5))).toBe(DEFAULT_ROOM);
    expect(DEFAULT_ROOM).toBe("corridor");
    // Crossing from lab into hall: lab is kept for the first 0.4 m.
    expect(roomAt(zones, p(10.2), "lab")).toBe("lab");
    expect(roomAt(zones, p(10.6), "lab")).toBe("hall");
    // And back: hall is kept just inside the lab.
    expect(roomAt(zones, p(9.8), "hall")).toBe("hall");
    expect(roomAt(zones, p(9.4), "hall")).toBe("lab");
    // From the corridor into the lab: the lab needs a step inside.
    expect(roomAt(zones, p(0.2), "corridor")).toBe("corridor");
    expect(roomAt(zones, p(0.8), "corridor")).toBe("lab");
    expect(roomAt(zones, p(-0.2), "lab")).toBe("lab");
    expect(roomAt(zones, p(-0.6), "lab")).toBe("corridor");
  });
});

describe("new one-shots", () => {
  test("timer tick: short, dry, soft-edged, unpitched", () => {
    const buf = render("timer_tick");
    const d = describeSound(buf, SR);
    expect(d.duration).toBeLessThan(0.1);
    expect(d.decay40Ms).toBeLessThan(60);
    // Not a hard digital click: the onset is shaped.
    expect(d.attackMs).toBeGreaterThanOrEqual(0.5);
    expect(tonalPeak(eventSpectrum([buf], 16384), SR).db).toBeLessThan(9);
    // Quieter than a button press.
    expect(LOUDNESS.timer_tick.rmsDb).toBeLessThan(LOUDNESS.button_press.rmsDb);
    // At pitch 1.2 it is shorter and brighter (more urgent).
    const fast = playAt(buf, 1.2);
    const df = describeSound(fast, SR);
    expect(df.duration).toBeLessThan(d.duration);
    expect(df.centroidOnset).toBeGreaterThan(d.centroidOnset);
  });

  test("door blocked: running, a dull knock, straining, then release", () => {
    const buf = render("door_blocked");
    const seg = (a: number, b: number) =>
      buf.subarray(Math.round(a * SR), Math.round(b * SR));
    const lvl = (a: number, b: number) => db(shortTermMaxRms(seg(a, b), SR));
    // The knock is the loudest moment and is dull (low centroid).
    expect(lvl(BLOCK_HIT, BLOCK_HIT + 0.08)).toBeGreaterThan(
      lvl(0, BLOCK_HIT) + 3,
    );
    expect(
      describeSound(seg(BLOCK_HIT, BLOCK_HIT + 0.06), SR).centroid,
    ).toBeLessThan(900);
    // Still sounding while straining, then dying away after the release.
    expect(lvl(BLOCK_HIT + 0.2, BLOCK_RELEASE)).toBeGreaterThan(
      lvl(BLOCK_HIT, BLOCK_HIT + 0.08) - 15,
    );
    expect(lvl(BLOCK_RELEASE + 0.35, 1.1)).toBeLessThan(
      lvl(BLOCK_HIT + 0.2, BLOCK_RELEASE) - 10,
    );
    // Not an alarm: no strong pitched peak.
    expect(tonalPeak(eventSpectrum([buf], 65536), SR).db).toBeLessThan(10);
  });

  test("objective cue: soft onset, tonal, short, below a door", () => {
    const buf = render("objective");
    const d = describeSound(buf, SR);
    expect(d.duration).toBeGreaterThan(1.2);
    expect(d.duration).toBeLessThan(1.7);
    // Soft: no sharp attack anywhere in the first 10 ms.
    expect(
      Math.max(...Array.from(buf.subarray(0, Math.round(0.01 * SR)), Math.abs)),
    ).toBeLessThan(0.05);
    expect(d.attackMs).toBeGreaterThan(5);
    // A signal: clearly tonal, in a small-speaker band.
    expect(tonalPeak(eventSpectrum([buf], 65536), SR).db).toBeGreaterThan(15);
    expect(d.bands.sub + d.bands.air).toBeLessThan(0.02);
    expect(LOUDNESS.objective.rmsDb).toBeLessThan(LOUDNESS.door_close.rmsDb);
  });
});
