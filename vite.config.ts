import { resolve } from "path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [dts()],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        protocol: resolve(__dirname, "src/protocol.ts"),
        gameframe: resolve(__dirname, "src/gameframe.ts"),
        parentframe: resolve(__dirname, "src/parentframe.ts"),
      },
      formats: ["es"],
    },
  },
});
