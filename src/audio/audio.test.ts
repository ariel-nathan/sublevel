import { describe, expect, test } from "bun:test";
import { LOOPING_SOUNDS, SOUND_IDS, type SoundId } from "../core/api";
import { createRng } from "../core/rng";
import {
  describe as describeSound,
  envelope,
  eventSpectrum,
  kLoudnessDb,
  loopEnvelopeStats,
  powerSpectrum,
  seamDiscontinuity,
  shortTermMaxRms,
  spectralPeaks,
  tonalPeak,
  db,
} from "./analysis";
import { fft, hann, magnitudeSpectrum, periodicNoisePair, stft } from "./fft";
import { candidateOf, renderSound, renderVariant } from "./index";
import {
  applyEra,
  CANDIDATE_NAMES,
  CANDIDATES,
  CATEGORY_OF,
  FAMILIES,
  FAMILY_SOUNDS,
  familyOf,
  formatSfx,
  LOUDNESS,
  loudnessFor,
  parseSfx,
  PRIORITY_OF,
  type Candidate,
} from "./mix";
import {
  PLASTIC_SHELL_MODES,
  STEEL_DRUM_MODES,
  WOOD_CRATE_MODES,
  modeTau,
  MATERIALS,
  type Mode,
} from "./modal";
import { VARIANTS } from "./recipes";
import {
  ATTENUATION,
  PRIORITY,
  clampGain,
  clampPitch,
  createVoiceLimiter,
  distanceCutoff,
  distanceGain,
  distanceSend,
  makeImpulseResponse,
} from "./voices";

const RATES = [44100, 48000];
/**
 * Footsteps A and C: no narrow peak may stand more than this far above its
 * neighbourhood (see `tonalPeak`). Shaped noise measures 4-7 dB; the rejected
 * tile and grate steps measure 19 and 28 dB.
 */
const TONAL_LIMIT_DB = 8;
const LOOPS = new Set<SoundId>(LOOPING_SOUNDS);

/** Expected duration range in seconds (family sounds: see FAMILY_DURATION). */
const DURATION: Record<SoundId, [number, number]> = {
  footstep_concrete: [0.08, 0.25],
  footstep_tile: [0.08, 0.25],
  footstep_metal: [0.2, 0.4],
  land: [0.15, 0.35],
  jump: [0.1, 0.2],
  impact_wood: [0.25, 0.45],
  impact_metal: [0.8, 1.3],
  impact_plastic: [0.08, 0.2],
  crate_break: [0.6, 1.0],
  pickup: [0.08, 0.16],
  throw: [0.2, 0.3],
  button_press: [0.12, 0.35],
  button_deny: [0.3, 0.5],
  door_open: [1.3, 1.7],
  door_close: [1.3, 1.7],
  plate_down: [0.15, 0.35],
  plate_up: [0.15, 0.35],
  hum_fluorescent: [5, 12.5],
  hum_machine: [5, 12.5],
  ambient_drone: [5, 12.5],
};

/**
 * Duration ranges of the candidate designs ("current" uses DURATION). The
 * break ranges are the briefs: B compact (0.3-0.4 s), C up to ~0.9 s.
 */
const FAMILY_DURATION: Record<
  Exclude<Candidate, "current">,
  Partial<Record<SoundId, [number, number]>>
> = {
  A: {
    footstep_concrete: [0.08, 0.3],
    footstep_tile: [0.08, 0.3],
    footstep_metal: [0.08, 0.3],
    land: [0.15, 0.4],
    impact_metal: [0.25, 0.6],
    crate_break: [0.4, 0.7],
  },
  B: {
    footstep_concrete: [0.08, 0.3],
    footstep_tile: [0.08, 0.3],
    footstep_metal: [0.08, 0.3],
    land: [0.15, 0.4],
    impact_metal: [0.4, 0.85],
    crate_break: [0.3, 0.4],
  },
  C: {
    footstep_concrete: [0.08, 0.3],
    footstep_tile: [0.08, 0.3],
    footstep_metal: [0.08, 0.3],
    land: [0.15, 0.4],
    impact_metal: [0.1, 0.3],
    crate_break: [0.7, 1.0],
  },
};

function durationRange(id: SoundId, candidate: Candidate): [number, number] {
  return candidate === "current"
    ? DURATION[id]
    : (FAMILY_DURATION[candidate][id] ?? DURATION[id]);
}

// Rendering is deterministic, so cache renders per sound, rate, take and design.
const cache = new Map<string, Float32Array>();
function render(id: SoundId, sr = 44100): Float32Array {
  return renderTake(id, candidateOf(id), 0, sr);
}
function renderTake(
  id: SoundId,
  candidate: Candidate,
  take = 0,
  sr = 44100,
): Float32Array {
  const key = `${id}@${sr}/${candidate}#${take}`;
  let buf = cache.get(key);
  if (!buf) {
    buf = renderVariant(id, sr, take, candidate);
    cache.set(key, buf);
  }
  return buf;
}
function takes(id: SoundId, candidate: Candidate): Float32Array[] {
  const out: Float32Array[] = [];
  for (let v = 0; v < VARIANTS[id]; v++) out.push(renderTake(id, candidate, v));
  return out;
}

function stats(buf: Float32Array) {
  let peak = 0;
  let sum = 0;
  let sq = 0;
  for (const v of buf) {
    peak = Math.max(peak, Math.abs(v));
    sum += v;
    sq += v * v;
  }
  return { peak, mean: sum / buf.length, rms: Math.sqrt(sq / buf.length) };
}

function goertzel(buf: Float32Array, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = buf[i]! + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / buf.length;
}

function sine(freq: number, sr: number, n: number, amp = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

describe("renderSound", () => {
  for (const sr of RATES) {
    for (const id of SOUND_IDS) {
      test(`${id} @ ${sr} is well formed`, () => {
        const buf = render(id, sr);
        expect(buf.length).toBeGreaterThan(0);
        for (const v of buf) expect(Number.isFinite(v)).toBe(true);
        const { peak, mean, rms } = stats(buf);
        expect(peak).toBeLessThanOrEqual(1);
        expect(peak).toBeGreaterThan(0.15);
        expect(rms).toBeGreaterThan(0.01);
        expect(Math.abs(mean)).toBeLessThan(0.01 * Math.max(peak, 0.1));
        const seconds = buf.length / sr;
        const range = durationRange(id, candidateOf(id));
        expect(seconds).toBeGreaterThanOrEqual(range[0]);
        expect(seconds).toBeLessThanOrEqual(range[1]);
        if (!LOOPS.has(id)) {
          for (let i = 0; i < 3; i++) {
            expect(Math.abs(buf[i]!)).toBeLessThan(0.02);
            expect(Math.abs(buf[buf.length - 1 - i]!)).toBeLessThan(0.02);
          }
        }
        // Deterministic.
        expect(renderSound(id, sr)).toEqual(buf);
      });
    }
  }

  for (const sr of RATES) {
    for (const id of LOOPING_SOUNDS) {
      test(`${id} @ ${sr} loops seamlessly`, () => {
        const buf = render(id, sr);
        const n = buf.length;
        let maxStep = 0;
        let maxSlopeChange = 0;
        for (let i = 1; i < n; i++)
          maxStep = Math.max(maxStep, Math.abs(buf[i]! - buf[i - 1]!));
        for (let i = 2; i < n; i++) {
          const a = buf[i]! - buf[i - 1]!;
          const b = buf[i - 1]! - buf[i - 2]!;
          maxSlopeChange = Math.max(maxSlopeChange, Math.abs(a - b));
        }
        const wrapStep = Math.abs(buf[0]! - buf[n - 1]!);
        expect(wrapStep).toBeLessThanOrEqual(maxStep);
        const wrapSlope = Math.abs(buf[1]! - buf[0]! - (buf[0]! - buf[n - 1]!));
        const wrapSlope2 = Math.abs(
          buf[0]! - buf[n - 1]! - (buf[n - 1]! - buf[n - 2]!),
        );
        expect(wrapSlope).toBeLessThanOrEqual(maxSlopeChange);
        expect(wrapSlope2).toBeLessThanOrEqual(maxSlopeChange);
        expect(seamDiscontinuity(buf)).toBeLessThan(3);
      });
    }
  }

  test("variants are deterministic, distinct and well formed", () => {
    for (const id of SOUND_IDS) {
      for (let v = 1; v < VARIANTS[id]; v++) {
        const a = renderVariant(id, 44100, v);
        expect(renderVariant(id, 44100, v)).toEqual(a);
        expect(a).not.toEqual(render(id));
        const { peak } = stats(a);
        expect(peak).toBeLessThanOrEqual(1);
        expect(Math.abs(a[0]!)).toBeLessThan(0.02);
        expect(Math.abs(a[a.length - 1]!)).toBeLessThan(0.02);
      }
    }
  });

  test("renders everything quickly", () => {
    const t0 = performance.now();
    for (const id of SOUND_IDS) renderSound(id, 48000);
    // Typically ~200 ms; generous bound for slow CI machines.
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("loudness targets", () => {
  for (const id of SOUND_IDS) {
    test(`${id} meets its ${CATEGORY_OF[id]} target`, () => {
      const buf = render(id);
      const target = loudnessFor(id, candidateOf(id));
      const level = LOOPS.has(id)
        ? db(stats(buf).rms)
        : db(shortTermMaxRms(buf, 44100));
      expect(Math.abs(level - target.rmsDb)).toBeLessThan(1.5);
      expect(db(stats(buf).peak)).toBeLessThanOrEqual(target.peakDb + 0.01);
    });
  }

  test("category ordering", () => {
    const level = (id: SoundId) => loudnessFor(id, candidateOf(id)).rmsDb;
    // Hard impacts above footsteps; footsteps above handling; ambience below
    // everything.
    expect(level("impact_wood")).toBeGreaterThan(level("footstep_concrete"));
    expect(level("footstep_concrete")).toBeGreaterThan(level("pickup"));
    // The rejected break design was set loudest by plain RMS. The new ones
    // are brighter, so they are compared by K-weighted loudness: a break
    // still lands at least about as loud as a hard wooden impact.
    expect(LOUDNESS.crate_break.rmsDb).toBeGreaterThanOrEqual(
      LOUDNESS.impact_wood.rmsDb,
    );
    expect(kLoudnessDb(render("crate_break"), 44100)).toBeGreaterThan(
      kLoudnessDb(render("impact_wood"), 44100) - 1,
    );
    for (const id of LOOPING_SOUNDS) {
      for (const other of SOUND_IDS) {
        if (!LOOPS.has(other)) expect(level(id)).toBeLessThan(level(other));
      }
    }
  });

  test("debris has the lowest voice priority", () => {
    expect(PRIORITY_OF.impact).toBe(PRIORITY.debris);
    expect(PRIORITY_OF.footstep).toBe(PRIORITY.player);
    expect(PRIORITY_OF.door).toBeGreaterThan(PRIORITY_OF.impact);
  });
});

describe("design targets", () => {
  /** True if `freq` is within `tolerance` (relative) of some designed mode. */
  const nearMode = (freq: number, modes: readonly Mode[], tolerance = 0.03) =>
    modes.some((m) => Math.abs(freq - m.freq) / m.freq < tolerance);

  const impacts: [SoundId, readonly Mode[]][] = [
    ["impact_wood", WOOD_CRATE_MODES],
    ["impact_metal", STEEL_DRUM_MODES],
    ["impact_plastic", PLASTIC_SHELL_MODES],
  ];
  for (const [id, modes] of impacts) {
    // Metal: only the rejected modal design has fixed modes to find.
    test(`${id}: strongest peaks are the designed modes (current design)`, () => {
      const buf = renderTake(id, "current");
      const peaks = spectralPeaks(
        powerSpectrum(buf, 0, buf.length, 8192),
        44100,
        6,
        15,
        100,
      );
      const hits = peaks.filter((p) => nearMode(p.freq, modes)).length;
      expect(hits).toBeGreaterThanOrEqual(5);
    });
  }

  test("modal decay: metal > wood > plastic, at every mode frequency", () => {
    for (const f of [200, 500, 1000, 2000]) {
      expect(modeTau(f, MATERIALS.steel)).toBeGreaterThan(
        3 * modeTau(f, MATERIALS.wood),
      );
      expect(modeTau(f, MATERIALS.wood)).toBeGreaterThan(
        modeTau(f, MATERIALS.plastic),
      );
    }
    // The rejected metal design rang for over a second; the new ones are
    // short on purpose (their own decay ranges are tested under
    // "candidates"), so the 2x-wood rule holds for "current" only.
    const decay = (id: SoundId) =>
      describeSound(renderTake(id, "current"), 44100).decay40Ms;
    expect(decay("impact_metal")).toBeGreaterThan(2 * decay("impact_wood"));
    expect(decay("impact_wood")).toBeGreaterThan(1.5 * decay("impact_plastic"));
  });

  test("footsteps (current design): tile brightest at onset, metal longest and most tonal", () => {
    const d = (id: SoundId) => describeSound(renderTake(id, "current"), 44100);
    const concrete = d("footstep_concrete");
    const tile = d("footstep_tile");
    const metal = d("footstep_metal");
    expect(tile.centroidOnset).toBeGreaterThan(concrete.centroidOnset * 1.15);
    expect(concrete.centroidOnset).toBeGreaterThan(metal.centroidOnset);
    expect(metal.decay40Ms).toBeGreaterThan(2 * concrete.decay40Ms);
    expect(metal.decay40Ms).toBeGreaterThan(2 * tile.decay40Ms);
    expect(metal.flatness).toBeLessThan(concrete.flatness / 5);
    expect(metal.flatness).toBeLessThan(tile.flatness / 5);
    // All three sit below impacts in level and cut through with a sharp attack.
    for (const s of [concrete, tile, metal]) expect(s.attackMs).toBeLessThan(3);
  });

  test("door open peaks at the start (release), close at the end (seal)", () => {
    const loudestAt = (id: SoundId) => {
      const env = envelope(render(id), 44100, 0.01, 0.05);
      let best = 0;
      for (let i = 0; i < env.length; i++) if (env[i]! > env[best]!) best = i;
      return best / env.length;
    };
    expect(loudestAt("door_open")).toBeLessThan(0.15);
    expect(loudestAt("door_close")).toBeGreaterThan(0.65);
    // The close's seal is a heavier, lower thud than the open's latch.
    const tail = (id: SoundId) => {
      const buf = render(id);
      const from = Math.round(buf.length * 0.7);
      return describeSound(buf.subarray(from), 44100);
    };
    expect(tail("door_close").rms50Db).toBeGreaterThan(
      tail("door_open").rms50Db + 3,
    );
  });

  test("plate_down is lower pitched than plate_up", () => {
    const d = (id: SoundId) => describeSound(render(id), 44100).centroid;
    expect(d("plate_down")).toBeLessThan(d("plate_up"));
  });

  test("button_deny is lower and rougher than button_press", () => {
    const d = (id: SoundId) => describeSound(render(id), 44100);
    expect(d("button_deny").centroidTail).toBeLessThan(
      d("button_press").centroidTail,
    );
    expect(d("button_deny").decay20Ms).toBeGreaterThan(
      d("button_press").decay20Ms,
    );
  });

  test("fluorescent hum is strongest at twice the mains frequency", () => {
    const sr = 44100;
    const buf = render("hum_fluorescent", sr);
    const candidates = [30, 50, 60, 80, 100, 120, 180, 240, 300, 360, 480, 600];
    let best = 0;
    let bestMag = -1;
    for (const f of candidates) {
      const m = goertzel(buf, f, sr);
      if (m > bestMag) {
        bestMag = m;
        best = f;
      }
    }
    expect([100, 120]).toContain(best);
  });

  for (const id of LOOPING_SOUNDS) {
    test(`${id} does not expose its loop length`, () => {
      const stats = loopEnvelopeStats(render(id), 44100);
      // No swell once (or two or three times) per loop deeper than 5%...
      expect(stats.loopModulation).toBeLessThan(0.05);
      // ...and no discrete events standing out of the texture.
      expect(stats.spreadDb).toBeLessThan(4);
    });
  }

  test("ambience has no sub-heavy drone", () => {
    for (const id of LOOPING_SOUNDS) {
      const bands = describeSound(render(id), 44100).bands;
      expect(bands.sub).toBeLessThan(0.3);
    }
  });
});

describe("candidates (listening round 1)", () => {
  const NEW = ["A", "B", "C"] as const;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const desc = (id: SoundId, c: Candidate, take = 0) =>
    describeSound(renderTake(id, c, take), 44100);

  for (const family of FAMILIES) {
    for (const c of CANDIDATE_NAMES) {
      for (const id of FAMILY_SOUNDS[family]) {
        test(`${id} [${c}]: every take well formed, on target, deterministic`, () => {
          const target = loudnessFor(id, c);
          const [lo, hi] = durationRange(id, c);
          for (let v = 0; v < VARIANTS[id]; v++) {
            for (const sr of v === 0 ? RATES : [44100]) {
              const buf = renderTake(id, c, v, sr);
              for (const x of buf) expect(Number.isFinite(x)).toBe(true);
              const { peak, mean: m } = stats(buf);
              expect(peak).toBeLessThanOrEqual(1);
              expect(db(peak)).toBeLessThanOrEqual(target.peakDb + 0.01);
              // DC-free (same tolerance as every other sound).
              expect(Math.abs(m)).toBeLessThan(0.01 * Math.max(peak, 0.1));
              // Click-free start and end.
              for (let i = 0; i < 3; i++) {
                expect(Math.abs(buf[i]!)).toBeLessThan(0.02);
                expect(Math.abs(buf[buf.length - 1 - i]!)).toBeLessThan(0.02);
              }
              const level = db(shortTermMaxRms(buf, sr));
              expect(Math.abs(level - target.rmsDb)).toBeLessThan(1.5);
              const seconds = buf.length / sr;
              expect(seconds).toBeGreaterThanOrEqual(lo);
              expect(seconds).toBeLessThanOrEqual(hi);
            }
          }
          // Deterministic, and the takes really differ.
          expect(renderVariant(id, 44100, 0, c)).toEqual(renderTake(id, c));
          if (VARIANTS[id] > 1)
            expect(renderTake(id, c, 1)).not.toEqual(renderTake(id, c, 0));
        });
      }
    }
  }

  test("footsteps A and C have no pitched peak; the rejected design does", () => {
    // The tonal-peak measure over all takes of a sound: what repeats from
    // step to step is what the ear hears as a tone in a walk.
    const tonal = (id: SoundId, c: Candidate) =>
      tonalPeak(eventSpectrum(takes(id, c)), 44100).db;
    for (const c of ["A", "C"] as const) {
      for (const id of FAMILY_SOUNDS.footsteps) {
        expect(tonal(id, c)).toBeLessThan(TONAL_LIMIT_DB);
      }
    }
    // Sanity: the measure flags the rejected tile and grate steps.
    expect(tonal("footstep_tile", "current")).toBeGreaterThan(15);
    expect(tonal("footstep_metal", "current")).toBeGreaterThan(15);
    expect(tonal("impact_metal", "current")).toBeGreaterThan(15);
  });

  test("footsteps: soft onsets for A and C, surfaces stay distinct", () => {
    for (const c of NEW) {
      const onset = (id: SoundId) =>
        mean(takes(id, c).map((b) => describeSound(b, 44100).centroidOnset));
      // Tile is the brighter surface, the grate the longer one.
      expect(onset("footstep_tile")).toBeGreaterThan(
        1.1 * onset("footstep_concrete"),
      );
      expect(desc("footstep_metal", c).duration).toBeGreaterThanOrEqual(
        desc("footstep_concrete", c).duration,
      );
    }
    for (const c of ["A", "C"] as const) {
      for (const id of ["footstep_concrete", "footstep_tile"] as const) {
        const attack = mean(
          takes(id, c).map((b) => describeSound(b, 44100).attackMs),
        );
        expect(attack).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("footstep candidates differ: C darkest, B brightest", () => {
    const onset = (c: Candidate) =>
      mean(
        ["footstep_concrete", "footstep_tile", "footstep_metal"].map(
          (id) => desc(id as SoundId, c).centroidOnset,
        ),
      );
    expect(onset("B")).toBeGreaterThan(1.3 * onset("A"));
    expect(onset("A")).toBeGreaterThan(1.5 * onset("C"));
    // And all three sit well below the rejected design's brightness.
    expect(onset("current")).toBeGreaterThan(onset("A"));
  });

  test("metal candidates keep their decay ranges and differ", () => {
    const d40 = (c: Candidate) =>
      takes("impact_metal", c).map((b) => describeSound(b, 44100).decay40Ms);
    for (const v of d40("A")) {
      expect(v).toBeGreaterThanOrEqual(200);
      expect(v).toBeLessThanOrEqual(300);
    }
    for (const v of d40("B")) {
      expect(v).toBeGreaterThanOrEqual(300);
      expect(v).toBeLessThanOrEqual(450);
    }
    for (const v of d40("C")) expect(v).toBeLessThan(200);
    expect(mean(d40("B"))).toBeGreaterThan(1.25 * mean(d40("A")));
    expect(mean(d40("A"))).toBeGreaterThan(1.6 * mean(d40("C")));
    // The clank is bright; the drum is dull.
    expect(desc("impact_metal", "A").centroidOnset).toBeGreaterThan(
      2 * desc("impact_metal", "B").centroidOnset,
    );
    // None rings like the rejected design.
    for (const c of NEW)
      expect(mean(d40(c))).toBeLessThan(0.5 * mean(d40("current")));
  });

  test("break candidates keep their lengths and differ", () => {
    const dur = (c: Candidate) =>
      mean(takes("crate_break", c).map((b) => b.length / 44100));
    expect(dur("B")).toBeLessThan(0.8 * dur("A"));
    expect(dur("C")).toBeGreaterThan(1.3 * dur("A"));
    // C is the quietest break.
    const k = (c: Candidate) =>
      kLoudnessDb(renderTake("crate_break", c), 44100);
    expect(k("C")).toBeLessThan(k("A") - 1);
    expect(k("C")).toBeLessThan(k("B") - 1);
  });

  test("defaults are new designs, and only they render at start-up", () => {
    for (const f of FAMILIES) expect(CANDIDATES[f]).not.toBe("current");
    // The whole default set (every take) renders well within budget.
    const t0 = performance.now();
    for (const id of SOUND_IDS)
      for (let v = 0; v < VARIANTS[id]; v++) renderVariant(id, 48000, v);
    // Typically ~300 ms; generous bound for slow CI machines.
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("sfx query", () => {
  test("parses families and candidates, case-insensitively", () => {
    expect(parseSfx("?sfx=footsteps:B,impact_metal:C,crate_break:A")).toEqual({
      footsteps: "B",
      impact_metal: "C",
      crate_break: "A",
    });
    expect(parseSfx("SFX=Footsteps:b,METAL:current")).toEqual({
      footsteps: "B",
      impact_metal: "current",
    });
    expect(parseSfx("?harness&sfx=break:c&x=1")).toEqual({ crate_break: "C" });
    expect(parseSfx("?sfx=footsteps%3AC%2Cmetal%3AB")).toEqual({
      footsteps: "C",
      impact_metal: "B",
    });
  });

  test("ignores unknown keys, values and malformed pairs", () => {
    expect(parseSfx("")).toEqual({});
    expect(parseSfx("?harness")).toEqual({});
    expect(parseSfx("?sfx=")).toEqual({});
    expect(parseSfx("?sfx=doors:A,footsteps:D,metal,crate_break:A:B")).toEqual(
      {},
    );
    expect(parseSfx("?sfx=footsteps:A,footsteps:C")).toEqual({
      footsteps: "C",
    });
    expect(parseSfx("?other=footsteps:B")).toEqual({});
    expect(parseSfx("?sfx=%E0%A4%A")).toEqual({});
  });

  test("formatSfx round-trips", () => {
    const s = { footsteps: "B", impact_metal: "C", crate_break: "A" } as const;
    expect(parseSfx(`?sfx=${formatSfx(s)}`)).toEqual(s);
    expect(formatSfx(s)).toBe("footsteps:B,impact_metal:C,crate_break:A");
  });

  test("family membership", () => {
    expect(familyOf("footstep_tile")).toBe("footsteps");
    expect(familyOf("land")).toBe("footsteps");
    expect(familyOf("impact_metal")).toBe("impact_metal");
    expect(familyOf("crate_break")).toBe("crate_break");
    expect(familyOf("impact_wood")).toBeNull();
    expect(candidateOf("impact_wood")).toBe("current");
  });
});

describe("fft", () => {
  test("transform of a bin-centred sine", () => {
    const n = 256;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 10 * i) / n);
    fft(re, im);
    for (let k = 0; k < n; k++) {
      const mag = Math.hypot(re[k]!, im[k]!);
      if (k === 10 || k === n - 10) expect(mag).toBeCloseTo(n / 2, 6);
      else expect(mag).toBeLessThan(1e-6);
    }
  });

  test("inverse round trip", () => {
    const rng = createRng(3);
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const orig = new Float64Array(n);
    for (let i = 0; i < n; i++) orig[i] = re[i] = rng.next() - 0.5;
    fft(re, im);
    fft(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]! / n).toBeCloseTo(orig[i]!, 9);
      expect(im[i]! / n).toBeCloseTo(0, 9);
    }
  });

  test("rejects non-power-of-two lengths", () => {
    expect(() => fft(new Float64Array(100), new Float64Array(100))).toThrow();
  });

  test("hann window", () => {
    const w = hann(8);
    expect(w[0]).toBe(0);
    expect(w[4]).toBeCloseTo(1, 12);
    expect(w[1]).toBeCloseTo(w[7]!, 12);
  });

  test("magnitude spectrum reads a full-scale sine as ~0 dB at its frequency", () => {
    const sr = 48000;
    const size = 1024;
    const freq = (100 * sr) / size; // bin-centred
    const mag = magnitudeSpectrum(sine(freq, sr, size), size);
    expect(mag[100]).toBeCloseTo(1, 2);
    expect(mag[300]).toBeLessThan(1e-3);
  });

  test("stft tracks a frequency change over time", () => {
    const sr = 16000;
    const half = 8000;
    const buf = new Float32Array(2 * half);
    buf.set(sine(500, sr, half), 0);
    buf.set(sine(3000, sr, half), half);
    const spec = stft(buf, sr, 512, 256);
    const peakBin = (frame: Float64Array) => {
      let b = 0;
      for (let k = 0; k < frame.length; k++) if (frame[k]! > frame[b]!) b = k;
      return (b * sr) / 512;
    };
    expect(Math.abs(peakBin(spec.frames[5]!) - 500)).toBeLessThan(40);
    expect(
      Math.abs(peakBin(spec.frames[spec.frames.length - 5]!) - 3000),
    ).toBeLessThan(40);
    expect(spec.frames[5]![Math.round((500 * 512) / sr)]!).toBeGreaterThan(-3);
  });

  test("periodic noise follows its spectral shape and wraps without a seam", () => {
    const rng = createRng(9);
    const n = 1 << 14;
    const sr = 16000;
    const [a, b] = periodicNoisePair(
      () => rng.next(),
      n,
      sr,
      (f) => (f > 1000 && f < 2000 ? 1 : 0),
      () => 1,
    );
    expect(stats(a).rms).toBeCloseTo(1, 3);
    expect(stats(b).rms).toBeCloseTo(1, 3);
    const p = powerSpectrum(a, 0, n, 1024);
    let inBand = 0;
    let total = 0;
    for (let k = 0; k < p.length; k++) {
      const f = (k * sr) / 1024;
      total += p[k]!;
      if (f > 900 && f < 2100) inBand += p[k]!;
    }
    expect(inBand / total).toBeGreaterThan(0.97);
    expect(seamDiscontinuity(a)).toBeLessThan(3);
  });
});

describe("analysis", () => {
  test("spectral peaks find two sines", () => {
    const sr = 44100;
    const n = 16384;
    const buf = sine(440, sr, n);
    const other = sine(1330, sr, n, 0.5);
    for (let i = 0; i < n; i++) buf[i] = buf[i]! + other[i]!;
    const peaks = spectralPeaks(powerSpectrum(buf, 0, n, 8192), sr, 2);
    expect(Math.abs(peaks[0]!.freq - 440)).toBeLessThan(2);
    expect(Math.abs(peaks[1]!.freq - 1330)).toBeLessThan(2);
    expect(peaks[0]!.db - peaks[1]!.db).toBeCloseTo(6, 0);
  });

  test("attack, decay and level of a known envelope", () => {
    const sr = 44100;
    const n = sr;
    const buf = new Float32Array(n);
    // 20 ms linear rise, then exponential decay with tau 50 ms.
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = t < 0.02 ? t / 0.02 : Math.exp(-(t - 0.02) / 0.05);
      buf[i] = env * Math.sin(2 * Math.PI * 2000 * t);
    }
    const d = describeSound(buf, sr);
    expect(d.attackMs).toBeGreaterThan(13);
    expect(d.attackMs).toBeLessThan(19);
    // -20 dB after tau * ln(10) = 115 ms; -40 dB after 230 ms.
    expect(Math.abs(d.decay20Ms - 115)).toBeLessThan(8);
    expect(Math.abs(d.decay40Ms - 230)).toBeLessThan(10);
    expect(Math.abs(d.centroid - 2000)).toBeLessThan(80);
    expect(d.bands.highMid).toBeGreaterThan(0.9);
  });

  test("seam discontinuity", () => {
    const n = 44100;
    const whole = sine(100, 44100, n); // exactly 100 cycles
    expect(seamDiscontinuity(whole)).toBeLessThan(1);
    const broken = sine(100.25, 44100, n);
    expect(seamDiscontinuity(broken)).toBeGreaterThan(10);
  });

  test("loop envelope stats detect a once-per-loop swell", () => {
    const rng = createRng(4);
    const n = 44100 * 4;
    const flat = new Float32Array(n);
    const swell = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = rng.next() * 2 - 1;
      flat[i] = x;
      swell[i] = x * (1 + 0.5 * Math.sin((2 * Math.PI * i) / n));
    }
    expect(loopEnvelopeStats(flat, 44100).loopModulation).toBeLessThan(0.02);
    expect(loopEnvelopeStats(swell, 44100).loopModulation).toBeGreaterThan(0.3);
  });
});

describe("era treatment", () => {
  test("removes content above the emulated Nyquist frequency", () => {
    const sr = 44100;
    const n = sr / 2;
    const high = sine(15000, sr, n);
    const low = sine(1000, sr, n);
    applyEra(high, sr, { rate: 22050, amount: 1, bits: 0 });
    applyEra(low, sr, { rate: 22050, amount: 1, bits: 0 });
    const tail = (b: Float32Array) => stats(b.subarray(2000)).rms;
    expect(db(tail(high) / Math.SQRT1_2)).toBeLessThan(-30);
    expect(Math.abs(db(tail(low) / Math.SQRT1_2))).toBeLessThan(1);
  });

  test("adds no jitter distortion at 48 kHz", () => {
    // Residual after removing the best-fit sine: what the treatment added.
    const residualDb = (sr: number, f: number) => {
      const n = 9600;
      const s = sine(f, sr, n);
      applyEra(s, sr, { rate: 22050, amount: 1, bits: 0 });
      let a = 0;
      let b = 0;
      let p = 0;
      let e = 0;
      const from = 2000;
      const to = n - 200;
      const w = (2 * Math.PI * f) / sr;
      for (let i = from; i < to; i++) {
        a += s[i]! * Math.sin(w * i);
        b += s[i]! * Math.cos(w * i);
        p += s[i]! * s[i]!;
      }
      a = (2 * a) / (to - from);
      b = (2 * b) / (to - from);
      for (let i = from; i < to; i++)
        e += (s[i]! - a * Math.sin(w * i) - b * Math.cos(w * i)) ** 2;
      return 10 * Math.log10(e / p);
    };
    // Nearest-sample decimation left -36 dB at 500 Hz and -24 dB at 2 kHz.
    expect(residualDb(48000, 500)).toBeLessThan(-50);
    expect(residualDb(48000, 2000)).toBeLessThan(-33);
  });

  test("bit reduction quantises", () => {
    const buf = sine(1000, 44100, 1000);
    applyEra(buf, 44100, { rate: 0, amount: 1, bits: 4 });
    const levels = new Set(Array.from(buf).map((v) => v.toFixed(6)));
    expect(levels.size).toBeLessThanOrEqual(17);
  });
});

describe("clamping", () => {
  test("gain and pitch", () => {
    expect(clampGain(undefined)).toBe(1);
    expect(clampGain(-3)).toBe(0);
    expect(clampGain(100)).toBe(4);
    expect(clampGain(Number.NaN)).toBe(1);
    expect(clampPitch(undefined)).toBe(1);
    expect(clampPitch(0)).toBe(0.25);
    expect(clampPitch(50)).toBe(4);
    expect(clampPitch(1.1)).toBe(1.1);
  });
});

describe("distance model", () => {
  test("full level near, silent at max, monotonic between", () => {
    for (const a of Object.values(ATTENUATION)) {
      expect(distanceGain(0, a)).toBe(1);
      expect(distanceGain(a.ref, a)).toBe(1);
      expect(distanceGain(a.max, a)).toBe(0);
      expect(distanceGain(a.max + 5, a)).toBe(0);
      let last = 1;
      for (let d = 0; d < a.max; d += 0.25) {
        const g = distanceGain(d, a);
        expect(g).toBeLessThanOrEqual(last);
        last = g;
      }
      expect(distanceCutoff(0, a)).toBe(20000);
      expect(distanceCutoff(a.max, a)).toBeCloseTo(2500, 6);
      // Wetter with distance: the send falls slower than the dry level.
      expect(distanceSend(8, a)).toBeGreaterThan(distanceGain(8, a));
    }
  });

  test("a hum 10 m away is faint; an impact 10 m away is clearly audible", () => {
    expect(db(distanceGain(10, ATTENUATION.ambience))).toBeLessThan(-25);
    expect(db(distanceGain(10, ATTENUATION.world))).toBeGreaterThan(-22);
  });
});

describe("voice limiter", () => {
  test("rate-limits identical sounds only", () => {
    const l = createVoiceLimiter(24, 0.03);
    expect(l.request("a", 1, 0, 0.5).play).toBe(true);
    expect(l.request("a", 1, 0.01, 0.5).play).toBe(false);
    expect(l.request("b", 1, 0.01, 0.5).play).toBe(true);
    expect(l.request("a", 1, 0.04, 0.5).play).toBe(true);
  });

  test("drops silent requests", () => {
    const l = createVoiceLimiter();
    expect(l.request("a", 0, 0, 1).play).toBe(false);
  });

  test("caps polyphony, stealing the quietest for a louder sound", () => {
    const l = createVoiceLimiter(4, 0);
    const ids: number[] = [];
    const gains = [1, 0.2, 0.8, 0.9];
    gains.forEach((g, i) => {
      const d = l.request(`s${i}`, g, 0, 1);
      expect(d.play).toBe(true);
      if (d.play) ids.push(d.id);
    });
    expect(l.active).toBe(4);
    const quiet = l.request("x", 0.05, 0.1, 1);
    expect(quiet).toEqual({ play: false, reason: "full" });
    const loud = l.request("y", 1, 0.1, 1);
    expect(loud.play).toBe(true);
    if (loud.play) expect(loud.steal).toBe(ids[1]!);
    expect(l.active).toBe(4);
  });

  test("debris never steals the player's sounds; the player steals debris", () => {
    const l = createVoiceLimiter(3, 0);
    const steps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = l.request(`step${i}`, 0.1, 0, 1, PRIORITY.player);
      if (d.play) steps.push(d.id);
    }
    expect(l.request("crash", 1, 0.01, 1, PRIORITY.debris)).toEqual({
      play: false,
      reason: "full",
    });
    const l2 = createVoiceLimiter(3, 0);
    const debris: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = l2.request(`crate${i}`, 1, 0, 1, PRIORITY.debris);
      if (d.play) debris.push(d.id);
    }
    const step = l2.request("step", 0.05, 0.01, 1, PRIORITY.player);
    expect(step.play).toBe(true);
    if (step.play) expect(debris).toContain(step.steal!);
  });

  test("expired and released voices free slots", () => {
    const l = createVoiceLimiter(2, 0);
    const a = l.request("a", 1, 0, 0.1);
    l.request("b", 1, 0, 5);
    expect(l.request("c", 0.1, 0.05, 1).play).toBe(false);
    expect(l.request("c", 0.1, 0.2, 1).play).toBe(true);
    if (a.play) l.release(a.id);
    expect(l.active).toBe(2);
  });
});

describe("impulse response", () => {
  test("shape: pre-delay, decaying energy, highs die first, no ringing", () => {
    const sr = 44100;
    const [left, right] = makeImpulseResponse(sr);
    expect(left.length).toBe(Math.round(sr * 1.1));
    expect(left).not.toEqual(right);
    const energy = (b: Float32Array, from: number, to: number) => {
      let e = 0;
      for (let i = from; i < to; i++) e += b[i]! * b[i]!;
      return e;
    };
    for (const ch of [left, right]) {
      for (const v of ch) expect(Number.isFinite(v)).toBe(true);
      // Silent pre-delay.
      for (let i = 0; i < Math.round(sr * 0.008); i++) expect(ch[i]).toBe(0);
      const q = ch.length >> 2;
      expect(energy(ch, 0, q)).toBeGreaterThan(energy(ch, q, 2 * q));
      expect(energy(ch, q, 2 * q)).toBeGreaterThan(energy(ch, 3 * q, 4 * q));
      expect(energy(ch, 0, ch.length)).toBeCloseTo(1, 3);
      // Later in the tail, the spectrum is darker than early on.
      const early = describeSound(
        ch.subarray(Math.round(sr * 0.03), Math.round(sr * 0.15)),
        sr,
      );
      const late = describeSound(
        ch.subarray(Math.round(sr * 0.4), Math.round(sr * 0.6)),
        sr,
      );
      expect(late.centroid).toBeLessThan(early.centroid);
      // Dense, not metallic: no narrow peaks standing out of the tail spectrum.
      expect(early.flatness).toBeGreaterThan(0.3);
    }
    expect(makeImpulseResponse(sr)[0]).toEqual(left);
  });
});
