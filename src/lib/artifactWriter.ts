import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { ExportArtifact } from "../types";

const target =
  typeof __PAPERTABLE_TARGET__ === "undefined" ? "web" : __PAPERTABLE_TARGET__;

export type ArtifactWriteResult =
  { status: "saved"; path?: string } | { status: "cancelled" };

function downloadInBrowser(artifact: ExportArtifact): ArtifactWriteResult {
  const url = URL.createObjectURL(artifact.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { status: "saved" };
}

/**
 * One host-neutral export seam.  The web uses a browser download; packaged
 * desktop builds must receive a real file path from the native Save dialog and
 * wait for Rust's atomic write + read-back verification before reporting any
 * success to the user.
 */
export async function writeArtifact(
  artifact: ExportArtifact,
): Promise<ArtifactWriteResult> {
  if (target !== "desktop") return downloadInBrowser(artifact);
  const path = await save({
    title: "导出 Papertable 文件",
    defaultPath: artifact.filename,
  });
  if (typeof path !== "string" || !path) return { status: "cancelled" };
  const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
  await invoke<void>("write_export_artifact", {
    path,
    bytes: Array.from(bytes),
  });
  return { status: "saved", path };
}
