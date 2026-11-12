/**
 * Audio module. `renderSound` is a pure synthesiser (runs under `bun test`);
 * `createAudioSystem` is a thin Web Audio wrapper that plays the results.
 */
import {
  LOOPING_SOUNDS,
  type AudioSystem,
  type LoopHandle,
  type PlayOptions,
  type SoundId,
} from "../core/api";
import { createRng, hashString } from "../core/rng";
import type { Vec3 } from "../math";
import { RECIPES } from "./recipes";
import {
  clampGain,
  clampPitch,
  createVoiceLimiter,
  makeImpulseResponse,
  type VoiceLimiter,
} from "./voices";

/** Level of the reverb send relative to the dry signal (dry is always 1). */
export const REVERB_WET_LEVEL = 0.16;
const REVERB_SECONDS = 0.8;
const PANNER_REF_DISTANCE = 1.5;
const PANNER_MAX_DISTANCE = 30;
const PANNER_ROLLOFF = 1.2;
const LOOP_FADE_OUT = 0.05;

/** Synthesises the mono waveform for a sound. Pure and deterministic. */
export function renderSound(sound: SoundId, sampleRate: number): Float32Array {
  const recipe = RECIPES[sound];
  return recipe({ sr: sampleRate, rng: createRng(hashString(sound)) });
}

const LOOPING = new Set<SoundId>(LOOPING_SOUNDS);

interface LoopEntry {
  sound: SoundId;
  options: PlayOptions;
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

function webAudioConstructor(): typeof AudioContext | undefined {
  const g = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return g.AudioContext ?? g.webkitAudioContext;
}

export function createAudioSystem(): AudioSystem {
  let ctx: AudioContext | null = null;
  let masterIn: GainNode | null = null;
  let masterOut: GainNode | null = null;
  let dryBus: GainNode | null = null;
  let reverbIn: GainNode | null = null;
  let masterGainValue = 1;
  const buffers = new Map<SoundId, AudioBuffer>();
  const voices = new Map<number, Voice>();
  const loops = new Map<number, LoopEntry>();
  const limiter: VoiceLimiter = createVoiceLimiter();
  let nextLoopId = 1;
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

  function buildGraph(context: AudioContext): void {
    masterIn = context.createGain();
    masterOut = context.createGain();
    masterOut.gain.value = masterGainValue;
    const comp = context.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    masterIn.connect(comp);
    comp.connect(masterOut);
    masterOut.connect(context.destination);

    dryBus = context.createGain();
    dryBus.connect(masterIn);

    reverbIn = context.createGain();
    reverbIn.gain.value = REVERB_WET_LEVEL;
    const convolver = context.createConvolver();
    const [left, right] = makeImpulseResponse(
      context.sampleRate,
      REVERB_SECONDS,
    );
    const ir = context.createBuffer(2, left.length, context.sampleRate);
    ir.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
    ir.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
    convolver.buffer = ir;
    reverbIn.connect(convolver);
    convolver.connect(masterIn);
  }

  function bufferFor(sound: SoundId): AudioBuffer | null {
    if (!ctx) return null;
    let buf = buffers.get(sound);
    if (!buf) {
      const data = renderSound(sound, ctx.sampleRate);
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      buffers.set(sound, buf);
    }
    return buf;
  }

  /** Builds source -> gain -> (panner) -> buses. Returns the nodes, not yet started. */
  function makeChain(
    context: AudioContext,
    buffer: AudioBuffer,
    options: PlayOptions,
    loop: boolean,
  ): { source: AudioBufferSourceNode; gain: GainNode } {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = clampPitch(options.pitch);
    const gain = context.createGain();
    gain.gain.value = clampGain(options.gain);
    source.connect(gain);
    let out: AudioNode = gain;
    if (options.position) {
      const panner = context.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = PANNER_REF_DISTANCE;
      panner.maxDistance = PANNER_MAX_DISTANCE;
      panner.rolloffFactor = PANNER_ROLLOFF;
      const p = options.position;
      if (panner.positionX) {
        panner.positionX.value = p.x;
        panner.positionY.value = p.y;
        panner.positionZ.value = p.z;
      } else {
        panner.setPosition(p.x, p.y, p.z);
      }
      gain.connect(panner);
      out = panner;
    }
    out.connect(dryBus!);
    if (!loop) out.connect(reverbIn!);
    return { source, gain };
  }

  function startLoopNow(entry: LoopEntry): void {
    if (!ctx) return;
    const buffer = bufferFor(entry.sound);
    if (!buffer) return;
    const { source, gain } = makeChain(ctx, buffer, entry.options, true);
    source.start();
    entry.source = source;
    entry.gain = gain;
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
        if (!entry.source) startLoopNow(entry);
      }
    },

    setListener(position, forward, up) {
      listener.position = position;
      listener.forward = forward;
      listener.up = up;
      applyListener();
    },

    play(sound, options = {}) {
      if (!ctx || ctx.state !== "running" || LOOPING.has(sound)) return;
      const buffer = bufferFor(sound);
      if (!buffer) return;
      const gainValue = clampGain(options.gain);
      const pitch = clampPitch(options.pitch);
      const decision = limiter.request(
        sound,
        gainValue,
        ctx.currentTime,
        buffer.duration / pitch,
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
      const { source, gain } = makeChain(ctx, buffer, options, false);
      const id = decision.id;
      voices.set(id, { source, gain });
      source.onended = () => {
        voices.delete(id);
        limiter.release(id);
        source.disconnect();
        gain.disconnect();
      };
      source.start();
    },

    startLoop(sound, options = {}): LoopHandle {
      const id = nextLoopId++;
      const entry: LoopEntry = { sound, options, source: null, gain: null };
      loops.set(id, entry);
      if (ctx && ctx.state === "running") startLoopNow(entry);
      return { id };
    },

    stopLoop(handle) {
      const entry = loops.get(handle.id);
      if (!entry) return;
      loops.delete(handle.id);
      if (!ctx || !entry.source || !entry.gain) return;
      const t = ctx.currentTime;
      const g = entry.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + LOOP_FADE_OUT);
      entry.source.stop(t + LOOP_FADE_OUT + 0.01);
    },

    setMasterGain(gain) {
      masterGainValue = clampGain(gain);
      if (ctx && masterOut)
        masterOut.gain.setTargetAtTime(masterGainValue, ctx.currentTime, 0.01);
    },
  };
}
