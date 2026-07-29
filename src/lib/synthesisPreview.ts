import type { OutputChannel } from "../types";
import {
  normalizeToolProtocolText,
  visibleProtocolPrefix,
} from "./agentProtocolRepair";
import { createAnswerGate } from "./modelOutput";

export type SynthesisPreviewEvent =
  | { type: "reset"; attempt: number }
  | {
      type: "token";
      attempt: number;
      text: string;
      channel: OutputChannel;
    };

const CITATION_MARKER_RE = /\[\[source:[^\]\s]+\]\]/giu;

function heldSuffixStart(text: string): number {
  const protocolStart = Math.max(text.lastIndexOf("<"), text.lastIndexOf("＜"));
  const citationStart = text.lastIndexOf("[[");
  const heldProtocol =
    protocolStart >= 0 &&
    !/[>＞]/u.test(text.slice(protocolStart)) &&
    visibleProtocolPrefix(text.slice(protocolStart))
      ? protocolStart
      : text.length;
  const heldCitation =
    citationStart >= 0 && !text.slice(citationStart).includes("]]")
      ? citationStart
      : text.length;
  return Math.min(heldProtocol, heldCitation);
}

/**
 * Final synthesis preview is deliberately stricter than the committed answer:
 * it requires the answer sentinel, withholds split protocol/citation markers,
 * and permanently blocks the attempt as soon as a complete protocol tag leaks.
 */
export function createSynthesisPreviewGate() {
  const answerGate = createAnswerGate();
  let blocked = false;

  return {
    push(text: string, channel: OutputChannel) {
      if (blocked) return { content: "", blocked };
      answerGate.push(text, channel);
      const visible = answerGate.visible();
      if (normalizeToolProtocolText(visible).containsProtocolTag) {
        blocked = true;
        return { content: "", blocked };
      }
      const safe = visible.slice(0, heldSuffixStart(visible));
      return {
        content: safe.replace(CITATION_MARKER_RE, "").trimStart(),
        blocked,
      };
    },
  };
}
