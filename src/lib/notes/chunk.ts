import type {
  ChunkMarkdownInput,
  ChunkedNoteDocument,
  NoteChunk,
} from "./types";

/**
 * 一块正文的上限。这里按 JS UTF-16 字符数计量；对中文等常见笔记文本足够稳定，
 * 且不会在 Web 与 Rust 的 UTF-8 字节数之间产生误导性的「800」语义。
 */
export const MAX_NOTE_CHUNK_CHARS = 800;
export const NOTE_CHUNK_OVERLAP_CHARS = 80;
/** Must stay aligned with `src-tauri/src/notes.rs`. */
export const MAX_NOTE_DOCUMENT_BYTES = 20 * 1024 * 1024;

interface SourceRange {
  start: number;
  end: number;
}

interface SourceLine extends SourceRange {
  fullEnd: number;
  text: string;
}

interface Heading extends SourceRange {
  level: number;
  title: string;
  bodyStart: number;
  titlePath: string[];
}

interface Section extends SourceRange {
  titlePath: string[];
}

interface Frontmatter {
  end: number;
  title?: string;
  tags: string[];
}

/**
 * 对笔记版本与确定性 ID 使用的浏览器 / Node 一致哈希。
 *
 * 版本哈希只规范化换行，不能用于密码学安全；它的职责只是让「引用来源已更新」可被
 * 稳定检测，不需要引入 Node-only crypto。
 */
export function noteContentHash(content: string): string {
  const bytes = new TextEncoder().encode(content.replace(/\r\n?/g, "\n"));
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }

  return `fnv1a64-${hash.toString(16).padStart(16, "0")}`;
}

/** 导入层也可复用，避免 Web / Desktop 对同一相对路径生成不同 document id。 */
export function noteDocumentId(
  libraryId: string,
  relativePath: string,
): string {
  return `note-${shortHash(`${libraryId}\u0000${safeRelativePath(relativePath)}`)}`;
}

/**
 * 把一篇 Markdown 切为可检索、可精确回链的块。Markdown 文本保持原样，块的
 * start/end 直接指向原文；标题层级和 tag 是旁路元数据，而不是拼进正文。
 */
export function chunkMarkdown(input: ChunkMarkdownInput): ChunkedNoteDocument {
  const content = input.content;
  const relativePath = safeRelativePath(input.relativePath);
  const lines = sourceLines(content);
  const frontmatter = readFrontmatter(lines);
  const headings = findHeadings(lines, frontmatter.end);
  const fallbackTitle = titleFromPath(relativePath);
  const documentTitle =
    cleanTitle(input.title) ??
    frontmatter.title ??
    headings.find((heading) => heading.level === 1)?.title ??
    fallbackTitle;
  const tags = uniqueTags([...(input.tags ?? []), ...frontmatter.tags]);
  const versionHash = noteContentHash(content);
  const documentId =
    input.documentId ?? noteDocumentId(input.libraryId, relativePath);
  const document = {
    id: documentId,
    libraryId: input.libraryId,
    relativePath,
    title: documentTitle,
    tags,
    versionHash,
    charCount: content.length,
    updatedAt: input.updatedAt ?? Date.now(),
  };

  const sections = makeSections({
    content,
    headings,
    contentStart: frontmatter.end,
    documentTitle,
  });
  const chunks: NoteChunk[] = [];

  for (const section of sections) {
    const ranges = splitSection(content, lines, section);
    for (const range of ranges) {
      const bounds = trimRange(content, range);
      if (bounds.end <= bounds.start) continue;
      const ordinal = chunks.length;
      chunks.push({
        id: `${documentId}:${shortHash(`${versionHash}\u0000${ordinal}\u0000${bounds.start}\u0000${bounds.end}`)}`,
        libraryId: input.libraryId,
        documentId,
        documentVersionHash: versionHash,
        relativePath,
        titlePath: section.titlePath,
        tags,
        ordinal,
        start: bounds.start,
        end: bounds.end,
        text: content.slice(bounds.start, bounds.end),
      });
    }
  }

  return { document, chunks };
}

function sourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const fullEnd = newline === -1 ? content.length : newline + 1;
    const end = newline === -1 ? content.length : newline;
    const raw = content.slice(start, end);
    lines.push({
      start,
      end,
      fullEnd,
      text: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
    });
    start = fullEnd;
  }

  return lines;
}

function readFrontmatter(lines: SourceLine[]): Frontmatter {
  if (lines[0]?.text.trim() !== "---") return { end: 0, tags: [] };

  const closing = lines.findIndex(
    (line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line.text),
  );
  if (closing === -1) return { end: 0, tags: [] };

  const frontmatterLines = lines.slice(1, closing);
  let title: string | undefined;
  const tags: string[] = [];
  let inTagsList = false;

  for (const line of frontmatterLines) {
    const titleMatch = /^\s*title\s*:\s*(.*?)\s*$/i.exec(line.text);
    if (titleMatch) {
      title = cleanTitle(unquote(titleMatch[1]));
      inTagsList = false;
      continue;
    }

    const tagsMatch = /^\s*tags\s*:\s*(.*?)\s*$/i.exec(line.text);
    if (tagsMatch) {
      const value = tagsMatch[1].trim();
      inTagsList = !value;
      if (value) tags.push(...parseTags(value));
      continue;
    }

    if (inTagsList) {
      const item = /^\s*-\s+(.*?)\s*$/.exec(line.text);
      if (item) {
        tags.push(...parseTags(item[1]));
        continue;
      }
      inTagsList = false;
    }
  }

  return { end: lines[closing].fullEnd, title, tags: uniqueTags(tags) };
}

function findHeadings(lines: SourceLine[], contentStart: number): Heading[] {
  const headings: Heading[] = [];
  const titleByLevel: string[] = [];
  let fenceMarker: "`" | "~" | null = null;

  for (const line of lines) {
    if (line.start < contentStart) continue;

    const fence = /^\s*(`{3,}|~{3,})/.exec(line.text);
    if (fence) {
      const marker = fence[1][0] as "`" | "~";
      if (fenceMarker === null) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = null;
      continue;
    }
    if (fenceMarker) continue;

    const match = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line.text);
    if (!match) continue;

    const level = match[1].length;
    const title = cleanTitle(match[2].replace(/[ \t]+#+\s*$/, ""));
    if (!title) continue;

    titleByLevel[level - 1] = title;
    titleByLevel.length = level;
    headings.push({
      start: line.start,
      end: line.end,
      bodyStart: line.fullEnd,
      level,
      title,
      titlePath: titleByLevel.filter(Boolean),
    });
  }

  return headings;
}

function makeSections(input: {
  content: string;
  headings: Heading[];
  contentStart: number;
  documentTitle: string;
}): Section[] {
  const { content, headings, contentStart, documentTitle } = input;
  const sections: Section[] = [];

  if (!headings.length) {
    if (contentStart < content.length) {
      sections.push({
        start: contentStart,
        end: content.length,
        titlePath: [documentTitle],
      });
    }
    return sections;
  }

  const preambleEnd = headings[0].start;
  if (
    trimRange(content, { start: contentStart, end: preambleEnd }).end >
    contentStart
  ) {
    sections.push({
      start: contentStart,
      end: preambleEnd,
      titlePath: [documentTitle],
    });
  }

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const end = headings[index + 1]?.start ?? content.length;
    if (heading.bodyStart >= end) continue;

    // 当传入标题/Frontmatter 与 H1 不同，H1 是这段正文真实的层级入口；没有 H1
    // 的二级标题则以文档标题作为根，避免丢失路径上下文。
    const titlePath =
      heading.level === 1
        ? heading.titlePath
        : heading.titlePath[0]
          ? heading.titlePath
          : [documentTitle, ...heading.titlePath];
    sections.push({ start: heading.bodyStart, end, titlePath });
  }

  return sections;
}

function splitSection(
  content: string,
  lines: SourceLine[],
  section: Section,
): SourceRange[] {
  const paragraphs = paragraphRanges(lines, section);
  if (!paragraphs.length) return [];

  const output: SourceRange[] = [];
  let currentStart = paragraphs[0].start;
  let currentEnd = currentStart;
  const queue = paragraphs.map((range) => ({ ...range }));

  while (queue.length) {
    const next = queue[0];
    if (next.end - currentStart <= MAX_NOTE_CHUNK_CHARS) {
      currentEnd = next.end;
      queue.shift();
      continue;
    }

    if (currentEnd > currentStart) {
      const emitted = trimRange(content, {
        start: currentStart,
        end: currentEnd,
      });
      if (emitted.end > emitted.start) output.push(emitted);
      currentStart = Math.max(
        emitted.start,
        emitted.end - NOTE_CHUNK_OVERLAP_CHARS,
      );
      currentEnd = currentStart;
      continue;
    }

    // 单段落比块上限长：优先在换行或中文句号附近切，找不到才硬切。切出的下一段
    // 仍会从上块尾部回看约 80 字，因此不遗漏连接语义。
    const cut = preferredCut(
      content,
      next.start,
      currentStart + MAX_NOTE_CHUNK_CHARS,
    );
    const emitted = trimRange(content, { start: currentStart, end: cut });
    if (emitted.end > emitted.start) output.push(emitted);
    currentStart = Math.max(
      emitted.start,
      emitted.end - NOTE_CHUNK_OVERLAP_CHARS,
    );
    currentEnd = currentStart;
    next.start = cut;
    if (next.start >= next.end) queue.shift();
  }

  if (currentEnd > currentStart) {
    const emitted = trimRange(content, {
      start: currentStart,
      end: currentEnd,
    });
    if (emitted.end > emitted.start) output.push(emitted);
  }

  return output;
}

function paragraphRanges(lines: SourceLine[], section: Section): SourceRange[] {
  const ranges: SourceRange[] = [];
  let start: number | null = null;
  let end = section.start;
  let fenceMarker: "`" | "~" | null = null;

  for (const line of lines) {
    if (line.start < section.start || line.start >= section.end) continue;
    const fence = /^\s*(`{3,}|~{3,})/.exec(line.text);
    const marker = fence?.[1][0] as "`" | "~" | undefined;
    const blank = line.text.trim() === "";

    if (blank && fenceMarker === null) {
      if (start !== null) {
        ranges.push({ start, end });
        start = null;
      }
      continue;
    }

    if (start === null) start = line.start;
    end = Math.min(line.fullEnd, section.end);

    if (marker) {
      if (fenceMarker === null) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = null;
    }
  }

  if (start !== null) ranges.push({ start, end });
  return ranges;
}

function preferredCut(content: string, start: number, hardEnd: number): number {
  const end = Math.min(content.length, hardEnd);
  if (end <= start + 1) return Math.min(content.length, start + 1);
  const softStart = Math.max(start + 1, end - 200);

  for (let index = end; index > softStart; index -= 1) {
    const char = content[index - 1];
    if (char === "\n") return index;
  }
  for (let index = end; index > softStart; index -= 1) {
    if (/[。！？；.!?;]/.test(content[index - 1])) return index;
  }
  return end;
}

function trimRange(content: string, range: SourceRange): SourceRange {
  let { start, end } = range;
  while (start < end && /\s/.test(content[start])) start += 1;
  while (end > start && /\s/.test(content[end - 1])) end -= 1;
  return { start, end };
}

function safeRelativePath(path: string): string {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .trim();
  return normalized || "untitled.md";
}

function titleFromPath(path: string): string {
  const parts = path.split("/");
  const last = parts[parts.length - 1] ?? "未命名笔记";
  return cleanTitle(last.replace(/\.[^.]+$/, "")) ?? "未命名笔记";
}

function cleanTitle(value: string | undefined): string | undefined {
  const result = value?.replace(/\s+/g, " ").trim();
  return result || undefined;
}

function parseTags(value: string): string[] {
  const unwrapped = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return unwrapped
    .split(",")
    .map((tag) => unquote(tag).replace(/^#/, "").trim())
    .filter(Boolean);
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const normalized = tag.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function unquote(value: string): string {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
}

function shortHash(value: string): string {
  return noteContentHash(value).slice(-12);
}
