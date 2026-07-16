/**
 * taskmaster-menu pure-logic tests.
 *
 * Covers the two-screen key→action state machine and the renderers. The
 * interactive `runTaskmasterMenu` itself drives raw-mode stdin + polling, so
 * it's exercised by manual smoke-testing (like doctor-menu's arrow-key
 * wrapper), not unit tests.
 */

import { describe, it, expect } from "vitest";
import {
  applyScreenKey,
  initialScreenState,
  renderJobsScreen,
  renderProjectsScreen,
  type JobsScreenState,
  type ProjectsScreenState,
} from "./taskmaster-menu.js";
import type { ProjectSummary, TaskmasterJobSummary } from "../gateway-client.js";

const PROJECTS: ProjectSummary[] = [
  { name: "alpha", path: "/home/user/alpha" },
  { name: "beta", path: "/home/user/beta" },
];

function job(overrides: Partial<TaskmasterJobSummary> = {}): TaskmasterJobSummary {
  return {
    id: "job-1",
    description: "Do the thing",
    status: "running",
    currentPhase: "phase-1",
    workers: ["$W.code.engineer"],
    gate: "auto",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("initialScreenState", () => {
  it("starts on the projects screen with an empty list", () => {
    const state = initialScreenState();
    expect(state.kind).toBe("projects");
    expect(state.projects).toEqual([]);
    expect(state.selectedIndex).toBe(0);
  });
});

describe("applyScreenKey — projects screen", () => {
  const base: ProjectsScreenState = { kind: "projects", projects: PROJECTS, selectedIndex: 0 };

  it("moves the highlight down and wraps", () => {
    expect(applyScreenKey(base, "\x1b[B")).toEqual({ kind: "move", newSelectedIndex: 1 });
    expect(applyScreenKey({ ...base, selectedIndex: 1 }, "\x1b[B")).toEqual({ kind: "move", newSelectedIndex: 0 });
  });

  it("moves the highlight up and wraps", () => {
    expect(applyScreenKey(base, "\x1b[A")).toEqual({ kind: "move", newSelectedIndex: 1 });
  });

  it("opens the selected project on Enter", () => {
    const action = applyScreenKey({ ...base, selectedIndex: 1 }, "\r");
    expect(action).toEqual({ kind: "open-project", project: PROJECTS[1] });
  });

  it("quits on Esc, q, and Ctrl-C", () => {
    for (const key of ["\x1b", "q", "Q", "\x03"]) {
      expect(applyScreenKey(base, key)).toEqual({ kind: "quit" });
    }
  });

  it("no-ops on an empty project list", () => {
    const empty: ProjectsScreenState = { kind: "projects", projects: [], selectedIndex: 0 };
    expect(applyScreenKey(empty, "\x1b[B")).toEqual({ kind: "noop" });
    expect(applyScreenKey(empty, "\r")).toEqual({ kind: "noop" });
  });
});

describe("applyScreenKey — jobs screen (list)", () => {
  const jobs = [job({ id: "job-a", status: "checkpoint" }), job({ id: "job-b", status: "running" })];
  const base: JobsScreenState = { kind: "jobs", project: PROJECTS[0]!, jobs, selectedIndex: 0, detail: false };

  it("goes back to projects on Esc/q, not quit", () => {
    expect(applyScreenKey(base, "\x1b")).toEqual({ kind: "back" });
    expect(applyScreenKey(base, "q")).toEqual({ kind: "back" });
  });

  it("opens detail view on Enter", () => {
    expect(applyScreenKey(base, "\r")).toEqual({ kind: "toggle-detail" });
  });

  it("approves a checkpoint-gated job with 'a'", () => {
    expect(applyScreenKey(base, "a")).toEqual({ kind: "approve", jobId: "job-a" });
  });

  it("rejects a checkpoint-gated job with 'r'", () => {
    expect(applyScreenKey(base, "r")).toEqual({ kind: "reject", jobId: "job-a" });
  });

  it("does not approve/reject a job that isn't at a checkpoint", () => {
    const onNonCheckpoint: JobsScreenState = { ...base, selectedIndex: 1 };
    expect(applyScreenKey(onNonCheckpoint, "a")).toEqual({ kind: "noop" });
    expect(applyScreenKey(onNonCheckpoint, "r")).toEqual({ kind: "noop" });
  });

  it("no-ops on an empty job list", () => {
    const empty: JobsScreenState = { kind: "jobs", project: PROJECTS[0]!, jobs: [], selectedIndex: 0, detail: false };
    expect(applyScreenKey(empty, "\x1b[B")).toEqual({ kind: "noop" });
    expect(applyScreenKey(empty, "a")).toEqual({ kind: "noop" });
  });
});

describe("applyScreenKey — jobs screen (detail)", () => {
  const jobs = [job({ id: "job-a", status: "checkpoint" })];
  const detail: JobsScreenState = { kind: "jobs", project: PROJECTS[0]!, jobs, selectedIndex: 0, detail: true };

  it("closes detail (not back-to-projects) on Esc/q", () => {
    expect(applyScreenKey(detail, "\x1b")).toEqual({ kind: "toggle-detail" });
    expect(applyScreenKey(detail, "q")).toEqual({ kind: "toggle-detail" });
  });

  it("closes detail on Enter", () => {
    expect(applyScreenKey(detail, "\r")).toEqual({ kind: "toggle-detail" });
  });

  it("ignores approve/reject/arrow keys while in detail", () => {
    expect(applyScreenKey(detail, "a")).toEqual({ kind: "noop" });
    expect(applyScreenKey(detail, "\x1b[B")).toEqual({ kind: "noop" });
  });
});

describe("renderProjectsScreen", () => {
  it("marks the selected project and lists all names + paths", () => {
    const rendered = renderProjectsScreen({ kind: "projects", projects: PROJECTS, selectedIndex: 1 });
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("/home/user/beta");
    const betaLine = rendered.split("\n").find((l) => l.includes("beta"));
    expect(betaLine).toContain("▶");
  });

  it("reports when there are no projects", () => {
    const rendered = renderProjectsScreen({ kind: "projects", projects: [], selectedIndex: 0 });
    expect(rendered).toContain("No projects found");
  });
});

describe("renderJobsScreen", () => {
  it("shows a status badge and truncated description per job", () => {
    const rendered = renderJobsScreen({
      kind: "jobs",
      project: PROJECTS[0]!,
      jobs: [job({ status: "checkpoint", description: "x".repeat(100) })],
      selectedIndex: 0,
      detail: false,
    });
    expect(rendered).toContain("checkpoint");
    expect(rendered).not.toContain("x".repeat(100));
  });

  it("shows full description, workers, and summary in detail view", () => {
    const rendered = renderJobsScreen({
      kind: "jobs",
      project: PROJECTS[0]!,
      jobs: [job({ description: "full description here", summary: "it worked" })],
      selectedIndex: 0,
      detail: true,
    });
    expect(rendered).toContain("full description here");
    expect(rendered).toContain("it worked");
    expect(rendered).toContain("$W.code.engineer");
  });

  it("reports when there are no jobs", () => {
    const rendered = renderJobsScreen({ kind: "jobs", project: PROJECTS[0]!, jobs: [], selectedIndex: 0, detail: false });
    expect(rendered).toContain("No Taskmaster jobs");
  });
});
