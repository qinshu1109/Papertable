/**
 * 由 Vite 的 `define` 在编译期替换成字面量。web 构建是 `"web"`，
 * `PAPERTABLE_TARGET=desktop` 的构建是 `"desktop"`。
 *
 * 它是常量而不是运行时判断，未选中的那条分支会被 tree-shake 掉。
 */
declare const __PAPERTABLE_TARGET__: "web" | "desktop";
