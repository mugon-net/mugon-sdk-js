import { readFileSync } from "node:fs";
import { resolve } from "path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  define: {
    __SDK_VERSION_MARKER__: JSON.stringify(
      `mugon-sdk-version:${JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version}`,
    ),
  },
  plugins: [dts({ exclude: ["src/**/*.test.ts", "src/iife.ts"] })],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        protocol: resolve(__dirname, "src/protocol.ts"),
        parentframe: resolve(__dirname, "src/parentframe.ts"),
        settings: resolve(__dirname, "src/settings.ts"),
        expression: resolve(__dirname, "src/expression.ts"),
      },
      formats: ["es"],
    },
  },
});
