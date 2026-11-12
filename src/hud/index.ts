import type { Hud, HudState } from "../core/api";
import { diffHud } from "./diff";

const ACCENT = "#e8a33d";
const STYLE_ID = "hud-style";

const CSS = `
.hud-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 10;
  font-family: ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #d9d2c0;
  -webkit-font-smoothing: auto;
}
.hud-root * {
  box-sizing: border-box;
}
.hud-hidden {
  display: none !important;
}
.hud-crosshair {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
.hud-crosshair[data-mode="idle"] {
  width: 2px;
  height: 2px;
  background: rgba(232, 163, 61, 0.55);
}
.hud-crosshair[data-mode="interact"] {
  width: 20px;
  height: 20px;
  border: 2px solid ${ACCENT};
}
.hud-crosshair[data-mode="holding"] {
  width: 10px;
  height: 10px;
  border: 1px solid ${ACCENT};
}
.hud-prompt {
  position: absolute;
  left: 50%;
  top: calc(50% + 22px);
  transform: translateX(-50%);
  white-space: pre;
  font-size: 15px;
  color: #f2e6cc;
  background: rgba(8, 8, 8, 0.72);
  border: 1px solid rgba(232, 163, 61, 0.6);
  padding: 4px 10px;
}
.hud-message {
  position: absolute;
  left: 50%;
  top: 18%;
  transform: translateX(-50%);
  max-width: calc(100% - 32px);
  padding: 8px 16px;
  font-size: 16px;
  white-space: pre-line;
  text-align: center;
  color: #f2e6cc;
  background: rgba(8, 8, 8, 0.72);
  border: 1px solid rgba(232, 163, 61, 0.6);
  opacity: 0;
  visibility: hidden;
  transition: opacity 250ms ease, visibility 250ms ease;
}
.hud-message.hud-shown {
  opacity: 1;
  visibility: visible;
}
.hud-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.55);
}
.hud-title {
  margin: 0 0 12px;
  font-size: 40px;
  font-weight: normal;
  letter-spacing: 0.3em;
  color: ${ACCENT};
}
.hud-subtitle {
  margin: 0 0 28px;
  font-size: 14px;
  color: #b9b09a;
}
.hud-controls {
  display: grid;
  grid-template-columns: auto auto;
  column-gap: 18px;
  row-gap: 8px;
  margin: 0;
  padding: 14px 18px;
  font-size: 13px;
  background: rgba(8, 8, 8, 0.72);
  border: 1px solid rgba(232, 163, 61, 0.6);
}
.hud-controls dt {
  color: ${ACCENT};
  white-space: nowrap;
}
.hud-controls dd {
  margin: 0;
  color: #b9b09a;
}
`;

/** Injects the stylesheet into the document once. */
function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const CONTROLS: readonly (readonly [string, string])[] = [
  ["WASD", "Move"],
  ["Mouse", "Look"],
  ["Space", "Jump"],
  ["C / Shift / Ctrl", "Crouch"],
  ["E", "Pick up / drop / use"],
  ["Left click", "Throw / shove"],
  ["F", "Fullscreen"],
  ["Esc", "Release mouse"],
];

/** Creates the HUD inside `root`. The root is `document.body` in the game. */
export function createHud(root: HTMLElement): Hud {
  const doc = root.ownerDocument;
  injectStyle(doc);

  const container = el(doc, "div", "hud-root");

  const crosshair = el(doc, "div", "hud-crosshair");
  crosshair.dataset.mode = "idle";

  const prompt = el(doc, "div", "hud-prompt hud-hidden");
  const message = el(doc, "div", "hud-message");

  const overlay = el(doc, "div", "hud-overlay");
  overlay.append(
    el(doc, "h1", "hud-title", "Sublevel"),
    el(doc, "p", "hud-subtitle", "Click to play"),
  );
  const controls = el(doc, "dl", "hud-controls");
  for (const [key, action] of CONTROLS) {
    controls.append(el(doc, "dt", "", key), el(doc, "dd", "", action));
  }
  overlay.append(controls);

  container.append(crosshair, prompt, message, overlay);
  root.appendChild(container);

  let last: HudState | null = null;

  function applyPrompt(state: HudState): void {
    const visible = state.playing && state.prompt !== null;
    prompt.textContent = state.prompt ?? "";
    prompt.classList.toggle("hud-hidden", !visible);
  }

  return {
    update(state: HudState): void {
      const changed = diffHud(last, state);
      last = { ...state };
      if (Object.keys(changed).length === 0) {
        return;
      }

      if ("playing" in changed) {
        overlay.classList.toggle("hud-hidden", state.playing);
        crosshair.classList.toggle("hud-hidden", !state.playing);
        applyPrompt(state);
      }
      if ("crosshair" in changed) {
        crosshair.dataset.mode = state.crosshair;
      }
      if ("prompt" in changed) {
        applyPrompt(state);
      }
      if ("message" in changed) {
        // Keep the last text while it fades out, so the panel does not
        // collapse mid-transition.
        if (state.message !== null) {
          message.textContent = state.message;
        }
        message.classList.toggle("hud-shown", state.message !== null);
      }
    },
  };
}
