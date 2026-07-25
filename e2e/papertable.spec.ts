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
