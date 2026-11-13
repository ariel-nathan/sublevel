/**
 * Audio module. `renderSound` is a pure synthesiser (runs under `bun test`);
 * `createAudioSystem` is a thin Web Audio wrapper that plays the results.
 *
 * Pure helpers the game uses alongside the system are re-exported here:
 * `contactLoopParams` and `createContactVoicePool` (scrape and roll loops,
 * contactVoices.ts), `measureOcclusion` / `occlusionParams` (voices.ts) and
 * `roomAt` (rooms.ts).
 */
import {
  LOOPING_SOUNDS,
  SOUND_IDS,
  type AudioSystem,
  type LoopHandle,
  type PlayOptions,
  type RoomAcoustics,
  type SoundId,
} from "../core/api";
import { createRng, hashString } from "../core/rng";
import type { Vec3 } from "../math";
import { CANDIDATE_RECIPES } from "./candidates";
import {
  BUSES,
  CANDIDATES,
  CATEGORY_OF,
  ERA,
  PRIORITY_OF,
  familyOf,
  finishSound,
  loudnessFor,
  parseSfx,
  type Candidate,
  type CandidateSelection,
  type CompressorSettings,
  type Family,
} from "./mix";
import { RECIPES, VARIANTS } from "./recipes";
import { DEFAULT_ROOM, ROOM_FADE, ROOM_PRESETS, roomImpulseFor } from "./rooms";
import {
  ATTENUATION,
  clampGain,
  clampOcclusion,
  clampPitch,
  createVoiceLimiter,
  distanceCutoff,
  distanceGain,
  distanceSend,
  occlusionParams,
  type Attenuation,
  type VoiceLimiter,
} from "./voices";

export {
  contactLoopFor,
  contactLoopParams,
  contactMaterialOf,
  createContactVoicePool,
  type ContactInput,
  type ContactLoopCommand,
  type ContactVoicePool,
} from "./contactVoices";
export { measureOcclusion, occlusionParams } from "./voices";
export { roomAt } from "./rooms";

const LOOPING = new Set<SoundId>(LOOPING_SOUNDS);

/** Synthesises the mono waveform for a sound. Pure and deterministic. */
export function renderSound(sound: SoundId, sampleRate: number): Float32Array {
  return renderVariant(sound, sampleRate, 0);
}

/** The design `sound` uses under `selection` ("current" for one-design sounds). */
export function candidateOf(
  sound: SoundId,
  selection: Readonly<CandidateSelection> = CANDIDATES,
): Candidate {
  const family = familyOf(sound);
  return family ? selection[family] : "current";
}

/**
 * Synthesises take `variant` (0..VARIANTS[sound]-1) of a sound, in the
 * design `candidate` (default: the family's entry in `CANDIDATES`). Take 0 is
 * `renderSound`. Pure and deterministic.
 */
export function renderVariant(
  sound: SoundId,
  sampleRate: number,
  variant: number,
  candidate: Candidate = candidateOf(sound),
): Float32Array {
  const recipe =
    candidate === "current"
      ? RECIPES[sound]
      : (CANDIDATE_RECIPES[candidate][sound] ?? RECIPES[sound]);
  const name = candidate === "current" ? sound : `${sound}@${candidate}`;
  const seed = hashString(variant === 0 ? name : `${name}#${variant}`);
  const raw = recipe({
    sr: sampleRate,
    rng: createRng(seed),
    variant,
  });
  return finishSound(
    sound,
    raw,
    sampleRate,
    LOOPING.has(sound),
    ERA,
    loudnessFor(sound, candidate),
  );
}

/**
 * The design selection a page asks for: `CANDIDATES`, overridden by the
 * page URL's `?sfx=` when running in a browser.
 */
function initialSelection(): CandidateSelection {
  const selection: CandidateSelection = { ...CANDIDATES };
  const location = (globalThis as { location?: { search?: string } }).location;
  if (typeof location?.search === "string")
    Object.assign(selection, parseSfx(location.search));
  return selection;
}

/** Extra controls beyond the game contract, used by the demo page. */
export interface AudioDebugControls {
  /** Turns the room reverb on or off. */
  setReverbEnabled(on: boolean): void;
  /** Picks the design a family plays from now on (no reload needed). */
  setCandidate(family: Family, candidate: Candidate): void;
  /** The current design selection. */
  candidates(): CandidateSelection;
  /** The room set last (the default until `setRoom` is called). */
  room(): RoomAcoustics;
  /** Loops currently holding Web Audio nodes (not silent and dormant). */
  activeLoopCount(): number;
}

/** A loop at or below this gain is silent: it releases its nodes. */
const SILENT = 1e-4;

interface Chain {
  source: AudioBufferSourceNode;
  /** Level set by the caller (and fades). */
  gain: GainNode;
  /** Distance attenuation, updated as the listener moves. */
  distance: GainNode | null;
  filter: BiquadFilterNode | null;
  /** Occlusion: low-pass and level on the direct sound only. */
  occFilter: BiquadFilterNode | null;
  occGain: GainNode | null;
  panner: PannerNode | null;
  send: GainNode;
  position: Vec3 | null;
  attenuation: Attenuation;
  sendLevel: number;
  occlusion: number;
}

interface LoopEntry {
  id: number;
  sound: SoundId;
  /** The loop's current target parameters. */
  options: PlayOptions;
  /** Null while the loop is silent (gain 0) or audio has not started. */
  chain: Chain | null;
  /** How many times the loop has (re)started, to vary its start offset. */
  starts: number;
}

interface RoomNode {
  convolver: ConvolverNode;
  level: GainNode;
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

/** Freezes a parameter at its current value at `t`, dropping later automation. */
function hold(param: AudioParam, t: number): void {
  const p = param as AudioParam & {
    cancelAndHoldAtTime?: (time: number) => AudioParam;
  };
  if (typeof p.cancelAndHoldAtTime === "function") {
    p.cancelAndHoldAtTime(t);
  } else {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
}

/**
 * Moves a parameter to `value`: immediately if `seconds` <= 0, otherwise
 * along an exponential approach that is 95 % there after `seconds`
 * (smooth, no zipper noise, and safe to retarget every frame).
 */
function glide(
  param: AudioParam,
  value: number,
  t: number,
  seconds: number,
): void {
  if (seconds <= 0) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(value, t);
    return;
  }
  hold(param, t);
  param.setTargetAtTime(value, t, seconds / 3);
}

/** Contact loops (scrapes, rolls) are world sounds that follow the physics. */
function isContact(sound: SoundId): boolean {
  return CATEGORY_OF[sound] === "contact";
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
  let room: RoomAcoustics = DEFAULT_ROOM;
  let roomNodes: RoomNode[] = [];
  const roomBuffers = new Map<RoomAcoustics, AudioBuffer>();
  const buffers = new Map<string, AudioBuffer>();
  const voices = new Map<number, Chain>();
  const loops = new Map<number, LoopEntry>();
  const limiter: VoiceLimiter = createVoiceLimiter();
  const takeCounter = new Map<SoundId, number>();
  const selection = initialSelection();
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

  /** Reverb send of a chain: its level, distance and occlusion. */
  function sendOf(chain: Chain): number {
    const d = chain.position
      ? distanceSend(distanceTo(chain.position), chain.attenuation)
      : 1;
    return chain.sendLevel * d * occlusionParams(chain.occlusion).send;
  }

  /**
   * Sets a chain's distance-dependent parameters, immediately (`seconds`
   * 0) or gliding over `seconds`.
   */
  function applyDistance(chain: Chain, seconds: number): void {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (chain.position && chain.distance && chain.filter) {
      const d = distanceTo(chain.position);
      glide(
        chain.distance.gain,
        distanceGain(d, chain.attenuation),
        t,
        seconds,
      );
      glide(
        chain.filter.frequency,
        distanceCutoff(d, chain.attenuation),
        t,
        seconds,
      );
    }
    glide(chain.send.gain, sendOf(chain), t, seconds);
  }

  /** Sets a chain's occlusion stage (and its send) to `chain.occlusion`. */
  function applyOcclusion(chain: Chain, seconds: number): void {
    if (!ctx || !chain.occFilter || !chain.occGain) return;
    const t = ctx.currentTime;
    const o = occlusionParams(chain.occlusion);
    glide(chain.occFilter.frequency, o.cutoff, t, seconds);
    glide(chain.occGain.gain, o.gain, t, seconds);
    glide(chain.send.gain, sendOf(chain), t, seconds);
  }

  function roomBuffer(context: AudioContext, r: RoomAcoustics): AudioBuffer {
    let buf = roomBuffers.get(r);
    if (!buf) {
      const [left, right] = roomImpulseFor(r, context.sampleRate);
      buf = context.createBuffer(2, left.length, context.sampleRate);
      buf.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
      roomBuffers.set(r, buf);
    }
    return buf;
  }

  /**
   * Starts the reverb of room `r`, cross-fading from whatever played
   * before over `fade` seconds. Each room gets a fresh convolver (cheap:
   * impulse responses are generated once and cached); the old ones are
   * disconnected once silent.
   */
  function switchRoom(context: AudioContext, r: RoomAcoustics, fade: number) {
    if (!reverbIn || !reverbReturn) return;
    const t = context.currentTime;
    const convolver = context.createConvolver();
    convolver.normalize = false;
    convolver.buffer = roomBuffer(context, r);
    const level = context.createGain();
    const wet = ROOM_PRESETS[r].wet;
    if (fade > 0) {
      level.gain.setValueAtTime(0, t);
      level.gain.linearRampToValueAtTime(wet, t + fade);
    } else {
      level.gain.value = wet;
    }
    reverbIn.connect(convolver);
    convolver.connect(level);
    level.connect(reverbReturn);
    const input = reverbIn;
    for (const old of roomNodes) {
      hold(old.level.gain, t);
      old.level.gain.linearRampToValueAtTime(0, t + Math.max(fade, 0.01));
      setTimeout(
        () => {
          input.disconnect(old.convolver);
          old.convolver.disconnect();
          old.level.disconnect();
        },
        (Math.max(fade, 0.01) + 0.1) * 1000,
      );
    }
    roomNodes = [{ convolver, level }];
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
    reverbReturn.connect(mix);
    switchRoom(context, room, 0);
  }

  function bufferFor(sound: SoundId, variant: number): AudioBuffer | null {
    if (!ctx) return null;
    const candidate = candidateOf(sound, selection);
    const key = `${sound}@${candidate}#${variant}`;
    let buf = buffers.get(key);
    if (!buf) {
      const data = renderVariant(sound, ctx.sampleRate, variant, candidate);
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      buffers.set(key, buf);
    }
    return buf;
  }

  /**
   * Renders every take in the background, one per task, after start-up.
   * The contact loops (the slowest renders, ~40 ms each) come last; a loop
   * the game starts earlier is rendered on the spot instead.
   */
  function queuePrerender(): void {
    if (prerenderQueued) return;
    prerenderQueued = true;
    const jobs: [SoundId, number][] = [];
    const ordered = [
      ...SOUND_IDS.filter((s) => !isContact(s)),
      ...SOUND_IDS.filter(isContact),
    ];
    for (const sound of ordered) {
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

  function setPannerPosition(
    panner: PannerNode,
    p: Vec3,
    t: number,
    seconds: number,
  ): void {
    if (panner.positionX) {
      glide(panner.positionX, p.x, t, seconds);
      glide(panner.positionY, p.y, t, seconds);
      glide(panner.positionZ, p.z, t, seconds);
    } else {
      panner.setPosition(p.x, p.y, p.z);
    }
  }

  /**
   * Builds the voice graph:
   *
   *   source -> gain -> [distance -> filter] -+-> send -> reverb
   *                                           +-> [occlusion lp -> level] -> [panner] -> bus
   *
   * Distance and the panner exist for positional sounds; the occlusion
   * stage for loops and for one-shots played with some occlusion. The
   * reverb send is tapped before the occlusion stage, so occluded sounds
   * keep more of their reverb than of their direct sound.
   */
  function makeChain(
    context: AudioContext,
    buffer: AudioBuffer,
    options: PlayOptions,
    loop: boolean,
    attenuation: Attenuation,
    sendLevel: number,
    bus: GainNode,
  ): Chain {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = clampPitch(options.pitch);
    const gain = context.createGain();
    gain.gain.value = clampGain(options.gain);
    source.connect(gain);
    let tap: AudioNode = gain;
    let distance: GainNode | null = null;
    let filter: BiquadFilterNode | null = null;
    let panner: PannerNode | null = null;
    const occlusion = clampOcclusion(options.occlusion);
    if (options.position) {
      distance = context.createGain();
      filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.5;
      gain.connect(distance);
      distance.connect(filter);
      tap = filter;
    }
    const send = context.createGain();
    tap.connect(send);
    send.connect(reverbIn!);
    let direct: AudioNode = tap;
    let occFilter: BiquadFilterNode | null = null;
    let occGain: GainNode | null = null;
    if (loop || occlusion > 0) {
      occFilter = context.createBiquadFilter();
      occFilter.type = "lowpass";
      occFilter.Q.value = 0.6;
      occGain = context.createGain();
      direct.connect(occFilter);
      occFilter.connect(occGain);
      direct = occGain;
    }
    if (options.position) {
      panner = context.createPanner();
      panner.panningModel = "HRTF";
      // Attenuation is done by `distance` (see voices.ts); the panner only
      // places the sound.
      panner.distanceModel = "inverse";
      panner.rolloffFactor = 0;
      setPannerPosition(panner, options.position, context.currentTime, 0);
      direct.connect(panner);
      direct = panner;
    }
    direct.connect(bus);
    const chain: Chain = {
      source,
      gain,
      distance,
      filter,
      occFilter,
      occGain,
      panner,
      send,
      position: options.position ?? null,
      attenuation,
      sendLevel,
      occlusion,
    };
    applyDistance(chain, 0);
    applyOcclusion(chain, 0);
    return chain;
  }

  function disconnect(chain: Chain): void {
    chain.source.disconnect();
    chain.gain.disconnect();
    chain.distance?.disconnect();
    chain.filter?.disconnect();
    chain.occFilter?.disconnect();
    chain.occGain?.disconnect();
    chain.panner?.disconnect();
    chain.send.disconnect();
  }

  /** Fades a chain to silence over `seconds`, stops it and frees its nodes. */
  function retire(chain: Chain, seconds: number): void {
    if (!ctx) return;
    const t = ctx.currentTime;
    const g = chain.gain.gain;
    hold(g, t);
    g.linearRampToValueAtTime(0, t + seconds);
    chain.source.onended = () => disconnect(chain);
    chain.source.stop(t + seconds + 0.01);
  }

  /** Starts a loop's sound, fading in from silence over `fade` seconds. */
  function startLoopNow(entry: LoopEntry, fade: number): void {
    if (!ctx) return;
    if (clampGain(entry.options.gain) <= SILENT) return;
    const buffer = bufferFor(entry.sound, 0);
    if (!buffer) return;
    const contact = isContact(entry.sound);
    const chain = makeChain(
      ctx,
      buffer,
      entry.options,
      true,
      contact ? ATTENUATION.world : ATTENUATION.ambience,
      entry.options.position
        ? contact
          ? BUSES.contactReverbSend
          : BUSES.ambienceReverbSend
        : 0,
      contact ? sfxBus! : ambienceBus!,
    );
    const target = clampGain(entry.options.gain);
    const t = ctx.currentTime;
    chain.gain.gain.setValueAtTime(0, t);
    chain.gain.gain.linearRampToValueAtTime(target, t + Math.max(0.005, fade));
    // Start at a different point each time, so several emitters of the same
    // sound, or one crate pushed again and again, never repeat in phase.
    const u = (entry.id * 0.37 + entry.starts * 0.618) % 1;
    entry.starts++;
    chain.source.start(t, u * buffer.duration);
    entry.chain = chain;
  }

  function fadeInFor(sound: SoundId): number {
    return isContact(sound) ? BUSES.contactFadeIn : BUSES.loopFadeIn;
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
        if (!entry.chain) startLoopNow(entry, fadeInFor(entry.sound));
      }
      queuePrerender();
    },

    setLoopParams(handle, params, fadeSeconds = 0.05) {
      const entry = loops.get(handle.id);
      if (!entry) return;
      const fade = Math.max(0, Number.isFinite(fadeSeconds) ? fadeSeconds : 0);
      const before = entry.options;
      const next: PlayOptions = { ...before };
      if (params.gain !== undefined) next.gain = params.gain;
      if (params.pitch !== undefined) next.pitch = params.pitch;
      if (params.position !== undefined) next.position = params.position;
      if (params.occlusion !== undefined) next.occlusion = params.occlusion;
      entry.options = next;
      if (!ctx || ctx.state !== "running") return;
      const gain = clampGain(next.gain);
      let chain = entry.chain;
      // A positional change on a loop that started without a position
      // needs a new graph: hand over to a fresh chain.
      if (chain && next.position && !chain.panner) {
        retire(chain, Math.max(0.02, fade));
        entry.chain = chain = null;
      }
      if (gain <= SILENT) {
        // Silent: fade out, then release every node. The loop costs
        // nothing until its gain comes back.
        if (chain) {
          retire(chain, Math.max(0.01, fade));
          entry.chain = null;
        }
        return;
      }
      if (!chain) {
        startLoopNow(entry, Math.max(0.01, fade));
        return;
      }
      const t = ctx.currentTime;
      glide(chain.gain.gain, gain, t, fade);
      if (params.pitch !== undefined)
        glide(chain.source.playbackRate, clampPitch(next.pitch), t, fade);
      if (params.position !== undefined && chain.panner && next.position) {
        chain.position = next.position;
        setPannerPosition(chain.panner, next.position, t, fade);
        applyDistance(chain, fade);
      }
      if (params.occlusion !== undefined) {
        chain.occlusion = clampOcclusion(next.occlusion);
        applyOcclusion(chain, fade);
      }
    },

    setRoom(next) {
      if (!(next in ROOM_PRESETS) || next === room) return;
      room = next;
      if (ctx) switchRoom(ctx, room, ROOM_FADE);
    },

    setListener(position, forward, up) {
      listener.position = position;
      listener.forward = forward;
      listener.up = up;
      applyListener();
      for (const entry of loops.values()) {
        if (entry.chain) applyDistance(entry.chain, 0.15);
      }
      for (const chain of voices.values()) applyDistance(chain, 0.15);
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
        occlusionParams(options.occlusion).gain *
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
        sfxBus!,
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
      const entry: LoopEntry = {
        id,
        sound,
        options: { ...options },
        chain: null,
        starts: 0,
      };
      loops.set(id, entry);
      if (ctx && ctx.state === "running") startLoopNow(entry, fadeInFor(sound));
      return { id };
    },

    stopLoop(handle) {
      const entry = loops.get(handle.id);
      if (!entry) return;
      loops.delete(handle.id);
      if (ctx && entry.chain) retire(entry.chain, BUSES.loopFadeOut);
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

    setCandidate(family, candidate) {
      selection[family] = candidate;
    },

    candidates() {
      return { ...selection };
    },

    room() {
      return room;
    },

    activeLoopCount() {
      let n = 0;
      for (const entry of loops.values()) if (entry.chain) n++;
      return n;
    },
  };
}
