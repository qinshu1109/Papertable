import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "playwright-report",
      "test-results",
      "*.tsbuildinfo",
      // Rust 侧：图标是二进制，target/ 是构建产物。
      "src-tauri",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["server/**/*.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
