/**
 * WebGPU renderer. Two passes per frame:
 *  1. scene: every DrawItem into a linear rgba16float target at the internal
 *     resolution (depth24plus, back faces culled, CCW front faces);
 *  2. present: that target, texel-for-texel, into the canvas (whose backing
 *     store is the internal resolution) with sRGB encoding, ordered dither
 *     and colour quantisation. CSS `image-rendering: pixelated` upscales it.
 * The pure parts (layouts, packing, light selection, mips) live in layout.ts.
 */
import { mat4 } from "../math";
import type {
  MeshHandle,
  RenderFrame,
  Renderer,
  RendererOptions,
  TextureImage,
} from "../core/api";
import { MATERIAL_IDS, MATERIALS, type MaterialId } from "../core/materials";
import type { MeshData } from "../core/mesh";
import {
  buildMipChain,
  computeInternalSize,
  FRAME_BYTES,
  FRAME_FLOATS,
  interleaveVertices,
  ITEM_FLOATS,
  ITEM_STRIDE,
  MAX_LIGHTS,
  packFrameUniforms,
  packItem,
  packPostUniforms,
  RETRO_COLOR_BITS,
  RETRO_DITHER,
  selectLights,
  VERTEX_OFFSETS,
  VERTEX_STRIDE,
} from "./layout";
import postShader from "./post.wgsl" with { type: "text" };
import sceneShader from "./scene.wgsl" with { type: "text" };

export { RETRO_COLOR_BITS, RETRO_DITHER } from "./layout";

// The DOM lib in this toolchain types the GPU* interfaces but not the
// GPUBufferUsage / GPUShaderStage / GPUTextureUsage globals; these are the
// fixed values from the WebGPU specification.
const BufferUsage = {
  COPY_DST: 0x8,
  INDEX: 0x10,
  VERTEX: 0x20,
  UNIFORM: 0x40,
  STORAGE: 0x80,
} as const;
const ShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2 } as const;
const TextureUsage = {
  COPY_DST: 0x2,
  TEXTURE_BINDING: 0x4,
  RENDER_ATTACHMENT: 0x10,
} as const;

const SCENE_FORMAT: GPUTextureFormat = "rgba16float";
const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

interface GpuMesh {
  vertices: GPUBuffer;
  indices: GPUBuffer;
  indexCount: number;
  materialIndex: number;
  hasColors: boolean;
  emissive: boolean;
}

async function compileShader(
  device: GPUDevice,
  name: string,
  code: string,
): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ label: name, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  for (const m of info.messages) {
    const text = `render: shader ${name} ${m.type} at ${m.lineNum}:${m.linePos}: ${m.message}`;
    if (m.type === "error") {
      console.error(text);
    } else {
      console.warn(text);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `render: shader ${name} failed to compile (${errors.length} error(s)); see console`,
    );
  }
  return module;
}

/** Magenta/black checker for a material that has no texture. */
function missingTexture(material: MaterialId): TextureImage {
  const size = 16;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = ((x >> 2) + (y >> 2)) % 2 === 0;
      const o = (y * size + x) * 4;
      pixels[o] = on ? 255 : 0;
      pixels[o + 1] = 0;
      pixels[o + 2] = on ? 255 : 0;
      pixels[o + 3] = 255;
    }
  }
  return { material, size, pixels };
}

export async function createRenderer(
  options: RendererOptions,
): Promise<Renderer> {
  const gpu = typeof navigator !== "undefined" ? navigator.gpu : undefined;
  if (!gpu) {
    throw new Error(
      "render: WebGPU is not available in this browser (navigator.gpu is missing)",
    );
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error("render: no WebGPU adapter found");
  }
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`render: could not create a WebGPU device: ${message}`);
  }
  let lost = false;
  void device.lost.then((info) => {
    lost = true;
    if (info.reason !== "destroyed") {
      console.error(`render: WebGPU device lost: ${info.message}`);
    }
  });
  device.addEventListener("uncapturederror", (event) => {
    console.error(
      `render: WebGPU error: ${(event as GPUUncapturedErrorEvent).error.message}`,
    );
  });

  const canvas = options.canvas;
  // The built-in DOM types know the GPU* interfaces but not the "webgpu" context id.
  const maybeContext = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!maybeContext) {
    throw new Error("render: could not create a WebGPU canvas context");
  }
  const context: GPUCanvasContext = maybeContext;
  const canvasFormat = gpu.getPreferredCanvasFormat();
  context.configure({ device, format: canvasFormat, alphaMode: "opaque" });
  canvas.style.imageRendering = "pixelated";

  const [sceneModule, postModule] = await Promise.all([
    compileShader(device, "scene.wgsl", sceneShader),
    compileShader(device, "post.wgsl", postShader),
  ]);

  // --- Layouts and pipelines ----------------------------------------------

  const frameLayout = device.createBindGroupLayout({
    label: "frame",
    entries: [
      {
        binding: 0,
        visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const materialLayout = device.createBindGroupLayout({
    label: "material",
    entries: [{ binding: 0, visibility: ShaderStage.FRAGMENT, texture: {} }],
  });
  const postLayout = device.createBindGroupLayout({
    label: "post",
    entries: [
      {
        binding: 0,
        visibility: ShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float" },
      },
      {
        binding: 1,
        visibility: ShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const scenePipeline = device.createRenderPipeline({
    label: "scene",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [frameLayout, materialLayout],
    }),
    vertex: {
      module: sceneModule,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: VERTEX_STRIDE,
          attributes: [
            {
              shaderLocation: 0,
              offset: VERTEX_OFFSETS.position,
              format: "float32x3",
            },
            {
              shaderLocation: 1,
              offset: VERTEX_OFFSETS.normal,
              format: "float32x3",
            },
            {
              shaderLocation: 2,
              offset: VERTEX_OFFSETS.uv,
              format: "float32x2",
            },
            {
              shaderLocation: 3,
              offset: VERTEX_OFFSETS.color,
              format: "float32x3",
            },
          ],
        },
      ],
    },
    fragment: {
      module: sceneModule,
      entryPoint: "fs",
      targets: [{ format: SCENE_FORMAT }],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "back",
      frontFace: "ccw",
    },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  const postPipeline = device.createRenderPipeline({
    label: "post",
    layout: device.createPipelineLayout({ bindGroupLayouts: [postLayout] }),
    vertex: { module: postModule, entryPoint: "vs" },
    fragment: {
      module: postModule,
      entryPoint: "fs",
      targets: [{ format: canvasFormat }],
    },
    primitive: { topology: "triangle-list" },
  });

  // --- Static resources ---------------------------------------------------

  const frameBuffer = device.createBuffer({
    label: "frame uniforms",
    size: FRAME_BYTES,
    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  });
  const frameData = new Float32Array(FRAME_FLOATS);

  const postBuffer = device.createBuffer({
    label: "post uniforms",
    size: 16,
    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    postBuffer,
    0,
    packPostUniforms(RETRO_COLOR_BITS, RETRO_DITHER),
  );

  // Nearest everywhere, including between mip levels: crisp texels, and the
  // mips keep distant floors from turning to noise at 240p (as the classic
  // software renderers did with their own nearest-sampled mip levels).
  const sampler = device.createSampler({
    label: "albedo",
    addressModeU: "repeat",
    addressModeV: "repeat",
    magFilter: "nearest",
    minFilter: "nearest",
    mipmapFilter: "nearest",
  });

  const materialIndex = new Map<MaterialId, number>();
  const materialGroups: GPUBindGroup[] = [];
  for (const id of MATERIAL_IDS) {
    let image = options.textures.get(id);
    if (!image) {
      console.warn(`render: no texture for material ${id}; using a checker`);
      image = missingTexture(id);
    }
    const levels = buildMipChain(image.size, image.pixels);
    const texture = device.createTexture({
      label: `texture ${id}`,
      size: [image.size, image.size],
      mipLevelCount: levels.length,
      format: "rgba8unorm-srgb",
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
    levels.forEach((level, mipLevel) => {
      device.queue.writeTexture(
        { texture, mipLevel },
        level.pixels,
        { bytesPerRow: level.size * 4, rowsPerImage: level.size },
        [level.size, level.size],
      );
    });
    materialIndex.set(id, materialGroups.length);
    materialGroups.push(
      device.createBindGroup({
        label: `material ${id}`,
        layout: materialLayout,
        entries: [{ binding: 0, resource: texture.createView() }],
      }),
    );
  }

  // --- Per-item storage (grows, never shrinks) ----------------------------

  let itemCapacity = 0;
  let itemBuffer: GPUBuffer | null = null;
  let itemData = new Float32Array(0);
  let frameGroup: GPUBindGroup | null = null;

  function ensureItemCapacity(count: number): void {
    if (count <= itemCapacity && itemBuffer) {
      return;
    }
    let capacity = Math.max(256, itemCapacity);
    while (capacity < count) {
      capacity *= 2;
    }
    itemBuffer?.destroy();
    itemCapacity = capacity;
    itemBuffer = device.createBuffer({
      label: "draw items",
      size: capacity * ITEM_STRIDE,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    itemData = new Float32Array(capacity * ITEM_FLOATS);
    frameGroup = device.createBindGroup({
      label: "frame",
      layout: frameLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: { buffer: itemBuffer } },
        { binding: 2, resource: sampler },
      ],
    });
  }
  ensureItemCapacity(256);

  // --- Size-dependent targets ---------------------------------------------

  let width = 0;
  let height = 0;
  let sceneTexture: GPUTexture | null = null;
  let sceneView: GPUTextureView | null = null;
  let depthView: GPUTextureView | null = null;
  let depthTexture: GPUTexture | null = null;
  let postGroup: GPUBindGroup | null = null;

  function resize(windowWidth: number, windowHeight: number): void {
    const size = computeInternalSize(
      windowWidth,
      windowHeight,
      options.internalHeight,
    );
    if (size.width === width && size.height === height) {
      return;
    }
    width = size.width;
    height = size.height;
    canvas.width = width;
    canvas.height = height;
    sceneTexture?.destroy();
    depthTexture?.destroy();
    sceneTexture = device.createTexture({
      label: "scene color",
      size: [width, height],
      format: SCENE_FORMAT,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
    });
    depthTexture = device.createTexture({
      label: "scene depth",
      size: [width, height],
      format: DEPTH_FORMAT,
      usage: TextureUsage.RENDER_ATTACHMENT,
    });
    sceneView = sceneTexture.createView();
    depthView = depthTexture.createView();
    postGroup = device.createBindGroup({
      label: "post",
      layout: postLayout,
      entries: [
        { binding: 0, resource: sceneView },
        { binding: 1, resource: { buffer: postBuffer } },
      ],
    });
  }

  const initialWidth =
    typeof window !== "undefined" ? window.innerWidth : canvas.width;
  const initialHeight =
    typeof window !== "undefined" ? window.innerHeight : canvas.height;
  resize(initialWidth, initialHeight);

  // --- Meshes -------------------------------------------------------------

  const meshes = new Map<number, GpuMesh>();
  let nextMeshId = 1;

  function createMesh(data: MeshData): MeshHandle {
    const material = materialIndex.get(data.material);
    if (material === undefined) {
      throw new Error(`render: unknown material ${String(data.material)}`);
    }
    const interleaved = interleaveVertices(data);
    const vertices = device.createBuffer({
      label: `mesh ${nextMeshId} vertices`,
      size: Math.max(4, interleaved.byteLength),
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertices, 0, interleaved);
    const indices = device.createBuffer({
      label: `mesh ${nextMeshId} indices`,
      size: Math.max(4, data.indices.byteLength),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indices, 0, data.indices);
    const id = nextMeshId++;
    meshes.set(id, {
      vertices,
      indices,
      indexCount: data.indices.length - (data.indices.length % 3),
      materialIndex: material,
      hasColors: data.colors !== undefined,
      emissive: MATERIALS[data.material].emissive,
    });
    return { id };
  }

  function destroyMesh(handle: MeshHandle): void {
    const mesh = meshes.get(handle.id);
    if (!mesh) {
      return;
    }
    meshes.delete(handle.id);
    // Safe even if a submitted frame still uses them: WebGPU defers the free.
    mesh.vertices.destroy();
    mesh.indices.destroy();
  }

  // --- Frame --------------------------------------------------------------

  // Reused per frame to avoid garbage.
  const drawMeshes: GpuMesh[] = [];
  const drawOrder: number[] = [];
  const clearValue = { r: 0, g: 0, b: 0, a: 1 };

  function render(frame: RenderFrame): void {
    if (lost || !sceneView || !depthView || !postGroup) {
      return;
    }
    const camera = frame.camera;
    const projection = mat4.perspective(
      camera.fovY,
      width / height,
      camera.near,
      camera.far,
    );
    const viewProj = mat4.multiply(
      projection,
      mat4.view(camera.position, camera.orientation),
    );
    packFrameUniforms(
      {
        viewProj,
        camera,
        ambient: frame.ambient,
        fog: frame.fog,
        time: frame.time,
        lights: selectLights(frame.lights, camera.position, MAX_LIGHTS),
      },
      frameData,
    );
    device.queue.writeBuffer(frameBuffer, 0, frameData);

    // Resolve items, skipping destroyed meshes, then sort by material so the
    // texture bind group changes as rarely as possible.
    drawMeshes.length = 0;
    drawOrder.length = 0;
    const items = frame.items;
    ensureItemCapacity(items.length);
    for (let i = 0; i < items.length; i++) {
      const mesh = meshes.get(items[i].mesh.id);
      if (!mesh || mesh.indexCount === 0) {
        continue;
      }
      const slot = drawMeshes.length;
      packItem(
        itemData,
        slot,
        items[i].transform,
        items[i].tint,
        mesh.hasColors,
        mesh.emissive,
      );
      drawMeshes.push(mesh);
      drawOrder.push(slot);
    }
    if (drawMeshes.length > 0 && itemBuffer) {
      device.queue.writeBuffer(
        itemBuffer,
        0,
        itemData,
        0,
        drawMeshes.length * ITEM_FLOATS,
      );
    }
    drawOrder.sort(
      (a, b) => drawMeshes[a].materialIndex - drawMeshes[b].materialIndex,
    );

    clearValue.r = frame.fog.color.x;
    clearValue.g = frame.fog.color.y;
    clearValue.b = frame.fog.color.z;

    const encoder = device.createCommandEncoder({ label: "frame" });
    const scenePass = encoder.beginRenderPass({
      label: "scene",
      colorAttachments: [
        { view: sceneView, clearValue, loadOp: "clear", storeOp: "store" },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    scenePass.setPipeline(scenePipeline);
    scenePass.setBindGroup(0, frameGroup);
    let boundMaterial = -1;
    for (const slot of drawOrder) {
      const mesh = drawMeshes[slot];
      if (mesh.materialIndex !== boundMaterial) {
        boundMaterial = mesh.materialIndex;
        scenePass.setBindGroup(1, materialGroups[boundMaterial]);
      }
      scenePass.setVertexBuffer(0, mesh.vertices);
      scenePass.setIndexBuffer(mesh.indices, "uint32");
      // firstInstance carries the item index to the shader (instance_index).
      scenePass.drawIndexed(mesh.indexCount, 1, 0, 0, slot);
    }
    scenePass.end();

    const postPass = encoder.beginRenderPass({
      label: "present",
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        },
      ],
    });
    postPass.setPipeline(postPipeline);
    postPass.setBindGroup(0, postGroup);
    postPass.draw(3);
    postPass.end();
    device.queue.submit([encoder.finish()]);
  }

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    resize,
    createMesh,
    destroyMesh,
    render,
  };
}
