/**
 * Development-only: prints a text summary of every synthesised sound and can
 * write 16-bit mono WAV files to out/audio/.
 *
 *   bun src/audio/preview.ts            # summary at 44100 Hz
 *   bun src/audio/preview.ts --wav      # also write out/audio/<sound>.wav
 *   bun src/audio/preview.ts jump land  # only these sounds
 */
import { mkdirSync } from "node:fs";
import { SOUND_IDS, type SoundId } from "../core/api";
import { renderSound } from "./index";

const SR = 44100;
const BLOCKS = " ▁▂▃▄▅▆▇█";

function fftMagnitudes(input: Float32Array, size: number): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const len = Math.min(size, input.length);
  for (let i = 0; i < len; i++) {
    re[i] =
      input[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1 || 1)));
  }
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let n = 2; n <= size; n <<= 1) {
    const ang = (-2 * Math.PI) / n;
    for (let i = 0; i < size; i += n) {
      for (let k = 0; k < n / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + n / 2;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i]!, im[i]!);
  return mag;
}

function centroid(buf: Float32Array): number {
  let size = 1024;
  while (size < buf.length && size < 65536) size <<= 1;
  const mag = fftMagnitudes(buf, size);
  let num = 0;
  let den = 0;
  for (let i = 1; i < mag.length; i++) {
    const p = mag[i]! * mag[i]!;
    num += p * ((i * SR) / size);
    den += p;
  }
  return den > 0 ? num / den : 0;
}

function envelope(buf: Float32Array, buckets = 40): string {
  const vals: number[] = [];
  const step = buf.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let sum = 0;
    let count = 0;
    for (let i = Math.floor(b * step); i < Math.floor((b + 1) * step); i++) {
      sum += buf[i]! * buf[i]!;
      count++;
    }
    vals.push(Math.sqrt(sum / Math.max(1, count)));
  }
  const max = Math.max(...vals, 1e-9);
  return vals
    .map((v) => BLOCKS[Math.round((v / max) * (BLOCKS.length - 1))])
    .join("");
}

function wav(buf: Float32Array): Uint8Array {
  const out = new Uint8Array(44 + buf.length * 2);
  const view = new DataView(out.buffer);
  const text = (o: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + buf.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, buf.length * 2, true);
  for (let i = 0; i < buf.length; i++) {
    view.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, buf[i]!)) * 32767),
      true,
    );
  }
  return out;
}

const args = process.argv.slice(2);
const writeWav = args.includes("--wav");
const names = args.filter((a) => !a.startsWith("--"));
const ids = (names.length ? names : [...SOUND_IDS]) as SoundId[];
if (writeWav) mkdirSync("out/audio", { recursive: true });

for (const id of ids) {
  const t0 = performance.now();
  const buf = renderSound(id, SR);
  const ms = performance.now() - t0;
  let peak = 0;
  let sum = 0;
  let sq = 0;
  for (const v of buf) {
    peak = Math.max(peak, Math.abs(v));
    sum += v;
    sq += v * v;
  }
  console.log(
    `${id.padEnd(18)} ${(buf.length / SR).toFixed(3)}s peak ${peak.toFixed(2)} ` +
      `rms ${Math.sqrt(sq / buf.length).toFixed(3)} dc ${(sum / buf.length).toExponential(1)} ` +
      `centroid ${Math.round(centroid(buf))}Hz (${ms.toFixed(1)}ms)`,
  );
  console.log(`  ${envelope(buf)}`);
  if (writeWav) await Bun.write(`out/audio/${id}.wav`, wav(buf));
}
