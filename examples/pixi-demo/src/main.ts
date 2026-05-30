import { Application, UPDATE_PRIORITY } from "pixi.js";
import "./styles.css";
import { Game } from "./game/resources";
import { createGameRuntime, FIXED_DT } from "./game/runtime";
import { GameRenderer } from "./render/GameRenderer";

declare global {
  interface Window {
    __AECS_DEMO_FRAME?: number;
    __AECS_DEMO_READY?: boolean;
  }
}

const params = new URLSearchParams(window.location.search);
const captureFrame = numberParam(params.get("frame"));
const runtime = createGameRuntime({
  seed: numberParam(params.get("seed")) ?? 7,
  scenario: params.get("scenario") ?? "hero",
  debug: params.get("debug") !== "0",
  hud: params.get("hud") !== "0",
  captureFrame,
});

const app = new Application();
const host = document.querySelector<HTMLDivElement>("#app");
if (!host) throw new Error("missing #app host");

await app.init({
  resizeTo: host,
  background: 0x080b12,
  antialias: true,
  autoDensity: true,
  resolution: Math.min(window.devicePixelRatio || 1, 2),
  preference: "webgl",
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
  hello: false,
});

host.appendChild(app.canvas);
const renderer = new GameRenderer(app, runtime);

window.addEventListener("resize", () => renderer.resize());
app.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

if (captureFrame !== null) {
  runtime.runFrames(captureFrame);
  renderer.sync();
  app.render();
  window.__AECS_DEMO_FRAME = runtime.world.getResource(Game).frame;
  window.__AECS_DEMO_READY = true;
} else {
  let accumulator = 0;
  app.ticker.add(
    (ticker) => {
      accumulator += Math.min(ticker.deltaMS / 1000, 0.1);
      while (accumulator >= FIXED_DT) {
        runtime.step(FIXED_DT);
        accumulator -= FIXED_DT;
      }
      renderer.sync();
      window.__AECS_DEMO_FRAME = runtime.world.getResource(Game).frame;
      window.__AECS_DEMO_READY = true;
    },
    undefined,
    UPDATE_PRIORITY.HIGH,
  );
}

window.addEventListener("beforeunload", () => {
  app.destroy(
    { removeView: true, releaseGlobalResources: true },
    { children: true },
  );
});

function numberParam(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
