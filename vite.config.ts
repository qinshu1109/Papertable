import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = Number(process.env.PAPERTABLE_API_PORT ?? 8787);

/**
 * 编译期选择存储后端与模型通道。用 define 而不是运行时探测 `__TAURI_INTERNALS__`，
 * 这样桌面包能 tree-shake 掉 Dexie，web 包永不拉 `@tauri-apps/api`。
 */
const target = process.env.PAPERTABLE_TARGET === "desktop" ? "desktop" : "web";

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    __PAPERTABLE_TARGET__: JSON.stringify(target),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
});
