import { test, expect } from "@playwright/test";

/**
 * Appearance settings (Wave 5 s232) — theme + radius/motion/density controls
 * that drive documentElement CSS vars live. The persist PATCH is mocked so the
 * test doesn't mutate the gateway config.
 */
test.describe("Appearance settings", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/config", (route) => {
      if (route.request().method() === "PATCH") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      return route.continue();
    });
  });

  test("loads with theme + radius/motion/density controls", async ({ page }) => {
    await page.goto("/settings/appearance");
    await expect(page.getByTestId("settings-appearance-page")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("appearance-themes")).toBeVisible();
    await expect(page.getByTestId("appearance-radius")).toBeVisible();
    await expect(page.getByTestId("appearance-motion")).toBeVisible();
    await expect(page.getByTestId("appearance-density")).toBeVisible();
    await expect(page.getByTestId("appearance-reduce-motion")).toBeVisible();
  });

  test("selecting a radius preset updates --radius-scale on documentElement", async ({ page }) => {
    await page.goto("/settings/appearance");
    await expect(page.getByTestId("appearance-radius")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("appearance-radius").getByRole("button", { name: "Sharp" }).click();
    const scale = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--radius-scale").trim(),
    );
    expect(scale).toBe("0.6");
  });
});
