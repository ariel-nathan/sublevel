/**
 * Audition page for the audio module (demos/audio.html). Plays every sound
 * the way the game does (same gains and pitch ranges), plus walk sequences,
 * a collapsing pile of crates, loops at a chosen distance, and a reverb
 * switch.
 */
import {
  LOOPING_SOUNDS,
  SOUND_IDS,
  type LoopHandle,
  type PlayOptions,
  type SoundId,
} from "../core/api";
import type { Vec3 } from "../math";
import { createAudioSystem, renderSound } from "./index";
import { CATEGORY_OF } from "./mix";

const audio = createAudioSystem();
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const list = $<HTMLDivElement>("sounds");
const walks = $<HTMLDivElement>("walks");
const loopsBox = $<HTMLDivElement>("loops");
const masterInput = $<HTMLInputElement>("master");
const distanceInput = $<HTMLInputElement>("distance");
const distanceLabel = $<HTMLSpanElement>("distancev");
const reverbInput = $<HTMLInputElement>("reverb");
const positionalInput = $<HTMLInputElement>("positional");
const mappingInput = $<HTMLSelectElement>("mapping");
const status = $<HTMLDivElement>("status");
const canvas = $<HTMLCanvasElement>("wave");
const g2d = canvas.getContext("2d")!;

/** Listener sits at z = distance looking along -Z; loops sit at the origin. */
let listenerZ = Number(distanceInput.value);
function placeListener(): void {
  audio.setListener(
    { x: 0, y: 1.6, z: listenerZ },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 1, z: 0 },
  );
}
placeListener();

/** A point `ahead` metres in front of the listener, `side` to the right. */
function near(ahead = 3, side = -1): Vec3 {
  return { x: side, y: 0.4, z: listenerZ - ahead };
}

let variation = 1;
const vary = (): number => {
  variation = (variation * 1103515245 + 12345) >>> 0;
  return variation / 4294967296;
};

type Level = "soft" | "medium" | "hard";
const STRENGTH: Record<Level, number> = { soft: 0.12, medium: 0.45, hard: 1 };

/** Impact gain/pitch for a strength in [0, 1], as the game computes it. */
function impactOptions(strength: number): PlayOptions {
  if (mappingInput.value === "recommended") {
    // Proposed mapping (see the audio module report).
    return {
      gain: 0.1 + 0.9 * strength ** 0.8,
      pitch: 1.08 - 0.16 * strength + (vary() - 0.5) * 0.06,
    };
  }
  return {
    gain: 0.25 + 0.75 * strength,
    pitch: 1.15 - 0.3 * strength + vary() * 0.1,
  };
}

/** Options for one play of `sound` at a level, mirroring src/game.ts. */
function optionsFor(sound: SoundId, level: Level): PlayOptions {
  const s = STRENGTH[level];
  const world = positionalInput.checked ? near() : undefined;
  switch (CATEGORY_OF[sound]) {
    case "impact":
      return { ...impactOptions(s), position: world };
    case "footstep":
      return { gain: 0.5 * (0.6 + 0.4 * s), pitch: 0.92 + vary() * 0.16 };
    case "body":
      return sound === "land" ? { gain: Math.min(1, (2 + 6 * s) / 8) } : {};
    case "handling":
      return {};
    default:
      return { position: world };
  }
}

function play(sound: SoundId, options: PlayOptions): void {
  void audio.resume().then(() => audio.play(sound, options));
}

function drawWave(sound: SoundId): void {
  const data = renderSound(sound, 44100);
  const w = canvas.width;
  const h = canvas.height;
  g2d.fillStyle = "#111";
  g2d.fillRect(0, 0, w, h);
  g2d.strokeStyle = "#333";
  g2d.beginPath();
  g2d.moveTo(0, h / 2);
  g2d.lineTo(w, h / 2);
  g2d.stroke();
  g2d.strokeStyle = "#7f7";
  g2d.beginPath();
  for (let x = 0; x < w; x++) {
    const from = Math.floor((x / w) * data.length);
    const to = Math.max(from + 1, Math.floor(((x + 1) / w) * data.length));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to; i++) {
      lo = Math.min(lo, data[i]!);
      hi = Math.max(hi, data[i]!);
    }
    g2d.moveTo(x + 0.5, h / 2 - hi * (h / 2 - 2));
    g2d.lineTo(x + 0.5, h / 2 - lo * (h / 2 - 2));
  }
  g2d.stroke();
  g2d.fillStyle = "#9f9";
  g2d.font = "12px monospace";
  g2d.fillText(`${sound}  ${(data.length / 44100).toFixed(2)}s`, 6, 14);
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// One row per one-shot: soft / medium / hard.
const loopSet = new Set<SoundId>(LOOPING_SOUNDS);
for (const sound of SOUND_IDS) {
  if (loopSet.has(sound)) continue;
  const row = document.createElement("div");
  row.className = "row";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = sound;
  const cat = document.createElement("span");
  cat.className = "cat";
  cat.textContent = CATEGORY_OF[sound];
  row.append(name, cat);
  for (const level of ["soft", "medium", "hard"] as const) {
    row.append(
      button(level, () => {
        drawWave(sound);
        play(sound, optionsFor(sound, level));
      }),
    );
  }
  list.append(row);
}

// Walk sequences: 8 steps at a running cadence (0.3 s), as the game plays them.
let walkTimer = 0;
for (const surface of ["concrete", "tile", "metal"] as const) {
  walks.append(
    button(`walk on ${surface}`, () => {
      clearInterval(walkTimer);
      let steps = 0;
      const sound = `footstep_${surface}` as SoundId;
      drawWave(sound);
      void audio.resume().then(() => {
        walkTimer = window.setInterval(() => {
          audio.play(sound, { gain: 0.5, pitch: 0.92 + vary() * 0.16 });
          if (++steps >= 8) clearInterval(walkTimer);
        }, 300);
      });
    }),
  );
}

// A stack of crates collapsing: one break, then a cascade of impacts of
// falling strength, spread over a few metres, wood and metal mixed.
walks.append(
  button("pile of crates", () => {
    void audio.resume().then(() => {
      const events: {
        at: number;
        sound: SoundId;
        strength: number;
        pos: Vec3;
      }[] = [];
      events.push({
        at: 0,
        sound: "crate_break",
        strength: 1,
        pos: near(4, 0),
      });
      for (let i = 0; i < 22; i++) {
        const at = 30 + vary() ** 1.4 * 1600;
        const strength = Math.max(0.05, (1 - at / 1800) * (0.4 + 0.6 * vary()));
        const sound: SoundId =
          vary() < 0.7
            ? "impact_wood"
            : vary() < 0.7
              ? "impact_metal"
              : "impact_plastic";
        events.push({
          at,
          sound,
          strength,
          pos: near(3.5 + vary() * 2, -2 + vary() * 4),
        });
      }
      for (const e of events) {
        setTimeout(() => {
          const options =
            e.sound === "crate_break"
              ? { position: e.pos }
              : { ...impactOptions(e.strength), position: e.pos };
          audio.play(e.sound, options);
        }, e.at);
      }
      // A footstep in the middle of it must survive (priority test).
      setTimeout(() => audio.play("footstep_concrete", { gain: 0.5 }), 400);
      status.textContent = `pile: ${events.length} events over 1.6 s, plus one footstep at 0.4 s that must stay audible`;
    });
  }),
);

// Loop toggles. Loops are positioned at the origin (the drone is not
// positional, as in the game); the distance slider moves the listener.
const loopHandles = new Map<SoundId, LoopHandle>();
const EMITTER_GAIN: Partial<Record<SoundId, number>> = {
  hum_fluorescent: 0.5,
  hum_machine: 0.6,
  ambient_drone: 0.4,
};
for (const sound of LOOPING_SOUNDS) {
  const b = button(`${sound} (loop)`, () => {
    void audio.resume().then(() => {
      const existing = loopHandles.get(sound);
      if (existing) {
        audio.stopLoop(existing);
        loopHandles.delete(sound);
        b.classList.remove("on");
      } else {
        loopHandles.set(
          sound,
          audio.startLoop(sound, {
            gain: EMITTER_GAIN[sound] ?? 0.5,
            position:
              sound === "ambient_drone" ? undefined : { x: 0, y: 1.6, z: 0 },
          }),
        );
        b.classList.add("on");
      }
    });
  });
  loopsBox.append(b);
}

function sync(): void {
  listenerZ = Number(distanceInput.value);
  distanceLabel.textContent = `${listenerZ.toFixed(1)} m`;
  placeListener();
  audio.setMasterGain(Number(masterInput.value));
  audio.setReverbEnabled(reverbInput.checked);
}
for (const input of [masterInput, distanceInput, reverbInput])
  input.addEventListener("input", sync);
sync();
