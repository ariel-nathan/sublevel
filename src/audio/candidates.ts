/**
 * Listening round 1: three alternative designs (A, B, C) for each family a
 * listener rejected, next to the rejected "current" recipes in recipes.ts.
 * Which one plays is chosen per family in mix.ts (`CANDIDATES`, or `?sfx=`
 * on the page URL). See DESIGN.md, "Listening round 1", for the diagnosis
 * these designs answer.
 *
 * Common rules for all of them:
 * - Contact sounds are mostly shaped noise. Pitched content is either absent
 *   (footsteps A and C), or a crowd of irregular, heavily damped partials, so
 *   no single pitch survives from one take to the next.
 * - Onsets are shaped (raised-cosine attacks, filtered after enveloping):
 *   soft for steps, sharp only for cracks and metal contact.
 * - Every take draws its own random values, so the takes differ in detail
 *   but not in character.
 */
import type { SoundId } from "../core/api";
import {
  addAt,
  between,
  cluster,
  clusterModes,
  darken,
  grains,
  layer,
  level10,
  logBetween,
  noiseEvent,
  pieceModes,
  restrike,
  strikeModes,
  type FilterSpec,
} from "./foley";
import type { Candidate, Family } from "./mix";
import { WOOD_CRATE_MODES, buffer, type Mode } from "./modal";
import type { Recipe } from "./recipes";

type Surface = "concrete" | "tile" | "metal";
type NewCandidate = Exclude<Candidate, "current">;

/** One line per design, for the audition page. */
export const CANDIDATE_INFO: Readonly<
  Record<Family, Readonly<Record<Candidate, string>>>
> = {
  footsteps: {
    current:
      "Rejected design: pitched 'sole' knocks with sharp clicks, tile ring, a ringing grate.",
    A: "Soft boot: dull noise thump and a quiet scuff, no pitch at all; grate adds a faint noisy rattle.",
    B: "Hard sole: crisp heel tick, more scuff and grit, a little louder; grate gives a short damped clank.",
    C: "Muffled and heavy: low rounded thud, almost no highs, quiet; grate is a hollow thud with a little rattle.",
  },
  impact_metal: {
    current:
      "Rejected design: 19 clean sine modes ringing for over a second (bell-like).",
    A: "Clank: hard and short; a dense, irregular crowd of metal partials gone in about 0.25 s, with rattle.",
    B: "Hollow drum: low, dull 'bong' of an empty drum on concrete under a noisy clatter.",
    C: "Case thud: mostly a heavy thud with a brief metallic edge; the least ringing option.",
  },
  crate_break: {
    current:
      "Rejected design: noise bursts, crackle and xylophone-like plank tones over 0.8 s.",
    A: "Crack and scatter: two dry cracks, then small wooden pieces skittering away.",
    B: "Short snap: one crack and a wooden thunk, a few ticks; compact and unobtrusive.",
    C: "Splinter and clatter: tearing splinters, then planks clattering down; longer but quieter.",
  },
};

// --- Footsteps --------------------------------------------------------------------

interface StepStyle {
  /** Heel thump band-pass centre per surface, Hz. */
  thumpHz: Record<Surface, number>;
  thumpQ: number;
  thumpLp: number;
  thumpAttack: number;
  thumpDecay: Record<Surface, number>;
  /** Ball of the foot: delay range (s) and level relative to the heel. */
  ball: readonly [number, number];
  ballLevel: number;
  /** Scuff band-pass centre, 1/e decay and level per surface. */
  scuff: Record<Surface, { hz: number; decay: number; amp: number }>;
  scuffAttack: number;
  /** Heel tick (very short noise transient) level per surface; 0 = none. */
  tick: Record<Surface, number>;
  /** Fine grit grains on concrete; 0 = none. */
  grit: number;
  /** Overall low-pass, Hz (0 = none). */
  darken: number;
}

const SOFT_BOOT: StepStyle = {
  thumpHz: { concrete: 130, tile: 155, metal: 115 },
  thumpQ: 0.8,
  thumpLp: 450,
  thumpAttack: 0.005,
  thumpDecay: { concrete: 0.014, tile: 0.011, metal: 0.016 },
  ball: [0.03, 0.045],
  ballLevel: 0.42,
  scuff: {
    concrete: { hz: 1400, decay: 0.014, amp: 0.5 },
    tile: { hz: 2500, decay: 0.009, amp: 0.5 },
    metal: { hz: 1700, decay: 0.01, amp: 0.35 },
  },
  scuffAttack: 0.006,
  tick: { concrete: 0, tile: 0, metal: 0 },
  grit: 0.1,
  darken: 0,
};

const HARD_SOLE: StepStyle = {
  thumpHz: { concrete: 170, tile: 195, metal: 150 },
  thumpQ: 0.9,
  thumpLp: 650,
  thumpAttack: 0.002,
  thumpDecay: { concrete: 0.011, tile: 0.009, metal: 0.012 },
  ball: [0.048, 0.062],
  ballLevel: 0.45,
  scuff: {
    concrete: { hz: 1900, decay: 0.012, amp: 0.4 },
    tile: { hz: 2900, decay: 0.008, amp: 0.55 },
    metal: { hz: 2200, decay: 0.009, amp: 0.3 },
  },
  scuffAttack: 0.003,
  tick: { concrete: 0.5, tile: 0.85, metal: 0.45 },
  grit: 0.2,
  darken: 0,
};

const MUFFLED: StepStyle = {
  thumpHz: { concrete: 100, tile: 110, metal: 90 },
  thumpQ: 0.7,
  thumpLp: 300,
  thumpAttack: 0.007,
  thumpDecay: { concrete: 0.02, tile: 0.017, metal: 0.022 },
  ball: [0.04, 0.055],
  ballLevel: 0.5,
  scuff: {
    concrete: { hz: 650, decay: 0.014, amp: 0.28 },
    tile: { hz: 850, decay: 0.011, amp: 0.3 },
    metal: { hz: 600, decay: 0.012, amp: 0.22 },
  },
  scuffAttack: 0.008,
  tick: { concrete: 0, tile: 0, metal: 0 },
  grit: 0,
  darken: 2000,
};

const STYLES: Readonly<Record<NewCandidate, StepStyle>> = {
  A: SOFT_BOOT,
  B: HARD_SOLE,
  C: MUFFLED,
};

/** Low thump: band-passed, low-passed noise with a soft attack. */
function thumpNoise(
  sr: number,
  rng: Parameters<Recipe>[0]["rng"],
  hz: number,
  q: number,
  lp: number,
  attack: number,
  decay: number,
): Float32Array {
  return noiseEvent(sr, rng, {
    attack,
    decay,
    filters: [
      ["bp", hz, q],
      ["lp", lp, 0.707],
    ],
  });
}

function scuffNoise(
  sr: number,
  rng: Parameters<Recipe>[0]["rng"],
  hz: number,
  attack: number,
  decay: number,
): Float32Array {
  const filters: FilterSpec[] = [
    ["hp", hz * 0.45, 0.707],
    ["bp", hz, 0.9],
    ["lp", hz * 2.2, 0.707],
  ];
  return noiseEvent(sr, rng, { attack, decay, filters });
}

function tickNoise(
  sr: number,
  rng: Parameters<Recipe>[0]["rng"],
  bright: boolean,
): Float32Array {
  return noiseEvent(sr, rng, {
    attack: 0.0003,
    decay: 0.0015,
    filters: [
      ["hp", bright ? 2500 : 1800, 0.707],
      ["peak", bright ? 5000 : 3500, 1, 4],
      ["lp", 8000, 0.707],
    ],
  });
}

/** Steel grating under a step, per design. */
function grate(
  b: Float32Array,
  sr: number,
  rng: Parameters<Recipe>[0]["rng"],
  candidate: NewCandidate,
  ball: number,
): void {
  if (candidate === "A") {
    // A faint rattle in the frame: a few band-passed noise bursts, no sines.
    let t = between(rng, 0.008, 0.014);
    let amp = 0.32;
    for (let k = 0; k < 4; k++) {
      const burst = noiseEvent(sr, rng, {
        attack: 0.0008,
        decay: between(rng, 0.003, 0.005),
        filters: [
          ["bp", logBetween(rng, 1200, 3200), 3],
          ["hp", 700, 0.707],
        ],
      });
      layer(b, burst, sr, t, amp);
      t += between(rng, 0.012, 0.024);
      amp *= between(rng, 0.5, 0.7);
    }
    // The pit below: a slightly longer, lower thump.
    layer(b, thumpNoise(sr, rng, 85, 1, 260, 0.004, 0.022), sr, 0.002, 0.45);
  } else if (candidate === "B") {
    // A short, damped clank: a dense crowd of short-lived partials, then two
    // weaker re-contacts as the bar settles in its frame.
    const modes = clusterModes(rng, {
      count: 50,
      lo: 450,
      hi: 5200,
      spacing: "log",
      tilt: -0.4,
    });
    const strikeOf = (m: readonly Mode[], contact: number) =>
      strikeModes(sr, rng, m, {
        material: { d: 18, c: 28 },
        scatter: 0.5,
        contact,
        length: 0.15,
      });
    layer(b, strikeOf(modes, 0.00025), sr, 0, 0.65);
    const t1 = between(rng, 0.014, 0.022);
    layer(b, strikeOf(restrike(rng, modes), 0.0003), sr, t1, 0.3);
    const t2 = t1 + between(rng, 0.016, 0.026);
    layer(b, strikeOf(restrike(rng, modes), 0.0003), sr, t2, 0.14);
    layer(b, strikeOf(restrike(rng, modes), 0.0003), sr, ball, 0.25);
    layer(b, thumpNoise(sr, rng, 100, 1, 300, 0.002, 0.02), sr, 0.001, 0.5);
  } else {
    // A hollow, low thud with a little rattle.
    layer(b, thumpNoise(sr, rng, 70, 1.1, 220, 0.006, 0.04), sr, 0.003, 0.9);
    let t = between(rng, 0.014, 0.02);
    let amp = 0.08;
    for (let k = 0; k < 3; k++) {
      const burst = noiseEvent(sr, rng, {
        attack: 0.001,
        decay: 0.005,
        filters: [["bp", logBetween(rng, 900, 1800), 2]],
      });
      layer(b, burst, sr, t, amp);
      t += between(rng, 0.014, 0.022);
      amp *= 0.6;
    }
  }
}

function footstep(candidate: NewCandidate, surface: Surface): Recipe {
  const s = STYLES[candidate];
  return ({ sr, rng }) => {
    const b = buffer(sr, surface === "metal" ? 0.26 : 0.2);
    const ball = between(rng, s.ball[0], s.ball[1]);
    const hz = s.thumpHz[surface] * between(rng, 0.9, 1.1);
    const decay = s.thumpDecay[surface];
    // Heel, then the ball of the foot rolling down (soft, so never a flam).
    layer(
      b,
      thumpNoise(sr, rng, hz, s.thumpQ, s.thumpLp, s.thumpAttack, decay),
      sr,
      0,
      1,
    );
    layer(
      b,
      thumpNoise(
        sr,
        rng,
        hz * 1.12,
        s.thumpQ,
        s.thumpLp,
        s.thumpAttack * 1.4,
        decay * 0.85,
      ),
      sr,
      ball,
      s.ballLevel * between(rng, 0.8, 1.2),
    );
    // Sole against the floor.
    const sc = s.scuff[surface];
    const scuffHz = sc.hz * between(rng, 0.85, 1.15);
    layer(
      b,
      scuffNoise(sr, rng, scuffHz, s.scuffAttack, sc.decay),
      sr,
      between(rng, 0.001, 0.005),
      sc.amp,
    );
    layer(
      b,
      scuffNoise(sr, rng, scuffHz * 1.1, s.scuffAttack, sc.decay * 0.8),
      sr,
      ball,
      sc.amp * 0.5,
    );
    // Heel tick: a very short, unpitched transient.
    const tick = s.tick[surface];
    if (tick > 0) {
      layer(b, tickNoise(sr, rng, surface === "tile"), sr, 0, tick);
      layer(b, tickNoise(sr, rng, surface === "tile"), sr, ball, tick * 0.45);
    }
    if (candidate === "B" && surface === "tile") {
      // Hard tile: a very short, broad knock, not a ringing mode.
      const knock = noiseEvent(sr, rng, {
        attack: 0.0003,
        decay: 0.004,
        filters: [["bp", logBetween(rng, 2200, 3000), 2.2]],
      });
      layer(b, knock, sr, 0, 0.6);
    }
    if (surface === "concrete" && s.grit > 0) {
      const g = grains(sr, rng, {
        dur: 0.05,
        rate: (u) => 1800 * (1 - u) ** 1.5,
        level: (u) => 1 - u,
        length: [0.0004, 0.0012],
        centre: [2200, 6000],
        q: 1.3,
      });
      layer(b, g, sr, between(rng, 0.002, 0.006), s.grit);
    }
    if (surface === "metal") grate(b, sr, rng, candidate, ball);
    if (s.darken > 0) darken(b, sr, s.darken);
    return b;
  };
}

function landing(candidate: NewCandidate): Recipe {
  return ({ sr, rng }) => {
    const b = buffer(sr, 0.32);
    const second = between(rng, 0.008, 0.018);
    const [hz, lp, decay, attack] =
      candidate === "A"
        ? [95, 320, 0.03, 0.005]
        : candidate === "B"
          ? [140, 600, 0.026, 0.002]
          : [72, 220, 0.04, 0.007];
    // Two feet, almost together, with the body's weight behind them.
    layer(b, thumpNoise(sr, rng, hz, 0.8, lp, attack, decay), sr, 0, 1);
    layer(
      b,
      thumpNoise(sr, rng, hz * 1.08, 0.8, lp, attack, decay * 0.9),
      sr,
      second,
      0.75,
    );
    const scuffHz = candidate === "C" ? 700 : candidate === "B" ? 2000 : 1500;
    const scuffAmp = candidate === "C" ? 0.1 : candidate === "B" ? 0.45 : 0.3;
    layer(
      b,
      scuffNoise(sr, rng, scuffHz, candidate === "B" ? 0.003 : 0.006, 0.02),
      sr,
      0.002,
      scuffAmp,
    );
    if (candidate === "B") {
      layer(b, tickNoise(sr, rng, false), sr, 0, 0.5);
      layer(b, tickNoise(sr, rng, false), sr, second, 0.35);
      const g = grains(sr, rng, {
        dur: 0.07,
        rate: (u) => 2200 * (1 - u) ** 1.5,
        level: (u) => 1 - u,
        length: [0.0004, 0.0012],
        centre: [2200, 6000],
        q: 1.3,
      });
      layer(b, g, sr, 0.003, 0.25);
    }
    // Gear and clothing settling.
    const rustle = noiseEvent(sr, rng, {
      attack: 0.02,
      decay: 0.05,
      filters: [
        ["bp", candidate === "C" ? 700 : 1100, 0.6],
        ["lp", 4000, 0.707],
      ],
    });
    layer(b, rustle, sr, 0.01, candidate === "C" ? 0.05 : 0.08);
    if (candidate === "C") darken(b, sr, 1600);
    return b;
  };
}

// --- Metal impact (60 kg steel case on concrete) -------------------------------------

/** Wide-band contact transient: the instant of steel meeting concrete. */
function contactNoise(
  sr: number,
  rng: Parameters<Recipe>[0]["rng"],
  decay = 0.002,
): Float32Array {
  return noiseEvent(sr, rng, {
    attack: 0.0001,
    decay,
    filters: [
      ["hp", 700, 0.707],
      ["lp", 9000, 0.707],
    ],
  });
}

const metalClank: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.7);
  // 140 partials: a sparse, uneven set below 1.5 kHz and a dense crowd above,
  // placed at random rather than at tidy ratios.
  const modes = [
    ...clusterModes(rng, {
      count: 40,
      lo: 170,
      hi: 1500,
      spacing: "log",
      tilt: -0.2,
    }),
    ...clusterModes(rng, {
      count: 100,
      lo: 800,
      hi: 7500,
      spacing: "lin",
      tilt: -0.5,
    }),
  ];
  const ring = (m: readonly Mode[], contact: number) =>
    strikeModes(sr, rng, m, {
      material: { d: 50, c: 14 },
      scatter: 0.5,
      contact,
      length: 0.6,
      roughness: 0.4,
    });
  layer(b, ring(modes, 0.00012), sr, 0, 1);
  layer(b, contactNoise(sr, rng), sr, 0, 0.9);
  // The body slapping the floor, and its weight.
  layer(
    b,
    noiseEvent(sr, rng, {
      attack: 0.0003,
      decay: 0.007,
      filters: [["bp", 1600, 0.7]],
    }),
    sr,
    0,
    0.45,
  );
  layer(b, thumpNoise(sr, rng, 110, 0.8, 300, 0.001, 0.018), sr, 0, 0.5);
  // Rattle: the case rocks and comes down again on another edge, twice.
  const t1 = between(rng, 0.028, 0.05);
  layer(b, ring(restrike(rng, modes, 0.6), 0.0002), sr, t1, 0.38);
  layer(b, contactNoise(sr, rng), sr, t1, 0.3);
  const t2 = t1 + between(rng, 0.03, 0.06);
  layer(b, ring(restrike(rng, modes, 0.6), 0.00025), sr, t2, 0.17);
  layer(b, contactNoise(sr, rng), sr, t2, 0.14);
  return b;
};

const metalDrum: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.8);
  // A few heavily damped low shell modes: the dull "bong".
  const f0 = between(rng, 122, 140);
  const ratios = [1, 1.47, 1.93, 2.29, 2.71, 3.17];
  const gains = [1, 0.75, 0.6, 0.45, 0.35, 0.25];
  const low: Mode[] = ratios.map((r, i) => ({
    freq: f0 * r * between(rng, 0.97, 1.03),
    gain: gains[i]!,
  }));
  const bong = (m: readonly Mode[], contact: number) =>
    strikeModes(sr, rng, m, {
      material: { d: 18, c: 3 },
      scatter: 0.25,
      contact,
      length: 0.75,
      roughness: 0.2,
    });
  layer(b, bong(low, 0.0012), sr, 0, 1);
  // Air in the drum.
  layer(b, thumpNoise(sr, rng, 90, 1.2, 260, 0.002, 0.04), sr, 0, 0.55);
  // Clatter on top: noise and a short crowd of partials.
  const clatter = () =>
    cluster(sr, rng, {
      count: 60,
      lo: 700,
      hi: 5000,
      spacing: "log",
      tilt: -0.3,
      material: { d: 25, c: 30 },
      scatter: 0.5,
      contact: 0.0002,
      length: 0.25,
    });
  layer(
    b,
    noiseEvent(sr, rng, {
      attack: 0.0003,
      decay: 0.012,
      filters: [
        ["hp", 700, 0.707],
        ["bp", 2200, 0.6],
      ],
    }),
    sr,
    0,
    0.45,
  );
  layer(b, clatter(), sr, 0, 0.35);
  // The rim comes down a moment later.
  const t1 = between(rng, 0.05, 0.08);
  layer(b, bong(restrike(rng, low, 0.4), 0.0015), sr, t1, 0.3);
  layer(b, clatter(), sr, t1, 0.2);
  return b;
};

const metalThud: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.4);
  layer(
    b,
    thumpNoise(sr, rng, 170 * between(rng, 0.9, 1.1), 0.8, 500, 0.0008, 0.02),
    sr,
    0,
    1,
  );
  layer(
    b,
    noiseEvent(sr, rng, {
      attack: 0.0003,
      decay: 0.006,
      filters: [["bp", 1200, 0.7]],
    }),
    sr,
    0,
    0.55,
  );
  // A brief metallic edge: a crowd of very short high partials.
  layer(
    b,
    cluster(sr, rng, {
      count: 40,
      lo: 1500,
      hi: 6500,
      spacing: "log",
      tilt: -0.2,
      material: { d: 30, c: 45 },
      scatter: 0.5,
      contact: 0.00015,
      length: 0.2,
    }),
    sr,
    0,
    0.3,
  );
  let t = between(rng, 0.02, 0.035);
  for (const amp of [0.12, 0.06]) {
    layer(
      b,
      noiseEvent(sr, rng, {
        attack: 0.0005,
        decay: 0.004,
        filters: [["bp", logBetween(rng, 2400, 3600), 2]],
      }),
      sr,
      t,
      amp,
    );
    t += between(rng, 0.015, 0.025);
  }
  return b;
};

// --- Crate break --------------------------------------------------------------------

/** A dry wood crack: a sharp edge, then a short mid-band body. */
function crack(
  sr: number,
  rng: Parameters<Recipe>[0]["rng"],
  centre: number,
): Float32Array {
  const out = new Float32Array(Math.round(sr * 0.1));
  layer(
    out,
    noiseEvent(sr, rng, {
      attack: 0.00015,
      decay: 0.0012,
      filters: [
        ["hp", 1000, 0.707],
        ["lp", 8000, 0.707],
      ],
    }),
    sr,
    0,
    0.7,
  );
  layer(
    out,
    noiseEvent(sr, rng, {
      attack: 0.0015,
      decay: between(rng, 0.007, 0.011),
      filters: [
        ["hp", 700, 0.707],
        ["bp", centre, 0.8],
        ["lp", 4500, 0.707],
      ],
    }),
    sr,
    0,
    1,
  );
  return out;
}

/** A small piece of wood hitting the floor: damped, irregular partials + click. */
function knock(
  sr: number,
  rng: Parameters<Recipe>[0]["rng"],
  modes: readonly Mode[],
  contact: number,
  damping = { d: 10, c: 45 },
): Float32Array {
  const out = strikeModes(sr, rng, modes, {
    material: damping,
    scatter: 0.3,
    contact,
    length: 0.15,
  });
  const click = noiseEvent(sr, rng, {
    attack: 0.0001,
    decay: 0.0008,
    filters: [["hp", 1500, 0.707]],
  });
  const g = (0.6 * level10(out, sr)) / Math.max(1e-12, level10(click, sr));
  addAt(out, click, sr, 0, g);
  return out;
}

/** Adds `piece` at `at` with its 10 ms level set to `level`. */
function addLevel(
  out: Float32Array,
  piece: Float32Array,
  sr: number,
  at: number,
  level: number,
): void {
  addAt(out, piece, sr, at, level / Math.max(1e-12, level10(piece, sr)));
}

/**
 * The crate's panels giving way: its box modes, each moved by up to 8 % per
 * take (a breaking box has no fixed pitch) and heavily damped.
 */
function crateGive(
  sr: number,
  rng: Parameters<Recipe>[0]["rng"],
  d: number,
  c: number,
  contact: number,
): Float32Array {
  const modes = restrike(rng, WOOD_CRATE_MODES, 0.35).map((m) => ({
    freq: m.freq * between(rng, 0.92, 1.08),
    gain: m.gain,
  }));
  return strikeModes(sr, rng, modes, {
    material: { d, c },
    scatter: 0.3,
    contact,
    length: 0.3,
  });
}

const breakScatter: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.8);
  layer(b, crack(sr, rng, between(rng, 1500, 2200)), sr, 0, 1);
  layer(b, crateGive(sr, rng, 14, 35, 0.0005), sr, 0, 0.55);
  layer(b, thumpNoise(sr, rng, 110, 0.8, 300, 0.002, 0.025), sr, 0, 0.45);
  layer(
    b,
    crack(sr, rng, between(rng, 2000, 2800)),
    sr,
    between(rng, 0.025, 0.055),
    0.65,
  );
  // Pieces skittering away: dense at first, then sparser and quieter.
  const scatter = new Float32Array(b.length);
  const pieces = 18;
  for (let k = 0; k < pieces; k++) {
    // Stratified, so every take spreads over the full half second.
    const t = 0.05 + 0.5 * ((k + rng.next()) / pieces) ** 1.8;
    const level = Math.exp(-(t - 0.05) / 0.2) * between(rng, 0.35, 1);
    const modes = pieceModes(rng, logBetween(rng, 300, 1400), 6);
    addLevel(
      scatter,
      knock(sr, rng, modes, between(rng, 0.0003, 0.0006)),
      sr,
      t,
      level,
    );
  }
  layer(b, scatter, sr, 0, 0.5);
  return b;
};

const breakSnap: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.42);
  layer(b, crack(sr, rng, between(rng, 1600, 2300)), sr, 0, 1);
  layer(b, crateGive(sr, rng, 16, 40, 0.0007), sr, 0.002, 0.8);
  layer(b, thumpNoise(sr, rng, 100, 0.8, 300, 0.002, 0.03), sr, 0, 0.6);
  const ticks = new Float32Array(b.length);
  const times = [0, 1, 2, 3].map(() => between(rng, 0.06, 0.3)).sort();
  times.forEach((t, i) => {
    const modes = pieceModes(rng, logBetween(rng, 500, 1500), 4);
    addLevel(ticks, knock(sr, rng, modes, 0.0004), sr, t, 1 - i * 0.2);
  });
  layer(b, ticks, sr, 0, 0.28);
  return b;
};

const breakSplinter: Recipe = ({ sr, rng }) => {
  const b = buffer(sr, 0.98);
  layer(b, crack(sr, rng, between(rng, 1600, 2400)), sr, 0, 0.8);
  // Tearing fibres: a cloud of separate snaps that swells over 40 ms, then
  // thins out. Sparse and uneven (few loud grains, many small ones) so it
  // crackles instead of hissing.
  const peak = 0.12;
  const splinters = grains(sr, rng, {
    dur: 0.35,
    rate: (u) => 900 * (u < peak ? u / peak : Math.exp(-(u - peak) / 0.25)),
    level: (u) =>
      (u < peak ? 1 : Math.exp(-(u - peak) / 0.35)) * rng.next() ** 2.5,
    length: [0.0004, 0.0016],
    centre: [900, 5000],
    q: 2,
  });
  layer(b, splinters, sr, 0.002, 0.7);
  layer(b, thumpNoise(sr, rng, 105, 0.8, 300, 0.002, 0.025), sr, 0, 0.4);
  // Planks clattering down, each with a bounce or two.
  const planks = new Float32Array(b.length);
  const count = 7;
  for (let k = 0; k < count; k++) {
    const t = 0.12 + 0.62 * ((k + rng.next()) / count) ** 1.3;
    const level = Math.exp(-(t - 0.12) / 0.5) * between(rng, 0.5, 1);
    const modes = pieceModes(rng, logBetween(rng, 140, 420), 4);
    let at = t;
    for (const g of [1, 0.45, 0.2]) {
      const hit = knock(sr, rng, restrike(rng, modes, 0.4), 0.0009, {
        d: 14,
        c: 30,
      });
      addLevel(planks, hit, sr, at, level * g);
      at += between(rng, 0.025, 0.065);
    }
  }
  layer(b, planks, sr, 0, 0.45);
  return b;
};

// --- Table ------------------------------------------------------------------------

/** The new designs' recipes, per candidate and sound. */
export const CANDIDATE_RECIPES: Readonly<
  Record<NewCandidate, Partial<Record<SoundId, Recipe>>>
> = {
  A: {
    footstep_concrete: footstep("A", "concrete"),
    footstep_tile: footstep("A", "tile"),
    footstep_metal: footstep("A", "metal"),
    land: landing("A"),
    impact_metal: metalClank,
    crate_break: breakScatter,
  },
  B: {
    footstep_concrete: footstep("B", "concrete"),
    footstep_tile: footstep("B", "tile"),
    footstep_metal: footstep("B", "metal"),
    land: landing("B"),
    impact_metal: metalDrum,
    crate_break: breakSnap,
  },
  C: {
    footstep_concrete: footstep("C", "concrete"),
    footstep_tile: footstep("C", "tile"),
    footstep_metal: footstep("C", "metal"),
    land: landing("C"),
    impact_metal: metalThud,
    crate_break: breakSplinter,
  },
};
