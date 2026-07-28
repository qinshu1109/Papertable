import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  replayTask013GoldenFixtures,
  summarizeTask013Rows,
  task013RowsPass,
  type Task013AcceptanceRow,
} from "./lib/task013Acceptance";
import {
  capabilityFromProbe,
  isCapabilityAdmitted,
} from "./lib/provider/capabilityGate";
import {
  getProviderConfig,
  probeProviderCapabilities,
} from "./lib/provider/http";
import { runTask013RealProviderMatrix } from "./lib/task013RealProvider";
import { runTask013DeterministicRuntimeMatrix } from "./lib/task013Runtime";

type Lane = "deterministic" | "real" | "all";

interface HostedServer {
  origin: string;
  child?: ChildProcess;
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function selectedLane(): Lane {
  const value = process.argv
    .find((argument) => argument.startsWith("--lane="))
    ?.slice("--lane=".length);
  if (value === "deterministic" || value === "real" || value === "all")
    return value;
  return "all";
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(origin: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/config`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TASK-013 provider host did not start within 15 seconds");
}

async function startServer(fake: boolean): Promise<HostedServer> {
  const provided = process.env.TASK013_PROVIDER_ORIGIN;
  if (provided && !fake) {
    await waitForServer(provided);
    return { origin: provided };
  }
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ["--env-file-if-exists=.env.local", "server/index.mjs"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PAPERTABLE_PORT: String(port),
        ...(fake ? { PAPERTABLE_FAKE_LLM: "1" } : {}),
      },
      stdio: "ignore",
    },
  );
  await waitForServer(origin);
  return { origin, child };
}

async function stopServer(server: HostedServer): Promise<void> {
  if (!server.child || server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.child?.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

async function withRelativeFetch<T>(
  origin: string,
  operation: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const resolved =
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, origin)
        : input;
    return original(resolved, init);
  }) as typeof fetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
  }
}

async function probeHostedProvider(fake: boolean) {
  const server = await startServer(fake);
  try {
    return await withRelativeFetch(server.origin, async () => {
      const config = await getProviderConfig();
      const probe = await probeProviderCapabilities();
      const capability = capabilityFromProbe({
        baseUrl: config.baseUrl,
        model: config.model,
        ttlMs: 86_400_000,
        probe,
        now: Date.now(),
      });
      return {
        config: {
          model: config.model,
          host: (() => {
            try {
              return new URL(config.baseUrl).host;
            } catch {
              return config.baseUrl;
            }
          })(),
          configured: fake || config.hasApiKey,
        },
        capability,
        rows:
          !fake && isCapabilityAdmitted(capability)
            ? await runTask013RealProviderMatrix(capability)
            : [],
      };
    });
  } finally {
    await stopServer(server);
  }
}

async function main() {
  const lane = selectedLane();
  const deterministicRows: Task013AcceptanceRow[] = [];
  let localProviderContract:
    | {
        status: "passed" | "failed";
        model: string;
        stages: string[];
      }
    | undefined;
  if (lane === "deterministic" || lane === "all") {
    deterministicRows.push(
      ...(await replayTask013GoldenFixtures({
        outputsRoot: path.join(repositoryRoot, "harness-rebuild/outputs"),
        manifestPath: path.join(
          repositoryRoot,
          "harness-rebuild/outputs/task-013/golden-manifest.json",
        ),
      })),
      ...(await runTask013DeterministicRuntimeMatrix()),
    );
    const local = await probeHostedProvider(true);
    localProviderContract = {
      status: isCapabilityAdmitted(local.capability) ? "passed" : "failed",
      model: local.config.model,
      stages: [
        local.capability.toolCallEmission.status,
        local.capability.toolResultAcceptance.status,
        local.capability.streamingToolCallDelta.status,
      ],
    };
  }

  let realLane:
    | {
        status: "passed" | "failed" | "unavailable";
        configured: boolean;
        model: string;
        host: string;
        stages: string[];
        rows: Task013AcceptanceRow[];
      }
    | undefined;
  if (lane === "real" || lane === "all") {
    try {
      const real = await probeHostedProvider(false);
      const admitted = isCapabilityAdmitted(real.capability);
      realLane = {
        status: !admitted
          ? "unavailable"
          : task013RowsPass(real.rows)
            ? "passed"
            : "failed",
        configured: real.config.configured,
        model: real.config.model,
        host: real.config.host,
        stages: [
          real.capability.toolCallEmission.status,
          real.capability.toolResultAcceptance.status,
          real.capability.streamingToolCallDelta.status,
        ],
        rows: real.rows,
      };
    } catch (cause) {
      realLane = {
        status: "unavailable",
        configured: Boolean(process.env.COZAI_API_KEY),
        model: process.env.COZAI_MODEL ?? "configured-model",
        host: "configured-provider",
        stages: ["not-run", "not-run", "not-run"],
        rows: [],
      };
      process.stderr.write(
        `TASK-013 real lane unavailable: ${
          cause instanceof Error ? cause.message : String(cause)
        }\n`,
      );
    }
  }

  const deterministicPassed =
    task013RowsPass(deterministicRows) &&
    localProviderContract?.status !== "failed";
  const realRequiredAndFailed = realLane?.status === "failed";
  const overallPassed = deterministicPassed && !realRequiredAndFailed;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    lane,
    overall: overallPassed ? "passed" : "failed",
    assertions: [
      "correct-tool-calls",
      "correct-terminal-state",
      "persisted-evidence",
      "no-unauthorized-reads",
      "no-unhandled-duplicate-calls",
      "no-two-stage-on-protocol-failure",
    ],
    deterministic: {
      status:
        lane === "real" ? "not-run" : deterministicPassed ? "passed" : "failed",
      summary: summarizeTask013Rows(deterministicRows),
      rows: deterministicRows,
    },
    localProviderContract,
    realLane,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!overallPassed) process.exitCode = 1;
}

await main();
