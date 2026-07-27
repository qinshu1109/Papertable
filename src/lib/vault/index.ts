/**
 * vault 同步的目标选择点，与 `lib/storage`、`lib/provider` 同一个模式。
 */
import { tauriVault } from "./tauri";
import { webVault } from "./web";

export type {
  Conflict,
  NoteWrite,
  VaultBridge,
  WriteOutcome,
  WriteReport,
} from "./types";

export const vault =
  __PAPERTABLE_TARGET__ === "desktop" ? tauriVault : webVault;
