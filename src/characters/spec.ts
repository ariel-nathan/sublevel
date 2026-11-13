/**
 * Character specs: everything that makes one generated person different from
 * another, drawn from a seed. Pure data; the body, skeleton and atlas are
 * built from it.
 */
import { createRng, type Rng } from "../core/rng";

export const CHARACTER_KINDS = ["scientist", "guard"] as const;
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

/** Overall body shape: "a" broader shoulders, "b" narrower shoulders and wider hips. */
export type Figure = "a" | "b";

export const HAIR_STYLES = [
  "bald",
  "receding",
  "short",
  "side_part",
  "tied_back",
  "long",
] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

export type FacialHair = "none" | "stubble" | "moustache" | "beard";

/** sRGB colour as 0xRRGGBB. */
export type Hex = number;

export interface ScientistOutfit {
  type: "scientist";
  /** Coat worn open (shirt and tie show down the front) or buttoned. */
  coatOpen: boolean;
  /** Hem height as a fraction of the way from the knee (0) to the hip (1). */
  coatLength: number;
  coat: Hex;
  shirt: Hex;
  /** null for an open collar. */
  tie: Hex | null;
  tieStripes: boolean;
  trousers: Hex;
  shoes: Hex;
  badge: boolean;
  /** Pens in the breast pocket, 0 to 3. */
  pens: number;
}

export interface GuardOutfit {
  type: "guard";
  uniform: Hex;
  trousers: Hex;
  /** Accent colour of the shoulder patch and trim. */
  accent: Hex;
  cap: boolean;
  sleevesRolled: boolean;
  /** What hangs on the right of the belt. */
  beltGear: "radio" | "torch" | "both";
  boots: Hex;
}

export type Outfit = ScientistOutfit | GuardOutfit;

export interface CharacterSpec {
  kind: CharacterKind;
  seed: number;
  /** Standing height, feet to the top of the head, in metres (1.60 to 1.92). */
  height: number;
  figure: Figure;
  /** 0 slim to 1 heavy. */
  build: number;
  /** Leg length relative to the torso, -1 short legs to 1 long legs. */
  legs: number;
  /** Head size multiplier, about 0.96 to 1.06. */
  headScale: number;
  /** 0 young adult to 1 near retirement. */
  age: number;
  skin: Hex;
  hair: { style: HairStyle; color: Hex };
  facialHair: FacialHair;
  glasses: Hex | null;
  eyes: Hex;
  outfit: Outfit;
}

/** Skin tones across a realistic range, light to dark. */
export const SKIN_TONES: readonly Hex[] = [
  0xf0d0b8, 0xe6bc9c, 0xd8a47e, 0xc58b62, 0xa8704a, 0x8c5835, 0x6c4029,
  0x4f2f1f,
];

const HAIR_COLORS: readonly Hex[] = [
  0x1d1815, 0x2e2119, 0x4a3322, 0x6a4b30, 0x9c7f52, 0x7a3e24,
];
const GREY_HAIR: readonly Hex[] = [0x7d7a76, 0x9d9a95, 0xc4c2bc];

const pick = <T>(rng: Rng, items: readonly T[]): T =>
  items[Math.min(items.length - 1, Math.floor(rng.next() * items.length))];

function chance(rng: Rng, p: number): boolean {
  return rng.next() < p;
}

/** A seeded, plausible spec for an archetype. */
export function randomSpec(seed: number, kind: CharacterKind): CharacterSpec {
  const rng = createRng(
    (seed ^ (kind === "guard" ? 0x5eed0002 : 0x5eed0001)) >>> 0,
  );
  const figure: Figure = chance(rng, kind === "guard" ? 0.3 : 0.45) ? "b" : "a";
  const tall = figure === "a" ? [1.66, 1.92] : [1.6, 1.8];
  // Sum of two uniforms: heights cluster in the middle of the range.
  const height =
    tall[0] + ((rng.next() + rng.next()) / 2) * (tall[1] - tall[0]);
  const build =
    kind === "guard"
      ? 0.25 + rng.next() * 0.75
      : Math.min(1, rng.next() * rng.next() * 1.4 + rng.next() * 0.25);
  const age = rng.next();
  const skinIndex = Math.floor(rng.next() * SKIN_TONES.length);
  const skin = SKIN_TONES[skinIndex];

  // Hair: older people go grey and lose hair more often.
  let style: HairStyle;
  if (figure === "b") {
    style = pick(rng, [
      "short",
      "side_part",
      "tied_back",
      "tied_back",
      "long",
      "long",
    ]);
  } else {
    const r = rng.next();
    const loss = 0.15 + age * 0.45;
    style =
      r < loss * 0.4
        ? "bald"
        : r < loss
          ? "receding"
          : pick(rng, [
              "short",
              "short",
              "side_part",
              "side_part",
              "tied_back",
            ]);
  }
  const darkSkin = skinIndex >= 4;
  let hairColor = darkSkin
    ? pick(rng, HAIR_COLORS.slice(0, 3))
    : pick(rng, HAIR_COLORS);
  if (age > 0.55 && chance(rng, (age - 0.45) * 1.6)) {
    hairColor = pick(rng, GREY_HAIR);
  }
  const facialHair: FacialHair =
    figure === "b"
      ? "none"
      : pick(rng, ["none", "none", "none", "stubble", "moustache", "beard"]);
  const glasses = chance(rng, kind === "scientist" ? 0.45 : 0.15)
    ? pick(rng, [0x262422, 0x5a4a36, 0x8a8a90, 0x40302a])
    : null;
  const eyes = darkSkin
    ? pick(rng, [0x2a1c14, 0x3a2416])
    : pick(rng, [0x3a2416, 0x4a3a22, 0x3e5a6e, 0x4e6a48, 0x5a4a2a]);

  let outfit: Outfit;
  if (kind === "scientist") {
    const tie = chance(rng, 0.7)
      ? pick(rng, [0x6a1e22, 0x22305a, 0x2a4a2e, 0x5a3a22, 0x3a2a4a, 0x7a6a2a])
      : null;
    outfit = {
      type: "scientist",
      coatOpen: chance(rng, 0.55),
      coatLength: rng.range(0.05, 0.6),
      coat: pick(rng, [0xdedfd8, 0xd6d8d2, 0xe2e0d6, 0xcfd6d4]),
      shirt: pick(
        rng,
        [0xb6c6d8, 0xe4e2da, 0xd8ccb0, 0xc8d4c0, 0xd6d0e0, 0x9eaab8],
      ),
      tie,
      tieStripes: tie !== null && chance(rng, 0.35),
      trousers: pick(rng, [0x4a4a4e, 0x5a4a3a, 0x2e3446, 0x6e6450, 0x3a3a3a]),
      shoes: pick(rng, [0x2a1e18, 0x1e1c1c, 0x4a3020]),
      badge: chance(rng, 0.7),
      pens: rng.int(0, 3),
    };
  } else {
    // An original facility uniform: dark green or charcoal work shirt with
    // two flapped pockets, a plain shoulder patch, a black duty belt.
    const green = chance(rng, 0.5);
    outfit = {
      type: "guard",
      uniform: green
        ? pick(rng, [0x3c4a3a, 0x40503e])
        : pick(rng, [0x3e4146, 0x44474c]),
      trousers: green ? 0x343e32 : 0x34363a,
      accent: green ? 0xb09a52 : 0x8a9aa8,
      cap: chance(rng, 0.5),
      sleevesRolled: chance(rng, 0.3),
      beltGear: pick(rng, ["radio", "torch", "both"] as const),
      boots: 0x1c1a18,
    };
  }

  return {
    kind,
    seed,
    height: Math.round(height * 1000) / 1000,
    figure,
    build,
    legs: rng.range(-1, 1),
    headScale: rng.range(0.96, 1.06),
    age,
    skin,
    hair: { style, color: hairColor },
    facialHair,
    glasses,
    eyes,
    outfit,
  };
}
