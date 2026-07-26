import { readFile } from "node:fs/promises";
import { normalizedHash } from "./vault-dryrun.mts";

const file =
  "/Users/qinshu/主知识库_AI/80_AI暂存/Papertable-dryrun/量子计算机与极低温/量子退相干.md";
const original = await readFile(file, "utf8");

/** 模拟 obsidian-linter 在 lintOnSave 时对我们写出的文件做的事。 */
function lintLike(md: string): string {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/)!;
  const keys = m[1].split("\n").sort(); // yaml-key-sort
  const body = md
    .slice(m[0].length)
    .split("\n")
    .map((l) => (l ? l + "   " : l)) // 编辑器留下尾空白…
    .map((l) => l.trimEnd()) // trailing-spaces 再剔除
    .join("\n")
    .replace(/\n{3,}/g, "\n\n"); // consecutive-blank-lines
  return `---\n${keys.join("\n")}\n---\n\n${body}`;
}

const linted = lintLike(original);
console.log("字节是否相同 ：", original === linted);
console.log("原始 hash    ：", normalizedHash(original));
console.log("Linter 重排后：", normalizedHash(linted));
console.log(
  normalizedHash(original) === normalizedHash(linted)
    ? "PASS · 归一化哈希不受 Linter 重排影响，不会误报冲突"
    : "FAIL · 每次用户保存都会误报冲突",
);

const edited = original.replace(
  "这是最常见的混淆。",
  "这是最常见的混淆（改过）。",
);
console.log(
  "\n用户真的改了正文 →",
  normalizedHash(edited) !== normalizedHash(original)
    ? "PASS · 检测到修改"
    : "FAIL · 漏检，会静默覆盖用户的编辑",
);
