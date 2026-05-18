import { test, expect } from "@playwright/test";

/**
 * Sidebar navigation and route redirect e2e tests.
 *
 * Locator strategy: Sidebar.Item (react-fancy) does NOT forward data-testid
 * to the DOM. All nav-item clicks use sidebar.getByRole("button", { name })
 * scoped to the app-sidebar wrapper. Section labels (Sidebar.Group) render
 * as paragraph elements — checked via getByText within the sidebar scope.
 */

test.describe("Sidebar Navigation", () => {
  test("sidebar is visible with main-mode sections", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.getByTestId("app-sidebar");
    await expect(sidebar).toBeVisible();

    // Sidebar.Group renders section labels as <p class="...uppercase..."> elements.
    // Use locator("p.uppercase") to target section headers specifically — avoids
    // substring collisions where nav items share words with section titles.
    await expect(sidebar.locator("p.uppercase", { hasText: "Overview" })).toBeVisible();
    await expect(sidebar.locator("p.uppercase", { hasText: "Projects" })).toBeVisible();
    await expect(sidebar.locator("p.uppercase", { hasText: "MagicApps" })).toBeVisible();
    await expect(sidebar.locator("p.uppercase", { hasText: "Communication" })).toBeVisible();
    await expect(sidebar.locator("p.uppercase", { hasText: "Knowledge" })).toBeVisible();

    // Admin sections must not appear in main mode
    await expect(sidebar.locator("p.uppercase", { hasText: "Gateway" })).toHaveCount(0);
    await expect(sidebar.locator("p.uppercase", { hasText: "System" })).toHaveCount(0);
  });

  test("admin mode shows admin sections when at admin URL", async ({ page }) => {
    await page.goto("/gateway/logs");
    const sidebar = page.getByTestId("app-sidebar");

    await expect(sidebar.locator("p.uppercase", { hasText: "Marketplace" })).toBeVisible();
    await expect(sidebar.locator("p.uppercase", { hasText: "Gateway" })).toBeVisible();
    await expect(sidebar.locator("p.uppercase", { hasText: "System" })).toBeVisible();

    // Main-mode section labels absent in admin mode (MagicApps still appears as
    // a nav item under Marketplace, but NOT as a section label <p.uppercase>)
    await expect(sidebar.locator("p.uppercase", { hasText: "Projects" })).toHaveCount(0);
    await expect(sidebar.locator("p.uppercase", { hasText: "MagicApps" })).toHaveCount(0);
  });

  test("clicking main-mode nav items navigates correctly", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.getByTestId("app-sidebar");

    await sidebar.getByRole("button", { name: "COA Explorer" }).click();
    await expect(page).toHaveURL("/coa");

    await sidebar.getByRole("button", { name: "All Projects" }).click();
    await expect(page).toHaveURL("/projects");

    await sidebar.getByRole("button", { name: "All Messages" }).click();
    await expect(page).toHaveURL("/comms");

    // Dashboard item has exact: true — navigates back to root
    await sidebar.getByRole("button", { name: "Dashboard" }).click();
    await expect(page).toHaveURL("/");
  });

  test("Admin button switches to admin mode and navigates to /admin", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.getByTestId("app-sidebar");
    await sidebar.getByRole("button", { name: "Admin" }).click();
    await expect(page).toHaveURL("/admin");
    await expect(sidebar.getByText("Gateway")).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  });

  test("Back button from admin mode returns to main mode", async ({ page }) => {
    await page.goto("/admin");
    const sidebar = page.getByTestId("app-sidebar");
    await expect(sidebar.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    await sidebar.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(sidebar.locator("p.uppercase", { hasText: "Projects" })).toBeVisible();
  });

  test("catch-all redirects unknown URLs to home", async ({ page }) => {
    await page.goto("/nonexistent-page");
    // PluginPageResolver shows loading then redirects home when no plugin matches
    await expect(page).toHaveURL("/", { timeout: 5000 });
  });

  test("chat button in header opens ChatFlyout", async ({ page }) => {
    await page.goto("/");
    const chatButton = page.getByTestId("header-chat-button");
    await expect(chatButton).toBeVisible();
    await chatButton.click();
    await expect(chatButton).toHaveClass(/bg-primary/);
  });
});

test.describe("Settings Navigation", () => {
  test("Settings item in admin sidebar navigates to settings", async ({ page }) => {
    // Navigate to an admin URL first so sidebar is in admin mode
    await page.goto("/gateway/logs");
    const sidebar = page.getByTestId("app-sidebar");
    // Settings is the last item in System section → /settings → redirects to /settings/gateway
    await sidebar.getByRole("button", { name: "Settings" }).click();
    await expect(page).toHaveURL("/settings/gateway");
  });

  test("/settings redirects to /settings/gateway", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL("/settings/gateway");
  });

  test("old /gateway/settings redirects to /settings/gateway", async ({ page }) => {
    await page.goto("/gateway/settings");
    await expect(page).toHaveURL("/settings/gateway");
  });
});

test.describe("Gateway Section", () => {
  test("Plugins link in admin sidebar navigates to marketplace", async ({ page }) => {
    await page.goto("/gateway/logs");
    const sidebar = page.getByTestId("app-sidebar");
    // "Plugins" is the Marketplace section item → /gateway/marketplace (direct, no redirect needed)
    await sidebar.getByRole("button", { name: "Plugins" }).click();
    await expect(page).toHaveURL("/gateway/marketplace");
  });

  test("Marketplace page shows Browse/Installed/Sources tabs", async ({ page }) => {
    await page.goto("/gateway/marketplace");
    // role="tablist" + role="tab" added to marketplace.tsx tab bar to scope away from
    // sidebar "Resources" button (substring "Sources" ⊂ "Resources" without scoping)
    const tablist = page.getByRole("tablist");
    await expect(tablist.getByRole("tab", { name: "Browse" })).toBeVisible();
    await expect(tablist.getByRole("tab", { name: "Installed" })).toBeVisible();
    await expect(tablist.getByRole("tab", { name: "Sources" })).toBeVisible();
  });
});

test.describe("Communication Section", () => {
  test("Communication section links navigate correctly", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.getByTestId("app-sidebar");

    await sidebar.getByRole("button", { name: "All Messages" }).click();
    await expect(page).toHaveURL("/comms");

    await sidebar.getByRole("button", { name: "Pending Identity" }).click();
    await expect(page).toHaveURL("/identity/pending");
  });
});

test.describe("Knowledge Section", () => {
  test("Knowledge section links navigate correctly", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.getByTestId("app-sidebar");

    await sidebar.getByRole("button", { name: "Browse" }).click();
    await expect(page).toHaveURL("/knowledge");

    await sidebar.getByRole("button", { name: "Documentation" }).click();
    await expect(page).toHaveURL("/docs");
  });
});

test.describe("Old Route Redirects", () => {
  test("/system/plugins redirects to /gateway/marketplace", async ({ page }) => {
    await page.goto("/system/plugins");
    await expect(page).toHaveURL("/gateway/marketplace");
  });

  test("/system/logs redirects to /gateway/logs", async ({ page }) => {
    await page.goto("/system/logs");
    await expect(page).toHaveURL("/gateway/logs");
  });

  test("/system/settings redirects to /settings/gateway", async ({ page }) => {
    await page.goto("/system/settings");
    await expect(page).toHaveURL("/settings/gateway");
  });

  test("/system/comms redirects to /comms", async ({ page }) => {
    await page.goto("/system/comms");
    await expect(page).toHaveURL("/comms");
  });
});
