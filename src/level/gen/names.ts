/**
 * A name for a generated facility, from its seed: "<Site> <Kind>, <Part>",
 * e.g. "Basalt Works, Sublevel 4". Original word lists only.
 */
import { createRng } from "../../core/rng";

const SITES = [
  "Basalt",
  "Cinder",
  "Gannet",
  "Slate",
  "Tern",
  "Fallow",
  "Marl",
  "Shale",
  "Linnet",
  "Dunlin",
  "Corrie",
  "Tarn",
  "Heron",
  "Ochre",
  "Lumen",
  "Wren",
  "Quill",
  "Sorrel",
  "Gravel",
  "Pewter",
  "Bittern",
  "Moraine",
  "Petrel",
  "Calder",
] as const;

const KINDS = [
  "Works",
  "Station",
  "Depot",
  "Complex",
  "Vault",
  "Yard",
  "Facility",
  "Reservoir",
  "Plant",
  "Institute",
] as const;

const PARTS = [
  (n: number) => `Sublevel ${n}`,
  (n: number) => `Block ${"ABCDEFGH"[n % 8]}`,
  (n: number) => `Wing ${n}`,
  (n: number) => `Deck ${n + 1}`,
  (n: number) => `Ring ${n}`,
] as const;

export function facilityName(seed: number): string {
  // Its own stream, so naming never shifts the layout's random choices.
  const rng = createRng((seed ^ 0x5a17e5) >>> 0);
  const site = SITES[rng.int(0, SITES.length - 1)];
  const kind = KINDS[rng.int(0, KINDS.length - 1)];
  const part = PARTS[rng.int(0, PARTS.length - 1)](rng.int(2, 7));
  return `${site} ${kind}, ${part}`;
}
