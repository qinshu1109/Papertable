/**
 * 某些 OpenAI-compatible 网关会把模型的草稿推理误放进 `content`。
 * Papertable 只保存、展示可交付的最终回答；无法可靠分离时宁可继续等待。
 */
const analysisPrefixes = [
  /^the user\b/i,
  /^i (?:need|should|will|must|do not|don't|cannot|can't|notice|recognize|understand|see|have to|am going to)\b/i,
  /^we (?:need|should|will|must)\b/i,
  /^用户(?:提出|要求|正在|想要|询问)/,
  /^我(?:需要|应该|会|将|必须|注意到)/,
];

function stripDelimitedThinking(input: string): string | null {
  const open = input.match(/^\s*<(?:think|analysis)>/i);
  if (!open) return input;
  const close = input.match(/<\/(?:think|analysis)>/i);
  if (!close || close.index === undefined) return null;
  return input.slice(close.index + close[0].length).trimStart();
}

/**
 * 返回适合显示的最终正文。遇到尚未结束的草稿前缀时返回空串，
 * 调用方继续缓冲原始流，直到最终回答边界出现。
 */
export function visibleModelOutput(raw: string): string {
  const withoutDelimitedThinking = stripDelimitedThinking(raw);
  if (withoutDelimitedThinking === null) return "";
  const text = withoutDelimitedThinking.trimStart();
  if (!text) return "";
  if (!analysisPrefixes.some((prefix) => prefix.test(text))) return text;

  // 常见情况：内部草稿后开始一段 Markdown 正文。
  const heading = text.match(/\n\s*(#{1,6}\s+\S)/);
  if (heading?.index !== undefined)
    return text.slice(heading.index + heading[0].indexOf("#")).trimStart();

  // 也允许最终正文不用标题，改在一个完整段落之后开始。
  const paragraphBreak = text.match(/\n\s*\n/);
  if (paragraphBreak?.index !== undefined)
    return text
      .slice(paragraphBreak.index + paragraphBreak[0].length)
      .trimStart();

  // 草稿还没结束，不能抢先展示或落盘。
  return "";
}
