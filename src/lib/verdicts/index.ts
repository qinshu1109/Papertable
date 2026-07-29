import { webVerdicts } from "./http";
import { desktopVerdicts } from "./tauri";

export * from "./types";
export * from "./context";
export * from "./adoption";
export * from "./reroute";
export * from "./ledger";

const target =
  typeof __PAPERTABLE_TARGET__ === "undefined" ? "web" : __PAPERTABLE_TARGET__;

export const verdicts = target === "desktop" ? desktopVerdicts : webVerdicts;
