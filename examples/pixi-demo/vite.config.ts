import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@idleflowgames/anotherecs": path.resolve(root, "../../src/index.ts"),
    },
  },
  build: {
    outDir: path.resolve(root, "../../dist/pixi-demo"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  test: {
    environment: "node",
  },
});
