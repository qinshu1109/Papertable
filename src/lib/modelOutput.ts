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
  // 真机标题泄漏原句「I'm looking at the answer 同步」。
  /\bI['\u2019]m (?:looking|thinking|going|trying|considering|planning)\b/i,
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

/**
 * 正文起点哨兵。**系统提示要求模型在最终回答之前输出它**，见 `lib/context.ts`。
 *
 * 这是从「枚举推理长什么样」转向「识别我们自己规定的正文起点」。前者原理上做不到
 * ——推理独白与正常回答在文本上无从区分；后者可靠，因为提示词是我们自己写的。
 */
export const ANSWER_SENTINEL = "<<<PAPERTABLE_ANSWER>>>";

/**
 * 所有模型任务共用的哨兵指令。聊天、标题、概念、概念预览的提示词都必须带上它——
 * 标题提取曾经没带，模型把推理写进 content，兜底启发式又漏判，于是卡片标题变成了
 * 「I'm looking at the answer 同步」。
 */
export const SENTINEL_INSTRUCTION = `无论你在内部如何思考，正式输出之前必须先单独输出一行：${ANSWER_SENTINEL}
该标记之前的内容会被丢弃、不会展示，因此不要把结论写在它之前；标记之后只写要求的输出，不要重复该标记。`;

/** 容忍模型把哨兵写得略有出入（大小写、下划线/连字符、两三个尖括号）。 */
const SENTINEL_RE = /<{2,3}\s*PAPERTABLE[_\- ]?ANSWER\s*>{2,3}/i;

/**
 * 哨兵可能跨 chunk 到达，尾部像半个哨兵时要扣住，绝不能当正文放出去。
 *
 * 必须取**最长**匹配尾：旧实现用 `lastIndexOf("<")`，对 `<<<PAPER` 只会扣住
 * `<PAPER`，前面的 `<<` 就漏出去了。也要认带 `>` 的前缀（`…ANSWER>`、`…ANSWER>>`），
 * 否则最后几个字符到达的那一拍会把整个哨兵短暂放出去再收回，违反只增不减。
 */
function partialSentinelHold(text: string): number {
  const max = Math.min(text.length, ANSWER_SENTINEL.length + 2);
  for (let k = max; k > 0; k--) {
    const tail = text.slice(text.length - k);
    if (tail[0] !== "<") continue;
    if (/^<{1,3}[A-Za-z_\-\s]*>{0,2}$/.test(tail)) return k;
  }
  return 0;
}

/** 完整哨兵：要么后面还有内容，要么以全部三个 `>` 结尾——否则再等一拍。 */
function sentinelComplete(text: string, m: RegExpExecArray): boolean {
  return m.index + m[0].length < text.length || m[0].endsWith(">>>");
}

export interface AnswerGate {
  /** 追加一段原始增量。`channel` 来自服务端的推理分道标注。 */
  push(text: string, channel?: OutputChannel): void;
  /** 目前可以安全展示并落盘的正文。只增不减。 */
  visible(): string;
  /**
   * 已识别出的推理内容，供独立的可折叠组件展示。
   * **它与 `visible()` 物理隔离**，绝不能写进 `turn.content`。
   */
  reasoning(): string;
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

/**
 * 兜底实现：基于草稿标记的单元级启发式。
 *
 * **只在模型没有输出哨兵时才会走到这里。** 它天生不可靠——真实的推理独白就是普通
 * 说明文英语（"The core issue is that qubits are extremely fragile…"），任何短语
 * 枚举都识别不了它。真机上正是这一条漏判，而 passthrough 闩锁把一次漏判放大成了
 * 全量泄漏。
 *
 * 保留它是因为：不遵守格式要求的模型，通常也不是会输出推理的模型，那种情况下
 * 这套启发式够用；而**会输出推理的模型会输出哨兵**，那时这里根本不执行。
 */
function createHeuristicGate(): AnswerGate {
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
    reasoning() {
      // 兜底路径无法可靠归因哪一段是推理。不猜——返回空，让 UI 不显示折叠块。
      return "";
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

/**
 * 正文闸门。**哨兵优先，启发式只作兜底。**
 *
 * 三条路径，按可靠性排序：
 *
 * 1. **网关分道**（`channel === "reasoning"` / `"final"`）——最可靠。网关自己把推理
 *    放进了独立字段，我们直接采信。
 * 2. **哨兵**——可靠。系统提示要求模型在正文前输出 `ANSWER_SENTINEL`；哨兵之前的
 *    一律是推理，之后的一律是正文，此后纯直通、零启发式。
 * 3. **兜底启发式**——不可靠，只在流结束时仍未见到哨兵才使用。
 *
 * 之前只有第 3 条，而真机上模型输出了 1573 字符的英文推理、紧接着不加任何分隔就
 * 写 `## 材料说明`。任何短语枚举都拦不住那种输入。
 */
export function createAnswerGate(): AnswerGate {
  /** 哨兵之前累积的内容——推理。 */
  let before = "";
  /** 哨兵之后累积的内容——正文，直通。 */
  let answer = "";
  /** 网关明确标了 reasoning 的文本；同样只进推理区。 */
  let channelReasoning = "";
  let sawSentinel = false;
  /** 网关已经分道过：content 可信，无需等哨兵。 */
  let trusted = false;
  let done = false;
  /** 兜底用：没等到哨兵时，把 `before` 交给启发式处理。 */
  let fallback = "";

  function ingest(text: string) {
    if (sawSentinel) {
      answer += text;
      return;
    }
    if (trusted) {
      // 网关已把推理分进独立字段，content 可信、逐 token 直通——但模型按系统提示
      // 的要求**仍会输出哨兵**。真机截图里它就被原样渲染进了正文。
      // 直通不等于不剥协议标记：哨兵是我们的线材符号，永远不是内容。
      answer += text;
      const m = SENTINEL_RE.exec(answer);
      if (m && sentinelComplete(answer, m)) {
        sawSentinel = true;
        const pre = answer.slice(0, m.index);
        const post = answer.slice(m.index + m[0].length);
        // pre 已经展示过，不能收回（只增不减）；只有纯空白才顺手丢掉。
        answer = pre.trim() ? pre + post : post.replace(/^\s+/, "");
      }
      return;
    }
    before += text;

    // 保守例外：正文一上来就是结构化 Markdown（标题 / 围栏 / 列表 / 引用 / 表格）时，
    // 认定这个模型不会输出哨兵、也没有推理，直接放流。
    //
    // 之所以安全：推理独白是散文，**从不以 `##` 或围栏开头**。真机上泄漏的那段正是
    // 散文开头（"The core issue is…"），这条例外不会放过它。
    // 代价是：不输出哨兵、且用散文开头的模型，正文要等流结束才出现。那正是无法
    // 区分的情形，宁可晚一点也不能混进推理。
    if (!sawSentinel && BLOCK_START.test(before.trimStart().slice(0, 17))) {
      trusted = true;
      answer = before.trimStart();
      before = "";
      return;
    }

    const match = SENTINEL_RE.exec(before);
    if (!match || !sentinelComplete(before, match)) return;
    sawSentinel = true;
    // 哨兵之后的部分立刻转为正文；哨兵本身与之前的内容留在推理区。
    answer = before.slice(match.index + match[0].length).replace(/^\s+/, "");
    before = before.slice(0, match.index);
  }

  return {
    push(text: string, channel: OutputChannel = "unknown") {
      if (done || !text) return;
      if (channel === "reasoning") {
        channelReasoning += text;
        return;
      }
      if (channel === "final") trusted = true;
      ingest(text);
    },
    visible() {
      if (sawSentinel || trusted) {
        // 尾部可能是半个哨兵，扣住不放。
        const hold = sawSentinel ? 0 : partialSentinelHold(answer);
        return hold ? answer.slice(0, answer.length - hold) : answer;
      }
      // 还没见到哨兵：一个字都不放。正在流的内容全部按推理处理。
      return "";
    },
    reasoning() {
      return (channelReasoning + before).trim();
    },
    finish() {
      if (done) return this.visible();
      done = true;
      if (sawSentinel || trusted) return answer.trim();
      // 流结束仍无哨兵：模型没按要求输出正文。退到启发式，并把它的结果作为正文。
      const heuristic = createHeuristicGate();
      heuristic.push(before);
      fallback = heuristic.finish();
      answer = fallback;
      before = "";
      return answer;
    },
  };
}
