import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(new URL("..", import.meta.url).pathname);
const outDir = resolve(root, "docs/screenshots");
const port = Number(process.env.AECS_DEMO_PORT ?? 4174);
const baseUrl = `http://127.0.0.1:${port}`;
const chromePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/usr/bin/google-chrome";

const shots = [
  {
    name: "swarm-arena-hero.png",
    url: `${baseUrl}/?scenario=hero&seed=41&frame=420&hud=1&debug=0`,
  },
];

mkdirSync(outDir, { recursive: true });

const server = spawn(
  "pnpm",
  [
    "exec",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--config",
    "examples/pixi-demo/vite.config.ts",
  ],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  },
);

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
server.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});

try {
  await waitForServer(baseUrl);
  const launchOptions = existsSync(chromePath)
    ? { executablePath: chromePath }
    : undefined;
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  for (const shot of shots) {
    await page.goto(shot.url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__AECS_DEMO_READY === true, null, {
      timeout: 20_000,
    });
    const nonBlank = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return false;
      const probe = document.createElement("canvas");
      probe.width = 24;
      probe.height = 24;
      const ctx = probe.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
      const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0) {
          return true;
        }
      }
      return false;
    });
    if (!nonBlank) throw new Error(`canvas was blank for ${shot.name}`);

    const path = resolve(outDir, shot.name);
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path });
    console.log(`wrote ${path}`);
  }

  await browser.close();
} finally {
  server.kill("SIGTERM");
}

async function waitForServer(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Vite server did not start.\n${serverOutput}`);
}
