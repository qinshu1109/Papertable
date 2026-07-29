import assert from "node:assert/strict";
import test from "node:test";
import {
  createVerdictService,
  unavailable,
  VERDICT_CUBE_ID,
} from "./memos.mjs";

function fakeMemos() {
  const records = [];
  let cube = false;
  return {
    records,
    async call(name, args) {
      if (name === "health") return { status: "ok" };
      if (name === "list_cubes")
        return { cubes: cube ? [{ cube_id: VERDICT_CUBE_ID }] : [] };
      if (name === "create_cube") {
        cube = true;
        return { created: true };
      }
      if (name === "search_memories") {
        return {
          results: records.filter(
            (record) =>
              record.memory_view.subject_id === args.subject_ids[0] &&
              record.memory.includes(args.query),
          ),
        };
      }
      if (name === "add_memory") {
        const memory_id = `memory-${records.length + 1}`;
        records.push({
          cube_id: VERDICT_CUBE_ID,
          memory_id,
          memory: args.content,
          metadata: {
            tags: args.tags,
            info: {
              hot_policy: args.hot_policy,
              supersedes_memory_id: args.supersedes_memory_id,
            },
          },
          memory_view: {
            semantic_type: args.semantic_type,
            subject_type: args.subject_type,
            subject_id: args.subject_id,
            client_id: args.client_id,
            status: "activated",
            attributes: args.attributes,
            locked_fields: args.locked_fields,
          },
        });
        return { memory_id };
      }
      if (name === "get_memory")
        return records.find((record) => record.memory_id === args.memory_id);
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

const input = {
  projectId: "project-a",
  verdictType: "tombstone",
  sourceKind: "edge",
  sourceId: "edge-1",
  content: "用户否决了自动写笔记，因为内容会被活埋。",
  concepts: ["自动写笔记"],
};

test("confirmed verdicts are idempotent and project isolated", async () => {
  const memos = fakeMemos();
  const service = createVerdictService(memos.call);
  const [first, retry] = await Promise.all([
    service.confirm(input),
    service.confirm(input),
  ]);
  assert.equal(first.verdict.id, retry.verdict.id);
  assert.equal(memos.records.length, 1);
  await service.confirm({ ...input, projectId: "project-b" });
  assert.equal(memos.records.length, 2);
  assert.equal((await service.list("project-a")).verdicts.length, 1);
  assert.equal(
    (await service.list("project-a", "自动写笔记")).verdicts.length,
    1,
  );
  assert.equal(
    (
      await service.list(
        "project-a",
        "为什么自动写笔记会失败 当前卡片 自动写笔记",
      )
    ).verdicts.length,
    1,
  );
  assert.equal((await service.list("project-b")).verdicts.length, 1);
});

test("supersede returns only the chain tail while retaining history", async () => {
  const memos = fakeMemos();
  const service = createVerdictService(memos.call);
  const first = await service.confirm(input);
  const replacement = await service.supersede(first.verdict.id, {
    ...input,
    content: "用户否决了无确认的生成流程，因为它会制造不可读存量。",
    concepts: ["自动生成存量"],
  });
  const listed = await service.list("project-a");
  assert.equal(listed.verdicts[0].id, replacement.verdict.id);
  assert.equal(listed.history.length, 2);
  assert.equal(
    (await service.list("project-a", "自动写笔记")).verdicts.length,
    0,
  );
  assert.equal(memos.records.length, 2);
  assert.deepEqual(memos.records[1].memory_view.locked_fields, [
    "verdict_type",
    "concepts",
    "source_kind",
    "source_id",
    "user_confirmed",
    "idempotency_key",
  ]);
});

test("gold preserves locked card and turn source location", async () => {
  const memos = fakeMemos();
  const service = createVerdictService(memos.call);
  const result = await service.confirm({
    ...input,
    verdictType: "gold",
    sourceKind: "turn",
    sourceId: "turn-1",
    sourceCardId: "card-1",
    sourceTurnId: "turn-1",
    content: "用户确认的一行结论。",
    concepts: ["证据纪律"],
  });
  assert.equal(result.verdict.sourceCardId, "card-1");
  assert.equal(result.verdict.sourceTurnId, "turn-1");
  assert.deepEqual(memos.records[0].memory_view.locked_fields.slice(-2), [
    "source_card_id",
    "source_turn_id",
  ]);
});

test("host rejects proposed, cross-project supersede and multiline content", async () => {
  const memos = fakeMemos();
  const service = createVerdictService(memos.call);
  await assert.rejects(() => service.confirm({ ...input, content: "a\nb" }));
  await assert.rejects(() =>
    service.confirm({ ...input, verdictType: "proposed" }),
  );
  await assert.rejects(() =>
    service.confirm({
      ...input,
      verdictType: "gold",
      sourceKind: "edge",
    }),
  );
  await assert.rejects(() =>
    service.confirm({
      ...input,
      sourceKind: "turn",
      sourceCardId: "card-1",
      sourceTurnId: "turn-1",
    }),
  );
  const first = await service.confirm(input);
  await assert.rejects(() =>
    service.supersede(first.verdict.id, { ...input, projectId: "project-b" }),
  );
  await assert.rejects(() =>
    service.supersede(first.verdict.id, {
      ...input,
      sourceId: "edge-other",
    }),
  );
  assert.equal("delete" in service, false);
});

test("unavailable is explicit and does not expose upstream detail", () => {
  assert.deepEqual(unavailable(new Error("secret upstream body")), {
    available: false,
    error: {
      code: "unavailable",
      message: "判决簿服务当前不可用，请稍后重试。",
    },
  });
});
