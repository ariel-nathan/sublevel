/**
 * Keyboard and mouse state with pointer lock.
 *
 * Buttons are named by `KeyboardEvent.code` ("KeyW", "Space", "ControlLeft")
 * and mouse buttons by "Mouse0" (left), "Mouse1" (middle), "Mouse2" (right).
 */
export interface Input {
  /** True while the button is held. */
  isDown(code: string): boolean;
  /** True once per press; reading it clears it. Call from the fixed update. */
  consumePressed(code: string): boolean;
  /** Mouse movement in pixels since the last call; reading it resets it. */
  consumeLook(): { dx: number; dy: number };
  /** True while the pointer is captured by the canvas. */
  readonly locked: boolean;
  /** Stops listening. */
  dispose(): void;
}

/**
 * Attaches input to a canvas. Clicking the canvas captures the pointer;
 * `onLock` runs on the first capture (use it to resume audio).
 */
export function createInput(
  canvas: HTMLCanvasElement,
  onLock?: () => void,
  options: { requireLock?: boolean } = {},
): Input {
  const down = new Set<string>();
  const pressed = new Set<string>();
  let dx = 0;
  let dy = 0;
  // Without requireLock, input is accepted without capturing the pointer
  // (used by the test harness, where automation cannot capture it).
  const requireLock = options.requireLock ?? true;
  const isLocked = (): boolean =>
    !requireLock || document.pointerLockElement === canvas;

  const press = (code: string): void => {
    if (!down.has(code)) {
      pressed.add(code);
    }
    down.add(code);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isLocked()) {
      return;
    }
    press(event.code);
    event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    down.delete(event.code);
  };
  const onMouseDown = (event: MouseEvent): void => {
    if (!isLocked()) {
      void canvas.requestPointerLock();
      return;
    }
    press(`Mouse${event.button}`);
  };
  const onMouseUp = (event: MouseEvent): void => {
    down.delete(`Mouse${event.button}`);
  };
  const onMouseMove = (event: MouseEvent): void => {
    if (isLocked()) {
      dx += event.movementX;
      dy += event.movementY;
    }
  };
  const onLockChange = (): void => {
    if (isLocked()) {
      onLock?.();
    } else {
      down.clear();
      pressed.clear();
    }
  };
  const onContextMenu = (event: Event): void => event.preventDefault();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onLockChange);
  canvas.addEventListener("contextmenu", onContextMenu);

  return {
    isDown: (code) => down.has(code),
    consumePressed: (code) => pressed.delete(code),
    consumeLook: () => {
      const look = { dx, dy };
      dx = 0;
      dy = 0;
      return look;
    },
    get locked() {
      return isLocked();
    },
    dispose: () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      canvas.removeEventListener("contextmenu", onContextMenu);
    },
  };
}
