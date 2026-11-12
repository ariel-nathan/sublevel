/** Demo page: a button per sound, gain/pitch sliders, a circling positional source. */
import {
  LOOPING_SOUNDS,
  SOUND_IDS,
  type LoopHandle,
  type SoundId,
} from "../core/api";
import { createAudioSystem, renderSound } from "./index";

const audio = createAudioSystem();
audio.setListener(
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
);

const buttons = document.getElementById("buttons") as HTMLDivElement;
const gainInput = document.getElementById("gain") as HTMLInputElement;
const pitchInput = document.getElementById("pitch") as HTMLInputElement;
const masterInput = document.getElementById("master") as HTMLInputElement;
const positional = document.getElementById("positional") as HTMLInputElement;
const gainLabel = document.getElementById("gainv") as HTMLSpanElement;
const pitchLabel = document.getElementById("pitchv") as HTMLSpanElement;
const status = document.getElementById("status") as HTMLDivElement;
const canvas = document.getElementById("wave") as HTMLCanvasElement;
const g2d = canvas.getContext("2d")!;

const loops = new Map<SoundId, LoopHandle>();
const loopSet = new Set<SoundId>(LOOPING_SOUNDS);
let angle = 0;
const RADIUS = 4;

function sourcePosition() {
  return { x: Math.cos(angle) * RADIUS, y: 0, z: Math.sin(angle) * RADIUS };
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

function options() {
  return {
    gain: Number(gainInput.value),
    pitch: Number(pitchInput.value),
    position: positional.checked ? sourcePosition() : undefined,
  };
}

for (const sound of SOUND_IDS) {
  const button = document.createElement("button");
  const isLoop = loopSet.has(sound);
  button.textContent = isLoop ? `${sound} (loop)` : sound;
  button.addEventListener("click", async () => {
    await audio.resume();
    drawWave(sound);
    if (isLoop) {
      const existing = loops.get(sound);
      if (existing) {
        audio.stopLoop(existing);
        loops.delete(sound);
        button.classList.remove("on");
      } else {
        loops.set(sound, audio.startLoop(sound, options()));
        button.classList.add("on");
      }
    } else {
      audio.play(sound, options());
    }
  });
  buttons.appendChild(button);
}

function syncLabels(): void {
  gainLabel.textContent = Number(gainInput.value).toFixed(2);
  pitchLabel.textContent = Number(pitchInput.value).toFixed(2);
  audio.setMasterGain(Number(masterInput.value));
}
for (const input of [gainInput, pitchInput, masterInput])
  input.addEventListener("input", syncLabels);
syncLabels();

let last = performance.now();
function frame(now: number): void {
  angle += ((now - last) / 1000) * 0.6;
  last = now;
  const p = sourcePosition();
  status.textContent = `source at x ${p.x.toFixed(1)} z ${p.z.toFixed(1)} (positional ${positional.checked ? "on" : "off"}; looping sounds keep the position they started with)`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
