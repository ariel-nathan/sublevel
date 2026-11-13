/**
 * `bun src/level/gen/solve-seeds.ts [first] [count] [--parallel N]`: plays
 * generated runs from their declared solutions in the real game, one
 * `bun tools/solve.ts --seed N` per seed (default seeds 1..12, 4 at a time),
 * and prints PASS/FAIL per seed with the failing step. Development only;
 * transcripts in out/solve-seeds/<seed>.txt.
 */
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const nums = args.filter(
  (a, i) => /^\d+$/.test(a) && args[i - 1] !== "--parallel",
);
const first = Number(nums[0] ?? 1);
const count = Number(nums[1] ?? 12);
const parallel = args.includes("--parallel")
  ? Number(args[args.indexOf("--parallel") + 1])
  : 4;
mkdirSync("out/solve-seeds", { recursive: true });

async function solve(seed: number): Promise<string> {
  const started = Date.now();
  const proc = Bun.spawn(["bun", "tools/solve.ts", "--seed", String(seed)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  await Bun.write(`out/solve-seeds/${seed}.txt`, `${out}\n${err}`);
  const verdict =
    out.split("\n").find((l) => l.startsWith("PASS") || l.startsWith("FAIL")) ??
    `no verdict (exit ${proc.exitCode})`;
  return `seed ${seed}: ${verdict} [${((Date.now() - started) / 1000).toFixed(0)} s]`;
}

const seeds = Array.from({ length: count }, (_, i) => first + i);
const results: string[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (next < seeds.length) {
      const seed = seeds[next++];
      const line = await solve(seed);
      console.log(line);
      results.push(line);
    }
  }),
);
const passed = results.filter((l) => l.includes("PASS")).length;
console.log(`${passed}/${seeds.length} passed`);
process.exit(passed === seeds.length ? 0 : 1);
