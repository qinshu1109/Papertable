import { invoke } from "@tauri-apps/api/core";
import type {
  VerdictHealth,
  VerdictHost,
  VerdictInput,
  VerdictList,
  VerdictResponse,
  VerdictWriteResult,
} from "./types";

function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<VerdictResponse<T>> {
  return invoke<VerdictResponse<T>>(command, args);
}

export const desktopVerdicts: VerdictHost = {
  health: () => call<VerdictHealth>("verdict_health"),
  ensureCube: () => call("verdict_ensure_cube"),
  list: (projectId, concept) =>
    call<VerdictList>("verdict_list", { projectId, concept }),
  confirm: (input: VerdictInput) =>
    call<VerdictWriteResult>("verdict_confirm", { input }),
  supersede: (memoryId: string, input: VerdictInput) =>
    call<VerdictWriteResult>("verdict_supersede", { memoryId, input }),
};
