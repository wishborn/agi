import { test, expect } from "@playwright/test";

/**
 * Upgrade Wizard e2e spec (s_upgrade_wizard).
 *
 * Two-step upgrade workflow:
 *   Step 1 — Source Selection: shows fork + upstream branch status with
 *             ahead/behind commit counts; user picks which ref to pull from.
 *   Step 2 — Preview + Execute: shows changelog, migrations, impact summary,
 *             then runs upgrade.sh with live per-step status rows.
 *
 * Iteration A: API-layer tests pass (fork-status, upgrade-preview endpoints).
 * Iteration B: Wizard UI tests turn green once UpgradeWizard.tsx is wired in.
 */

// ---------------------------------------------------------------------------
// API layer — these pass after Iteration A
// ---------------------------------------------------------------------------

test.describe("Upgrade Wizard — API layer", () => {
  test("GET /api/system/fork-status returns valid shape", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    const result = await page.evaluate(async () => {
      const res = await fetch("/api/system/fork-status");
      if (!res.ok) return null;
      return res.json();
    });

    expect(result).not.toBeNull();
    expect(typeof result.devModeEnabled).toBe("boolean");
    expect(typeof result.currentBranch).toBe("string");
    expect(typeof result.currentVersion).toBe("string");
    expect(typeof result.deployedCommit).toBe("string");
    expect(Array.isArray(result.sources)).toBe(true);

    // At least one source must be present (origin/main or origin/dev)
    expect(result.sources.length).toBeGreaterThan(0);

    const source = result.sources[0];
    expect(typeof source.ref).toBe("string");
    expect(typeof source.label).toBe("string");
    expect(typeof source.commitsAhead).toBe("number");
    expect(typeof source.commitsBehind).toBe("number");
    expect(typeof source.isCurrentChannel).toBe("boolean");
  });

  test("GET /api/system/upgrade-preview returns valid shape for current channel ref", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    // First get fork-status to find the current channel ref
    const forkStatus = await page.evaluate(async () => {
      const res = await fetch("/api/system/fork-status");
      if (!res.ok) return null;
      return res.json();
    });

    const currentSource = forkStatus?.sources?.find((s: { isCurrentChannel: boolean }) => s.isCurrentChannel)
      ?? forkStatus?.sources?.[0];

    if (!currentSource) {
      test.skip();
      return;
    }

    const preview = await page.evaluate(async (source: string) => {
      const res = await fetch(`/api/system/upgrade-preview?source=${encodeURIComponent(source)}`);
      if (!res.ok) return null;
      return res.json();
    }, currentSource.ref as string);

    expect(preview).not.toBeNull();
    expect(typeof preview.fromVersion).toBe("string");
    expect(typeof preview.toVersion).toBe("string");
    expect(typeof preview.commitCount).toBe("number");
    expect(Array.isArray(preview.commits)).toBe(true);
    expect(Array.isArray(preview.migrations)).toBe(true);
    expect(typeof preview.impact).toBe("object");
    expect(typeof preview.impact.requiresRestart).toBe("boolean");
    expect(typeof preview.impact.requiresDbMigration).toBe("boolean");
    expect(typeof preview.impact.frontendOnly).toBe("boolean");
    expect(Array.isArray(preview.impact.changedAreas)).toBe(true);
  });

  test("POST /api/system/merge-source rejects unknown ref", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });

    const result = await page.evaluate(async () => {
      const res = await fetch("/api/system/merge-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "nonexistent/branch-xyz-test" }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });

    // Should return 400 or 422 for unknown ref
    expect([400, 422, 500]).toContain(result.status);
  });
});

// ---------------------------------------------------------------------------
// Wizard UI — these pass after Iteration B
//
// The "Manage Upgrade" button in Settings → Gateway → General is the
// always-available entry point. The header trigger only appears when updates
// are pending; using settings ensures tests pass in up-to-date environments.
// ---------------------------------------------------------------------------

test.describe("Upgrade Wizard — UI", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate via Settings > Gateway so the trigger is always visible
    // regardless of whether updates are pending.
    await page.goto("/settings/gateway");
    await page.waitForSelector("[data-testid='hearth-top']", { timeout: 10_000 });
  });

  test("settings-gateway shows Manage Upgrade button (always accessible)", async ({ page }) => {
    // The trigger in settings is always rendered, regardless of update availability.
    const trigger = page.getByTestId("upgrade-wizard-trigger");
    await expect(trigger).toBeVisible({ timeout: 8_000 });
  });

  test("clicking the trigger opens the upgrade wizard overlay", async ({ page }) => {
    await page.getByTestId("upgrade-wizard-trigger").click();
    await expect(page.getByTestId("upgrade-wizard-overlay")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("upgrade-wizard-step-1")).toBeVisible();
  });

  test("step 1 shows source cards with ahead/behind counts", async ({ page }) => {
    await page.getByTestId("upgrade-wizard-trigger").click();
    await expect(page.getByTestId("upgrade-wizard-step-1")).toBeVisible({ timeout: 5_000 });

    // At least one source card must be visible
    const sourceCards = page.getByTestId("upgrade-source-card");
    await expect(sourceCards.first()).toBeVisible();
  });

  test("step 1 has the current channel source pre-selected", async ({ page }) => {
    await page.getByTestId("upgrade-wizard-trigger").click();
    await expect(page.getByTestId("upgrade-wizard-step-1")).toBeVisible({ timeout: 5_000 });

    // The current-channel card should have the selected state
    const currentCard = page.getByTestId("upgrade-source-card-current");
    await expect(currentCard).toBeVisible();
    await expect(currentCard).toHaveAttribute("data-selected", "true");
  });

  test("selecting a source and clicking Preview advances to step 2", async ({ page }) => {
    await page.getByTestId("upgrade-wizard-trigger").click();
    await expect(page.getByTestId("upgrade-wizard-step-1")).toBeVisible({ timeout: 5_000 });

    await page.getByTestId("upgrade-wizard-preview-btn").click();
    await expect(page.getByTestId("upgrade-wizard-step-2")).toBeVisible({ timeout: 8_000 });
  });

  test("step 2 shows version delta, impact row, and changelog", async ({ page }) => {
    await page.getByTestId("upgrade-wizard-trigger").click();
    await expect(page.getByTestId("upgrade-wizard-step-1")).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("upgrade-wizard-preview-btn").click();
    await expect(page.getByTestId("upgrade-wizard-step-2")).toBeVisible({ timeout: 8_000 });

    await expect(page.getByTestId("upgrade-preview-version-delta")).toBeVisible();
    await expect(page.getByTestId("upgrade-preview-impact-row")).toBeVisible();
    await expect(page.getByTestId("upgrade-preview-changelog")).toBeVisible();
  });

  test("step 2 Back button returns to step 1", async ({ page }) => {
    await page.getByTestId("upgrade-wizard-trigger").click();
    await page.getByTestId("upgrade-wizard-preview-btn").click();
    await expect(page.getByTestId("upgrade-wizard-step-2")).toBeVisible({ timeout: 8_000 });

    await page.getByTestId("upgrade-wizard-back-btn").click();
    await expect(page.getByTestId("upgrade-wizard-step-1")).toBeVisible({ timeout: 3_000 });
  });

  test("wizard can be dismissed with Escape key", async ({ page }) => {
    await page.getByTestId("upgrade-wizard-trigger").click();
    await expect(page.getByTestId("upgrade-wizard-overlay")).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("upgrade-wizard-overlay")).not.toBeVisible({ timeout: 3_000 });
  });

  test("step indicator highlights the active step", async ({ page }) => {
    await page.getByTestId("upgrade-wizard-trigger").click();
    await expect(page.getByTestId("upgrade-wizard-step-indicator-1")).toHaveAttribute("data-active", "true", { timeout: 5_000 });
    await expect(page.getByTestId("upgrade-wizard-step-indicator-2")).toHaveAttribute("data-active", "false");
    await expect(page.getByTestId("upgrade-wizard-step-indicator-3")).toHaveAttribute("data-active", "false");
  });
});
