import { expect, test } from "bun:test";
import { v3, type Vec3 } from "../math";
import { MeshBuilder, type MeshData } from "./mesh";

function vertex(mesh: MeshData, array: Float32Array, index: number): Vec3 {
  return v3.create(
    array[index * 3],
    array[index * 3 + 1],
    array[index * 3 + 2],
  );
}

/** Every triangle's geometric normal must agree with its vertex normals. */
function expectOutwardWinding(mesh: MeshData): void {
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [
      mesh.indices[i],
      mesh.indices[i + 1],
      mesh.indices[i + 2],
    ];
    const pa = vertex(mesh, mesh.positions, a);
    const pb = vertex(mesh, mesh.positions, b);
    const pc = vertex(mesh, mesh.positions, c);
    const face = v3.normalize(v3.cross(v3.sub(pb, pa), v3.sub(pc, pa)));
    for (const index of [a, b, c]) {
      expect(v3.dot(face, vertex(mesh, mesh.normals, index))).toBeGreaterThan(
        0.5,
      );
    }
  }
}

test("box has 6 outward-facing quads with world-scaled uvs", () => {
  const builder = new MeshBuilder("crate_wood");
  builder.addBox(v3.create(-1, 0, -2), v3.create(1, 3, 2), { tileSize: 0.5 });
  const mesh = builder.build();
  expect(mesh.positions.length / 3).toBe(24);
  expect(mesh.indices.length).toBe(36);
  expect(mesh.colors).toBeUndefined();
  expectOutwardWinding(mesh);
  // The +X face is 4 m wide and 3 m tall at 0.5 m per tile: 8 x 6 repeats.
  expect(Math.max(...mesh.uvs.slice(0, 8))).toBe(8);
});

test("box can skip faces and carry a vertex colour", () => {
  const builder = new MeshBuilder("crate_wood");
  builder.addBox(v3.create(0, 0, 0), v3.create(1, 1, 1), {
    skip: ["ny", "py"],
    color: v3.create(0.5, 0.25, 1),
  });
  const mesh = builder.build();
  expect(mesh.indices.length).toBe(24);
  expect(mesh.colors?.[1]).toBe(0.25);
});

test("cylinder is closed and winds outward", () => {
  const builder = new MeshBuilder("barrel_side");
  builder.addCylinder(v3.create(2, 0, 1), 0.3, 0.9, 12);
  const mesh = builder.build();
  expect(mesh.indices.length).toBe(12 * 6 + 12 * 3 * 2);
  expectOutwardWinding(mesh);
});
