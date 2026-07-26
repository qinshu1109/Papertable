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
  // 等第一句真正释放出来再停止：闸门按句子释放，立刻停止会合法地得到空内容，
  // 那属于「停止在首句之前」的另一种情形，由 P0 的专门用例覆盖。
  await expect(page.getByText("第一句已经完成")).toBeVisible();
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText("已停止，已保留生成内容。")).toBeVisible();
  await page.waitForTimeout(650);
  await page.reload();
  await expect(page.getByText("已停止，已保留生成内容。")).toBeVisible();
  await expect(page.getByText("第一句已经完成")).toBeVisible();
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

// --- 两个标签页不得互相销毁数据 ---------------------------------------------

/**
 * 必须是**一个 context、两个 page**：两次 `browser.newContext()` 的存储是分区的，
 * 不共享 IndexedDB，那样测不出这个 bug。
 */
test("closing a second tab must not destroy the first tab's proposals", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    // tabB 先水合，它的内存里一条提案都没有。
    const tabB = await context.newPage();
    await tabB.goto("/");
    await expect(
      tabB.getByRole("button", { name: /CozAI · papertable-test-model/ }),
    ).toBeVisible();

    // tabA 生成并落盘一条提案。
    const tabA = await context.newPage();
    await tabA.goto("/");
    await seedPriorDaySignal(tabA);
    await tabA.reload();
    await expect(tabA.getByLabel("次日探索提示")).toBeVisible();
    await expect
      .poll(async () => (await workspaceCounts(tabA)).proposals.length)
      .toBeGreaterThan(0);
    const before = (await workspaceCounts(tabA)).proposals.length;

    // 关闭 tabB 会触发它的 pagehide → 写回它自己那份（空的）注意力状态。
    await tabB.close();
    await tabA.waitForTimeout(400);

    expect(
      (await workspaceCounts(tabA)).proposals.length,
      "关闭另一个标签页销毁了本标签页生成的提案",
    ).toBe(before);
  } finally {
    await context.close();
  }
});

/**
 * 删项目的另一半：删得**不完整**。陈旧标签页按自己的基线推导删除时，只删得掉它
 * 记得的那些行，另一个标签页刚建的卡片会变成没有项目的孤儿。
 */
test("deleting a project also removes rows the deleting tab never saw", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const tabA = await context.newPage();
    await tabA.goto("/");
    await expect(
      tabA.getByRole("button", { name: /CozAI · papertable-test-model/ }),
    ).toBeVisible();
    await tabA.getByRole("button", { name: "新建项目" }).click();
    await tabA
      .getByRole("textbox", { name: "提问输入框" })
      .fill("第一个标签页的问题");
    await tabA.getByRole("button", { name: "发送" }).click();
    await expect(tabA.getByText("这是本地验收用的流式回答")).toBeVisible();
    await tabA.waitForTimeout(700);

    const { projectId, projectName } = await tabA.evaluate(
      async () =>
        await new Promise<{ projectId: string; projectName: string }>(
          (resolve, reject) => {
            const request = indexedDB.open("papertable-web-v1");
            request.onsuccess = () => {
              const database = request.result;
              const tx = database.transaction(["view", "projects"], "readonly");
              const get = tx.objectStore("view").get("main");
              get.onsuccess = () => {
                const id = (get.result as { activeProjectId: string })
                  .activeProjectId;
                const project = tx.objectStore("projects").get(id);
                project.onsuccess = () => {
                  resolve({
                    projectId: id,
                    projectName: (project.result as { name: string }).name,
                  });
                  database.close();
                };
                project.onerror = () => reject(project.error);
              };
              get.onerror = () => reject(get.error);
            };
            request.onerror = () => reject(request.error);
          },
        ),
    );

    // tabB 现在打开，基线包含 tabA 到此为止建的行。
    const tabB = await context.newPage();
    await tabB.goto("/");
    await expect(
      tabB.getByRole("button", { name: /CozAI · papertable-test-model/ }),
    ).toBeVisible();

    // tabA 在同一个项目下深挖出一张子卡片，tabB 对此一无所知。
    await tabA
      .getByRole("button", { name: "深挖", exact: true })
      .first()
      .click();
    await expect(
      tabA.getByText("这是本地验收用的流式回答").first(),
    ).toBeVisible();
    await tabA.waitForTimeout(700);
    const beforeDelete = await workspaceCounts(tabA);
    const inProject = (state: Awaited<ReturnType<typeof workspaceCounts>>) =>
      (state.cards as { id: string; projectId: string }[]).filter(
        (card) => card.projectId === projectId,
      );
    expect(inProject(beforeDelete).length).toBeGreaterThan(1);

    // tabB 用它那份陈旧状态删掉这个项目。按名字精确定位——种子数据里已经有一个
    // 同名项目，`.first()` 会删错对象。
    await tabB
      .getByRole("button", { name: `${projectName} 的菜单` })
      .last()
      .click();
    await tabB.getByRole("button", { name: "移入回收站" }).click();
    await tabB.waitForTimeout(700);

    const afterDelete = await workspaceCounts(tabB);
    expect(
      inProject(afterDelete),
      "陈旧标签页删项目时漏掉了另一个标签页刚建的卡片，留下了孤儿行",
    ).toHaveLength(0);
    const orphanCardIds = new Set(inProject(beforeDelete).map((c) => c.id));
    expect(
      (afterDelete.turns as { cardId: string }[]).filter((turn) =>
        orphanCardIds.has(turn.cardId),
      ),
      "孤儿轮次也必须一并删除",
    ).toHaveLength(0);
  } finally {
    await context.close();
  }
});

// --- 隐藏推理不得展示、更不得落盘 -------------------------------------------

/**
 * 证明必须落在磁盘边界而不是 DOM：正文写进 `turn.content` 后 500 ms 内就进了
 * IndexedDB，只断言界面看不见并不能说明它没被保存。
 */
const FORBIDDEN = [
  "Since the user",
  "draw on general knowledge",
  "making sure to",
  "<think>",
  "internal plan",
  "The user didn't give me",
];

async function persistedBlob(page: import("@playwright/test").Page) {
  const state = await workspaceCounts(page);
  return JSON.stringify([state.turns, state.cards]);
}

function expectClean(blob: string) {
  for (const forbidden of FORBIDDEN)
    expect(blob, `落盘内容里出现了草稿推理：${forbidden}`).not.toContain(
      forbidden,
    );
}

async function askInNewProject(
  page: import("@playwright/test").Page,
  question: string,
) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /CozAI · papertable-test-model/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("textbox", { name: "提问输入框" }).fill(question);
  await page.getByRole("button", { name: "发送" }).click();
}

test("a gateway reasoning preamble is never displayed nor persisted", async ({
  page,
}) => {
  await askInNewProject(page, "思考泄漏：解释量子退相干");
  await expect(page.getByText("量子退相干是指系统与环境纠缠")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Since the user");

  await page.waitForTimeout(700); // 越过 500 ms 的流式自动保存节奏
  expectClean(await persistedBlob(page));

  await page.reload();
  await expect(page.getByText("量子退相干是指系统与环境纠缠")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Since the user");
  expectClean(await persistedBlob(page));
});

test("stopping mid-draft flushes nothing to disk", async ({ page }) => {
  await askInNewProject(page, "思考泄漏：解释量子退相干");
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText(/^已停止/)).toBeVisible();

  await page.waitForTimeout(700);
  expectClean(await persistedBlob(page));

  await page.reload();
  await expect(page.getByText(/^已停止/)).toBeVisible();
  const state = await workspaceCounts(page);
  // 只看这次被停止的轮次；demo 种子数据里也有 ai 轮次。
  const stopped = (
    state.turns as { status?: string; content: string }[]
  ).filter((turn) => turn.status === "stopped");
  expect(stopped.length).toBeGreaterThan(0);
  for (const turn of stopped)
    expect(
      turn.content === "" || turn.content.startsWith("量子退相干"),
      `停止后保留了非正文内容：${JSON.stringify(turn.content)}`,
    ).toBe(true);
});

test("an unterminated thinking tag is reported, not partially shown", async ({
  page,
}) => {
  await askInNewProject(page, "思考未闭合：解释量子退相干");
  await expect(
    page.getByRole("article").getByText("模型没有返回可显示的最终文本"),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("<think");
  await expect(page.locator("body")).not.toContainText("internal plan");
  await page.waitForTimeout(700);
  expectClean(await persistedBlob(page));
});

test("the concept popover neither shows nor caches hidden reasoning", async ({
  page,
}) => {
  await askInNewProject(page, "思考泄漏：解释量子退相干");
  await expect(page.getByText("量子退相干是指系统与环境纠缠")).toBeVisible();

  const term = page.locator(".concept-term").first();
  await expect(term).toBeVisible();
  await term.click();

  const popover = page.getByRole("dialog", { name: /概念解释/ });
  await expect(popover).toContainText("退相干描述的是相位相干性");
  await expect(popover).not.toContainText("The user didn't give me");

  await page.waitForTimeout(700);
  expectClean(await persistedBlob(page));

  // 「展开为卡片」会把预览正文当作新卡片的种子轮次，同样不能带上草稿。
  await popover.getByRole("button", { name: "展开为卡片" }).click();
  await page.waitForTimeout(700);
  expectClean(await persistedBlob(page));
});
