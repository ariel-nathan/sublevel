/**
 * Character generation: a spec (or a seed and an archetype) becomes a
 * skeleton, one rigid mesh per bone and a painted texture atlas.
 */
import type { MeshImage } from "../core/mesh";
import type { Vec3 } from "../math";
import { atlasRows, buildBody, solePoints, type CharacterPart } from "./body";
import { groundSpeed } from "./animator";
import { CLIP_TABLE, habitsFor, type Habits } from "./clips";
import { paintAtlas } from "./paint";
import { buildSkeleton, type Skeleton } from "./skeleton";
import { randomSpec, type CharacterKind, type CharacterSpec } from "./spec";

export interface Character {
  spec: CharacterSpec;
  skeleton: Skeleton;
  /** One mesh per bone that has geometry; all share `atlas`. */
  parts: CharacterPart[];
  atlas: MeshImage;
  triangleCount: number;
  /** Heel and toe points of each sole, in the foot bone's space. */
  soles: Vec3[];
  habits: Habits;
  /** Ground speed (m/s) that matches the walk clip's stride. */
  walkSpeed: number;
  /** Ground speed (m/s) that matches the scurry clip's stride. */
  scurrySpeed: number;
}

/**
 * Builds a character from a full spec, or from a seed and an archetype
 * (same seed and kind, same person).
 */
export function generateCharacter(
  specOrSeed: CharacterSpec | number,
  kind: CharacterKind = "scientist",
): Character {
  const spec =
    typeof specOrSeed === "number" ? randomSpec(specOrSeed, kind) : specOrSeed;
  const skeleton = buildSkeleton(spec);
  const rows = atlasRows(skeleton.metrics, spec);
  const atlas = paintAtlas(spec, skeleton.metrics, rows);
  const parts = buildBody(spec, skeleton, atlas);
  const triangleCount = parts.reduce(
    (sum, part) => sum + part.mesh.indices.length / 3,
    0,
  );
  const character: Character = {
    spec,
    skeleton,
    parts,
    atlas,
    triangleCount,
    soles: solePoints(skeleton, spec),
    habits: habitsFor(spec.seed, spec.build),
    walkSpeed: 0,
    scurrySpeed: 0,
  };
  // Measured from the clips on this body, so a planted foot stays planted.
  character.walkSpeed = groundSpeed(character, CLIP_TABLE.walk, 48);
  character.scurrySpeed = groundSpeed(character, CLIP_TABLE.scurry, 48);
  return character;
}
