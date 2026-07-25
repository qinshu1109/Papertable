import JSZip from "jszip";
import type {
  Card,
  CardEdge,
  ContextSnapshot,
  ExportArtifact,
  ImportInput,
  PortableProject,
  Project,
  ReferenceChip,
  SourceAnchor,
  ViewState,
} from "../types";

const now = () => Date.now();
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const safeName = (value: string) =>
  value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 72) || "papertable";

function metadata(project: PortableProject, card: Card) {
  const edge = project.edges.find(
    (candidate) => candidate.targetCardId === card.id,
  );
  return {
    id: card.id,
    project_id: project.project.id,
    relation: edge?.type ?? "root",
    source_card: edge?.sourceCardId,
    source_anchor: edge?.sourceAnchorId,
    created: new Date(card.createdAt).toISOString(),
  };
}

export function cardMarkdown(project: PortableProject, card: Card) {
  const meta = metadata(project, card);
  const frontmatter = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  const turns = card.turns
    .map(
      (turn) =>
        `## ${turn.role === "user" ? "用户" : "助手"}\n\n${turn.content}`,
    )
    .join("\n\n");
  const transport = btoa(
    unescape(
      encodeURIComponent(
        JSON.stringify({
          card,
          edge: project.edges.find(
            (candidate) => candidate.targetCardId === card.id,
          ),
        }),
      ),
    ),
  );
  return `---\n${frontmatter}\n---\n\n<!-- papertable:${transport} -->\n\n# ${card.title}\n\n${turns}\n`;
}

function decodeTransport(
  markdown: string,
): { card: Card; edge?: CardEdge } | null {
  const raw = markdown.match(/<!--\s*papertable:([^\s]+)\s*-->/)?.[1];
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(raw)))) as {
      card: Card;
      edge?: CardEdge;
    };
  } catch {
    return null;
  }
}

function markdownTitle(markdown: string, fallback: string) {
  return (
    markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    fallback.replace(/\.md$/i, "") ||
    "导入笔记"
  );
}

function genericMarkdownCard(
  name: string,
  content: string,
  projectId: string,
): Card {
  return {
    id: id("card"),
    projectId,
    title: markdownTitle(content, name),
    favorite: false,
    unread: false,
    concepts: [],
    createdAt: now(),
    turns: [
      {
        id: id("turn"),
        role: "ai",
        content,
        createdAt: now(),
        status: "complete",
      },
    ],
  };
}

function makeProject(name: string): Project {
  return { id: id("project"), name, pinned: false, updatedAt: now() };
}

function defaultView(projectId: string, cardId: string): Partial<ViewState> {
  return {
    activeProjectId: projectId,
    currentCardId: cardId,
    drafts: {},
    lastCardByProject: { [projectId]: cardId },
    collapsed: [],
    scrollPositions: {},
  };
}

function assemble(
  project: Project,
  cards: Card[],
  edges: CardEdge[] = [],
  snapshots: ContextSnapshot[] = [],
  anchors: SourceAnchor[] = [],
  references: ReferenceChip[] = [],
): PortableProject {
  const root = cards[0];
  return {
    version: 1,
    project,
    cards,
    edges,
    snapshots,
    anchors,
    references,
    viewState: root ? defaultView(project.id, root.id) : undefined,
  };
}

export function projectBundle(project: PortableProject) {
  const zip = new JSZip();
  const root = safeName(project.project.name);
  zip.file(
    `${root}/manifest.json`,
    JSON.stringify(
      {
        schema: "papertable-project",
        version: 1,
        exportedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  zip.file(`${root}/graph.json`, JSON.stringify(project, null, 2));
  for (const card of project.cards)
    zip.file(
      `${root}/cards/${safeName(card.title)}-${card.id.slice(-8)}.md`,
      cardMarkdown(project, card),
    );
  zip.folder(`${root}/assets`);
  return zip
    .generateAsync({ type: "blob" })
    .then((blob) => ({ filename: `${root}.papertable.zip`, blob }));
}

export function markdownFolder(project: PortableProject) {
  const zip = new JSZip();
  const root = safeName(project.project.name);
  for (const card of project.cards)
    zip.file(
      `${root}/cards/${safeName(card.title)}-${card.id.slice(-8)}.md`,
      cardMarkdown(project, card),
    );
  zip.file(
    `${root}/README.md`,
    `# ${project.project.name}\n\n由 Papertable 导出。每张卡片保存在 cards/ 目录。\n`,
  );
  return zip
    .generateAsync({ type: "blob" })
    .then((blob) => ({ filename: `${root}-markdown.zip`, blob }));
}

export function jsonCanvas(project: PortableProject) {
  const zip = new JSZip();
  const root = safeName(project.project.name);
  const nodes = project.cards.map((card, index) => ({
    id: card.id,
    type: "file",
    file: `cards/${safeName(card.title)}-${card.id.slice(-8)}.md`,
    x: (index % 4) * 340,
    y: Math.floor(index / 4) * 260,
    width: 300,
    height: 210,
  }));
  const edges = project.edges.map((edge) => ({
    id: edge.id,
    fromNode: edge.sourceCardId,
    toNode: edge.targetCardId,
    label:
      edge.type === "child"
        ? "深挖"
        : edge.type === "divergent"
          ? "发散"
          : "改道",
  }));
  zip.file(`${root}/graph.canvas`, JSON.stringify({ nodes, edges }, null, 2));
  for (const card of project.cards)
    zip.file(
      `${root}/cards/${safeName(card.title)}-${card.id.slice(-8)}.md`,
      cardMarkdown(project, card),
    );
  return zip
    .generateAsync({ type: "blob" })
    .then((blob) => ({ filename: `${root}-canvas.zip`, blob }));
}

export function downloadArtifact(artifact: ExportArtifact) {
  const url = URL.createObjectURL(artifact.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function bundleImport(file: File): Promise<PortableProject> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const graphFile = Object.values(zip.files).find((entry) =>
    entry.name.endsWith("graph.json"),
  );
  if (!graphFile) throw new Error("无损项目包中缺少 graph.json。");
  const parsed = JSON.parse(await graphFile.async("text")) as PortableProject;
  if (parsed.version !== 1 || !parsed.project || !Array.isArray(parsed.cards))
    throw new Error("无损项目包格式不受支持。");
  return parsed;
}

async function markdownImport(input: ImportInput): Promise<PortableProject> {
  const mdFiles = input.files.filter((file) =>
    file.name.toLowerCase().endsWith(".md"),
  );
  if (!mdFiles.length) throw new Error("没有找到 Markdown 文件。");
  const project = makeProject(
    mdFiles.length === 1
      ? markdownTitle(await mdFiles[0].text(), mdFiles[0].name)
      : "导入的 Markdown 笔记",
  );
  const cards: Card[] = [];
  const edges: CardEdge[] = [];
  for (const file of mdFiles) {
    const content = await file.text();
    const restored = decodeTransport(content);
    const card = restored?.card
      ? { ...restored.card, projectId: project.id }
      : genericMarkdownCard(file.name, content, project.id);
    cards.push(card);
    if (restored?.edge) edges.push({ ...restored.edge, targetCardId: card.id });
  }
  const cardIds = new Set(cards.map((card) => card.id));
  return assemble(
    project,
    cards,
    edges.filter(
      (edge) =>
        cardIds.has(edge.sourceCardId) && cardIds.has(edge.targetCardId),
    ),
  );
}

async function canvasImport(input: ImportInput): Promise<PortableProject> {
  const canvasFile = input.files.find((file) =>
    file.name.toLowerCase().endsWith(".canvas"),
  );
  if (!canvasFile) throw new Error("请选择 .canvas 文件。");
  const canvas = JSON.parse(await canvasFile.text()) as {
    nodes?: Array<{ id: string; type: string; file?: string; text?: string }>;
    edges?: Array<{
      id?: string;
      fromNode: string;
      toNode: string;
      label?: string;
    }>;
  };
  const project = makeProject(canvasFile.name.replace(/\.canvas$/i, ""));
  const markdownByName = new Map(
    await Promise.all(
      input.files
        .filter((file) => file.name.endsWith(".md"))
        .map(async (file) => [file.name, await file.text()] as const),
    ),
  );
  const cards: Card[] = (canvas.nodes ?? [])
    .filter((node) => node.type === "file" || node.type === "text")
    .map((node) => {
      const name = node.file?.split("/").pop() ?? `${node.id}.md`;
      const content = markdownByName.get(name) ?? node.text ?? "";
      return { ...genericMarkdownCard(name, content, project.id), id: node.id };
    });
  const ids = new Set(cards.map((card) => card.id));
  const edges: CardEdge[] = (canvas.edges ?? [])
    .filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode))
    .map((edge) => {
      const type = edge.label?.includes("发散")
        ? "divergent"
        : edge.label?.includes("改道")
          ? "branch"
          : "child";
      return {
        id: edge.id ?? id("edge"),
        type,
        sourceCardId: edge.fromNode,
        targetCardId: edge.toNode,
        contextPolicy:
          type === "child"
            ? "topic-and-selection"
            : type === "divergent"
              ? "topic-only"
              : "history-through-turn",
      };
    });
  if (!cards.length)
    throw new Error("JSON Canvas 中没有可导入的文本或文件节点。");
  return assemble(project, cards, edges);
}

export const formatAdapters = {
  bundle: {
    id: "bundle",
    async canImport(input: ImportInput) {
      return input.files.some((file) => file.name.endsWith(".zip"));
    },
    async import(input: ImportInput) {
      const file = input.files.find((candidate) =>
        candidate.name.endsWith(".zip"),
      );
      if (!file) throw new Error("请选择 .zip 项目包。");
      return bundleImport(file);
    },
    async export(project: PortableProject) {
      return [await projectBundle(project)];
    },
  },
  "md-dir": {
    id: "md-dir",
    async canImport(input: ImportInput) {
      return input.files.some((file) => file.name.endsWith(".md"));
    },
    import: markdownImport,
    async export(project: PortableProject) {
      return [await markdownFolder(project)];
    },
  },
  canvas: {
    id: "canvas",
    async canImport(input: ImportInput) {
      return input.files.some((file) => file.name.endsWith(".canvas"));
    },
    import: canvasImport,
    async export(project: PortableProject) {
      return [await jsonCanvas(project)];
    },
  },
};
