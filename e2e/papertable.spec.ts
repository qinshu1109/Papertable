import { expect, test } from "@playwright/test";

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

test("a prior-day signal becomes a ghost branch without an extra model call, then materializes on demand", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /CozAI · papertable-test-model/ }),
  ).toBeVisible();

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

  const modelRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/llm/stream"))
      modelRequests.push(request.url());
  });
  await page.reload();
  const morning = page.getByLabel("次日探索提示");
  await expect(morning).toBeVisible();
  expect(modelRequests).toHaveLength(0);
  await morning.getByRole("button", { name: "查看幽灵分支" }).click();
  const tray = page.getByRole("dialog", { name: "幽灵分支" });
  await expect(tray).toContainText("人类行为信号");
  await tray.getByRole("button", { name: "开始探索" }).click();
  await expect(page.getByText("这是本地验收用的流式回答")).toBeVisible();
  expect(modelRequests.length).toBeGreaterThanOrEqual(1);

  // The materialized card remains ordinary UI and can immediately receive a
  // second strong signal, which is the experiment's success metric.
  await page.locator(".card-head-actions .icon-btn").first().click();
});
