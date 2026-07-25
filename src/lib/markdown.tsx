import React from "react";

/** 极简 Markdown 渲染器：标题 / 段落 / 列表 / 引用 / 代码块 / 表格 / 粗体 / 行内代码 */

interface Props {
  content: string;
  concepts?: string[];
  onConcept?: (term: string, blockText: string, el: HTMLElement) => void;
}

function inline(
  text: string,
  key: string,
  concepts: string[],
  onConcept: Props["onConcept"],
  blockText: string,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  tokens.forEach((tok, i) => {
    if (!tok) return;
    if (tok.startsWith("**") && tok.endsWith("**")) {
      out.push(
        <strong key={`${key}-b${i}`}>
          {withConcepts(
            tok.slice(2, -2),
            `${key}-b${i}`,
            concepts,
            onConcept,
            blockText,
          )}
        </strong>,
      );
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      out.push(
        <code className="md-code" key={`${key}-c${i}`}>
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        ...withConcepts(tok, `${key}-t${i}`, concepts, onConcept, blockText),
      );
    }
  });
  return out;
}

function withConcepts(
  text: string,
  key: string,
  concepts: string[],
  onConcept: Props["onConcept"],
  blockText: string,
): React.ReactNode[] {
  if (!concepts.length || !onConcept) return [text];
  const escaped = concepts
    .filter(Boolean)
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${escaped.join("|")})`, "g");
  const parts = text.split(re);
  return parts.map((p, i) =>
    concepts.includes(p) ? (
      <button
        type="button"
        className="concept-term"
        key={`${key}-k${i}`}
        onClick={(e) => onConcept(p, blockText, e.currentTarget)}
        title={`查看「${p}」的概念解释`}
      >
        {p}
      </button>
    ) : (
      <React.Fragment key={`${key}-p${i}`}>{p}</React.Fragment>
    ),
  );
}

export function Markdown({ content, concepts = [], onConcept }: Props) {
  const lines = content.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // 代码块
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```"))
        buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre className="md-pre" key={`k${k++}`}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // 表格
    if (line.trim().startsWith("|") && lines[i + 1]?.includes("---")) {
      const head = line
        .split("|")
        .slice(1, -1)
        .map((s) => s.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(
          lines[i]
            .split("|")
            .slice(1, -1)
            .map((s) => s.trim()),
        );
        i++;
      }
      blocks.push(
        <div className="md-table-wrap" key={`k${k++}`}>
          <table className="md-table">
            <thead>
              <tr>
                {head.map((h, hi) => (
                  <th key={hi}>
                    {inline(h, `th${hi}`, concepts, onConcept, h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>
                      {inline(c, `td${ri}${ci}`, concepts, onConcept, c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const Tag = (level <= 2 ? "h2" : level === 3 ? "h3" : "h4") as
        "h2" | "h3" | "h4";
      blocks.push(
        <Tag className={`md-h${level <= 2 ? 2 : level}`} key={`k${k++}`}>
          {inline(h[2], `h${k}`, concepts, onConcept, h[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    // 引用
    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith("> "))
        buf.push(lines[i++].slice(2));
      const txt = buf.join(" ");
      blocks.push(
        <blockquote className="md-quote" key={`k${k++}`}>
          {inline(txt, `q${k}`, concepts, onConcept, txt)}
        </blockquote>,
      );
      continue;
    }

    // 有序列表
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
        while (i < lines.length && /^\s{3,}\S/.test(lines[i])) {
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        }
      }
      blocks.push(
        <ol className="md-ol" key={`k${k++}`}>
          {items.map((it, ii) => (
            <li key={ii}>
              {inline(it, `ol${k}${ii}`, concepts, onConcept, it)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // 无序列表
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      blocks.push(
        <ul className="md-ul" key={`k${k++}`}>
          {items.map((it, ii) => (
            <li key={ii}>
              {inline(it, `ul${k}${ii}`, concepts, onConcept, it)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // 段落
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("> ") &&
      !lines[i].startsWith("```") &&
      !/^[-*]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i]) &&
      !lines[i].trim().startsWith("|")
    ) {
      buf.push(lines[i++]);
    }
    // 流式渲染时可能出现「# 尚未补全」这类中间态，保证每轮至少消费一行，避免死循环
    if (buf.length === 0) buf.push(lines[i++]);
    const para = buf.join(" ");
    blocks.push(
      <p className="md-p" key={`k${k++}`}>
        {inline(para, `p${k}`, concepts, onConcept, para)}
      </p>,
    );
  }

  return <>{blocks}</>;
}
