import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Conflict, NoteWrite, VaultBridge, WriteReport } from "./types";

export const tauriVault: VaultBridge = {
  available: true,
  async chooseVault() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择 Obsidian vault 根目录",
    });
    return typeof picked === "string" ? picked : null;
  },
  sync: (input) =>
    invoke<WriteReport[]>("vault_sync", {
      vault: input.vault,
      notes: input.notes,
      now: input.now,
    }),
  rename: (input) => invoke<void>("vault_rename", input),
  remove: (input) => invoke<void>("vault_delete", input),
  forget: (input) => invoke<number>("vault_forget", input),
  watch: (vault) => invoke<number>("vault_watch", { vault }),
  resolveLink: (name) =>
    invoke<[string, string | null][]>("vault_resolve_link", { name }),
  indexedCount: () => invoke<number>("vault_indexed_count"),
  conflicts: () => invoke<Conflict[]>("vault_conflicts"),
  resolveConflict: (input) => invoke<string>("vault_resolve_conflict", input),
};

export type { NoteWrite };
