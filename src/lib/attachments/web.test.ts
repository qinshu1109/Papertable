import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../storage/dexie";
import { webAttachmentHost } from "./web";
import { attachmentScope } from "./types";

async function reset() {
  await db.open();
  await db.transaction("rw", db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
  await db.projects.put({
    id: "project-a",
    name: "附件测试",
    pinned: false,
    updatedAt: 1,
  });
  for (const id of ["card-a", "card-b"]) {
    await db.cards.put({
      id,
      projectId: "project-a",
      title: id,
      favorite: false,
      unread: false,
      concepts: [],
      createdAt: 1,
    });
  }
}

test("web lifecycle snapshots bytes, freezes card scope, promotes explicitly, and preserves deleted citation evidence", async () => {
  await reset();
  const source = new File(
    ["# 航线\n\n唯一附件事实是 ORBIT-ATTACHMENT-42。"],
    "航线.md",
    { type: "text/markdown", lastModified: 10 },
  );
  const preflight = await webAttachmentHost.preflightFiles("card-a", [source]);
  const progress: string[] = [];
  const result = await webAttachmentHost.importFiles({
    preflight,
    files: [source],
    confirmed: false,
    signal: new AbortController().signal,
    onProgress: (event) => progress.push(event.phase),
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(progress[0], "copying");
  assert.ok(progress.includes("indexing"));
  assert.equal(progress[progress.length - 1], "complete");
  const attachment = result.attachments[0];
  assert.equal(attachment.scope, "attachment:card-a");
  assert.equal(attachment.indexed, true);
  assert.equal(
    "bytes" in attachment,
    false,
    "public records never expose bytes",
  );
  const persisted = await db.attachments.get(attachment.id);
  assert.ok(persisted);
  assert.ok(persisted.bytes instanceof ArrayBuffer);
  assert.equal(
    new TextDecoder().decode(persisted.bytes),
    await source.text(),
    "the application-owned snapshot is a byte-for-byte copy",
  );

  const hits = await webAttachmentHost.search({
    runId: "run-a",
    projectId: "project-a",
    cardId: "card-a",
    query: "ORBIT-ATTACHMENT-42",
    limit: 8,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunk.libraryId, attachmentScope("card-a"));
  assert.deepEqual(
    await webAttachmentHost.search({
      runId: "run-b",
      projectId: "project-a",
      cardId: "card-b",
      query: "ORBIT-ATTACHMENT-42",
      limit: 8,
    }),
    [],
    "another card cannot search the attachment corpus",
  );
  assert.deepEqual(
    await webAttachmentHost.read({
      runId: "run-b",
      projectId: "project-a",
      cardId: "card-b",
      chunkIds: [hits[0].chunk.id],
    }),
    [],
    "another card cannot read a known chunk id",
  );

  const promoted = await webAttachmentHost.promote({
    projectId: "project-a",
    attachmentId: attachment.id,
  });
  assert.equal(promoted.scope, "attachment:card-a");
  assert.equal(promoted.promotedLibraryId, "project-attachments-project-a");
  assert.equal(await db.attachmentChunks.count(), 1);
  assert.equal(await db.noteDocuments.count(), 1);
  assert.deepEqual(
    await db.projectNoteLibraries.get([
      "project-a",
      "project-attachments-project-a",
    ]),
    {
      projectId: "project-a",
      libraryId: "project-attachments-project-a",
    },
  );

  const citation = {
    libraryId: attachment.scope,
    documentId: attachment.id,
    relativePath: attachment.relativePath,
    documentHash: hits[0].chunk.documentVersionHash,
    chunkId: hits[0].chunk.id,
    excerpt: hits[0].chunk.text,
  };
  assert.equal(
    (
      await webAttachmentHost.resolveCitation({
        projectId: "project-a",
        citation,
      })
    ).state,
    "current",
  );
  await webAttachmentHost.remove(attachment.id);
  const deleted = await webAttachmentHost.resolveCitation({
    projectId: "project-a",
    citation,
  });
  assert.deepEqual(deleted, { state: "missing", reason: "原来源已移除" });
  assert.match(citation.excerpt, /ORBIT-ATTACHMENT-42/);
  assert.equal(
    await db.noteDocuments.count(),
    1,
    "deleting the attachment does not retract its explicitly promoted copy",
  );
});

test("web preflight requires explicit confirmation above the default count limit and rejects a changed selection", async () => {
  await reset();
  const files = Array.from(
    { length: 26 },
    (_, index) =>
      new File([`${index}`], `${index}.txt`, { type: "text/plain" }),
  );
  const preflight = await webAttachmentHost.preflightFiles("card-a", files);
  assert.equal(preflight.requiresConfirmation, true);
  await assert.rejects(
    webAttachmentHost.importFiles({
      preflight,
      files,
      confirmed: false,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }),
    /必须先在应用内确认/,
  );
  await assert.rejects(
    webAttachmentHost.importFiles({
      preflight,
      files: [...files.slice(0, -1), new File(["x"], "changed.txt")],
      confirmed: true,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }),
    /预检结果与当前选择不一致/,
  );
  assert.equal(await db.attachments.count(), 0);
  await assert.rejects(
    webAttachmentHost.preflightFiles(
      "card-a",
      Array.from(
        { length: 501 },
        (_, index) => new File(["x"], `hard-${index}.txt`),
      ),
    ),
    /安全硬上限/,
  );
});
