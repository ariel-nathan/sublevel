/**
 * Audio module. `renderSound` is a pure synthesiser (runs under `bun test`);
 * `createAudioSystem` is a thin Web Audio wrapper that plays the results.
 */
import {
  LOOPING_SOUNDS,
  SOUND_IDS,
  type AudioSystem,
  type LoopHandle,
  type PlayOptions,
  type SoundId,
} from "../core/api";
import { createRng, hashString } from "../core/rng";
import type { Vec3 } from "../math";
import {
  BUSES,
  CATEGORY_OF,
  PRIORITY_OF,
  finishSound,
  type CompressorSettings,
} from "./mix";
import { RECIPES, VARIANTS } from "./recipes";
import {
  ATTENUATION,
  clampGain,
  clampPitch,
  createVoiceLimiter,
  distanceCutoff,
  distanceGain,
  distanceSend,
  makeImpulseResponse,
  type Attenuation,
  type VoiceLimiter,
} from "./voices";

const LOOPING = new Set<SoundId>(LOOPING_SOUNDS);

/** Synthesises the mono waveform for a sound. Pure and deterministic. */
export function renderSound(sound: SoundId, sampleRate: number): Float32Array {
  return renderVariant(sound, sampleRate, 0);
}

/**
 * Synthesises take `variant` (0..VARIANTS[sound]-1) of a sound. Take 0 is
 * `renderSound`. Pure and deterministic.
 */
export function renderVariant(
  sound: SoundId,
  sampleRate: number,
  variant: number,
): Float32Array {
  const seed = hashString(variant === 0 ? sound : `${sound}#${variant}`);
  const raw = RECIPES[sound]({
    sr: sampleRate,
    rng: createRng(seed),
    variant,
  });
  return finishSound(sound, raw, sampleRate, LOOPING.has(sound));
}

/** Extra controls beyond the game contract, used by the demo page. */
export interface AudioDebugControls {
  /** Turns the room reverb on or off. */
  setReverbEnabled(on: boolean): void;
}

interface Chain {
  source: AudioBufferSourceNode;
  /** Level set by the caller (and fades). */
  gain: GainNode;
  /** Distance attenuation, updated as the listener moves. */
  distance: GainNode | null;
  filter: BiquadFilterNode | null;
  send: GainNode;
  position: Vec3 | null;
  attenuation: Attenuation;
  sendLevel: number;
}

interface LoopEntry {
  sound: SoundId;
  options: PlayOptions;
  chain: Chain | null;
}

function webAudioConstructor(): typeof AudioContext | undefined {
  const g = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return g.AudioContext ?? g.webkitAudioContext;
}

function configure(node: DynamicsCompressorNode, s: CompressorSettings): void {
  node.threshold.value = s.threshold;
  node.knee.value = s.knee;
  node.ratio.value = s.ratio;
  node.attack.value = s.attack;
  node.release.value = s.release;
}

export function createAudioSystem(): AudioSystem & AudioDebugControls {
  let ctx: AudioContext | null = null;
  let masterOut: GainNode | null = null;
  let sfxBus: GainNode | null = null;
  let ambienceBus: GainNode | null = null;
  let reverbIn: GainNode | null = null;
  let reverbReturn: GainNode | null = null;
  let reverbOn = true;
  let masterGainValue = 1;
  const buffers = new Map<string, AudioBuffer>();
  const voices = new Map<number, Chain>();
  const loops = new Map<number, LoopEntry>();
  const limiter: VoiceLimiter = createVoiceLimiter();
  const takeCounter = new Map<SoundId, number>();
  let nextLoopId = 1;
  let prerenderQueued = false;
  const listener = {
    position: { x: 0, y: 0, z: 0 } as Vec3,
    forward: { x: 0, y: 0, z: -1 } as Vec3,
    up: { x: 0, y: 1, z: 0 } as Vec3,
  };

  function applyListener(): void {
    if (!ctx) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    const { position: p, forward: f, up: u } = listener;
    if (l.positionX) {
      l.positionX.setValueAtTime(p.x, t);
      l.positionY.setValueAtTime(p.y, t);
      l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(f.x, t);
      l.forwardY.setValueAtTime(f.y, t);
      l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(u.x, t);
      l.upY.setValueAtTime(u.y, t);
      l.upZ.setValueAtTime(u.z, t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  function distanceTo(p: Vec3): number {
    const l = listener.position;
    return Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);
  }

  /** Sets a chain's distance-dependent parameters (immediately or smoothly). */
  function applyDistance(chain: Chain, smooth: boolean): void {
    if (!ctx || !chain.position || !chain.distance || !chain.filter) return;
    const d = distanceTo(chain.position);
    const g = distanceGain(d, chain.attenuation);
    const f = distanceCutoff(d, chain.attenuation);
    const s = chain.sendLevel * distanceSend(d, chain.attenuation);
    const t = ctx.currentTime;
    if (smooth) {
      chain.distance.gain.setTargetAtTime(g, t, 0.05);
      chain.filter.frequency.setTargetAtTime(f, t, 0.05);
      chain.send.gain.setTargetAtTime(s, t, 0.05);
    } else {
      chain.distance.gain.value = g;
      chain.filter.frequency.value = f;
      chain.send.gain.value = s;
    }
  }

  function buildGraph(context: AudioContext): void {
    masterOut = context.createGain();
    masterOut.gain.value = masterGainValue * BUSES.master;
    const mix = context.createGain();
    const safety = context.createDynamicsCompressor();
    configure(safety, BUSES.limiter);
    mix.connect(safety);
    safety.connect(masterOut);
    masterOut.connect(context.destination);

    sfxBus = context.createGain();
    const glue = context.createDynamicsCompressor();
    configure(glue, BUSES.sfxCompressor);
    sfxBus.connect(glue);
    glue.connect(mix);

    ambienceBus = context.createGain();
    ambienceBus.connect(mix);

    reverbIn = context.createGain();
    reverbReturn = context.createGain();
    reverbReturn.gain.value = reverbOn ? 1 : 0;
    const convolver = context.createConvolver();
    const [left, right] = makeImpulseResponse(context.sampleRate);
    const ir = context.createBuffer(2, left.length, context.sampleRate);
    ir.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
    ir.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
    convolver.normalize = false;
    convolver.buffer = ir;
    reverbIn.connect(convolver);
    convolver.connect(reverbReturn);
    reverbReturn.connect(mix);
  }

  function bufferFor(sound: SoundId, variant: number): AudioBuffer | null {
    if (!ctx) return null;
    const key = `${sound}#${variant}`;
    let buf = buffers.get(key);
    if (!buf) {
      const data = renderVariant(sound, ctx.sampleRate, variant);
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      buffers.set(key, buf);
    }
    return buf;
  }

  /** Renders every take in the background, one per task, after start-up. */
  function queuePrerender(): void {
    if (prerenderQueued) return;
    prerenderQueued = true;
    const jobs: [SoundId, number][] = [];
    for (const sound of SOUND_IDS) {
      for (let v = 0; v < VARIANTS[sound]; v++) jobs.push([sound, v]);
    }
    const step = () => {
      const job = jobs.shift();
      if (!job) return;
      bufferFor(job[0], job[1]);
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  /** Next take of a sound: cycles through all takes, never repeating the last. */
  function nextTake(sound: SoundId): number {
    const count = VARIANTS[sound];
    if (count <= 1) return 0;
    const n = (takeCounter.get(sound) ?? -1) + 1;
    takeCounter.set(sound, n);
    // A fixed scrambled order so consecutive steps do not form a pattern.
    const order = [0, 2, 1, 3, 1, 0, 3, 2, 0, 1, 2, 3];
    return order[n % order.length]! % count;
  }

  /** Builds source -> gain -> [distance -> filter -> panner] -> bus (+ send). */
  function makeChain(
    context: AudioContext,
    buffer: AudioBuffer,
    options: PlayOptions,
    loop: boolean,
    attenuation: Attenuation,
    sendLevel: number,
  ): Chain {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = clampPitch(options.pitch);
    const gain = context.createGain();
    gain.gain.value = clampGain(options.gain);
    source.connect(gain);
    let out: AudioNode = gain;
    let distance: GainNode | null = null;
    let filter: BiquadFilterNode | null = null;
    const send = context.createGain();
    send.gain.value = sendLevel;
    if (options.position) {
      distance = context.createGain();
      filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.5;
      const panner = context.createPanner();
      panner.panningModel = "HRTF";
      // Attenuation is done by `distance` (see voices.ts); the panner only
      // places the sound.
      panner.distanceModel = "inverse";
      panner.rolloffFactor = 0;
      const p = options.position;
      if (panner.positionX) {
        panner.positionX.value = p.x;
        panner.positionY.value = p.y;
        panner.positionZ.value = p.z;
      } else {
        panner.setPosition(p.x, p.y, p.z);
      }
      gain.connect(distance);
      distance.connect(filter);
      filter.connect(panner);
      filter.connect(send);
      out = panner;
    } else {
      gain.connect(send);
    }
    out.connect(loop ? ambienceBus! : sfxBus!);
    send.connect(reverbIn!);
    const chain: Chain = {
      source,
      gain,
      distance,
      filter,
      send,
      position: options.position ?? null,
      attenuation,
      sendLevel,
    };
    applyDistance(chain, false);
    return chain;
  }

  function disconnect(chain: Chain): void {
    chain.source.disconnect();
    chain.gain.disconnect();
    chain.distance?.disconnect();
    chain.filter?.disconnect();
    chain.send.disconnect();
  }

  function startLoopNow(entry: LoopEntry): void {
    if (!ctx) return;
    const buffer = bufferFor(entry.sound, 0);
    if (!buffer) return;
    const chain = makeChain(
      ctx,
      buffer,
      entry.options,
      true,
      ATTENUATION.ambience,
      entry.options.position ? BUSES.ambienceReverbSend : 0,
    );
    // Fade in, and start at a different point in each loop so several
    // emitters of the same sound never play in phase.
    const target = clampGain(entry.options.gain);
    const t = ctx.currentTime;
    chain.gain.gain.setValueAtTime(0, t);
    chain.gain.gain.linearRampToValueAtTime(target, t + BUSES.loopFadeIn);
    const offset = ((loops.size * 0.37) % 1) * buffer.duration;
    chain.source.start(t, offset);
    entry.chain = chain;
  }

  return {
    async resume() {
      if (!ctx) {
        const Ctor = webAudioConstructor();
        if (!Ctor) return;
        try {
          ctx = new Ctor({ latencyHint: "interactive" });
          buildGraph(ctx);
          applyListener();
        } catch {
          ctx = null;
          return;
        }
      }
      try {
        if (ctx.state !== "running") await ctx.resume();
      } catch {
        return;
      }
      for (const entry of loops.values()) {
        if (!entry.chain) startLoopNow(entry);
      }
      queuePrerender();
    },

    setListener(position, forward, up) {
      listener.position = position;
      listener.forward = forward;
      listener.up = up;
      applyListener();
      for (const entry of loops.values()) {
        if (entry.chain) applyDistance(entry.chain, true);
      }
      for (const chain of voices.values()) applyDistance(chain, true);
    },

    play(sound, options = {}) {
      if (!ctx || ctx.state !== "running" || LOOPING.has(sound)) return;
      const variant = nextTake(sound);
      const buffer = bufferFor(sound, variant);
      if (!buffer) return;
      const pitch = clampPitch(options.pitch);
      const attenuation = ATTENUATION.world;
      const audible =
        clampGain(options.gain) *
        (options.position
          ? distanceGain(distanceTo(options.position), attenuation)
          : 1);
      const decision = limiter.request(
        sound,
        audible,
        ctx.currentTime,
        buffer.duration / pitch,
        PRIORITY_OF[CATEGORY_OF[sound]],
      );
      if (!decision.play) return;
      if (decision.steal !== null) {
        const victim = voices.get(decision.steal);
        if (victim) {
          const t = ctx.currentTime;
          victim.gain.gain.cancelScheduledValues(t);
          victim.gain.gain.setTargetAtTime(0, t, 0.005);
          victim.source.stop(t + 0.03);
          voices.delete(decision.steal);
        }
      }
      const chain = makeChain(
        ctx,
        buffer,
        options,
        false,
        attenuation,
        options.position ? BUSES.reverbSend : BUSES.playerReverbSend,
      );
      const id = decision.id;
      voices.set(id, chain);
      chain.source.onended = () => {
        voices.delete(id);
        limiter.release(id);
        disconnect(chain);
      };
      chain.source.start();
    },

    startLoop(sound, options = {}): LoopHandle {
      const id = nextLoopId++;
      const entry: LoopEntry = { sound, options, chain: null };
      loops.set(id, entry);
      if (ctx && ctx.state === "running") startLoopNow(entry);
      return { id };
    },

    stopLoop(handle) {
      const entry = loops.get(handle.id);
      if (!entry) return;
      loops.delete(handle.id);
      const chain = entry.chain;
      if (!ctx || !chain) return;
      const t = ctx.currentTime;
      const g = chain.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + BUSES.loopFadeOut);
      chain.source.stop(t + BUSES.loopFadeOut + 0.01);
      chain.source.onended = () => disconnect(chain);
    },

    setMasterGain(gain) {
      masterGainValue = clampGain(gain);
      if (ctx && masterOut)
        masterOut.gain.setTargetAtTime(
          masterGainValue * BUSES.master,
          ctx.currentTime,
          0.01,
        );
    },

    setReverbEnabled(on) {
      reverbOn = on;
      if (ctx && reverbReturn)
        reverbReturn.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.02);
    },
  };
}
