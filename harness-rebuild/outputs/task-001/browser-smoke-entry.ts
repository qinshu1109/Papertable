import { streamModel } from "../../../src/lib/provider/tauri";
import {
  createPapertablePiStream,
  type RustProviderStream,
} from "./pi-rust-bridge";

// Compile-time proof that Pi can sit above the existing Tauri/Rust channel.
// streamModel never exposes provider.json or its API key to this bundle.
export const rustBackedPiStream = createPapertablePiStream(
  streamModel as RustProviderStream,
);
