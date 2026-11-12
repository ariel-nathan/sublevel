import triangleShader from "./shaders/triangle.wgsl" with { type: "text" };
import { internalResolution } from "./resolution";

const status = document.getElementById("status") as HTMLDivElement;

async function start(): Promise<void> {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available in this browser");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found");
  }
  const device = await adapter.requestDevice();
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const size = internalResolution(window.innerWidth, window.innerHeight, 240);
  canvas.width = size.width;
  canvas.height = size.height;

  // The built-in DOM types know the GPU* interfaces but not the "webgpu" context id.
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) {
    throw new Error("Could not create a WebGPU canvas context");
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  const module = device.createShaderModule({ code: triangleShader });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const frame = (): void => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.05, g: 0.06, b: 0.08, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  status.textContent = `webgpu ok ${size.width}x${size.height} ${format}`;
  console.log("sublevel: webgpu ok", size.width, size.height, format);
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = `error: ${message}`;
  status.style.color = "#f99";
  console.error("sublevel:", message);
});
