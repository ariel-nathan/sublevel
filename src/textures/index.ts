import type { TextureImage, TextureSet } from "../core/api";
import { MATERIAL_IDS, type MaterialId } from "../core/materials";
import { hashString } from "../core/rng";
import * as arch from "./arch";
import { buttonGreen, buttonRed, lightPanel, monitorScreen } from "./emissive";
import { Canvas, type Generator, hex, makeContext } from "./gfx";
import * as props from "./props";

interface Recipe {
  size: number;
  /** Palette size after quantising. */
  colors: number;
  /** Starting fill colour (0xRRGGBB). */
  base: number;
  generate: Generator;
}

const RECIPES: Record<MaterialId, Recipe> = {
  concrete_wall: {
    size: 128,
    colors: 20,
    base: 0x8a867e,
    generate: arch.concreteWall,
  },
  concrete_floor: {
    size: 128,
    colors: 18,
    base: 0x606060,
    generate: arch.concreteFloor,
  },
  ceiling_panel: {
    size: 64,
    colors: 14,
    base: 0xd2d0c6,
    generate: arch.ceilingPanel,
  },
  lab_wall: { size: 64, colors: 16, base: 0xdde2de, generate: arch.labWall },
  lab_floor_tile: {
    size: 64,
    colors: 16,
    base: 0xb0b8b6,
    generate: arch.labFloorTile,
  },
  metal_panel: {
    size: 64,
    colors: 20,
    base: 0x737b80,
    generate: arch.metalPanel,
  },
  metal_grate: {
    size: 64,
    colors: 14,
    base: 0x2a2e31,
    generate: arch.metalGrate,
  },
  hazard_stripe: {
    size: 64,
    colors: 14,
    base: 0xd6ab26,
    generate: arch.hazardStripe,
  },
  door_steel: {
    size: 64,
    colors: 22,
    base: 0x6a767c,
    generate: arch.doorSteel,
  },
  crate_wood: {
    size: 64,
    colors: 22,
    base: 0x946336,
    generate: props.crateWood,
  },
  crate_wood_weak: {
    size: 64,
    colors: 22,
    base: 0xc4a578,
    generate: props.crateWoodWeak,
  },
  crate_metal: {
    size: 64,
    colors: 22,
    base: 0x6f7a5f,
    generate: props.crateMetal,
  },
  barrel_side: {
    size: 64,
    colors: 20,
    base: 0x3f6c87,
    generate: props.barrelSide,
  },
  barrel_top: {
    size: 64,
    colors: 18,
    base: 0x4c5c68,
    generate: props.barrelTop,
  },
  pipe: { size: 64, colors: 14, base: 0x5f8f90, generate: props.pipe },
  plastic_white: {
    size: 32,
    colors: 8,
    base: 0xd5cfb9,
    generate: props.plasticWhite,
  },
  rubber_dark: {
    size: 32,
    colors: 8,
    base: 0x2e2f33,
    generate: props.rubberDark,
  },
  pressure_plate: {
    size: 32,
    colors: 14,
    base: 0x3f464a,
    generate: arch.pressurePlate,
  },
  sign_warning: {
    size: 64,
    colors: 14,
    base: 0xe0b929,
    generate: arch.signWarning,
  },
  light_panel: { size: 32, colors: 8, base: 0xe9f4f8, generate: lightPanel },
  button_red: { size: 32, colors: 14, base: 0x4b4f55, generate: buttonRed },
  button_green: { size: 32, colors: 14, base: 0x4b4f55, generate: buttonGreen },
  monitor_screen: {
    size: 64,
    colors: 12,
    base: 0x123a24,
    generate: monitorScreen,
  },
};

/** Generates one tiling image for every material. Same seed, same pixels. */
export function createTextureSet(seed: number): TextureSet {
  const set = new Map<MaterialId, TextureImage>();
  for (const material of MATERIAL_IDS) {
    const recipe = RECIPES[material];
    const canvas = new Canvas(recipe.size, hex(recipe.base));
    recipe.generate(canvas, makeContext(seed, hashString(material)));
    set.set(material, {
      material,
      size: recipe.size,
      pixels: canvas.toRgba(recipe.colors),
    });
  }
  return set;
}
