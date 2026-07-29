import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { InteractionEvent, InteractionEventType } from "../types";

const execFileAsync = promisify(execFile);
const verdictTypes = new Set<InteractionEventType>([
  "reroute-eligible",
  "tombstone-confirmed",
  "tombstone-rewritten",
  "tombstone-abandoned",
]);

interface DesktopInteractionRow {
  id?: unknown;
  projectId?: unknown;
  createdAt?: unknown;
  doc?: unknown;
}

const requiredText = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value)
    throw new Error(`桌面事件 ${field} 无效`);
  return value;
};

export function defaultDesktopDatabasePath(): string {
  if (process.platform !== "darwin")
    throw new Error("自动定位安装版数据库目前只支持 macOS，请显式传入路径");
  return path.join(
    homedir(),
    "Library",
    "Application Support",
    "com.papertable.app",
    "papertable.sqlite3",
  );
}

export function parseDesktopInteractionRows(
  value: unknown,
): InteractionEvent[] {
  if (!Array.isArray(value)) throw new Error("sqlite3 返回的事件行不是数组");
  return value.flatMap((raw, index) => {
    const row = raw as DesktopInteractionRow;
    if (typeof row.doc !== "string")
      throw new Error(`桌面事件第 ${index + 1} 行缺少 doc`);
    let doc: Partial<InteractionEvent>;
    try {
      doc = JSON.parse(row.doc) as Partial<InteractionEvent>;
    } catch {
      throw new Error(`桌面事件第 ${index + 1} 行 doc 不是 JSON`);
    }
    if (!verdictTypes.has(doc.type as InteractionEventType)) return [];
    const id = requiredText(doc.id, "id");
    const projectId = requiredText(doc.projectId, "projectId");
    const sessionId = requiredText(doc.sessionId, "sessionId");
    const targetCardId = requiredText(doc.targetCardId, "targetCardId");
    if (
      row.id !== id ||
      row.projectId !== projectId ||
      row.createdAt !== doc.createdAt ||
      typeof doc.createdAt !== "number" ||
      !Number.isFinite(doc.createdAt)
    )
      throw new Error(`桌面事件第 ${index + 1} 行与 doc 不一致`);
    if (
      doc.editRatio !== undefined &&
      (typeof doc.editRatio !== "number" || !Number.isFinite(doc.editRatio))
    )
      throw new Error(`桌面事件第 ${index + 1} 行 editRatio 无效`);
    return [
      {
        id,
        projectId,
        sessionId,
        type: doc.type as InteractionEventType,
        createdAt: doc.createdAt,
        targetCardId,
        ...(doc.editRatio === undefined ? {} : { editRatio: doc.editRatio }),
      },
    ];
  });
}

export async function readDesktopInteractionEvents(
  databasePath: string,
): Promise<InteractionEvent[]> {
  const resolved = path.resolve(databasePath);
  const { stdout } = await execFileAsync(
    "sqlite3",
    [
      "-readonly",
      "-json",
      resolved,
      "select id, project_id as projectId, created_at as createdAt, doc from interaction_events order by created_at, id;",
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return parseDesktopInteractionRows(JSON.parse(stdout || "[]") as unknown);
}
