import assert from "node:assert/strict";
import test from "node:test";
import { readAgentPreflight } from "./agentPreflight";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("preflight starts independent reads together and waits for the audited Turn", async () => {
  const verdict = deferred<"verdict">();
  const persisted = deferred<void>();
  const audit = deferred<"audit">();
  const libraries = deferred<readonly string[]>();
  const attachments = deferred<readonly string[]>();
  const started: string[] = [];

  const pending = readAgentPreflight({
    verdict: () => {
      started.push("verdict");
      return verdict.promise;
    },
    persistVerdict: () => {
      started.push("persist-verdict");
      return persisted.promise;
    },
    resumeAudit: () => {
      started.push("audit");
      return audit.promise;
    },
    libraryIds: () => {
      started.push("libraries");
      return libraries.promise;
    },
    attachments: () => {
      started.push("attachments");
      return attachments.promise;
    },
  });

  assert.deepEqual(started, ["verdict", "audit", "libraries", "attachments"]);
  verdict.resolve("verdict");
  await Promise.resolve();
  assert.deepEqual(started, [
    "verdict",
    "audit",
    "libraries",
    "attachments",
    "persist-verdict",
  ]);

  let settled = false;
  void pending.then(() => {
    started.push("first-agent-audit");
    started.push("first-model-request");
    settled = true;
  });
  persisted.resolve();
  await Promise.resolve();
  assert.equal(settled, false, "the other host reads remain a hard barrier");

  audit.resolve("audit");
  libraries.resolve(["library"]);
  attachments.resolve(["attachment"]);
  assert.deepEqual(await pending, {
    verdict: "verdict",
    resumeAudit: "audit",
    libraryIds: ["library"],
    attachments: ["attachment"],
  });
  await Promise.resolve();
  assert.deepEqual(started.slice(-2), [
    "first-agent-audit",
    "first-model-request",
  ]);
  assert.ok(
    started.indexOf("persist-verdict") < started.indexOf("first-agent-audit"),
  );
});

test("a failed host scope read closes preflight before audit or model work", async () => {
  let downstream = false;
  await assert.rejects(
    readAgentPreflight({
      verdict: async () => "verdict",
      persistVerdict: async () => undefined,
      resumeAudit: async () => null,
      libraryIds: async () => {
        throw new Error("scope unavailable");
      },
      attachments: async () => [],
    }).then(() => {
      downstream = true;
    }),
    /scope unavailable/,
  );
  assert.equal(downstream, false);
});
