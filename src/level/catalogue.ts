/**
 * Dev-only: prints every pair of same-facing coplanar overlapping level faces
 * (`bun src/level/catalogue.ts`). Not imported by the game.
 */
import { coplanarOverlaps, describeOverlap, levelRects } from "./coplanar";
import { defineLevel } from "./define";
import { levelAir } from "./index";
import { faceCells } from "./meshgen";

const data = defineLevel();
const label = (n: number) => `#${n} ${data.brushes[n].material}`;
const overlaps = coplanarOverlaps(
  levelRects(faceCells(data.brushes, levelAir(data)), label),
);
for (const o of overlaps) console.log(describeOverlap(o));
console.log(`${overlaps.length} overlaps`);
