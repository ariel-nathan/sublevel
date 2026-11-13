/**
 * Generic hole finder for ANY level (the generic form of src/level/coverage.ts,
 * which is specific to the hand-built level): sweeps eye positions over the
 * open floor of every zone (auto-views.ts `floorPoints`) in the renderer's
 * "coverage" debug view (geometry white on pure magenta) and counts magenta
 * pixels, each of which is a missing face. At every spot the camera looks in
 * eight directions, up and down, at eye height; every other spot also at
 * crouch height. Run it with doors closed and again with them open.
 *
 *   bun tools/coverage-sweep.ts [--seed N | --rooms a,b] [--step 1.5] [--out dir]
 *
 * Exit code 0 when no pixel is magenta in either state.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LevelData } from "../src/core/api";
import { floorPoints } from "./auto-views";
import { launchGame, type GameSession } from "./browser";
import { parseArgs } from "./cli";
import { openAllDoors } from "./doors";
import { isSelected, levelQuery, levelSelector, levelTag } from "./level-args";

export interface Shot {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
}

export interface Hole extends Shot {
  magenta: number;
  state: "closed" | "open";
}

export interface SweepResult {
  state: "closed" | "open";
  shots: number;
  holes: Hole[];
}

/** The camera poses of the sweep for a level. */
export function sweepShots(level: LevelData, step: number): Shot[] {
  const shots: Shot[] = [];
  floorPoints(level, step).forEach((p, i) => {
    const heights = i % 2 === 0 ? [1.65, 0.9] : [1.65];
    for (const h of heights) {
      const pos: [number, number, number] = [p.x, p.floorY + h, p.z];
      for (let yaw = 0; yaw < 360; yaw += 45) {
        shots.push({ pos, yaw: yaw > 180 ? yaw - 360 : yaw, pitch: 0 });
      }
      shots.push({ pos, yaw: 0, pitch: 70 });
      shots.push({ pos, yaw: 90, pitch: -70 });
    }
  });
  return shots;
}

/** Counts pure-magenta pixels of each shot in the page; returns the holes found. */
export async function runSweep(
  session: GameSession,
  shots: readonly Shot[],
  state: "closed" | "open",
  out: string,
): Promise<SweepResult> {
  await session.evaluate('__harness.setDebugView("coverage")');
  const holes: Hole[] = [];
  const CHUNK = 60;
  for (let i = 0; i < shots.length; i += CHUNK) {
    const chunk = shots.slice(i, i + CHUNK);
    const results = await session.evaluate<
      { n: number; url: string | null }[]
    >(`(async () => {
      const h = window.__harness;
      const out = [];
      for (const s of ${JSON.stringify(chunk)}) {
        h.setCamera({ position: { x: s.pos[0], y: s.pos[1], z: s.pos[2] }, yawDeg: s.yaw, pitchDeg: s.pitch });
        const url = h.capture();
        const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = url; });
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const x = c.getContext("2d"); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let k = 0; k < d.length; k += 4) if (d[k] > 240 && d[k+1] < 15 && d[k+2] > 240) n++;
        out.push({ n, url: n > 0 ? url : null });
      }
      return out;
    })()`);
    for (const [k, r] of results.entries()) {
      if (r.n === 0) continue;
      const shot = chunk[k];
      holes.push({ ...shot, magenta: r.n, state });
      if (holes.length <= 10 && r.url) {
        mkdirSync(out, { recursive: true });
        writeFileSync(
          join(out, `hole-${state}-${holes.length}.png`),
          Buffer.from(r.url.split(",")[1], "base64"),
        );
      }
    }
  }
  await session.evaluate('__harness.setDebugView("none")');
  await session.evaluate("__harness.setCamera(null)");
  return { state, shots: shots.length, holes };
}

/**
 * The whole check on a session: closed, then every door opened
 * (doors.ts), then open. The session is left with doors open.
 */
export async function coverageSweep(
  session: GameSession,
  step: number,
  out: string,
): Promise<{ results: SweepResult[]; notOpened: string[] }> {
  const level = await session.evaluate<LevelData>("__game.level.data");
  const shots = sweepShots(level, step);
  const closed = await runSweep(session, shots, "closed", out);
  const report = await openAllDoors(session, level);
  const open = await runSweep(session, shots, "open", out);
  return {
    results: [closed, open],
    notOpened: report.failed.map((f) => f.door),
  };
}

export function describeSweep(results: readonly SweepResult[]): string {
  return results
    .map(
      (r) =>
        `${r.state}: ${r.shots} shots, ${r.holes.length} with holes (${r.holes.reduce((n, h) => n + h.magenta, 0)} magenta px)`,
    )
    .join("; ");
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const sel = levelSelector(args);
  const step = Number(args.options.get("step") ?? 1.5);
  const out =
    args.options.get("out") ??
    (isSelected(sel) ? `out/coverage/${levelTag(sel)}` : "out/coverage/annex");
  const started = Date.now();
  const session = await launchGame({ query: levelQuery(sel) });
  let ok = false;
  try {
    const { results, notOpened } = await coverageSweep(session, step, out);
    console.log(describeSweep(results));
    if (notOpened.length > 0) {
      console.log(`warning: doors not opened: ${notOpened.join(", ")}`);
    }
    for (const r of results) {
      for (const h of r.holes.slice(0, 8)) {
        console.log(
          `  hole (${r.state}) at (${h.pos.join(", ")}) yaw ${h.yaw} pitch ${h.pitch}: ${h.magenta} px`,
        );
      }
    }
    ok = results.every((r) => r.holes.length === 0);
    console.log(
      `${ok ? "PASS" : "FAIL"}: coverage (${((Date.now() - started) / 1000).toFixed(1)} s)`,
    );
  } finally {
    await session.close();
  }
  process.exit(ok ? 0 : 1);
}
