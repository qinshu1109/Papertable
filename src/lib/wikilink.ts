/**
 * `[[双链]]` 解析。
 *
 * README 一直声称「普通 Markdown 双链会被导入为 `reference`」，但那个功能从来
 * 没有实现过——`formats.ts` 的 `assemble()` 硬编码 `references: []`，全库也搜不到
 * 任何解析 `[[` 的代码。这里把它补上。
 *
 * **双链只生成 `ReferenceChip`，绝不推断 `CardEdge`。** 这不是偷懒：整个架构的
 * 立论是「边携带冻结的 `ContextSnapshot`」，而一条 `[[链接]]` 没有快照。由它推断
 * 出一条边，等于凭空伪造一份出处。
 */

/** Obsidian 的写法：`[[名字]]`、`[[名字|显示文本]]`、`[[名字#小节]]`。 */
const LINK = /\[\[([^\]|#[]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

export interface ParsedLink {
  /** 目标笔记名，已去掉 `#小节` 与 `|显示文本`。 */
  name: string;
  /** 用户看到的文字；没写别名时就是名字本身。 */
  label: string;
}

/**
 * 代码里的 `[[...]]` 不是双链。Obsidian 自己也不会在代码块里解析双链，而
 * `a[[0]]`、`matrix[[i]]` 这类写法在技术笔记里很常见——把它们当成引用会凭空造出
 * 一堆指向不存在笔记的链接。
 */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`?/g, " ");
}

export function parseWikilinks(text: string): ParsedLink[] {
  const found = new Map<string, ParsedLink>();
  for (const match of withoutCode(text).matchAll(LINK)) {
    const name = match[1].trim();
    if (!name) continue;
    const label = match[2]?.trim() || name;
    // 同一篇笔记被链接多次只算一条引用。
    if (!found.has(name)) found.set(name, { name, label });
  }
  return [...found.values()];
}

/** 正文里去掉双链语法，只留显示文本——用于摘录，避免把 `[[` 带进引用片段。 */
export function stripWikilinks(text: string): string {
  return text.replace(LINK, (_, name: string, label?: string) =>
    (label?.trim() || name.trim()).trim(),
  );
}
