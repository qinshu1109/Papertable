import { tauriAttachmentHost } from "./tauri";
import { webAttachmentHost } from "./web";

export * from "./types";

const target =
  typeof __PAPERTABLE_TARGET__ === "undefined" ? "web" : __PAPERTABLE_TARGET__;

export const attachments =
  target === "desktop" ? tauriAttachmentHost : webAttachmentHost;

export const attachmentTarget = target;
