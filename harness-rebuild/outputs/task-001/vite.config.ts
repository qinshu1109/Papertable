import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(
        new URL("./browser-smoke-entry.ts", import.meta.url),
      ),
      formats: ["es"],
      fileName: "pi-rust-bridge",
    },
    minify: false,
  },
});
