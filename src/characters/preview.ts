/**
 * Dev-only: captures the character viewer headlessly into contact sheets.
 *
 *   bun src/characters/preview.ts [tag] [parts...]
 *
 * Writes to out/characters/<tag>/ (tag defaults to "latest"); parts are any
 * of lineup, faces, jaw, clips, walkpast, atlas (default: all). Sheets:
 * - lineup_<kind>.png: 8 people front, three-quarter and side;
 * - faces.png, faces_3q.png: a dozen head-and-shoulders close-ups;
 * - jaw.png: one face through a stretch of synthetic talking;
 * - clip_<name>.png: 12 frames across one cycle from a three-quarter view;
 * - walkpast.png: the walk-past mode at a few moments;
 * - atlas.png: a few texture atlases, enlarged.
 */
import { mkdirSync } from "node:fs";
import { launchGame, type GameSession } from "../../tools/browser";
import {
  contactSheets,
  createImage,
  drawLabel,
  vstack,
  type Image,
} from "../../tools/image";
import { decodePng, writePng } from "../../tools/png";
import { CLIP_NAMES, CLIP_TABLE, generateCharacter } from "./index";

const tag = process.argv[2] ?? "latest";
const wanted = new Set(process.argv.slice(3));
const want = (part: string): boolean => wanted.size === 0 || wanted.has(part);
const OUT = `out/characters/${tag}`;
mkdirSync(OUT, { recursive: true });

async function grab(session: GameSession): Promise<Image> {
  const url = await session.evaluate<string>("__viewer.capture()");
  return decodePng(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
}

function crop(image: Image, x: number, y: number, w: number, h: number): Image {
  const out = createImage(w, h);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const sx = Math.min(image.width - 1, Math.max(0, x + xx));
      const sy = Math.min(image.height - 1, Math.max(0, y + yy));
      const s = (sy * image.width + sx) * 4;
      const d = (yy * w + xx) * 4;
      out.rgba.set(image.rgba.subarray(s, s + 4), d);
    }
  }
  return out;
}

function scaleUp(image: Image, k: number): Image {
  const out = createImage(image.width * k, image.height * k);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const s = (Math.floor(y / k) * image.width + Math.floor(x / k)) * 4;
      out.rgba.set(image.rgba.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

async function save(name: string, image: Image): Promise<void> {
  await writePng(`${OUT}/${name}.png`, image.width, image.height, image.rgba);
  console.log(`wrote ${OUT}/${name}.png (${image.width}x${image.height})`);
}

async function configure(
  session: GameSession,
  change: object,
  t: number,
): Promise<void> {
  await session.evaluate(`__viewer.configure(${JSON.stringify(change)})`);
  await session.evaluate(`__viewer.setTime(${t})`);
}

async function main(): Promise<void> {
  const session = await launchGame({
    page: "demos/characters.html",
    query: "kind=scientist&count=8&seed=1&clip=idle&t=0&h=300",
    width: 1280,
    height: 720,
  });
  try {
    for (let i = 0; i < 100; i++) {
      if (await session.evaluate<boolean>("typeof __viewer === 'object'"))
        break;
      await Bun.sleep(100);
    }
    const base = {
      seed: 1,
      clip: "idle",
      look: false,
      talk: false,
      walk: false,
      orbit: false,
      cam: null,
      turn: null,
      focus: 0,
      rate: 15,
      stepped: false,
    };

    if (want("lineup")) {
      for (const kind of ["scientist", "guard"]) {
        const shots: Image[] = [];
        for (const view of ["lineup", "threequarter", "side"]) {
          await configure(session, { ...base, kind, count: 8, view }, 1.2);
          const frame = await grab(session);
          drawLabel(frame, `${kind} ${view}`, 2, 2, 1);
          shots.push(frame);
        }
        await save(`lineup_${kind}`, vstack(shots));
      }
    }

    if (want("faces")) {
      for (const [name, turn] of [
        ["faces", 0],
        ["faces_3q", -32],
      ] as const) {
        const items = [];
        for (let i = 0; i < 12; i++) {
          await configure(
            session,
            {
              ...base,
              kind: "mixed",
              count: 12,
              seed: 3,
              view: "closeup",
              focus: i,
              turn,
            },
            0.5,
          );
          const frame = await grab(session);
          const w = Math.round(frame.height * 0.75);
          items.push({
            image: crop(
              frame,
              Math.round((frame.width - w) / 2),
              0,
              w,
              frame.height,
            ),
            label: `${i}`,
          });
        }
        const [sheet] = contactSheets(items, { cols: 6, rows: 2 });
        await save(name, sheet.image);
      }
    }

    if (want("jaw")) {
      const items = [];
      for (let k = 0; k < 12; k++) {
        const t = 0.1 + k * 0.067;
        await configure(
          session,
          {
            ...base,
            kind: "scientist",
            count: 1,
            seed: 5,
            view: "closeup",
            talk: true,
            turn: -20,
          },
          t,
        );
        const frame = await grab(session);
        const w = Math.round(frame.height * 0.75);
        items.push({
          image: crop(
            frame,
            Math.round((frame.width - w) / 2),
            0,
            w,
            frame.height,
          ),
          label: `t${t.toFixed(2)}`,
        });
      }
      const [sheet] = contactSheets(items, { cols: 6, rows: 2 });
      await save("jaw", sheet.image);
    }

    // "clips" captures every clip; a clip's name captures just that one.
    if (want("clips") || CLIP_NAMES.some((c) => wanted.has(c))) {
      for (const clip of CLIP_NAMES) {
        if (!want("clips") && !wanted.has(clip)) continue;
        const info = CLIP_TABLE[clip];
        const items = [];
        const frames = 12;
        for (const kind of ["scientist", "guard"]) {
          for (let k = 0; k < frames; k++) {
            const t = info.loop
              ? (k * info.duration) / frames
              : (k * info.duration) / (frames - 1);
            await configure(
              session,
              { ...base, kind, count: 1, seed: 2, clip, view: "threequarter" },
              t,
            );
            const frame = await grab(session);
            const w = Math.round(frame.height * 0.62);
            items.push({
              image: crop(
                frame,
                Math.round((frame.width - w) / 2),
                0,
                w,
                frame.height,
              ),
              label: `${k} ${t.toFixed(2)}`,
            });
          }
        }
        const [sheet] = contactSheets(items, { cols: frames, rows: 2 });
        await save(`clip_${clip}`, sheet.image);
      }
    }

    if (want("walkpast")) {
      const shots: Image[] = [];
      for (const t of [0.5, 2.0, 3.5]) {
        await configure(
          session,
          { ...base, kind: "mixed", count: 6, walk: true, view: "lineup" },
          t,
        );
        const frame = await grab(session);
        drawLabel(frame, `walk past t${t}`, 2, 2, 1);
        shots.push(frame);
      }
      await save("walkpast", vstack(shots));
    }

    const errors = session.consoleLines.filter((l) =>
      /error|exception|warn/i.test(l),
    );
    console.log(
      `console: ${session.consoleLines.length} lines, ${errors.length} errors/warnings`,
    );
    for (const e of errors.slice(0, 10)) console.log("  " + e);
  } finally {
    await session.close();
  }

  if (want("atlas")) {
    const items = [];
    for (const [seed, kind] of [
      [1000, "scientist"],
      [1001, "guard"],
      [3004, "scientist"],
      [3005, "guard"],
    ] as const) {
      const c = generateCharacter(seed, kind);
      const img: Image = {
        width: c.atlas.size,
        height: c.atlas.size,
        rgba: c.atlas.pixels,
      };
      items.push({ image: scaleUp(img, 4), label: `${kind} ${seed}` });
    }
    const [sheet] = contactSheets(items, { cols: 2, rows: 2 });
    await save("atlas", sheet.image);
  }
}

await main();
