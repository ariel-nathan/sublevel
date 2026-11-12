/**
 * The fixed list of surface materials. Every module refers to surfaces by
 * these ids: the texture generator produces one image per id, level and prop
 * meshes are tagged with one, and audio picks sounds from the surface kind.
 */
export const MATERIAL_IDS = [
  "concrete_wall",
  "concrete_floor",
  "ceiling_panel",
  "lab_wall",
  "lab_floor_tile",
  "metal_panel",
  "metal_grate",
  "hazard_stripe",
  "door_steel",
  "crate_wood",
  "crate_wood_weak",
  "crate_metal",
  "barrel_side",
  "barrel_top",
  "pipe",
  "plastic_white",
  "rubber_dark",
  "pressure_plate",
  "sign_warning",
  "light_panel",
  "button_red",
  "button_green",
  "monitor_screen",
] as const;

export type MaterialId = (typeof MATERIAL_IDS)[number];

/** What a surface is made of, for footstep and impact sounds. */
export type SurfaceKind =
  "concrete" | "tile" | "metal" | "wood" | "plastic" | "rubber";

export interface MaterialInfo {
  surface: SurfaceKind;
  /** Emissive surfaces ignore lighting and are drawn at full brightness. */
  emissive: boolean;
}

export const MATERIALS: Readonly<Record<MaterialId, MaterialInfo>> = {
  concrete_wall: { surface: "concrete", emissive: false },
  concrete_floor: { surface: "concrete", emissive: false },
  ceiling_panel: { surface: "plastic", emissive: false },
  lab_wall: { surface: "plastic", emissive: false },
  lab_floor_tile: { surface: "tile", emissive: false },
  metal_panel: { surface: "metal", emissive: false },
  metal_grate: { surface: "metal", emissive: false },
  hazard_stripe: { surface: "metal", emissive: false },
  door_steel: { surface: "metal", emissive: false },
  crate_wood: { surface: "wood", emissive: false },
  crate_wood_weak: { surface: "wood", emissive: false },
  crate_metal: { surface: "metal", emissive: false },
  barrel_side: { surface: "metal", emissive: false },
  barrel_top: { surface: "metal", emissive: false },
  pipe: { surface: "metal", emissive: false },
  plastic_white: { surface: "plastic", emissive: false },
  rubber_dark: { surface: "rubber", emissive: false },
  pressure_plate: { surface: "metal", emissive: false },
  sign_warning: { surface: "metal", emissive: false },
  light_panel: { surface: "plastic", emissive: true },
  button_red: { surface: "plastic", emissive: true },
  button_green: { surface: "plastic", emissive: true },
  monitor_screen: { surface: "plastic", emissive: true },
};
