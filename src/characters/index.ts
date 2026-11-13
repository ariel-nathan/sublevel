/**
 * Code-generated non-player characters: low-poly rigid-part people with a
 * painted texture atlas, a fixed humanoid skeleton and clips sampled at a
 * low rate. Pure (no DOM or WebGPU); the renderer draws the parts as
 * ordinary meshes that carry their own image.
 *
 *   const person = generateCharacter(42, "scientist");
 *   const meshes = person.parts.map((part) => renderer.createMesh(part.mesh));
 *   const anim = new CharacterAnimator(person);
 *   anim.setAuto(true);
 *   // each frame:
 *   anim.update(dt, placement);
 *   items.push(...characterDrawItems(person, meshes, anim.pose(), placementMatrix(placement)));
 */
import type { Color, DrawItem, MeshHandle } from "../core/api";
import { mat4, type Mat4 } from "../math";
import type { Character } from "./generate";
import { boneMatrices, type Pose } from "./skeleton";

export {
  ANIM_SAMPLE_RATE,
  blendPoses,
  CharacterAnimator,
  ClipSampler,
  clipPose,
  DEFAULT_FADE,
  groundSpeed,
  JAW_OPEN,
  LOOK,
  lowestSole,
  placementMatrix,
  TalkEnvelope,
  type AnimatorOptions,
  type Placement,
} from "./animator";
export {
  CLIP_NAMES,
  CLIP_TABLE,
  FIDGETS,
  SCURRY,
  TURN_RATE,
  WALK,
  type ClipName,
} from "./clips";
export { generateCharacter, type Character } from "./generate";
export {
  BONE,
  BONE_NAMES,
  BONE_PARENTS,
  boneMatrices,
  restPose,
  type Pose,
  type Skeleton,
} from "./skeleton";
export {
  CHARACTER_KINDS,
  randomSpec,
  type CharacterKind,
  type CharacterSpec,
} from "./spec";

/**
 * Draw items for a posed character: one per part, each part's transform
 * being `root` times its bone's matrix. `meshes` are the renderer handles of
 * `character.parts`, in the same order.
 */
export function characterDrawItems(
  character: Character,
  meshes: readonly MeshHandle[],
  pose: Pose,
  root: Mat4,
  tint?: Color,
): DrawItem[] {
  const bones = boneMatrices(character.skeleton, pose);
  return character.parts.map((part, i) => ({
    mesh: meshes[i],
    transform: mat4.multiply(root, bones[part.bone]),
    tint,
  }));
}
