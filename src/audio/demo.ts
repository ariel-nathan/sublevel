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
  type RoomAcoustics,
  type SoundId,
} from "../core/api";
import type { Vec3 } from "../math";
import { CANDIDATE_INFO } from "./candidates";
import {
  CONTACT_LOOPS,
  contactLoopFor,
  contactLoopParams,
  createContactVoicePool,
  type ContactInput,
  type ContactKind,
  type ContactLoop,
  type ContactMaterial,
} from "./contactVoices";
import { candidateOf, createAudioSystem, renderVariant } from "./index";
import {
  CANDIDATE_NAMES,
  CATEGORY_OF,
  FAMILIES,
  formatSfx,
  type Candidate,
  type Family,
} from "./mix";

const audio = createAudioSystem();
// For headless smoke tests (tools/browser.ts) and the console.
(globalThis as { __audio?: unknown }).__audio = audio;
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
  void audio
    .resume()
    .then(() => audio.play(sound, { ...options, occlusion: occlusion() }));
}

function drawWave(sound: SoundId): void {
  const data = renderVariant(
    sound,
    44100,
    0,
    candidateOf(sound, audio.candidates()),
  );
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
  g2d.fillText(
    `${sound} [${candidateOf(sound, audio.candidates())}]  ${(data.length / 44100).toFixed(2)}s`,
    6,
    14,
  );
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// --- Candidates (listening round 1) ---------------------------------------------

const FAMILY_LABEL: Record<Family, string> = {
  footsteps: "footsteps",
  impact_metal: "metal",
  crate_break: "break",
};
const candidateRows = new Map<string, HTMLDivElement>();
/** Timers of the sequence playing now, so a new one replaces it. */
let sequenceTimers: number[] = [];

function schedule(steps: { at: number; run: () => void }[]): void {
  for (const t of sequenceTimers) clearTimeout(t);
  sequenceTimers = [];
  void audio.resume().then(() => {
    for (const s of steps) sequenceTimers.push(window.setTimeout(s.run, s.at));
  });
}

function showSelection(): void {
  const sel = audio.candidates();
  for (const f of FAMILIES) {
    for (const c of CANDIDATE_NAMES) {
      candidateRows
        .get(`${f}:${c}`)
        ?.classList.toggle("selected", sel[f] === c);
    }
  }
  $<HTMLElement>("picks").textContent = FAMILIES.map(
    (f) => `${FAMILY_LABEL[f]} ${sel[f]}`,
  ).join(", ");
  const sfx = `?sfx=${formatSfx(sel)}`;
  $<HTMLElement>("sfx").textContent = sfx;
  // Keep the selection across reloads of this page.
  const url = new URL(location.href);
  url.searchParams.set("sfx", formatSfx(sel));
  history.replaceState(
    null,
    "",
    url.toString().replace(/%3A/g, ":").replace(/%2C/g, ","),
  );
}

function select(family: Family, candidate: Candidate): void {
  audio.setCandidate(family, candidate);
  showSelection();
}

/** Footsteps as the game plays them: every 0.39 s, gain 0.5, pitch ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â±4 %. */
function walk(sound: SoundId): void {
  drawWave(sound);
  schedule(
    Array.from({ length: 8 }, (_, i) => ({
      at: i * 390,
      run: () => audio.play(sound, { gain: 0.5, pitch: 0.96 + vary() * 0.08 }),
    })),
  );
}

/** A metal impact of a given strength, with the game's gain/pitch mapping. */
function metalHit(strength: number): () => void {
  return () =>
    audio.play("impact_metal", {
      gain: 0.1 + 0.9 * strength ** 0.8,
      pitch: 1.08 - 0.16 * strength + (vary() - 0.5) * 0.06,
      position: near(3, -0.5),
    });
}

const CANDIDATE_BUTTONS: Record<Family, { label: string; run: () => void }[]> =
  {
    footsteps: [
      { label: "walk on concrete", run: () => walk("footstep_concrete") },
      { label: "walk on tile", run: () => walk("footstep_tile") },
      { label: "walk on grate", run: () => walk("footstep_metal") },
      {
        label: "land",
        run: () => {
          drawWave("land");
          schedule([{ at: 0, run: () => audio.play("land", { gain: 0.8 }) }]);
        },
      },
    ],
    impact_metal: [
      ...(
        [
          ["soft", 0.12],
          ["medium", 0.45],
          ["hard", 1],
        ] as const
      ).map(([label, s]) => ({
        label,
        run: () => {
          drawWave("impact_metal");
          schedule([{ at: 0, run: metalHit(s) }]);
        },
      })),
      {
        label: "barrel roll",
        run: () => {
          drawWave("impact_metal");
          const hits = [
            [0, 1],
            [170, 0.7],
            [310, 0.45],
            [420, 0.28],
            [510, 0.15],
          ] as const;
          schedule(hits.map(([at, s]) => ({ at, run: metalHit(s) })));
        },
      },
    ],
    crate_break: [
      {
        label: "break",
        run: () => {
          drawWave("crate_break");
          schedule([
            {
              at: 0,
              run: () => audio.play("crate_break", { position: near(4, 0) }),
            },
          ]);
        },
      },
    ],
  };

const candidatesBox = $<HTMLDivElement>("candidates");
for (const family of FAMILIES) {
  const title = document.createElement("div");
  title.className = "family";
  title.textContent = FAMILY_LABEL[family];
  candidatesBox.append(title);
  for (const c of CANDIDATE_NAMES) {
    const row = document.createElement("div");
    row.className = "cand";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = c;
    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = CANDIDATE_INFO[family][c];
    row.append(label);
    for (const b of CANDIDATE_BUTTONS[family]) {
      row.append(
        button(b.label, () => {
          select(family, c);
          b.run();
        }),
      );
    }
    row.append(desc);
    candidateRows.set(`${family}:${c}`, row);
    candidatesBox.append(row);
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = `copied: ${text}`;
  } catch {
    status.textContent = `copy this: ${text}`;
  }
}
$<HTMLButtonElement>("copy-picks").addEventListener("click", () => {
  void copy($<HTMLElement>("picks").textContent ?? "");
});
$<HTMLButtonElement>("copy-sfx").addEventListener("click", () => {
  void copy($<HTMLElement>("sfx").textContent ?? "");
});
showSelection();

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
          audio.play(e.sound, { ...options, occlusion: occlusion() });
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
  if (CATEGORY_OF[sound] === "contact") continue;
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
            occlusion: occlusion(),
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

// --- Round 2: room, occlusion, contact loops, new cues --------------------------

const roomInput = $<HTMLSelectElement>("room");
const occlusionInput = $<HTMLInputElement>("occlusion");
const occlusionLabel = $<HTMLSpanElement>("occlusionv");
const dragsBox = $<HTMLDivElement>("drags");
const pushesBox = $<HTMLDivElement>("pushes");
const cuesBox = $<HTMLDivElement>("cues");

function occlusion(): number {
  return Number(occlusionInput.value);
}

roomInput.value = audio.room();
roomInput.addEventListener("change", () => {
  void audio.resume().then(() => {
    audio.setRoom(roomInput.value as RoomAcoustics);
    status.textContent = `room: ${audio.room()}`;
  });
});

/** Every loop this page is playing, so occlusion reaches all of them. */
const playingLoops = (): LoopHandle[] => [
  ...loopHandles.values(),
  ...drags.flatMap((d) => (d.handle ? [d.handle] : [])),
  ...pushHandles.values(),
];

function syncOcclusion(): void {
  occlusionLabel.textContent = occlusion().toFixed(2);
  for (const h of playingLoops())
    audio.setLoopParams(h, { occlusion: occlusion() }, 0.12);
}
occlusionInput.addEventListener("input", syncOcclusion);

interface Drag {
  sound: ContactLoop;
  kind: ContactKind;
  material: ContactMaterial;
  speed: HTMLInputElement;
  force: HTMLInputElement;
  readout: HTMLSpanElement;
  handle: LoopHandle | null;
}

const DRAG_FORCE: Record<ContactLoop, number> = {
  scrape_wood: 245,
  scrape_metal: 590,
  scrape_plastic: 70,
  roll_metal: 345,
};
const DRAG_MATERIAL: Record<ContactLoop, ContactMaterial> = {
  scrape_wood: "wood",
  scrape_metal: "metal",
  scrape_plastic: "plastic",
  roll_metal: "metal",
};

function slider(min: number, max: number, step: number, value: number) {
  const s = document.createElement("input");
  s.type = "range";
  s.min = String(min);
  s.max = String(max);
  s.step = String(step);
  s.value = String(value);
  return s;
}

/** The loop parameters a drag row asks for, as the game computes them. */
function dragParams(d: Drag): { gain: number; pitch: number } {
  const p = contactLoopParams(
    d.kind,
    Number(d.speed.value),
    Number(d.force.value),
  );
  const loop = contactLoopFor(d.material, d.kind);
  return { gain: p.gain * loop.gain, pitch: p.pitch * loop.pitch };
}

const drags: Drag[] = CONTACT_LOOPS.map((sound) => {
  const row = document.createElement("div");
  row.className = "row drag";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = sound;
  const d: Drag = {
    sound,
    kind: sound.startsWith("roll") ? "roll" : "scrape",
    material: DRAG_MATERIAL[sound],
    speed: slider(0, 2.5, 0.01, 0.8),
    force: slider(0, 800, 5, DRAG_FORCE[sound]),
    readout: document.createElement("span"),
    handle: null,
  };
  d.readout.className = "readout";
  const toggle = button("drag", () => {
    void audio.resume().then(() => {
      if (d.handle) {
        audio.setLoopParams(d.handle, { gain: 0 }, 0.08);
        const h = d.handle;
        setTimeout(() => audio.stopLoop(h), 150);
        d.handle = null;
        toggle.classList.remove("on");
      } else {
        drawWave(sound);
        d.handle = audio.startLoop(sound, {
          gain: 0,
          position: near(2.5, 0.5),
          occlusion: occlusion(),
        });
        toggle.classList.add("on");
      }
    });
  });
  const speedLabel = document.createElement("label");
  speedLabel.append("speed ", d.speed);
  const forceLabel = document.createElement("label");
  forceLabel.append("force ", d.force);
  row.append(name, toggle, speedLabel, forceLabel, d.readout);
  dragsBox.append(row);
  return d;
});

// Drive the drags at 20 Hz with a 50 ms glide, as the game would per step.
setInterval(() => {
  for (const d of drags) {
    const p = dragParams(d);
    d.readout.textContent = `${Number(d.speed.value).toFixed(2)} m/s ${d.force.value} N -> gain ${p.gain.toFixed(2)} pitch ${p.pitch.toFixed(2)}`;
    if (d.handle)
      audio.setLoopParams(
        d.handle,
        { gain: p.gain, pitch: p.pitch, position: near(2.5, 0.5) },
        0.05,
      );
  }
}, 50);

// Pushes through the voice pool, at the game's 60 Hz step.
const pool = createContactVoicePool();
const pushHandles = new Map<string, LoopHandle>();
let pushTimer = 0;
let pushBodies: { input: ContactInput; v: number; decel: number }[] = [];

function runPool(): void {
  const dt = 1 / 60;
  const contacts: ContactInput[] = [];
  for (const b of pushBodies) {
    b.v = Math.max(0, b.v - b.decel * dt);
    if (b.v > 0)
      contacts.push({
        ...b.input,
        slipSpeed: b.input.rollSpeed > 0 ? 0 : b.v,
        rollSpeed: b.input.rollSpeed > 0 ? b.v : 0,
      });
  }
  for (const c of pool.update(contacts, dt)) {
    let h = pushHandles.get(c.key);
    if (!h) {
      h = audio.startLoop(c.sound, { gain: 0, position: c.position });
      pushHandles.set(c.key, h);
    }
    audio.setLoopParams(
      h,
      {
        gain: c.gain,
        pitch: c.pitch,
        position: c.position,
        occlusion: occlusion(),
      },
      c.fade,
    );
  }
  if (contacts.length === 0 && pool.voices().every((v) => v.body === null)) {
    clearInterval(pushTimer);
    pushTimer = 0;
  }
}

function push(
  bodies: {
    material: ContactMaterial;
    v: number;
    decel: number;
    force: number;
    roll?: boolean;
    x: number;
  }[],
): void {
  void audio.resume().then(() => {
    pushBodies = bodies.map((b, i) => ({
      input: {
        body: 100 + i + Math.floor(vary() * 1000),
        material: b.material,
        slipSpeed: 0,
        rollSpeed: b.roll ? 1 : 0,
        force: b.force,
        position: near(3, b.x),
      },
      v: b.v,
      decel: b.decel,
    }));
    if (!pushTimer) pushTimer = window.setInterval(runPool, 1000 / 60);
    status.textContent = `voice pool: ${bodies.length} bodies`;
  });
}

pushesBox.append(
  button("push wooden crate", () =>
    push([{ material: "wood", v: 1.4, decel: 1.2, force: 245, x: 0 }]),
  ),
  button("shove steel case", () =>
    push([{ material: "metal", v: 0.9, decel: 0.9, force: 590, x: 0 }]),
  ),
  button("kick chair", () =>
    push([{ material: "plastic", v: 2, decel: 3, force: 70, x: 0 }]),
  ),
  button("roll drum", () =>
    push([
      { material: "metal", v: 1.6, decel: 0.5, force: 345, roll: true, x: 0 },
    ]),
  ),
  button("six things at once (pool of 4)", () =>
    push([
      { material: "wood", v: 1.4, decel: 1.0, force: 245, x: -2 },
      { material: "wood", v: 0.6, decel: 0.6, force: 80, x: -1 },
      { material: "metal", v: 1.0, decel: 0.8, force: 590, x: 0 },
      { material: "plastic", v: 1.8, decel: 2.5, force: 70, x: 1 },
      { material: "metal", v: 1.2, decel: 0.4, force: 345, roll: true, x: 2 },
      { material: "wood", v: 0.3, decel: 0.5, force: 245, x: 3 },
    ]),
  ),
);

// New one-shots.
function cue(sound: SoundId, options: PlayOptions = {}): void {
  drawWave(sound);
  play(sound, options);
}
const doorAt = (): Vec3 => near(3, 1.5);
cuesBox.append(
  button("timer tick", () =>
    cue("timer_tick", { position: doorAt(), gain: 0.8 }),
  ),
  button("timer tick (urgent, pitch 1.2)", () =>
    cue("timer_tick", { position: doorAt(), gain: 1, pitch: 1.2 }),
  ),
  button("countdown", () => {
    drawWave("timer_tick");
    // Ten ticks: seven a second apart, the last three faster and higher.
    const times = [0, 1, 2, 3, 4, 5, 6, 7, 7.5, 8];
    schedule(
      times.map((at, i) => ({
        at: at * 1000,
        run: () =>
          audio.play("timer_tick", {
            position: doorAt(),
            gain: i >= 7 ? 1 : 0.8,
            pitch: i >= 7 ? 1.2 : 1,
            occlusion: occlusion(),
          }),
      })),
    );
  }),
  button("door blocked", () => cue("door_blocked", { position: doorAt() })),
  button("objective", () => cue("objective")),
);

// Last, once every loop list above exists.
syncOcclusion();
