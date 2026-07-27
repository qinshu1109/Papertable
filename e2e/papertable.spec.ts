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

async function importReadOnlyFixture(page: import("@playwright/test").Page) {
  // `page.goto()` only guarantees document load. Wait for React's shell before
  // deciding whether this viewport has the mobile drawer; otherwise an early
  // zero-count can skip opening the drawer and try to tap its off-canvas item.
  await expect(page.getByRole("textbox", { name: "提问输入框" })).toBeVisible();
  const drawer = page.getByRole("button", { name: "打开项目抽屉" });
  if (await drawer.isVisible()) {
    await drawer.click();
    const drawerPanel = page.getByRole("dialog", { name: "项目栏" });
    await expect(drawerPanel).toBeVisible();
    await expect(
      drawerPanel.getByRole("button", { name: "导入笔记" }),
    ).toBeInViewport();
  }
  await page.getByRole("button", { name: "导入笔记" }).click();
  const dialog = page.getByRole("dialog", { name: "导入笔记" });
  await dialog.getByRole("button", { name: "建立只读资料库" }).click();
  await dialog
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "验收资料/海蓝计划.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(`# 海蓝计划

唯一事实：海蓝计划的内部代号是 ORBIT-97。

这份资料只用于只读 Harness 验收。`),
    });
  await dialog.getByRole("button", { name: /导入 1 个文件/ }).click();
  await expect(page.getByText(/已建立只读资料库：1 篇笔记/)).toBeVisible();
}

async function seedLongAnswer(page: import("@playwright/test").Page) {
  const content =
    "# 一段用于长文阅读器验收的回答\n\n" +
    "这段文字用于确认普通卡片只保留轻量预览，而完整 Markdown 会在分页阅读器中打开。\n\n".repeat(
      180,
    );
  await page.evaluate(async (answer) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("papertable-web-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["turns", "view"], "readwrite");
      const viewRequest = tx.objectStore("view").get("main");
      viewRequest.onsuccess = () => {
        const cardId = viewRequest.result?.currentCardId;
        if (!cardId) return tx.abort();
        tx.objectStore("turns").put({
          id: "e2e-long-answer",
          cardId,
          role: "ai",
          content: answer,
          createdAt: Date.now() + 1,
          status: "complete",
        });
      };
      viewRequest.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("无法写入长回答夹具"));
    });
    db.close();
  }, content);
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

test("an empty project pauses the composer until a fresh root card is created", async ({
  page,
}) => {
  const modelRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/llm/stream"))
      modelRequests.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目" }).click();
  // The prior card may still be in Framer Motion's short exit animation;
  // operate on the newly current card rather than treating the transient
  // exiting DOM as a second actionable card.
  await page.getByTitle("卡片菜单").last().click();
  await page.getByRole("button", { name: "删除卡片及下游" }).click();

  await expect(
    page.getByRole("heading", { name: "项目暂时没有可用卡片" }),
  ).toBeVisible();
  const composer = page.getByRole("textbox", { name: "提问输入框" });
  await expect(composer).toBeDisabled();
  await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();
  await expect(page.getByText("在此之前不会发送模型请求")).toBeVisible();
  expect(modelRequests).toHaveLength(0);

  await page.getByRole("button", { name: "新建根卡片" }).click();
  await expect(
    page.getByRole("heading", { name: "未命名卡片", exact: true }),
  ).toBeVisible();
  await expect(composer).toBeEnabled();
  expect(modelRequests).toHaveLength(0);
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

test("mobile drawer actions close the drawer before opening a modal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "提问输入框" })).toBeVisible();

  const drawerButton = page.getByRole("button", { name: "打开项目抽屉" });
  const sidebar = page.locator(".sidebar");
  const openDrawer = async () => {
    await drawerButton.click();
    await expect(sidebar).toHaveClass(/drawer-open/);
  };

  for (const [action, dialog] of [
    ["导入笔记", "导入笔记"],
    ["导出项目", "导出项目"],
    ["设置", "设置"],
  ] as const) {
    await openDrawer();
    await page.getByRole("button", { name: action }).click();
    await expect(page.getByRole("dialog", { name: dialog })).toBeVisible();
    await expect(sidebar).not.toHaveClass(/drawer-open/);
    await page.keyboard.press("Escape");
  }
});

test("concepts open as four independent temporary cards without replacing each other", async ({
  page,
}) => {
  await page.goto("/");
  const openConcept = async (term: string) => {
    await page
      .locator(".concept-term")
      .filter({ hasText: term })
      .first()
      .click({ force: true });
  };

  await openConcept("希尔伯特空间");
  await expect(page.locator(".concept-pop")).toHaveCount(1);
  await openConcept("玻恩规则");
  await expect(page.locator(".concept-pop")).toHaveCount(2);
  await openConcept("量子退相干");
  await expect(page.locator(".concept-pop")).toHaveCount(3);

  // 同一概念只把旧窗口置顶，不创建第五份状态。
  await openConcept("希尔伯特空间");
  await expect(page.locator(".concept-pop")).toHaveCount(3);

  await openConcept("厄米算符");
  await expect(page.locator(".concept-pop")).toHaveCount(4);
  await openConcept("波函数");
  await expect(
    page.getByText("最多同时打开 4 张临时卡片，先收起或关闭一张"),
  ).toBeVisible();
  await expect(page.locator(".concept-pop")).toHaveCount(4);

  const hilbert = page.getByRole("dialog", {
    name: /概念解释：希尔伯特空间/,
  });
  await hilbert.getByRole("button", { name: "最小化临时卡片" }).click();
  await expect(
    page.getByLabel("已最小化的临时卡片").getByText("希尔伯特空间"),
  ).toBeVisible();
  await page
    .getByLabel("已最小化的临时卡片")
    .getByTitle("恢复「希尔伯特空间」")
    .click();
  await expect(hilbert).toBeVisible();
  await expect(hilbert).toContainText("不会进入主会话");
  expect(
    await hilbert.evaluate((element) => getComputedStyle(element).borderStyle),
  ).toBe("dashed");
});

test("temporary follow-ups stay out of IndexedDB until an explicit reference or promotion", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("article")).toBeVisible();
  await page.waitForTimeout(200);
  const before = await workspaceCounts(page);
  const referencesBefore = await page.locator(".ref-strip .ref-chip").count();
  await page
    .locator(".concept-term")
    .filter({ hasText: "量子退相干" })
    .first()
    .click();
  const temp = page.getByRole("dialog", { name: /概念解释：量子退相干/ });
  await expect(temp).toContainText("退相干描述的是相位相干性");
  await temp
    .getByRole("textbox", { name: "追问概念：量子退相干" })
    .fill("它与测量坍缩有什么区别？");
  await temp.getByRole("button", { name: "发送临时追问" }).click();
  await expect(temp.getByText("这是本地验收用的流式回答")).toBeVisible();
  await page.waitForTimeout(700);

  const afterFollowup = await workspaceCounts(page);
  expect(afterFollowup.turns).toHaveLength(before.turns.length);

  await temp.getByRole("button", { name: "带入当前探索" }).click();
  await expect(page.locator(".ref-strip .ref-chip")).toHaveCount(
    referencesBefore + 1,
  );
  const afterReference = await workspaceCounts(page);
  expect(afterReference.turns).toHaveLength(before.turns.length);

  await temp.getByRole("button", { name: "关闭临时卡片" }).click();
  await expect(temp).toHaveCount(0);
});

test("composer grows vertically and restores a separate in-memory draft per card", async ({
  page,
}) => {
  await page.goto("/");
  const textarea = page.getByRole("textbox", { name: "提问输入框" });
  const firstDraft = "长".repeat(1_200);
  await textarea.fill(firstDraft);
  const metrics = await textarea.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(metrics.clientHeight).toBeGreaterThan(40);
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.overflowY).toBe("auto");

  await page.getByRole("button", { name: /^打开量子退相干，/ }).click();
  await expect(textarea).toHaveValue("");
  await textarea.fill("另一张卡片的草稿");
  await page.getByRole("button", { name: /^打开波函数，/ }).click();
  await expect(textarea).toHaveValue(firstDraft);
});

test("long answers stay lightweight in the card and open a paginated full reader", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "提问输入框" })).toBeVisible();
  await seedLongAnswer(page);
  await page.reload();

  const openReader = page.getByRole("button", { name: /查看完整内容/ });
  await expect(openReader).toBeVisible();
  await openReader.click();
  const reader = page.getByRole("dialog", { name: /完整回答/ });
  await expect(reader).toContainText("每页最多 4,000 字");
  const firstPageText = await reader.locator(".long-turn-body").innerText();
  expect(Array.from(firstPageText).length).toBeLessThanOrEqual(4_000);
  await reader.getByRole("button", { name: "下一页" }).click();
  await expect(reader).toContainText("第 2 /");
  await reader.getByRole("button", { name: "复制完整内容" }).click();
  await expect(reader.getByText("已复制完整内容")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reader).toHaveCount(0);
  await expect(openReader).toBeFocused();
});

test("title editing shows the Unicode limit and never saves a truncated title", async ({
  page,
}) => {
  await page.goto("/");
  const title = page.locator(".card-title");
  await title.dblclick();
  const input = page.getByRole("textbox", { name: "编辑卡片标题" });
  await input.fill("😀".repeat(81));
  await expect(page.getByRole("alert")).toContainText("标题最多 80 个字符");
  await input.press("Enter");
  await expect(input).toBeVisible();

  const validTitle = "😀".repeat(80);
  await input.fill(validTitle);
  await input.press("Enter");
  await expect(title).toHaveText(validTitle);
  expect(
    await title.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
});

test("compact desktop composer keeps controls and popovers inside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/");
  const contextButton = page.getByRole("button", { name: /本次上下文/ });
  await expect(contextButton).toBeVisible();
  const layout = await page.locator(".composer-control-row").evaluate((row) => {
    const controls = Array.from(row.querySelectorAll("button"))
      .map((button) => button.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map(({ left, top, right, bottom }) => ({ left, top, right, bottom }));
    const overlaps = controls.some((first, index) =>
      controls
        .slice(index + 1)
        .some(
          (second) =>
            first.left < second.right &&
            first.right > second.left &&
            first.top < second.bottom &&
            first.bottom > second.top,
        ),
    );
    const rect = row.getBoundingClientRect();
    return {
      overlaps,
      inBounds: rect.left >= 0 && rect.right <= innerWidth,
    };
  });
  expect(layout.overlaps).toBe(false);
  expect(layout.inBounds).toBe(true);

  await contextButton.click();
  const panel = page.getByRole("dialog", { name: "本次上下文" });
  await expect(panel).toBeVisible();
  expect(
    await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= innerWidth &&
        rect.bottom <= innerHeight
      );
    }),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(contextButton).toBeFocused();

  const settings = page.getByRole("button", { name: "设置", exact: true });
  await settings.click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
});

test("rapid double-clicking send starts one model run", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "提问输入框" })).toBeVisible();
  const before = await workspaceCounts(page);
  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("快速双击发送只能触发一次。");
  await page.getByRole("button", { name: "发送" }).dblclick();
  await expect
    .poll(async () => (await workspaceCounts(page)).turns.length)
    .toBe(before.turns.length + 2);
  await page.waitForTimeout(650);
  expect((await workspaceCounts(page)).turns).toHaveLength(
    before.turns.length + 2,
  );
});

test("390px uses a tabbed temporary-card sheet and a collapsible handle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const concepts = page.locator(".concept-term");
  await concepts.filter({ hasText: "希尔伯特空间" }).first().click();
  let sheet = page.locator(".temp-sheet:visible");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "收起临时卡片" }).click();
  await concepts.filter({ hasText: "玻恩规则" }).first().click();
  sheet = page.locator(".temp-sheet:visible");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("tab")).toHaveCount(2);
  await sheet.getByRole("button", { name: "收起临时卡片" }).click();
  await expect(
    page.getByRole("button", { name: "展开 2 张临时卡片" }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "更多输入设置" }).click();
  await page.getByRole("button", { name: /回答依据：通用探索/ }).click();
  await page.getByRole("button", { name: "更多输入设置" }).click();
  await expect(
    page.getByRole("button", { name: /回答依据：仅依据材料/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
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

test("sources-only root cards refuse locally instead of sending an unsupported request", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/llm/stream")) requests.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("button", { name: /回答依据：通用探索/ }).click();
  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("没有提供材料时，这个问题的答案是什么？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(
    page.getByText(/不会在“仅依据材料”模式下补充无来源结论/),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
});

test("workspace becomes interactive only after hydration and a new project survives refresh", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /CozAI · papertable-test-model/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "新建项目" }).click();
  await expect(
    page.getByRole("heading", { name: "未命名卡片", exact: true }),
  ).toBeVisible();
  // 自动保存的正常节流窗口；这不是为了掩盖水合竞争，而是确认已开放的工作区
  // 会把正常用户操作写入 IndexedDB。
  await page.waitForTimeout(220);

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "未命名卡片", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "提问输入框" })).toBeVisible();
});

test("a read-only library uses bounded tools, renders a controlled citation, and refuses missing evidence", async ({
  page,
}) => {
  const streams: Array<{
    messages?: Array<{ role?: string; content?: string }>;
    tools?: unknown[];
  }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/llm/stream"))
      streams.push(request.postDataJSON());
  });
  await page.goto("/");
  // Use an empty project so the sources-only half of this test does not get
  // unrelated demo references as legitimate frozen evidence.
  await page.getByRole("button", { name: "新建项目" }).click();
  await importReadOnlyFixture(page);

  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("海蓝计划的内部代号是什么？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("我已阅读本轮检索到的资料")).toBeVisible();
  await expect(page.getByLabel("笔记引用")).toBeVisible();
  await expect.poll(() => streams.length).toBe(3);
  expect(streams[0]?.tools).toHaveLength(2);
  expect(
    streams
      .slice(1)
      .some((request) =>
        request.messages?.some((message) => message.role === "tool"),
      ),
  ).toBe(true);

  await page.getByLabel("笔记引用").getByRole("button").click();
  const source = page.getByRole("dialog", { name: /笔记来源：海蓝计划/ });
  await expect(source).toContainText("ORBIT-97");
  await expect(source).toContainText("不会进入主会话");
  await source.getByRole("button", { name: "关闭来源卡" }).click();

  await page.getByRole("button", { name: /回答依据：通用探索/ }).click();
  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("资料库里没有出现的赤霄项目代号是什么？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(
    page.getByText("在已绑定的只读资料库中没有找到足够证据"),
  ).toBeVisible();
});

test("390px keeps read-only Harness citations reachable without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await importReadOnlyFixture(page);
  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("海蓝计划的内部代号是什么？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByLabel("笔记引用")).toBeVisible();
  expect(
    await page
      .locator("html")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
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

test("switching projects keeps the first answer running and allows a second generation", async ({
  page,
}) => {
  const chatRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/llm/stream"))
      chatRequests.push(request.postData() ?? "");
  });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("停止测试：请在后台继续生成");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("第一句已经完成")).toBeVisible();

  await page
    .getByRole("button", { name: "AI Agent 的上下文管理", exact: true })
    .click();
  await expect(page.getByLabel("量子计算机与极低温正在后台生成")).toBeVisible();
  await expect(page.getByLabel(/另有 1 张卡片正在后台生成/)).toBeVisible();

  await page
    .getByRole("textbox", { name: "提问输入框" })
    .fill("第二个项目可以同时继续提问吗？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect.poll(() => chatRequests.length).toBe(2);
  await expect(page.getByText("这是本地验收用的流式回答")).toBeVisible();

  await expect(page.getByLabel("量子计算机与极低温正在后台生成")).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "量子计算机与极低温", exact: true })
    .click();
  await expect(page.getByText(/后面还有很长的内容/).first()).toBeVisible();
  await expect(page.getByText(/^已停止/)).toHaveCount(0);
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
  // 真机上泄漏的那两句：普通说明文英语，任何短语枚举都识别不了，
  // 只有哨兵能把它挡在正文之外。
  "The core issue is that qubits",
  "I'm thinking of it like",
  // 哨兵本身也不能出现在用户看到的内容里。
  "PAPERTABLE_ANSWER",
];

/** 全量序列化持久状态：草稿不得藏在任何独立字段里。 */
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

/**
 * 真机上失效的正是这一条：推理是普通说明文英语，与正文之间连换行都没有。
 * 旧的短语枚举一条都没命中，passthrough 闩锁又把一次漏判放大成全量泄漏。
 */
test("gateway drafts are neither displayed nor persisted", async ({ page }) => {
  await askInNewProject(page, "思考分道：解释量子退相干");
  await expect(page.getByText("量子退相干是指系统与环境纠缠")).toBeVisible();

  // 正文区绝不能出现推理，也不能出现哨兵；UI 中也不存在可展开的草稿区。
  const article = page.getByRole("article");
  await expect(article).not.toContainText("internal plan the gateway");
  await expect(article).not.toContainText("PAPERTABLE_ANSWER");
  await expect(page.locator(".reasoning-head")).toHaveCount(0);

  await page.waitForTimeout(700);
  const state = await workspaceCounts(page);
  const turns = state.turns as Record<string, unknown>[];
  expect(
    turns.some((turn) => "reasoning" in turn),
    "草稿不得以独立字段落进 IndexedDB",
  ).toBe(false);
  expectClean(await persistedBlob(page));
});

test("without a sentinel the answer still arrives, just at the end", async ({
  page,
}) => {
  await askInNewProject(page, "无哨兵：随便问问");
  await expect(page.getByText("这是没有哨兵的散文回答")).toBeVisible();
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
