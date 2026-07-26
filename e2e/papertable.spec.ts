import { expect, test } from "@playwright/test";

async function workspaceCounts(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("papertable-web-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(
      ["cards", "edges", "snapshots", "proposals", "turns"],
      "readonly",
    );
    const count = (name: string) =>
      new Promise<number>((resolve, reject) => {
        const request = tx.objectStore(name).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const proposals = await new Promise<unknown[]>((resolve, reject) => {
      const request = tx.objectStore("proposals").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const cards = await new Promise<unknown[]>((resolve, reject) => {
      const request = tx.objectStore("cards").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const turns = await new Promise<unknown[]>((resolve, reject) => {
      const request = tx.objectStore("turns").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [cardCount, edgeCount, snapshotCount] = await Promise.all([
      count("cards"),
      count("edges"),
      count("snapshots"),
    ]);
    db.close();
    return {
      cardCount,
      edgeCount,
      snapshotCount,
      proposals,
      cards,
      turns,
    };
  });
}

async function seedPriorDaySignal(page: import("@playwright/test").Page) {
  const yesterday = Date.now() - 24 * 60 * 60 * 1000;
  const localDate = await page.evaluate((timestamp) => {
    const date = new Date(timestamp);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }, yesterday);
  await page.evaluate(
    async ({ timestamp, date }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("papertable-web-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          ["interactionEvents", "sessionBoundaries"],
          "readwrite",
        );
        tx.objectStore("sessionBoundaries").put({
          id: "e2e-prior-session",
          projectId: "p-quantum",
          localDate: date,
          startedAt: timestamp,
          lastActiveAt: timestamp + 1_000,
          endedAt: timestamp + 2_000,
        });
        tx.objectStore("interactionEvents").put({
          id: "e2e-strong-signal",
          projectId: "p-quantum",
          sessionId: "e2e-prior-session",
          type: "title-edited",
          createdAt: timestamp + 1_000,
          targetCardId: "c-wave",
          sourceCardId: "c-wave",
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { timestamp: yesterday, date: localDate },
  );
}

test("desktop flow creates a real streamed card without an API key", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /CozAI · papertable-test-model/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("请解释什么是上下文隔离？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("这是本地验收用的流式回答")).toBeVisible();
  await page.getByRole("button", { name: /本次上下文/ }).click();
  await expect(page.getByRole("dialog", { name: "本次上下文" })).toContainText(
    "当前卡片",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "深挖", exact: true }).first().click();
  await expect(page.getByText("这是本地验收用的流式回答")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "关系导航器" }),
  ).toBeVisible();
});

test("390px mobile layout has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "打开项目抽屉" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "提问输入框" })).toBeVisible();
  expect(
    await page
      .locator("html")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("390px mobile mode switch and ghost preview can be edited before starting", async ({
  page,
}) => {
  const modelRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/llm/stream"))
      modelRequests.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: /回答依据：通用探索/ }).click();
  await expect(
    page.getByRole("button", { name: /回答依据：仅依据材料/ }),
  ).toBeVisible();
  await seedPriorDaySignal(page);
  await page.reload();
  await page
    .locator(".mini-nav")
    .getByRole("button", { name: /查看幽灵分支/ })
    .click();
  const tray = page.getByRole("dialog", { name: "幽灵分支" });
  await tray.getByRole("button", { name: "查看" }).click();
  await tray
    .getByRole("textbox", { name: "探索问题" })
    .fill("移动端也先编辑，再主动开始探索。");
  expect(modelRequests).toHaveLength(0);
  await tray.getByRole("button", { name: "开始探索" }).click();
  await expect.poll(() => modelRequests.length).toBe(1);
  await expect(page.getByText("这是本地验收用的流式回答")).toBeVisible();
  expect(
    await page
      .locator("html")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("answer-mode chip changes the next real request and child cards inherit it", async ({
  page,
}) => {
  const requests: Array<{ task?: string; messages?: { content: string }[] }> =
    [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/llm/stream")) return;
    requests.push(request.postDataJSON());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目" }).click();
  await expect(
    page.getByRole("button", { name: /回答依据：通用探索/ }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("没有材料时，你可以怎样帮助我？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("这是本地验收用的流式回答")).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  await page.waitForTimeout(500);
  expect(requests[0]?.messages?.[0]?.content).toContain("可以使用通用知识");

  await page.getByRole("button", { name: /回答依据：通用探索/ }).click();
  await expect(
    page.getByRole("button", { name: /回答依据：仅依据材料/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "深挖", exact: true }).first().click();
  await expect(
    page.getByRole("button", { name: /回答依据：仅依据材料/ }),
  ).toBeVisible();
  await expect.poll(() => requests.length).toBe(2);
  await page.waitForTimeout(500);
  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("下一次只看材料时怎么办？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(3);
  expect(requests.at(-1)?.messages?.[0]?.content).toContain(
    "只能使用下方明确提供的上下文",
  );
});

test("stopping a stream keeps partial content after reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /CozAI · papertable-test-model/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("请生成一段用于停止测试的说明");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText("已停止，已保留生成内容。")).toBeVisible();
  await page.waitForTimeout(650);
  await page.reload();
  await expect(page.getByText("已停止，已保留生成内容。")).toBeVisible();
});

test("a ghost branch only opens a preview, then materializes once with an edited question", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /CozAI · papertable-test-model/ }),
  ).toBeVisible();

  await seedPriorDaySignal(page);

  const modelRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/llm/stream"))
      modelRequests.push(request.url());
  });
  await page.reload();
  const morning = page.getByLabel("次日探索提示");
  await expect(morning).toBeVisible();
  expect(modelRequests).toHaveLength(0);
  const beforePreview = await workspaceCounts(page);
  await page
    .getByRole("button", { name: /查看幽灵分支提案/ })
    .first()
    .click();
  const tray = page.getByRole("dialog", { name: "幽灵分支" });
  await expect(tray).toContainText("人类行为信号");
  await expect(tray).toContainText("提案详情");
  await expect
    .poll(async () => {
      const state = await workspaceCounts(page);
      return (state.proposals as { status?: string }[]).find(
        (proposal) => proposal.status === "opened",
      )?.status;
    })
    .toBe("opened");
  const afterPreview = await workspaceCounts(page);
  expect(modelRequests).toHaveLength(0);
  expect(afterPreview.cardCount).toBe(beforePreview.cardCount);
  expect(afterPreview.edgeCount).toBe(beforePreview.edgeCount);
  expect(afterPreview.snapshotCount).toBe(beforePreview.snapshotCount);
  expect(
    (afterPreview.proposals as { status?: string }[]).find(
      (proposal) => proposal.status === "opened",
    ),
  ).toBeTruthy();

  const finalQuestion = "我改过问题后，先比较这条路径的两个关键前提。";
  await tray.getByRole("textbox", { name: "探索问题" }).fill(finalQuestion);
  await tray.getByRole("button", { name: "开始探索" }).click();
  await expect(page.getByText("这是本地验收用的流式回答")).toBeVisible();
  expect(modelRequests).toHaveLength(1);
  await expect
    .poll(async () => {
      const state = await workspaceCounts(page);
      return (state.proposals as { status?: string }[]).find(
        (proposal) => proposal.status === "accepted",
      )?.status;
    })
    .toBe("accepted");
  const afterMaterialize = await workspaceCounts(page);
  expect(afterMaterialize.cardCount).toBe(beforePreview.cardCount + 1);
  expect(afterMaterialize.edgeCount).toBe(beforePreview.edgeCount + 1);
  expect(afterMaterialize.snapshotCount).toBe(beforePreview.snapshotCount + 1);
  const accepted = (
    afterMaterialize.proposals as {
      status?: string;
      acceptedCardId?: string;
    }[]
  ).find((proposal) => proposal.status === "accepted");
  expect(accepted?.acceptedCardId).toBeTruthy();
  const newCard = (
    afterMaterialize.cards as {
      id?: string;
      proposalId?: string;
    }[]
  ).find((card) => card.id === accepted?.acceptedCardId);
  expect(newCard?.proposalId).toBeTruthy();
  expect(
    (
      afterMaterialize.turns as {
        cardId?: string;
        role?: string;
        content?: string;
      }[]
    ).some(
      (turn) =>
        turn.cardId === accepted?.acceptedCardId &&
        turn.role === "user" &&
        turn.content === finalQuestion,
    ),
  ).toBe(true);
});
