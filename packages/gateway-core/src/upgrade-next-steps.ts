/**
 * UpgradeNextSteps — post-upgrade interactive task queue.
 *
 * Migrations and upgrade.sh can stack items here. Required items block the
 * "upgrade complete" acknowledgement in the dashboard; optional items can be
 * dismissed. Steps persist in ~/.agi/upgrade-next-steps.json until actioned.
 *
 * The upgrade script writes to ~/.agi/upgrade-next-steps-pending.ndjson;
 * importPendingSteps() reads + merges them on gateway boot so bash scripts
 * don't need to call a live API.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UpgradeNextStepStatus = "pending" | "done" | "dismissed";
export type UpgradeNextStepActionKind = "navigate" | "external-url" | "chat";

export interface UpgradeNextStepAction {
  label: string;
  kind: UpgradeNextStepActionKind;
  /** Route path, URL, or chat context string depending on kind. */
  target: string;
}

export interface UpgradeNextStep {
  /** Stable unique ID — use kebab-case + version suffix (e.g. "pax-conflict-react-fancy-v0.4.879"). */
  id: string;
  title: string;
  description: string;
  /** true = blocks "upgrade acknowledged" until completed. */
  required: boolean;
  status: UpgradeNextStepStatus;
  /** ISO timestamp when the step was stacked. */
  addedAt: string;
  /** Gateway semver that stacked this step. */
  fromVersion: string;
  /** Optional dashboard action the user can take from the panel. */
  action?: UpgradeNextStepAction;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const AGI_DIR = join(homedir(), ".agi");
const STEPS_PATH = join(AGI_DIR, "upgrade-next-steps.json");
const PENDING_PATH = join(AGI_DIR, "upgrade-next-steps-pending.ndjson");
/** Written by upgrade.sh after a successful deploy; read on boot to detect new versions. */
export const DEPLOYED_VERSION_PATH = join(AGI_DIR, "deployed-version.txt");
/** Last version the gateway acknowledged (emitted system:upgraded for). */
export const SEEN_VERSION_PATH = join(AGI_DIR, "seen-version.txt");

function ensureDir(): void {
  if (!existsSync(AGI_DIR)) mkdirSync(AGI_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readSteps(): UpgradeNextStep[] {
  if (!existsSync(STEPS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(STEPS_PATH, "utf-8")) as UpgradeNextStep[];
  } catch {
    return [];
  }
}

function writeSteps(steps: UpgradeNextStep[]): void {
  ensureDir();
  writeFileSync(STEPS_PATH, JSON.stringify(steps, null, 2));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Stack a new step. Idempotent by ID — existing step with same ID is kept unchanged. */
export function stackUpgradeNextStep(step: Omit<UpgradeNextStep, "status" | "addedAt"> & { addedAt?: string }): void {
  const steps = readSteps();
  if (steps.some((s) => s.id === step.id)) return;
  steps.push({ ...step, status: "pending", addedAt: step.addedAt ?? new Date().toISOString() });
  writeSteps(steps);
}

/** List all steps. Pass `filter="pending"` to get only actionable ones. */
export function listUpgradeNextSteps(filter?: "pending" | "all"): UpgradeNextStep[] {
  const steps = readSteps();
  if (filter === "pending") return steps.filter((s) => s.status === "pending");
  return steps;
}

/** Mark a step done. */
export function completeUpgradeNextStep(id: string): boolean {
  const steps = readSteps();
  const step = steps.find((s) => s.id === id);
  if (!step) return false;
  step.status = "done";
  writeSteps(steps);
  return true;
}

/** Dismiss an optional step. Required steps cannot be dismissed. */
export function dismissUpgradeNextStep(id: string): boolean | "required" {
  const steps = readSteps();
  const step = steps.find((s) => s.id === id);
  if (!step) return false;
  if (step.required) return "required";
  step.status = "dismissed";
  writeSteps(steps);
  return true;
}

/** True when any pending step is marked required (blocks acknowledgement). */
export function hasPendingRequiredSteps(): boolean {
  return readSteps().some((s) => s.status === "pending" && s.required);
}

// ---------------------------------------------------------------------------
// Pending import — upgrade.sh writes to the .ndjson file, gateway boot merges
// ---------------------------------------------------------------------------

/**
 * Read upgrade-next-steps-pending.ndjson written by upgrade.sh and merge
 * each line into the main steps store. Clears the pending file after import.
 * Call once on gateway boot before emitting system:upgraded.
 */
export function importPendingSteps(): number {
  if (!existsSync(PENDING_PATH)) return 0;
  const raw = readFileSync(PENDING_PATH, "utf-8").trim();
  if (!raw) return 0;
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line) as Omit<UpgradeNextStep, "status" | "addedAt"> & { addedAt?: string };
      stackUpgradeNextStep(step);
      count++;
    } catch {
      // Malformed line — skip
    }
  }
  writeFileSync(PENDING_PATH, ""); // clear after import
  return count;
}

/**
 * Append a step to the pending NDJSON file. Used from upgrade.sh via
 * `node -e` inline calls so bash doesn't need to call a live API.
 */
export function appendPendingStep(step: Omit<UpgradeNextStep, "status" | "addedAt">): void {
  ensureDir();
  appendFileSync(PENDING_PATH, JSON.stringify({ ...step, addedAt: new Date().toISOString() }) + "\n");
}

// ---------------------------------------------------------------------------
// Version tracking
// ---------------------------------------------------------------------------

export function readDeployedVersion(): string | null {
  if (!existsSync(DEPLOYED_VERSION_PATH)) return null;
  return readFileSync(DEPLOYED_VERSION_PATH, "utf-8").trim() || null;
}

export function readSeenVersion(): string | null {
  if (!existsSync(SEEN_VERSION_PATH)) return null;
  return readFileSync(SEEN_VERSION_PATH, "utf-8").trim() || null;
}

export function writeSeenVersion(version: string): void {
  ensureDir();
  writeFileSync(SEEN_VERSION_PATH, version);
}
