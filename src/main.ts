import type { PlayerInput } from "./core/api";
import { createInput } from "./core/input";
import { runLoop } from "./core/loop";
import { createGame, IDLE_INPUT, SEED } from "./game";
import { installHarness } from "./harness";
import { ReplayRecorder } from "./harness/replay";

const status = document.getElementById("status") as HTMLDivElement;

/** Saves a recording of the session so far as a downloaded JSON file. */
function saveReplay(recorder: ReplayRecorder): void {
  const blob = new Blob([JSON.stringify(recorder.toReplay(SEED))], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `sublevel-replay-${recorder.steps}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  status.textContent = `saved replay (${recorder.steps} steps)`;
  setTimeout(() => {
    status.textContent = "";
  }, 3000);
}

/**
 * Stops browser shortcuts such as Ctrl+W (close tab) from ending the game
 * while a movement key is held with Ctrl.
 *
 * A page can only receive those shortcuts itself while it is fullscreen with
 * the keyboard locked, so clicking to play also enters fullscreen. Where
 * that is unavailable or refused, closing the tab during play asks for
 * confirmation first.
 */
function guardBrowserShortcuts(
  canvas: HTMLCanvasElement,
  isPlaying: () => boolean,
): void {
  const keyboard = (
    navigator as Navigator & {
      keyboard?: { lock?: (codes?: string[]) => Promise<void> };
    }
  ).keyboard;
  canvas.addEventListener("mousedown", () => {
    if (document.fullscreenElement) {
      return;
    }
    document.documentElement
      .requestFullscreen()
      .then(() => keyboard?.lock?.())
      .catch(() => {
        // Fullscreen refused: the close confirmation below still applies.
      });
  });
  // With the keyboard locked, a short Escape press reaches the page instead
  // of leaving fullscreen, so release the mouse and fullscreen ourselves.
  window.addEventListener("keydown", (event) => {
    if (event.code === "Escape") {
      document.exitPointerLock();
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      }
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (isPlaying()) {
      event.preventDefault();
    }
  });
}

async function start(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const harnessMode = new URLSearchParams(location.search).has("harness");
  const game = await createGame(canvas);
  const input = createInput(canvas, () => game.resumeAudio(), {
    // Automation cannot capture the pointer, so the harness skips the lock.
    requireLock: !harnessMode,
  });

  const sampleInput = (): PlayerInput => {
    const look = input.consumeLook();
    const use = input.consumePressed("KeyE");
    const primary = input.consumePressed("Mouse0");
    if (!input.locked) {
      return IDLE_INPUT;
    }
    const axis = (positive: string, negative: string): number =>
      (input.isDown(positive) ? 1 : 0) - (input.isDown(negative) ? 1 : 0);
    return {
      moveX: axis("KeyD", "KeyA"),
      moveZ: axis("KeyW", "KeyS"),
      lookDx: look.dx,
      lookDy: look.dy,
      jump: input.isDown("Space"),
      crouch:
        input.isDown("ControlLeft") ||
        input.isDown("KeyC") ||
        input.isDown("ShiftLeft"),
      usePressed: use,
      primaryPressed: primary,
    };
  };

  if (harnessMode) {
    installHarness(game, canvas, sampleInput, () => {
      input.consumeLook();
    }).draw();
    status.textContent = "";
    console.log("sublevel: harness ready");
    return;
  }

  guardBrowserShortcuts(canvas, () => input.locked);
  const recorder = new ReplayRecorder();
  window.addEventListener("keydown", (event) => {
    if (event.code === "F8") {
      event.preventDefault();
      saveReplay(recorder);
    }
  });
  runLoop({
    update() {
      const playerInput = sampleInput();
      recorder.push(playerInput);
      game.step(playerInput);
    },
    render(alpha) {
      game.render(alpha, input.locked);
    },
  });
  status.textContent = "";
  console.log("sublevel: running", game.level.data.name);
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = `error: ${message}`;
  status.style.color = "#f99";
  console.error("sublevel:", message);
});
