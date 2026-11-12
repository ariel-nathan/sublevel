import { expect, test } from "bun:test";
import { mat4, quat, v3, type Mat4, type Vec3 } from "./index";

function expectVec(actual: Vec3, expected: Vec3, epsilon = 1e-5): void {
  expect(v3.equalsApprox(actual, expected, epsilon)).toBe(true);
}

function expectMat(actual: Mat4, expected: Mat4, epsilon = 1e-4): void {
  for (let i = 0; i < 16; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThan(epsilon);
  }
}

test("cross product is right-handed", () => {
  expectVec(
    v3.cross(v3.create(1, 0, 0), v3.create(0, 1, 0)),
    v3.create(0, 0, 1),
  );
});

test("normalize is safe on the zero vector", () => {
  expectVec(v3.normalize(v3.create()), v3.create());
  expect(v3.length(v3.normalize(v3.create(3, 4, 0)))).toBeCloseTo(1);
});

test("axis-angle rotation follows the right-hand rule", () => {
  const q = quat.fromAxisAngle(v3.create(0, 1, 0), Math.PI / 2);
  expectVec(quat.rotate(q, v3.create(1, 0, 0)), v3.create(0, 0, -1));
});

test("yaw 0 looks along -Z, positive yaw turns left, positive pitch looks up", () => {
  const forward = v3.create(0, 0, -1);
  expectVec(quat.rotate(quat.fromYawPitch(0, 0), forward), v3.create(0, 0, -1));
  expectVec(
    quat.rotate(quat.fromYawPitch(Math.PI / 2, 0), forward),
    v3.create(-1, 0, 0),
  );
  expectVec(
    quat.rotate(quat.fromYawPitch(0, Math.PI / 2), forward),
    v3.create(0, 1, 0),
  );
});

test("multiply composes rotations, conjugate undoes them", () => {
  const a = quat.fromAxisAngle(v3.create(0, 1, 0), 0.7);
  const b = quat.fromAxisAngle(v3.create(1, 0, 0), -0.4);
  const v = v3.create(0.3, -1.2, 2);
  expectVec(
    quat.rotate(quat.multiply(a, b), v),
    quat.rotate(a, quat.rotate(b, v)),
  );
  expectVec(quat.rotate(quat.conjugate(a), quat.rotate(a, v)), v);
});

test("integrate matches axis-angle for a constant angular velocity", () => {
  let q = quat.identity();
  const steps = 1000;
  for (let i = 0; i < steps; i++) {
    q = quat.integrate(q, v3.create(0, 2, 0), 1 / steps);
  }
  const expected = quat.fromAxisAngle(v3.create(0, 1, 0), 2);
  expectVec(
    quat.rotate(q, v3.create(1, 0, 0)),
    quat.rotate(expected, v3.create(1, 0, 0)),
    1e-3,
  );
});

test("fromTRS agrees with quaternion rotation", () => {
  const q = quat.fromYawPitch(0.9, -0.3);
  const m = mat4.fromTRS(v3.create(1, 2, 3), q, v3.create(2, 2, 2));
  const p = v3.create(0.5, -0.25, 1);
  expectVec(
    mat4.transformPoint(m, p),
    v3.add(quat.rotate(q, v3.scale(p, 2)), v3.create(1, 2, 3)),
  );
});

test("view is the inverse of the camera's model matrix", () => {
  const position = v3.create(4, 1.6, -2);
  const orientation = quat.fromYawPitch(1.1, 0.2);
  const model = mat4.fromTRS(position, orientation);
  expectMat(
    mat4.multiply(mat4.view(position, orientation), model),
    mat4.identity(),
  );
});

test("invert produces the inverse of a general matrix", () => {
  const m = mat4.multiply(
    mat4.perspective(1.2, 1.5, 0.1, 50),
    mat4.fromTRS(
      v3.create(1, -2, 3),
      quat.fromYawPitch(0.4, 0.3),
      v3.create(1, 2, 3),
    ),
  );
  expectMat(mat4.multiply(m, mat4.invert(m)), mat4.identity(), 1e-3);
});

test("perspective maps near to depth 0 and far to depth 1", () => {
  const p = mat4.perspective(Math.PI / 2, 1, 0.1, 100);
  expect(mat4.transformPoint(p, v3.create(0, 0, -0.1)).z).toBeCloseTo(0, 4);
  expect(mat4.transformPoint(p, v3.create(0, 0, -100)).z).toBeCloseTo(1, 4);
  // A point up and to the right stays up and to the right in clip space.
  const corner = mat4.transformPoint(p, v3.create(1, 1, -2));
  expect(corner.x).toBeGreaterThan(0);
  expect(corner.y).toBeGreaterThan(0);
});
