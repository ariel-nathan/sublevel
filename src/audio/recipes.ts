/** One synthesis recipe per sound. Each returns a finished mono buffer. */
import type { SoundId } from "../core/api";
import type { Rng } from "../core/rng";
import {
  TAU,
  bell,
  click,
  filterCyclic,
  finishLoop,
  finishOneShot,
  makeFilter,
  mixInto,
  noiseLayer,
  normalizeRms,
  ring,
  samples,
  thud,
  whiteNoise,
} from "./dsp";

export interface RecipeContext {
  sr: number;
  rng: Rng;
}

type Recipe = (c: RecipeContext) => Float32Array;

const PEAK = 0.708; // -3 dBFS

function zeros(sr: number, seconds: number): Float32Array {
  return new Float32Array(samples(sr, seconds));
}

// --- Footsteps and body movement ------------------------------------------

const footstepConcrete: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.18);
  mixInto(
    b,
    thud(sr, {
      dur: 0.18,
      f0: 95,
      f1: 52,
      pitchTau: 0.02,
      decay: 0.05,
      amp: 1,
    }),
    sr,
  );
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.1,
      mode: "lp",
      cutoff: 1500,
      q: 0.9,
      decay: 0.022,
      amp: 0.4,
    }),
    sr,
    0.002,
  );
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.14,
      mode: "lp",
      cutoff: 450,
      decay: 0.04,
      amp: 0.3,
    }),
    sr,
  );
  return finishOneShot(b, sr, PEAK);
};

const footstepTile: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.15);
  mixInto(
    b,
    thud(sr, {
      dur: 0.15,
      f0: 140,
      f1: 85,
      pitchTau: 0.015,
      decay: 0.035,
      amp: 1,
    }),
    sr,
  );
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.08,
      mode: "bp",
      cutoff: 3200,
      q: 1.2,
      decay: 0.015,
      amp: 0.45,
    }),
    sr,
  );
  mixInto(b, click(rng, sr, 0.25, 4500), sr, 0.001);
  mixInto(b, ring(sr, { dur: 0.05, freq: 2100, decay: 0.008, amp: 0.12 }), sr);
  return finishOneShot(b, sr, PEAK);
};

const footstepMetal: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.2);
  mixInto(
    b,
    thud(sr, {
      dur: 0.2,
      f0: 120,
      f1: 72,
      pitchTau: 0.015,
      decay: 0.04,
      amp: 0.9,
    }),
    sr,
  );
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.06,
      mode: "hp",
      cutoff: 1800,
      decay: 0.012,
      amp: 0.3,
    }),
    sr,
  );
  const partials: [number, number, number][] = [
    [610, 0.07, 0.3],
    [1043, 0.05, 0.22],
    [1790, 0.035, 0.14],
  ];
  for (const [freq, decay, amp] of partials) {
    mixInto(b, ring(sr, { dur: 0.2, freq, decay, amp }), sr);
  }
  return finishOneShot(b, sr, PEAK);
};

const land: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.25);
  mixInto(
    b,
    thud(sr, {
      dur: 0.25,
      f0: 80,
      f1: 42,
      pitchTau: 0.03,
      decay: 0.07,
      amp: 1,
    }),
    sr,
  );
  mixInto(
    b,
    thud(sr, {
      dur: 0.18,
      f0: 68,
      f1: 38,
      pitchTau: 0.03,
      decay: 0.06,
      amp: 0.8,
    }),
    sr,
    0.075,
  );
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.1,
      mode: "lp",
      cutoff: 900,
      decay: 0.03,
      amp: 0.4,
    }),
    sr,
  );
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.1,
      mode: "lp",
      cutoff: 700,
      decay: 0.03,
      amp: 0.3,
    }),
    sr,
    0.075,
  );
  return finishOneShot(b, sr, PEAK);
};

const jump: Recipe = ({ sr, rng }) => {
  const b = noiseLayer(rng, sr, {
    dur: 0.12,
    mode: "bp",
    cutoff: (u) => 450 + 500 * u,
    q: 1.0,
    curve: (u) => bell(u),
    amp: 1,
  });
  return finishOneShot(b, sr, 0.22);
};

// --- Impacts ----------------------------------------------------------------

const impactWood: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.26);
  mixInto(
    b,
    thud(sr, {
      dur: 0.2,
      f0: 190,
      f1: 130,
      pitchTau: 0.02,
      decay: 0.045,
      amp: 0.8,
    }),
    sr,
  );
  const partials: [number, number, number][] = [
    [240, 0.06, 0.6],
    [455, 0.045, 0.45],
    [790, 0.03, 0.3],
    [1250, 0.02, 0.15],
  ];
  for (const [freq, decay, amp] of partials) {
    mixInto(b, ring(sr, { dur: 0.26, freq, decay, amp }), sr);
  }
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.05,
      mode: "lp",
      cutoff: 2200,
      decay: 0.008,
      amp: 0.4,
    }),
    sr,
  );
  return finishOneShot(b, sr, PEAK);
};

const impactMetal: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.45);
  const partials: [number, number, number][] = [
    [523, 0.14, 0.7],
    [1171, 0.1, 0.55],
    [1783, 0.075, 0.4],
    [2547, 0.05, 0.3],
    [3412, 0.035, 0.2],
    [4630, 0.02, 0.12],
  ];
  for (const [freq, decay, amp] of partials) {
    mixInto(b, ring(sr, { dur: 0.45, freq, decay, amp }), sr);
  }
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.03,
      mode: "hp",
      cutoff: 3000,
      decay: 0.005,
      amp: 0.7,
    }),
    sr,
  );
  mixInto(
    b,
    thud(sr, {
      dur: 0.08,
      f0: 160,
      f1: 110,
      pitchTau: 0.01,
      decay: 0.02,
      amp: 0.3,
    }),
    sr,
  );
  return finishOneShot(b, sr, PEAK);
};

const impactPlastic: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.15);
  mixInto(
    b,
    thud(sr, {
      dur: 0.15,
      f0: 760,
      f1: 480,
      pitchTau: 0.01,
      decay: 0.022,
      amp: 0.9,
    }),
    sr,
  );
  mixInto(b, ring(sr, { dur: 0.1, freq: 1480, decay: 0.012, amp: 0.3 }), sr);
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.04,
      mode: "bp",
      cutoff: 2400,
      decay: 0.006,
      amp: 0.4,
    }),
    sr,
  );
  return finishOneShot(b, sr, PEAK);
};

const crateBreak: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.62);
  // Sharp crack and low body.
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.12,
      mode: "hp",
      cutoff: 1400,
      decay: 0.02,
      amp: 1,
    }),
    sr,
  );
  mixInto(
    b,
    thud(sr, {
      dur: 0.25,
      f0: 150,
      f1: 70,
      pitchTau: 0.03,
      decay: 0.07,
      amp: 0.7,
    }),
    sr,
  );
  mixInto(b, ring(sr, { dur: 0.2, freq: 330, decay: 0.05, amp: 0.3 }), sr);
  // Splintering debris: scattered short band-passed bursts and clicks.
  for (let i = 0; i < 16; i++) {
    const t = 0.03 + rng.next() ** 1.6 * 0.5;
    const amp = 0.55 * Math.exp(-t / 0.22) * rng.range(0.4, 1);
    const burst = noiseLayer(rng, sr, {
      dur: rng.range(0.008, 0.03),
      mode: "bp",
      cutoff: rng.range(1200, 5000),
      q: 1.5,
      decay: 0.007,
      amp,
    });
    mixInto(b, burst, sr, t);
  }
  for (let i = 0; i < 12; i++) {
    const t = 0.02 + rng.next() * 0.5;
    mixInto(
      b,
      click(rng, sr, 0.5 * Math.exp(-t / 0.25), rng.range(2000, 5000)),
      sr,
      t,
    );
  }
  for (let i = 0; i < 4; i++) {
    const t = 0.05 + rng.next() * 0.3;
    mixInto(
      b,
      ring(sr, {
        dur: 0.08,
        freq: rng.range(250, 700),
        decay: 0.02,
        amp: 0.15,
      }),
      sr,
      t,
    );
  }
  return finishOneShot(b, sr, PEAK);
};

// --- Interaction ------------------------------------------------------------

const pickup: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.1);
  mixInto(
    b,
    thud(sr, {
      dur: 0.1,
      f0: 340,
      f1: 210,
      pitchTau: 0.01,
      decay: 0.016,
      amp: 0.8,
    }),
    sr,
  );
  mixInto(
    b,
    noiseLayer(rng, sr, {
      dur: 0.04,
      mode: "bp",
      cutoff: 2000,
      decay: 0.01,
      amp: 0.5,
    }),
    sr,
  );
  mixInto(b, click(rng, sr, 0.2, 2500), sr, 0.0005);
  return finishOneShot(b, sr, 0.5);
};

const throwSound: Recipe = ({ sr, rng }) => {
  const b = noiseLayer(rng, sr, {
    dur: 0.2,
    mode: "bp",
    cutoff: (u) =>
      500 + 1500 * Math.sin(Math.PI * Math.min(1, u * 1.1)) * (1 - 0.3 * u),
    q: 1.5,
    curve: (u) => bell(u) ** 0.8,
    amp: 1,
  });
  return finishOneShot(b, sr, 0.5);
};

const buttonPress: Recipe = ({ sr, rng }) => {
  const b = zeros(sr, 0.15);
  mixInto(b, click(rng, sr, 1, 2200), sr);
  mixInto(
    b,
    thud(sr, {
      dur: 0.06,
      f0: 220,
      f1: 130,
      pitchTau: 0.01,
      decay: 0.015,
      amp: 0.6,
    }),
    sr,
  );
  const blip = ring(sr, { dur: 0.08, freq: 1320, decay: 0.03, amp: 0.35 });
  for (let i = 0; i < blip.length; i++)
    blip[i] = blip[i]! * Math.min(1, i / (sr * 0.004));
  mixInto(b, blip, sr, 0.05);
  return finishOneShot(b, sr, PEAK);
};

/** Square-ish tone: odd harmonics, gated with short ramps. */
function buzzTone(
  sr: number,
  freq: number,
  dur: number,
  amp: number,
): Float32Array {
  const n = samples(sr, dur);
  const out = new Float32Array(n);
  const ramp = sr * 0.006;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const x = TAU * freq * t;
    const s =
      Math.sin(x) +
      Math.sin(3 * x) / 3 +
      Math.sin(5 * x) / 5 +
      Math.sin(7 * x) / 7;
    const gate = Math.min(1, i / ramp, (n - 1 - i) / ramp);
    // 55 Hz tremolo for a buzzy edge.
    out[i] = s * gate * amp * (0.75 + 0.25 * Math.sin(TAU * 55 * t));
  }
  return out;
}

const buttonDeny: Recipe = ({ sr }) => {
  const b = zeros(sr, 0.25);
  mixInto(b, buzzTone(sr, 150, 0.11, 1), sr);
  mixInto(b, buzzTone(sr, 105, 0.12, 1), sr, 0.12);
  return finishOneShot(b, sr, 0.6);
};

/** Pneumatic servo door. `opening` glides the motor up, otherwise down. */
function door(opening: boolean): Recipe {
  return ({ sr, rng }) => {
    const dur = opening ? 0.9 : 0.95;
    const b = zeros(sr, dur);
    const slide = 0.66;
    // Hiss of air.
    mixInto(
      b,
      noiseLayer(rng, sr, {
        dur: slide,
        mode: "bp",
        cutoff: (u) => (opening ? 2400 - 900 * u : 1400 + 1000 * u),
        q: 0.9,
        attack: 0.03,
        curve: (u) => Math.min(1, u * 8) * Math.min(1, (1 - u) * 6),
        amp: 0.26,
      }),
      sr,
      0.02,
    );
    // Servo motor tone with a few harmonics and a little wobble.
    const n = samples(sr, slide);
    const motor = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const t = i / sr;
      const eased = 1 - (1 - u) * (1 - u);
      const f0 = opening ? 85 + 150 * eased : 235 - 150 * eased;
      phase += (TAU * f0 * (1 + 0.012 * Math.sin(TAU * 9 * t))) / sr;
      const env = Math.min(1, u * 12) * Math.min(1, (1 - u) * 8);
      motor[i] =
        (Math.sin(phase) +
          0.5 * Math.sin(2 * phase) +
          0.3 * Math.sin(3 * phase) +
          0.15 * Math.sin(5 * phase)) *
        env *
        0.3;
    }
    mixInto(b, motor, sr, 0.02);
    // Heavy thunk at the end.
    const t0 = 0.02 + slide + 0.01;
    mixInto(
      b,
      thud(sr, {
        dur: 0.2,
        f0: 95,
        f1: 48,
        pitchTau: 0.02,
        decay: 0.06,
        amp: 1,
      }),
      sr,
      t0,
    );
    mixInto(
      b,
      noiseLayer(rng, sr, {
        dur: 0.08,
        mode: "lp",
        cutoff: 900,
        decay: 0.02,
        amp: 0.45,
      }),
      sr,
      t0,
    );
    mixInto(
      b,
      ring(sr, { dur: 0.15, freq: 930, decay: 0.035, amp: 0.1 }),
      sr,
      t0,
    );
    return finishOneShot(b, sr, PEAK);
  };
}

function plate(down: boolean): Recipe {
  return ({ sr, rng }) => {
    const b = zeros(sr, 0.2);
    if (down) {
      mixInto(
        b,
        thud(sr, {
          dur: 0.2,
          f0: 105,
          f1: 55,
          pitchTau: 0.02,
          decay: 0.055,
          amp: 1,
        }),
        sr,
      );
      mixInto(b, ring(sr, { dur: 0.1, freq: 780, decay: 0.03, amp: 0.2 }), sr);
      mixInto(
        b,
        ring(sr, { dur: 0.08, freq: 1340, decay: 0.02, amp: 0.12 }),
        sr,
      );
      mixInto(
        b,
        noiseLayer(rng, sr, {
          dur: 0.08,
          mode: "lp",
          cutoff: 1200,
          decay: 0.02,
          amp: 0.3,
        }),
        sr,
      );
    } else {
      mixInto(
        b,
        thud(sr, {
          dur: 0.15,
          f0: 170,
          f1: 105,
          pitchTau: 0.015,
          decay: 0.04,
          amp: 0.8,
        }),
        sr,
      );
      mixInto(
        b,
        ring(sr, { dur: 0.1, freq: 1100, decay: 0.025, amp: 0.22 }),
        sr,
      );
      mixInto(
        b,
        ring(sr, { dur: 0.08, freq: 1830, decay: 0.015, amp: 0.12 }),
        sr,
      );
      mixInto(
        b,
        noiseLayer(rng, sr, {
          dur: 0.06,
          mode: "bp",
          cutoff: 2400,
          decay: 0.012,
          amp: 0.3,
        }),
        sr,
      );
    }
    return finishOneShot(b, sr, PEAK);
  };
}

// --- Loops --------------------------------------------------------------------

/** Frequency snapped so that an integer number of periods fits the loop. */
function cyclesFor(freq: number, dur: number): number {
  return Math.max(1, Math.round(freq * dur));
}

const humFluorescent: Recipe = ({ sr, rng }) => {
  const dur = 3;
  const n = samples(sr, dur);
  const b = new Float32Array(n);
  const harmonics: [number, number][] = [
    [120, 1],
    [240, 0.45],
    [360, 0.32],
    [480, 0.14],
    [600, 0.1],
    [840, 0.06],
    [1200, 0.04],
  ];
  const wobble = [1, 2, 3, 2, 1, 3, 2];
  harmonics.forEach(([freq, amp], k) => {
    const c = cyclesFor(freq, dur);
    const ph = rng.next() * TAU;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const am = 1 + 0.1 * Math.sin(TAU * wobble[k]! * u + ph);
      const pm = 0.03 * Math.sin(TAU * 2 * u + ph);
      b[i] = b[i]! + amp * am * Math.sin(TAU * c * u + ph + pm * c * 0.02);
    }
  });
  // Mains sub-harmonic, beating gently against the main buzz.
  const c100 = cyclesFor(100, dur);
  for (let i = 0; i < n; i++)
    b[i] = b[i]! + 0.22 * Math.sin((TAU * c100 * i) / n);
  // Faint high whine, slowly drifting in level.
  const cw = cyclesFor(7200, dur);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    b[i] =
      b[i]! + 0.025 * (0.7 + 0.3 * Math.sin(TAU * u)) * Math.sin(TAU * cw * u);
  }
  // Crackly buzz noise, gated by a periodic envelope.
  const hf = filterCyclic(
    whiteNoise(rng, n),
    (() => {
      const f = makeFilter("hp", 1, sr);
      return (x: number) => f(x, 2500);
    })(),
  );
  normalizeRms(hf);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const gate = 0.5 + 0.5 * Math.sin(TAU * 120 * dur * u * 1) ** 2;
    b[i] = b[i]! + 0.035 * hf[i]! * gate;
  }
  return finishLoop(b, 0.45);
};

const humMachine: Recipe = ({ sr, rng }) => {
  const dur = 4;
  const n = samples(sr, dur);
  const b = new Float32Array(n);
  // Two close fundamentals beat at 1.5 Hz; 6 beats per loop.
  const tones: [number, number][] = [
    [48, 1],
    [49.5, 0.9],
    [96, 0.35],
    [99, 0.3],
    [147.5, 0.12],
    [195, 0.06],
  ];
  tones.forEach(([freq, amp], k) => {
    const c = cyclesFor(freq, dur);
    const ph = k * 1.3;
    for (let i = 0; i < n; i++)
      b[i] = b[i]! + amp * Math.sin((TAU * c * i) / n + ph);
  });
  // Ventilation rumble: low-passed noise plus a band of moving air.
  const lp = makeFilter("lp", 0.9, sr);
  const rumble = filterCyclic(whiteNoise(rng, n), (x) => lp(x, 220));
  normalizeRms(rumble);
  const bp = makeFilter("bp", 1.2, sr);
  const air = filterCyclic(whiteNoise(rng, n), (x) => bp(x, 650));
  normalizeRms(air);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    b[i] =
      b[i]! +
      0.45 * rumble[i]! +
      0.1 * air[i]! * (0.6 + 0.4 * Math.sin(TAU * 2 * u));
  }
  return finishLoop(b, 0.5);
};

const ambientDrone: Recipe = ({ sr, rng }) => {
  const dur = 4;
  const n = samples(sr, dur);
  const b = new Float32Array(n);
  // Low sine cluster with slow, periodic level changes.
  const cluster: [number, number, number][] = [
    [38, 1, 1],
    [41.25, 0.8, 2],
    [55.5, 0.5, 1],
    [57.75, 0.35, 3],
    [82.25, 0.18, 2],
  ];
  cluster.forEach(([freq, amp, lfo], k) => {
    const c = cyclesFor(freq, dur);
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const slow = 0.65 + 0.35 * Math.sin(TAU * lfo * u + k * 1.7);
      b[i] = b[i]! + amp * slow * Math.sin(TAU * c * u + k);
    }
  });
  // Deep filtered room tone and a faint hollow mid band.
  const lp = makeFilter("lp", 0.8, sr);
  const room = filterCyclic(whiteNoise(rng, n), (x) => lp(x, 140));
  normalizeRms(room);
  const bp = makeFilter("bp", 2, sr);
  const mid = filterCyclic(whiteNoise(rng, n), (x, i) =>
    bp(x, 300 + 80 * Math.sin((TAU * 2 * i) / n)),
  );
  normalizeRms(mid);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    b[i] =
      b[i]! +
      0.9 * room[i]! +
      0.12 * mid[i]! * (0.5 + 0.5 * Math.sin(TAU * u + 1));
  }
  return finishLoop(b, 0.3);
};

export const RECIPES: Record<SoundId, Recipe> = {
  footstep_concrete: footstepConcrete,
  footstep_tile: footstepTile,
  footstep_metal: footstepMetal,
  land,
  jump,
  impact_wood: impactWood,
  impact_metal: impactMetal,
  impact_plastic: impactPlastic,
  crate_break: crateBreak,
  pickup,
  throw: throwSound,
  button_press: buttonPress,
  button_deny: buttonDeny,
  door_open: door(true),
  door_close: door(false),
  plate_down: plate(true),
  plate_up: plate(false),
  hum_fluorescent: humFluorescent,
  hum_machine: humMachine,
  ambient_drone: ambientDrone,
};
