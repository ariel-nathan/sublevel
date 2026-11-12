/**
 * Development-only: launches the game in a headless copy of the installed
 * Edge or Chrome and talks to it over the DevTools protocol, with no
 * dependencies. Each session has its own dev server, browser process and
 * throwaway profile, so several can run at once.
 *
 *   const session = await launchGame();
 *   await session.evaluate("__harness.step(60, { moveZ: 1 })");
 *   await session.captureFrame("out/frame.png");
 *   await session.close();
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export interface LaunchOptions {
  /** Show the browser window. Default false (headless). */
  headed?: boolean;
  /** Window size in CSS pixels. Default 1280 x 720. */
  width?: number;
  height?: number;
  /** Page to serve, relative to the repo root. Default "index.html". */
  page?: string;
  /** Query string without the "?". Default "harness". */
  query?: string;
}

export interface KeyOptions {
  /** KeyboardEvent.code, e.g. "KeyW", "Space", "ShiftLeft". */
  code: string;
}

export interface GameSession {
  /** Base URL of this session's dev server. */
  readonly url: string;
  /** Console output and uncaught errors from the page so far. */
  readonly consoleLines: string[];
  /** Sends a raw DevTools protocol command. */
  send(method: string, params?: object): Promise<any>;
  /** Evaluates an expression in the page, awaiting promises. Throws on error. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Saves the last harness frame (exact internal resolution) as a PNG. */
  captureFrame(path: string): Promise<void>;
  /** Saves a screenshot of the whole page, HUD included, as a PNG. */
  screenshot(path: string): Promise<void>;
  /** Real, trusted keyboard events. */
  keyDown(code: string): Promise<void>;
  keyUp(code: string): Promise<void>;
  /** Real, trusted relative mouse movement in pixels. */
  mouseMove(dx: number, dy: number): Promise<void>;
  /** Real, trusted mouse button press and release at the window centre. */
  mouseDown(button?: "left" | "right"): Promise<void>;
  mouseUp(button?: "left" | "right"): Promise<void>;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function retry<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await Bun.sleep(150);
    }
  }
}

/** Windows virtual key codes for the keys the game uses. */
function virtualKey(code: string): number {
  if (code.startsWith("Key")) {
    return code.charCodeAt(3);
  }
  if (code.startsWith("Digit")) {
    return code.charCodeAt(5);
  }
  const table: Record<string, number> = {
    Space: 32,
    ShiftLeft: 16,
    ControlLeft: 17,
    Escape: 27,
    Enter: 13,
    F8: 119,
  };
  return table[code] ?? 0;
}

export async function launchGame(
  options: LaunchOptions = {},
): Promise<GameSession> {
  const executable = BROWSER_PATHS.find((path) => existsSync(path));
  if (!executable) {
    throw new Error("No Edge or Chrome installation found");
  }
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const page = options.page ?? "index.html";
  const query = options.query ?? "harness";
  const gamePort = await freePort();
  const debugPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "sublevel-browser-"));

  const server = Bun.spawn(["bun", `./${page}`, "--port", String(gamePort)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const browser = Bun.spawn(
    [
      executable,
      ...(options.headed ? [] : ["--headless=new"]),
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--hide-scrollbars",
      "--mute-audio",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const shutdown = async (): Promise<void> => {
    browser.kill();
    server.kill();
    await browser.exited;
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // The profile folder can stay locked briefly on Windows; it is in temp.
    }
  };

  try {
    const url = `http://localhost:${gamePort}/`;
    await retry(() => fetch(url), 15000);
    const targets = await retry(async () => {
      const response = await fetch(`http://localhost:${debugPort}/json/list`);
      return (await response.json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
    }, 15000);
    const target = targets.find((entry) => entry.type === "page");
    if (!target) {
      throw new Error("Browser exposed no page to control");
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("DevTools connection failed"));
    });

    let nextId = 1;
    const pending = new Map<number, (message: any) => void>();
    const consoleLines: string[] = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } else if (message.method === "Runtime.consoleAPICalled") {
        const text = message.params.args
          .map((arg: any) => arg.value ?? arg.description ?? "")
          .join(" ");
        consoleLines.push(`${message.params.type}: ${text}`);
      } else if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        consoleLines.push(
          `exception: ${details.exception?.description ?? details.text}`,
        );
      }
    };
    const send = (method: string, params: object = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (message) => {
          if (message.error) {
            reject(new Error(`${method}: ${message.error.message}`));
          } else {
            resolve(message.result);
          }
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async <T>(expression: string): Promise<T> => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw new Error(
          `Page error: ${details.exception?.description ?? details.text}`,
        );
      }
      return result.result.value as T;
    };

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: query ? `${url}?${query}` : url });
    if (query.split("&").includes("harness")) {
      await retry(async () => {
        if (!(await evaluate<boolean>("typeof __harness === 'object'"))) {
          const errors = consoleLines.filter((line) =>
            /error|exception/.test(line),
          );
          throw new Error(
            `Harness did not start. Console: ${errors.join(" | ") || "(no errors)"}`,
          );
        }
      }, 20000);
    }

    const centre = { x: Math.round(width / 2), y: Math.round(height / 2) };
    let pointer = { ...centre };
    // Establish the pointer position so the first real move has a delta.
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointer });
    const keyEvent = (type: string, code: string): Promise<any> =>
      send("Input.dispatchKeyEvent", {
        type,
        code,
        key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
        windowsVirtualKeyCode: virtualKey(code),
      });
    const mouseButton = (type: string, button: string): Promise<any> =>
      send("Input.dispatchMouseEvent", {
        type,
        ...centre,
        button,
        clickCount: 1,
      });

    return {
      url,
      consoleLines,
      send,
      evaluate,
      async captureFrame(path) {
        const dataUrl = await evaluate<string>("__harness.capture()");
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        await Bun.write(path, Buffer.from(base64, "base64"));
      },
      async screenshot(path) {
        // Draw first so the WebGPU canvas holds an image when captured.
        const result = await send("Page.captureScreenshot", { format: "png" });
        await Bun.write(path, Buffer.from(result.data, "base64"));
      },
      keyDown: (code) => keyEvent("rawKeyDown", code),
      keyUp: (code) => keyEvent("keyUp", code),
      async mouseMove(dx, dy) {
        // The browser derives movement from successive pointer positions, so
        // move a real virtual pointer. When it would leave the window, put it
        // back in the centre and have the game drop that jump.
        const fits = (x: number, y: number): boolean =>
          x >= 1 && x <= width - 2 && y >= 1 && y <= height - 2;
        if (!fits(pointer.x + dx, pointer.y + dy)) {
          pointer = { ...centre };
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            ...pointer,
          });
          await evaluate("__harness.discardLook()");
        }
        if (!fits(pointer.x + dx, pointer.y + dy)) {
          throw new Error("mouseMove: movement larger than half the window");
        }
        pointer = { x: pointer.x + dx, y: pointer.y + dy };
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...pointer,
        });
      },
      mouseDown: (button = "left") => mouseButton("mousePressed", button),
      mouseUp: (button = "left") => mouseButton("mouseReleased", button),
      async close() {
        socket.close();
        await shutdown();
      },
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}
