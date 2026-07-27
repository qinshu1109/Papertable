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
  // Tauri 的打包资源从 `tauri://localhost/` 提供。这里必须生成根路径资源 URL；
  // `./assets/...` 在 macOS WKWebView 中会被当成相对自定义协议资源，导致 CSS
  // 偶尔能加载而 ES module 不会执行，最终只剩一片白屏。
  base: target === "desktop" ? "/" : "./",
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
