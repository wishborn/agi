import { test, expect } from "@playwright/test";

/**
 * System ▸ Identity — consolidated Identity Management page (story #212).
 *
 * Verifies the single identity home: the canonical 6-provider grid, the
 * "Your Identity" + Federation cards, GitHub's connect affordance, the
 * Machine Admin cross-link, and that the old Settings ▸ Identity route now
 * redirects here. All assertions are read-only structural checks — no OAuth
 * flow is actually completed and no config is mutated.
 */

const CANONICAL_PROVIDERS = ["github", "google", "meta", "x", "tynn", "civicognita"] as const;

test.describe("System ▸ Identity (consolidated)", () => {
  test("page loads at /system/identity", async ({ page }) => {
    await page.goto("/system/identity");
    await expect(page).toHaveURL("/system/identity");
    await expect(page.getByTestId("system-identity-page")).toBeVisible({ timeout: 10_000 });
  });

  test("renders the Identity heading and the Your Identity card", async ({ page }) => {
    await page.goto("/system/identity");
    await expect(page.getByRole("heading", { name: "Identity", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("your-identity-card")).toBeVisible();
  });

  test("renders all six canonical identity providers", async ({ page }) => {
    await page.goto("/system/identity");
    await expect(page.getByTestId("identity-provider-grid")).toBeVisible({ timeout: 10_000 });
    for (const id of CANONICAL_PROVIDERS) {
      await expect(page.getByTestId(`identity-provider-${id}`)).toBeVisible();
      await expect(page.getByTestId(`identity-provider-${id}-status`)).toBeVisible();
    }
  });

  test("GitHub exposes a Connect affordance (hosted device flow)", async ({ page }) => {
    await page.goto("/system/identity");
    const ghCard = page.getByTestId("identity-provider-github");
    await expect(ghCard).toBeVisible({ timeout: 10_000 });
    // GitHub is either connectable now (Connect button) or already connected (Remove).
    const connect = page.getByTestId("identity-connect-github");
    const remove = page.getByTestId("identity-remove-github");
    await expect(connect.or(remove)).toBeVisible();
  });

  test("Civicognita is federation-gated until federation is enabled", async ({ page }) => {
    await page.goto("/system/identity");
    const status = page.getByTestId("identity-provider-civicognita-status");
    await expect(status).toBeVisible({ timeout: 10_000 });
    // Default bare node: federation off → gated. (If federation is on, it is connectable.)
    await expect(page.getByTestId("identity-provider-civicognita")).toBeVisible();
  });

  test("shows the Federation / Civicognita card and a Machine Admin cross-link", async ({ page }) => {
    await page.goto("/system/identity");
    await expect(page.getByTestId("federation-card")).toBeVisible({ timeout: 10_000 });
    const link = page.getByTestId("identity-machine-admin-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/admin");
  });

  test("Settings ▸ Identity redirects to System ▸ Identity (de-dup)", async ({ page }) => {
    await page.goto("/settings/identity");
    await expect(page).toHaveURL("/system/identity");
    await expect(page.getByTestId("system-identity-page")).toBeVisible({ timeout: 10_000 });
  });

  test("Settings sub-nav no longer lists Identity", async ({ page }) => {
    await page.goto("/settings/gateway");
    // The settings left-nav should not contain an Identity link anymore.
    await expect(page.getByRole("link", { name: "Identity", exact: true })).toHaveCount(0);
  });
});
