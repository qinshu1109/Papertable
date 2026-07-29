import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildVerdictSystemBlock } from "./lib/context";
import {
  summarizeTask018Ab,
  summarizeTask018Events,
  validateTask018Cases,
  type Task018AbRun,
} from "./lib/task018Acceptance";
import {
  defaultDesktopDatabasePath,
  readDesktopInteractionEvents,
} from "./lib/task018DesktopEvents";
import { VERDICT_PROMPT_VERSION } from "./lib/verdicts";
import type { InteractionEvent } from "./types";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const argument = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(file), "utf8")) as unknown;
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) =>
        error
          ? reject(error)
          : resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
}

async function waitForServer(origin: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/api/config`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TASK-018 provider host did not start within 15 seconds");
}

async function startServer(): Promise<{
  origin: string;
  child: ChildProcess;
}> {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ["--env-file-if-exists=.env.local", "server/index.mjs"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, PAPERTABLE_PORT: String(port) },
      stdio: "ignore",
    },
  );
  await waitForServer(origin);
  return { origin, child };
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function complete(
  origin: string,
  question: string,
  verdict?: string,
): Promise<string> {
  const system = [
    "你是 Papertable 的知识探索助手。直接回答当前问题，不比较文风，也不要评论这是一项 A/B 测试。",
    ...(verdict
      ? [
          buildVerdictSystemBlock([
            {
              id: "task-018-frozen-tombstone",
              verdictType: "tombstone",
              content: verdict,
            },
          ]),
        ]
      : []),
  ];
  const response = await fetch(`${origin}/api/llm/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: "concept-preview",
      temperature: 0,
      messages: [
        ...system.map((content) => ({ role: "system", content })),
        { role: "user", content: question },
      ],
    }),
  });
  const body = (await response.json()) as {
    content?: string;
    message?: string;
  };
  if (!response.ok || typeof body.content !== "string")
    throw new Error(body.message ?? `模型请求失败：HTTP ${response.status}`);
  return body.content;
}

async function runAb(casesFile: string): Promise<Task018AbRun> {
  const cases = validateTask018Cases(await readJson(casesFile));
  const server = await startServer();
  try {
    const config = (await fetch(`${server.origin}/api/config`).then(
      (response) => response.json(),
    )) as { model: string; baseUrl: string; hasApiKey: boolean };
    if (!config.hasApiKey) throw new Error("真实模型密钥尚未配置");
    const results: Task018AbRun["cases"] = [];
    for (const item of cases) {
      results.push({
        ...item,
        off: {
          response: await complete(server.origin, item.question),
          recurrence: null,
        },
        on: {
          response: await complete(server.origin, item.question, item.verdict),
          recurrence: null,
        },
      });
    }
    return {
      promptVersion: VERDICT_PROMPT_VERSION,
      generatedAt: new Date().toISOString(),
      provider: {
        model: config.model,
        host: new URL(config.baseUrl).host,
      },
      cases: results,
    };
  } finally {
    await stopServer(server.child);
  }
}

async function main() {
  const output = argument("out");
  const scoreFile = argument("score");
  const eventsFile = argument("events");
  const desktopDbArgument = argument("desktop-db");
  if (eventsFile && desktopDbArgument)
    throw new Error("--events 与 --desktop-db 只能选择一个");
  const desktopDb =
    desktopDbArgument === "auto"
      ? defaultDesktopDatabasePath()
      : desktopDbArgument;
  let result: unknown;
  if (scoreFile || eventsFile || desktopDb) {
    const events = eventsFile
      ? (((await readJson(eventsFile)) as { events: InteractionEvent[] })
          .events ?? [])
      : desktopDb
        ? await readDesktopInteractionEvents(desktopDb)
        : null;
    result = {
      ...(scoreFile
        ? {
            ab: summarizeTask018Ab((await readJson(scoreFile)) as Task018AbRun),
          }
        : {}),
      ...(events
        ? {
            events: {
              ...(desktopDb ? { source: path.resolve(desktopDb) } : {}),
              ...summarizeTask018Events(events),
            },
          }
        : {}),
    };
  } else {
    const casesFile = argument("cases");
    if (!casesFile)
      throw new Error(
        "用 --cases=<冻结的10题.json> 运行 A/B，或用 --score/--events/--desktop-db=auto 结算。",
      );
    result = await runAb(casesFile);
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await writeFile(path.resolve(output), text);
  else process.stdout.write(text);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
