import { readFileSync } from "node:fs";
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    __SDK_VERSION_MARKER__: JSON.stringify(
      `mugon-sdk-version:${JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version}`,
    ),
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/iife.ts"),
      name: "Mugon",
      formats: ["iife"],
      fileName: () => "mugon.iife.js",
    },
  },
});
