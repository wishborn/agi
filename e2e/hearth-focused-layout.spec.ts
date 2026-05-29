import { test, expect } from "@playwright/test";

/**
 * HearthFocusedLayout e2e tests.
 *
 * Verifies the 38/62 split layout on /projects/:slug and /comms/* routes:
 * HearthChatPane on the left, canvas content on the right.
 * Back button returns to HearthHome. Non-focused routes remain unaffected.
 *
 * s198 — Focused canvas state.
 */

test.describe("HearthFocusedLayout", () => {
  test("focused layout activates when navigating to a project", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");

    const cards = page.getByTestId("project-card");
    const cardCount = await cards.count();
    if (cardCount === 0) {
      test.skip();
      return;
    }
    await cards.first().click();
    await expect(page).toHaveURL(/\/projects\/[a-z0-9_\-]+/);
    await expect(page.getByTestId("hearth-focused-layout")).toBeVisible();
  });

  test("HearthChatPane is visible on project detail route", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");

    const cards = page.getByTestId("project-card");
    if (await cards.count() === 0) { test.skip(); return; }
    await cards.first().click();
    await expect(page.getByTestId("hearth-chat-pane")).toBeVisible();
  });

  test("HearthChatPane has back button on project route", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");

    const cards = page.getByTestId("project-card");
    if (await cards.count() === 0) { test.skip(); return; }
    await cards.first().click();
    await expect(page.getByTestId("hearth-back-button")).toBeVisible();
  });

  test("context title shows project name in left pane", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");

    const cards = page.getByTestId("project-card");
    if (await cards.count() === 0) { test.skip(); return; }
    await cards.first().click();
    // Context title must be non-empty after navigation
    const title = page.getByTestId("hearth-context-title");
    await expect(title).toBeVisible();
    const text = await title.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test("canvas renders ProjectDetail content on project route", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");

    const cards = page.getByTestId("project-card");
    if (await cards.count() === 0) { test.skip(); return; }
    await cards.first().click();
    await expect(page.getByTestId("hearth-canvas")).toBeVisible();
    // ProjectDetail has a mode picker — verify canvas renders it
    await expect(page.getByTestId("project-mode-picker")).toBeVisible({ timeout: 6000 });
  });

  test("back button returns to HearthHome", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");

    const cards = page.getByTestId("project-card");
    if (await cards.count() === 0) { test.skip(); return; }
    await cards.first().click();
    await expect(page.getByTestId("hearth-back-button")).toBeVisible();
    await page.getByTestId("hearth-back-button").click();
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("hearth-home")).toBeVisible();
  });

  test("focused layout activates on /comms/discord", async ({ page }) => {
    await page.goto("/comms/discord");
    await expect(page.getByTestId("hearth-focused-layout")).toBeVisible();
  });

  test("HearthChatPane is visible on /comms/discord", async ({ page }) => {
    await page.goto("/comms/discord");
    await expect(page.getByTestId("hearth-chat-pane")).toBeVisible();
  });

  test("comms chat pane shows channel name as context title", async ({ page }) => {
    await page.goto("/comms/discord");
    const title = page.getByTestId("hearth-context-title");
    await expect(title).toBeVisible();
    await expect(title).toHaveText("Discord");
  });

  test("comms back button returns to HearthHome", async ({ page }) => {
    await page.goto("/comms/discord");
    await page.getByTestId("hearth-back-button").click();
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("hearth-home")).toBeVisible();
  });

  test("no focused layout on /settings routes", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("hearth-focused-layout")).toHaveCount(0);
    await expect(page.getByTestId("hearth-home")).toHaveCount(0);
  });

  test("no focused layout on /system routes", async ({ page }) => {
    await page.goto("/system/security");
    await expect(page.getByTestId("hearth-focused-layout")).toHaveCount(0);
  });

  test("/projects list page does not trigger focused layout", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByTestId("hearth-focused-layout")).toHaveCount(0);
  });

  test("HearthTop is still visible on focused routes", async ({ page }) => {
    await page.goto("/comms/discord");
    await expect(page.getByTestId("hearth-top")).toBeVisible();
  });

  test("pane composer accepts text on project route", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");

    const cards = page.getByTestId("project-card");
    if (await cards.count() === 0) { test.skip(); return; }
    await cards.first().click();
    const composer = page.getByTestId("hearth-pane-composer");
    await expect(composer).toBeVisible();
    await composer.fill("run tests");
    await expect(composer).toHaveValue("run tests");
  });
});
