/**
 * A fingerprint of a built level: one short hash per aspect (each mesh, the
 * colliders, lights, props, doors...), so that a refactor of how the level is
 * put together can prove the result did not change.
 *
 * Numbers are rounded to 1e-5 and order is ignored wherever it carries no
 * meaning (brushes, colliders, triangles within a mesh, doors, zones...), so
 * that merely emitting the same parts in another order gives the same
 * fingerprint. Order is kept where the game depends on it: props (physics
 * body ids and solution steps refer to the spawn index) and the indices of
 * dynamic lights (their flicker phase follows the index).
 *
 *   bun src/level/fingerprint.ts           print the current fingerprint
 *   bun src/level/fingerprint.ts --write   store it as the test fixture
 */
import type { BuiltLevel } from "../core/api";

export type Fingerprint = Record<string, string>;

/** cyrb53-style 53-bit string hash, as 14 hex digits. */
export function hashString(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

/** A number rounded to 1e-5, with -0 written as 0. */
function num(x: number): string {
  const s = x.toFixed(5);
  return s === "-0.00000" ? "0.00000" : s;
}

/** Canonical text of any JSON-like value, numbers rounded, keys sorted. */
function canon(value: unknown): string {
  if (typeof value === "number") return num(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${k}:${canon(obj[k])}`)
    .join(",")}}`;
}

const hashSorted = (items: unknown[]): string =>
  hashString(items.map(canon).sort().join("\n"));
const hashOrdered = (items: unknown[]): string =>
  hashString(items.map(canon).join("\n"));

export function fingerprintLevel(level: BuiltLevel): Fingerprint {
  const { data } = level;
  const out: Fingerprint = {};
  const meshes = [...level.meshes].sort((a, b) =>
    a.material < b.material ? -1 : 1,
  );
  for (const m of meshes) {
    const vertex = (i: number): string => {
      const parts = [
        ...m.positions.subarray(i * 3, i * 3 + 3),
        ...m.normals.subarray(i * 3, i * 3 + 3),
        ...m.uvs.subarray(i * 2, i * 2 + 2),
        ...(m.colors ? m.colors.subarray(i * 3, i * 3 + 3) : []),
      ];
      return parts.map(num).join(",");
    };
    const tris: string[] = [];
    for (let t = 0; t < m.indices.length; t += 3) {
      const v = [
        vertex(m.indices[t]),
        vertex(m.indices[t + 1]),
        vertex(m.indices[t + 2]),
      ];
      // Rotate so the smallest vertex comes first, keeping the winding.
      let k = 0;
      if (v[1] < v[k]) k = 1;
      if (v[2] < v[k]) k = 2;
      tris.push(`${v[k]};${v[(k + 1) % 3]};${v[(k + 2) % 3]}`);
    }
    tris.sort();
    out[`mesh.${m.material}`] =
      `${tris.length} tris ${hashString(tris.join("\n"))}`;
  }
  out.brushes = `${data.brushes.length} ${hashSorted(data.brushes)}`;
  out.colliders = `${level.colliders.length} ${hashSorted(level.colliders)}`;
  out.lights = `${data.lights.length} ${hashSorted(data.lights)}`;
  out.dynamicLights = hashOrdered(
    data.lights
      .map((light, index) => ({ index, light }))
      .filter((l) => l.light.flicker !== "none"),
  );
  out.props = `${data.props.length} ${hashOrdered(data.props)}`;
  out.doors = `${data.doors.length} ${hashSorted(data.doors)}`;
  out.buttons = `${data.buttons.length} ${hashSorted(data.buttons)}`;
  out.plates = `${data.plates.length} ${hashSorted(data.plates)}`;
  out.emitters = `${data.emitters.length} ${hashSorted(data.emitters)}`;
  out.zones = `${data.zones.length} ${hashSorted(data.zones)}`;
  out.exit = hashString(canon(data.exit));
  out.spawn = hashString(canon(data.playerSpawn));
  out.environment = hashString(
    canon({ name: data.name, ambient: data.ambient, fog: data.fog }),
  );
  return out;
}

if (import.meta.main) {
  const { buildLevel } = await import("./index");
  const print = fingerprintLevel(buildLevel());
  const text = `${JSON.stringify(print, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    await Bun.write(new URL("./fingerprint.json", import.meta.url), text);
    console.log("wrote src/level/fingerprint.json");
  } else {
    console.log(text);
  }
}
