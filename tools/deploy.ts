// Builds the single-file game and publishes it to Cloudflare as a static site.
//
//   bun run deploy
//
// Needs the Cloudflare CLI (`cf`) on the PATH and logged in. The game is one
// HTML file, so the script writes the CLI's prebuilt layout by hand instead of
// adding a config package to the project.
import { $ } from "bun";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const WORKER = "sublevel";
const DOMAIN = "sublevel.arielnathan.com";

const root = join(import.meta.dir, "..");
const output = join(root, ".cloudflare", "output", "v0");
const worker = join(output, "workers", "default");

await $`bun run dist`.cwd(root);

await rm(join(root, ".cloudflare", "output"), { recursive: true, force: true });
await mkdir(join(worker, "assets"), { recursive: true });
await cp(
  join(root, "dist", "index.html"),
  join(worker, "assets", "index.html"),
);
await Bun.write(
  join(output, "config.json"),
  JSON.stringify({ buildContext: { isPreview: false } }),
);
await Bun.write(
  join(worker, "worker.config.json"),
  JSON.stringify({
    name: WORKER,
    compatibilityDate: "2026-11-13",
    domains: [DOMAIN],
  }),
);

const commit = (await $`git rev-parse --short HEAD`.cwd(root).text()).trim();
await $`cf deploy --prebuilt --message ${`commit ${commit}`}`.cwd(root);
console.log(`\nLive at https://${DOMAIN}`);
