/**
 * 某些 OpenAI-compatible 网关会把模型的草稿推理误放进 `content`。
 * Papertable 只保存、展示可交付的最终回答；无法可靠分离时宁可继续等待。
 *
 * 这里是「默认扣留」的闸门。一段文本被释放的条件是：它构成一个**完整单元**
 * （句子或 Markdown 块）、不含草稿标记、且它之前的单元都已释放或已判为草稿。
 * 推理定界标签未闭合时永不释放。
 *
 * 关键性质：**已释放的内容永不收回**。调用方据此可以把 `visible()` 直接写进
 * 卡片并落盘——旧的纯函数实现做不到这点，它在 token 之间可能改变已返回的前缀，
 * 而已渲染的文本 500 ms 内就已经进了 IndexedDB。
 *
 * 释放单位是一个句子而不是「标题或空行」，这样两句话的短回答也能流式显示，
 * 不必等到生成结束。头部的结构化开头与 passthrough 闩锁进一步消掉这点延迟。
 */

/**
 * 草稿标记。与旧实现的关键区别：**在单元内任意位置匹配，而不是锚定在句首**。
 * 旧的 `/^the user\b/` 白名单挡不住 "Since the user…"、"Given that the user…"、
 * "Looking at the user's question…" 这一整类开场白，而漏判的代价是把推理写进
 * 用户数据，比误判多缓冲一会儿糟得多。
 *
 * 刻意不收录裸 `用户`、裸 `我`、`based on the context`：三者都出现在合法回答里，
 * 最后一个正是「仅依据材料」模式的用语。
 */
export const DRAFT_MARKERS: readonly RegExp[] = [
  /\bthe user\b/i,
  /\busers?\s+(?:asked|wants?|is asking|did ?n[o']t|provided|has ?n[o']t)\b/i,
  /\bI(?:['’]ll|['’]m going to| will| should| need to| must| have to| am going to| shall)\b/,
  /\bI (?:noticed?|see|understand|recognize|realize|do ?n[o']t|cannot|can[''’]t)\b/,
  /\bwe(?:['’]ll| will| should| need to| must)\b/i,
  /\blet me\b/i,
  /\blet['’]?s (?:start|begin|think|see|outline|structure|first)\b/i,
  /\bmy (?:answer|response|reply|explanation)\b/i,
  /\bthe (?:answer|response) (?:should|will|needs to|has to)\b/i,
  /\b(?:first|okay|ok|alright|hmm|so),\s+(?:I|let|we)\b/i,
  /\bthe (?:question|prompt|request|topic) (?:is|asks|seems|appears)\b/i,
  /\bmaking sure to\b/i,
  /\bdraw on general knowledge\b/i,
  /用户(?:提出|要求|正在|想要|询问|没有|未|问的|想|只|并没有)/,
  /我(?:需要|应该|会|将|必须|注意到|先|来|打算|可以先)/,
  /我们(?:需要|应该|可以先)/,
  /(?:好的|首先|嗯|让我)[，,、]?\s*(?:我|先|来|看)/,
  /这个(?:问题|请求|主题)(?:是|似乎|应该|看起来)/,
  /回答(?:时|中)(?:我|需要|应该)/,
];

/** 推理定界标签。任何模式下都生效，包括已经切到 passthrough 之后。 */
const OPEN_TAG = /<(?:think|thinking|analysis|reasoning|thought|scratchpad)>/i;
const CLOSE_TAG =
  /<\/(?:think|thinking|analysis|reasoning|thought|scratchpad)>/i;

/** 结构化行首。推理前言是散文，不会用围栏、标题或列表开场。 */
const BLOCK_START =
  /^[ \t]{0,3}(?:#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>[ \t]?|\||```|~~~)/;

/** 拉丁缩写豁免，避免 "e.g." 之类被当成句末。 */
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Prof|Fig|No|approx|cf)\.$/i;

/** 切到直通前需要累计的干净单元数 / 已释放字符数。推理只出现在头部。 */
const PASSTHROUGH_UNITS = 2;
const PASSTHROUGH_CHARS = 200;
/** 收尾时「已释放为空但存在干净尾段」的兜底阈值。 */
const SALVAGE_MIN_CHARS = 40;

export type OutputChannel = "final" | "reasoning" | "unknown";

export interface AnswerGate {
  /** 追加一段原始增量。`channel` 来自服务端的推理分道标注。 */
  push(text: string, channel?: OutputChannel): void;
  /** 目前可以安全展示并落盘的正文。只增不减。 */
  visible(): string;
  /** **只在流正常结束时调用**：中断路径必须只用 `visible()`。 */
  finish(): string;
}

/** 去掉围栏代码块与行内代码，避免名为 `user` 的变量触发闸门。 */
function withoutCode(unit: string): string {
  return unit.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`]*`?/g, " ");
}

function hasDraftMarker(unit: string): boolean {
  const text = withoutCode(unit);
  return DRAFT_MARKERS.some((marker) => marker.test(text));
}

function isStructural(unit: string): boolean {
  return BLOCK_START.test(unit);
}

/**
 * 尾部半个标签（`<thi`）必须扣住，否则会先当字面量渲染出去，而已释放的内容
 * 收不回来。
 */
function partialTagHold(text: string, from: number): number {
  const idx = text.lastIndexOf("<");
  if (idx < from) return 0;
  const tail = text.slice(idx);
  if (tail.includes(">") || tail.length > 16) return 0;
  if (!/^<\/?[a-z]*$/i.test(tail)) return 0;
  return text.length - idx;
}

/**
 * 返回 `from` 处第一个完整单元的结束下标；尚不完整时返回 -1。
 * 三种边界取最早者：块边界、段落边界、句末。
 */
function nextUnitEnd(text: string, from: number, limit: number): number {
  // 围栏代码块整体算一个单元，闭合前不完整。
  if (text.startsWith("```", from)) {
    const close = text.indexOf("\n```", from + 3);
    if (close === -1 || close >= limit) return -1;
    const lineEnd = text.indexOf("\n", close + 1);
    return lineEnd === -1 || lineEnd > limit ? limit : lineEnd;
  }

  for (let i = from; i < limit; i++) {
    const ch = text[i];

    if (ch === "\n") {
      // 段落边界：\n 后跟空白行。
      let k = i + 1;
      while (k < limit && (text[k] === " " || text[k] === "\t")) k++;
      if (k < limit && text[k] === "\n") return i;
      // 块边界：\n 后跟结构化行首。
      if (
        i + 1 < limit &&
        BLOCK_START.test(text.slice(i + 1, Math.min(limit, i + 17)))
      )
        return i;
      continue;
    }

    // CJK 句末无歧义：不必确认后面跟着什么，缓冲区末尾也算完整。被 limit 扣在
    // 后面的要么是半个标签、要么是紧跟的标签，都不会是这一句的收尾引号。
    if (ch === "。" || ch === "！" || ch === "？" || ch === "…") {
      let j = i + 1;
      while (j < limit && /["'’”』」）)]/.test(text[j])) j++;
      return j;
    }

    // 拉丁句末要求后面确实跟着空白，否则可能是小数点或缩写。
    if (ch === "." || ch === "!" || ch === "?") {
      if (ch === "." && i > from && /\d/.test(text[i - 1])) continue;
      if (ch === "." && ABBREV.test(text.slice(Math.max(from, i - 7), i + 1)))
        continue;
      let j = i + 1;
      while (j < limit && /["'’”)\]]/.test(text[j])) j++;
      if (j >= limit) return -1;
      if (/\s/.test(text[j])) return j;
      continue;
    }
  }
  return -1;
}

export function createAnswerGate(): AnswerGate {
  let raw = "";
  let cursor = 0;
  let released = "";
  let lastReleasedEnd = 0;
  /** 已释放内容与下一段之间要补的连接符；null 表示两段在原文里连续。 */
  let pendingJoin: string | null = null;
  let mode: "gated" | "draft" | "passthrough" = "gated";
  let tagOpen = false;
  let releasedUnits = 0;
  let done = false;
  /**
   * 判为草稿之后、又没等到恢复边界而被丢弃的干净单元。收尾时如果一个字都没
   * 释放，用它兜底——否则一次「推理和正文只隔单个换行」就会让整轮回答消失。
   */
  let heldClean: { start: number; end: number } | null = null;

  function releaseUnit(start: number, end: number): void {
    if (end <= start) return;
    if (released === "") {
      released = raw.slice(start, end);
    } else if (pendingJoin === null) {
      released += raw.slice(lastReleasedEnd, end);
    } else {
      released += pendingJoin + raw.slice(start, end);
    }
    lastReleasedEnd = end;
    pendingJoin = null;
    releasedUnits++;
  }

  function drop(start: number, end: number, clean: boolean): void {
    if (clean) {
      heldClean = { start: heldClean ? heldClean.start : start, end };
    } else {
      heldClean = null;
    }
    if (released !== "") pendingJoin = "\n\n";
  }

  function shouldLatch(unit: string): boolean {
    return (
      releasedUnits >= PASSTHROUGH_UNITS ||
      released.length >= PASSTHROUGH_CHARS ||
      isStructural(unit)
    );
  }

  /** 在 [cursor, limit) 内消费完整单元。`force` 时把剩余部分当作完整单元。 */
  function consumeUnits(limit: number, force: boolean): void {
    for (;;) {
      while (cursor < limit && /\s/.test(raw[cursor])) cursor++;
      if (cursor >= limit) return;

      // 结构化开头：零延迟直通，不必等一个完整单元。
      if (
        mode === "gated" &&
        released === "" &&
        BLOCK_START.test(raw.slice(cursor, cursor + 17))
      ) {
        mode = "passthrough";
        return;
      }

      const found = nextUnitEnd(raw, cursor, limit);
      if (found === -1 && !force) return;
      const end = found === -1 ? limit : found;
      const start = cursor;
      const unit = raw.slice(start, end);
      cursor = end;
      if (!unit.trim()) continue;

      if (hasDraftMarker(unit)) {
        mode = "draft";
        drop(start, end, false);
        continue;
      }
      if (mode === "gated") {
        releaseUnit(start, end);
        if (shouldLatch(unit)) {
          mode = "passthrough";
          return;
        }
        continue;
      }
      // draft 态：干净单元还需要一个恢复边界才能释放。推理与正文糊在同一段里
      // 是不可切分的，扣下整轮、让调用方显示重试错误才是正确的失败方向。
      if (isStructural(unit) || blankLineBefore(start)) {
        releaseUnit(start, end);
        mode = "passthrough";
        return;
      }
      drop(start, end, true);
    }
  }

  function blankLineBefore(start: number): boolean {
    let i = start - 1;
    let newlines = 0;
    while (i >= 0 && /\s/.test(raw[i])) {
      if (raw[i] === "\n") newlines++;
      i--;
    }
    return newlines >= 2;
  }

  function drain(atEnd: boolean): void {
    for (;;) {
      if (tagOpen) {
        const close = CLOSE_TAG.exec(raw.slice(cursor));
        if (!close) return;
        cursor += close.index + close[0].length;
        tagOpen = false;
        if (released !== "" && pendingJoin === null) pendingJoin = "";
        continue;
      }
      if (cursor >= raw.length) return;

      const open = OPEN_TAG.exec(raw.slice(cursor));
      const regionEnd = open ? cursor + open.index : raw.length;
      const limit = open ? regionEnd : raw.length - partialTagHold(raw, cursor);

      const beforeCursor = cursor;
      const beforeMode = mode;

      if (mode === "passthrough") {
        if (released === "")
          while (cursor < limit && /\s/.test(raw[cursor])) cursor++;
        if (limit > cursor) {
          if (released === "") released = raw.slice(cursor, limit);
          else released += (pendingJoin ?? "") + raw.slice(cursor, limit);
          pendingJoin = null;
          lastReleasedEnd = limit;
          cursor = limit;
        }
      } else {
        // 后面紧跟一个标签时，这段区间已经不会再增长，可以当完整单元收尾。
        consumeUnits(limit, atEnd || open !== null);
      }

      if (open) {
        cursor = regionEnd + open[0].length;
        tagOpen = true;
        continue;
      }
      if (cursor === beforeCursor && mode === beforeMode) return;
    }
  }

  return {
    push(text: string, channel: OutputChannel = "unknown") {
      if (done || !text) return;
      // 网关把草稿放进独立字段时，content 才是可信的最终正文。
      if (channel === "reasoning") return;
      if (channel === "final") mode = "passthrough";
      raw += text;
      drain(false);
    },
    visible() {
      return released;
    },
    finish() {
      if (done) return released;
      done = true;
      // 标签没闭合就到了结尾：宁可什么都不给，也不能把草稿刷出去。
      if (tagOpen) return released;
      drain(true);
      if (released === "" && heldClean) {
        const salvaged = raw.slice(heldClean.start, heldClean.end).trim();
        if (salvaged.length >= SALVAGE_MIN_CHARS) released = salvaged;
      }
      return released;
    },
  };
}

/**
 * 非流式调用点的薄兼容层：一次性喂完并收尾。
 * 流式路径必须直接用 `createAnswerGate()`，否则会丢掉「中断时不得 flush」的保证。
 */
export function visibleModelOutput(raw: string): string {
  const gate = createAnswerGate();
  gate.push(raw);
  return gate.finish();
}
