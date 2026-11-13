/**
 * Development-only: renders every sound and writes, to out/audio/,
 *   <sound>.wav   16-bit mono WAV
 *   <sound>.png   waveform strip on top, log-frequency spectrogram below
 *                 (20 Hz - 20 kHz; faint lines at 100 Hz, 1 kHz, 10 kHz;
 *                 ticks every 100 ms, long ticks every second)
 *   sheet.png     contact sheet of all sounds, each scaled to its own length
 * and prints a table of objective descriptors (see analysis.ts).
 *
 *   bun src/audio/preview.ts            # everything at 44100 Hz
 *   bun src/audio/preview.ts jump land  # only these sounds
 *   bun src/audio/preview.ts --rate 48000
 */
import { mkdirSync } from "node:fs";
import { LOOPING_SOUNDS, SOUND_IDS, type SoundId } from "../core/api";
import { writePng } from "../../tools/png";
import {
  BANDS,
  describe,
  loopEnvelopeStats,
  powerSpectrum,
  seamDiscontinuity,
  spectralPeaks,
} from "./analysis";
import { stft } from "./fft";
import { renderSound } from "./index";
import { CATEGORY_OF } from "./mix";

const args = process.argv.slice(2);
const rateIndex = args.indexOf("--rate");
const SR = rateIndex >= 0 ? Number(args[rateIndex + 1]) : 44100;
const names = args.filter(
  (a, i) => !a.startsWith("--") && (rateIndex < 0 || i !== rateIndex + 1),
);
const ids = (names.length ? names : [...SOUND_IDS]) as SoundId[];
const LOOPS = new Set<SoundId>(LOOPING_SOUNDS);
mkdirSync("out/audio", { recursive: true });

// --- WAV ----------------------------------------------------------------------

function wav(buf: Float32Array, sampleRate: number): Uint8Array {
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
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
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

// --- Drawing --------------------------------------------------------------------

class Canvas {
  readonly rgba: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.rgba[i * 4 + 3] = 255;
  }
  set(x: number, y: number, r: number, g: number, b: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (Math.floor(y) * this.width + Math.floor(x)) * 4;
    this.rgba[o] = r;
    this.rgba[o + 1] = g;
    this.rgba[o + 2] = b;
  }
  blend(x: number, y: number, r: number, g: number, b: number, a: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (Math.floor(y) * this.width + Math.floor(x)) * 4;
    this.rgba[o] = this.rgba[o]! * (1 - a) + r * a;
    this.rgba[o + 1] = this.rgba[o + 1]! * (1 - a) + g * a;
    this.rgba[o + 2] = this.rgba[o + 2]! * (1 - a) + b * a;
  }
  blit(src: Canvas, ox: number, oy: number): void {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const s = (y * src.width + x) * 4;
        this.set(
          ox + x,
          oy + y,
          src.rgba[s]!,
          src.rgba[s + 1]!,
          src.rgba[s + 2]!,
        );
      }
    }
  }
}

// 3x5 pixel font for labels.
const FONT: Record<string, string> = {
  a: "111101111101101",
  b: "110101110101110",
  c: "111100100100111",
  d: "110101101101110",
  e: "111100110100111",
  f: "111100110100100",
  g: "111100101101111",
  h: "101101111101101",
  i: "111010010010111",
  j: "001001001101111",
  k: "101101110101101",
  l: "100100100100111",
  m: "101111111101101",
  n: "110101101101101",
  o: "111101101101111",
  p: "111101111100100",
  q: "111101101111001",
  r: "110101110101101",
  s: "111100111001111",
  t: "111010010010010",
  u: "101101101101111",
  v: "101101101101010",
  w: "101101111111101",
  x: "101101010101101",
  y: "101101111010010",
  z: "111001010100111",
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "111001111100111",
  "3": "111001111001111",
  "4": "101101111001001",
  "5": "111100111001111",
  "6": "111100111101111",
  "7": "111001001001001",
  "8": "111101111101111",
  "9": "111101111001111",
  _: "000000000000111",
  ".": "000000000000010",
  " ": "000000000000000",
  "-": "000000111000000",
  "/": "001001010100100",
};

function text(c: Canvas, x: number, y: number, s: string, scale = 2): void {
  let cx = x;
  for (const ch of s.toLowerCase()) {
    const glyph = FONT[ch] ?? FONT[" "]!;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy * 3 + gx] === "1") {
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              c.set(cx + gx * scale + sx, y + gy * scale + sy, 255, 255, 255);
        }
      }
    }
    cx += 4 * scale;
  }
}

/** Black -> blue -> magenta -> orange -> yellow -> white, for t in [0, 1]. */
function heat(t: number): [number, number, number] {
  const stops: [number, number, number][] = [
    [0, 0, 0],
    [20, 20, 110],
    [140, 30, 140],
    [230, 90, 30],
    [255, 210, 40],
    [255, 255, 255],
  ];
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

const F_LO = 20;
const F_HI = 20000;
const DB_FLOOR = -100;

/** Waveform strip plus spectrogram of `buf`, `width` columns wide. */
function drawSound(
  buf: Float32Array,
  sampleRate: number,
  width: number,
  waveHeight: number,
  specHeight: number,
  loop: boolean,
): Canvas {
  const c = new Canvas(width, waveHeight + specHeight + 8);
  const n = buf.length;
  // Waveform: min/max per column.
  const mid = waveHeight / 2;
  for (let x = 0; x < width; x++) {
    c.set(x, mid, 60, 60, 60);
    const from = Math.floor((x / width) * n);
    const to = Math.max(from + 1, Math.floor(((x + 1) / width) * n));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to; i++) {
      lo = Math.min(lo, buf[i]!);
      hi = Math.max(hi, buf[i]!);
    }
    for (
      let y = Math.floor(mid - hi * (mid - 1));
      y <= mid - lo * (mid - 1);
      y++
    ) {
      c.set(x, y, 120, 230, 140);
    }
  }
  // Spectrogram.
  const size = loop ? 4096 : 1024;
  const hop = Math.max(32, Math.floor(n / width));
  const spec = stft(buf, sampleRate, size, hop);
  const top = waveHeight + 4;
  const binHz = sampleRate / size;
  for (let x = 0; x < width; x++) {
    const frame =
      spec.frames[
        Math.min(
          spec.frames.length - 1,
          Math.floor((x / width) * spec.frames.length),
        )
      ]!;
    for (let y = 0; y < specHeight; y++) {
      // Log axis: top row is F_HI.
      const u = 1 - (y + 0.5) / specHeight;
      const f = F_LO * Math.pow(F_HI / F_LO, u);
      const k = f / binHz;
      const k0 = Math.floor(k);
      const fr = k - k0;
      const a = frame[Math.min(frame.length - 1, k0)]!;
      const b = frame[Math.min(frame.length - 1, k0 + 1)]!;
      const v = f > sampleRate / 2 ? DB_FLOOR : a + (b - a) * fr;
      const [r, g, bl] = heat((v - DB_FLOOR) / -DB_FLOOR);
      c.set(x, top + y, r, g, bl);
    }
  }
  // Frequency grid.
  for (const f of [100, 1000, 10000]) {
    const y =
      top + (1 - Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * specHeight;
    for (let x = 0; x < width; x += 2) c.blend(x, y, 255, 255, 255, 0.35);
  }
  // Time ticks.
  const seconds = n / sampleRate;
  for (let t = 0; t <= seconds + 1e-9; t += 0.1) {
    const x = Math.round((t / seconds) * (width - 1));
    const whole = Math.abs(t - Math.round(t)) < 1e-6;
    const len = whole ? 8 : 4;
    for (let y = 0; y < len; y++)
      c.set(x, top + specHeight + 4 - y + 3, 255, 255, 255);
  }
  return c;
}

// --- Main ------------------------------------------------------------------------

const fmt = (v: number, d = 0) => v.toFixed(d).padStart(6);
const header =
  "sound              cat     dur  peak  rms  rms50 crest  att  d20  d40" +
  "  centOn  rollOn  centTl  rollTl  flat  " +
  BANDS.map((b) => b.name.padStart(7)).join("") +
  "   ms";
console.log(header);
const thumbs: { id: SoundId; canvas: Canvas; seconds: number }[] = [];
let totalMs = 0;
for (const id of ids) {
  const t0 = performance.now();
  const buf = renderSound(id, SR);
  const ms = performance.now() - t0;
  totalMs += ms;
  const d = describe(buf, SR);
  const loop = LOOPS.has(id);
  console.log(
    `${id.padEnd(18)} ${CATEGORY_OF[id].padEnd(7)}${fmt(d.duration, 2)}${fmt(d.peakDb, 1)}${fmt(d.rmsDb, 1)}${fmt(d.rms50Db, 1)}${fmt(d.crestDb, 1)}` +
      `${fmt(d.attackMs)}${fmt(d.decay20Ms)}${fmt(d.decay40Ms)}` +
      `  ${fmt(d.centroidOnset)}  ${fmt(d.rolloffOnset)}  ${fmt(d.centroidTail)}  ${fmt(d.rolloffTail)}${fmt(d.flatness, 2)}  ` +
      BANDS.map((b) =>
        `${(d.bands[b.name] * 100).toFixed(1)}%`.padStart(7),
      ).join("") +
      `${fmt(ms, 1)}`,
  );
  if (loop) {
    const power = powerSpectrum(buf, 0, buf.length, 16384);
    const peaks = spectralPeaks(power, SR, 8, 8);
    const env = loopEnvelopeStats(buf, SR);
    console.log(
      `    seam ${seamDiscontinuity(buf).toFixed(2)}x median step; envelope spread ${env.spreadDb.toFixed(2)} dB; ` +
        `loop-rate modulation ${(env.loopModulation * 100).toFixed(1)}%`,
    );
    console.log(
      `    peaks: ${peaks.map((p) => `${p.freq.toFixed(1)}Hz ${p.db.toFixed(1)}dB`).join(", ")}`,
    );
  } else if (id.startsWith("impact") || id.startsWith("footstep")) {
    const power = powerSpectrum(buf, 0, buf.length, 8192);
    const peaks = spectralPeaks(power, SR, 8, 15);
    console.log(
      `    peaks: ${peaks.map((p) => `${p.freq.toFixed(0)}`).join(" ")} Hz`,
    );
  }
  await Bun.write(`out/audio/${id}.wav`, wav(buf, SR));
  const width = Math.min(1600, Math.max(400, Math.round(d.duration * 800)));
  const big = drawSound(buf, SR, width, 100, 360, loop);
  await writePng(`out/audio/${id}.png`, big.width, big.height, big.rgba);
  thumbs.push({
    id,
    canvas: drawSound(buf, SR, 360, 50, 150, loop),
    seconds: d.duration,
  });
}
console.log(`total render ${totalMs.toFixed(1)} ms at ${SR} Hz`);

// Contact sheet.
const COLS = 4;
const cellW = 370;
const cellH = 50 + 150 + 8 + 20;
const rows = Math.ceil(thumbs.length / COLS);
const sheet = new Canvas(COLS * cellW, rows * cellH);
thumbs.forEach(({ id, canvas, seconds }, i) => {
  const x = (i % COLS) * cellW;
  const y = Math.floor(i / COLS) * cellH;
  text(sheet, x + 2, y + 3, `${id} ${seconds.toFixed(2)}s`);
  sheet.blit(canvas, x, y + 18);
});
await writePng("out/audio/sheet.png", sheet.width, sheet.height, sheet.rgba);
