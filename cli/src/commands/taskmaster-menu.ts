/**
 * `agi taskmaster menu` — arrow-key TUI for browsing projects and driving
 * Taskmaster jobs (approve/reject checkpoint gates, view worker output).
 *
 * Reuses doctor-menu.ts's raw-TTY primitives (escape-buffer disambiguation,
 * cursor-rewind rendering, canUseRawTty) — this is a second screen-state
 * machine layered on the same terminal primitives, not a new TUI framework.
 * Live status: the jobs screen polls `GET /api/taskmaster/jobs` on an
 * interval and re-renders, since jobs progress in the background outside
 * any keypress.
 */

import {
  bufferKey,
  canUseRawTty,
  countRenderLines,
  eraseLines,
  ESCAPE_BUFFER_TIMEOUT_MS,
  flushEscapeBuffer,
  initialEscapeBufferState,
} from "./doctor-menu.js";
import { GatewayClient } from "../gateway-client.js";
import type { ProjectSummary, TaskmasterJobSummary } from "../gateway-client.js";

/** How often the jobs screen re-fetches job status while idle. */
export const TASKMASTER_POLL_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// Pure state + key handling
// ---------------------------------------------------------------------------

export interface ProjectsScreenState {
  kind: "projects";
  projects: ProjectSummary[];
  selectedIndex: number;
}

export interface JobsScreenState {
  kind: "jobs";
  project: ProjectSummary;
  jobs: TaskmasterJobSummary[];
  selectedIndex: number;
  /** True when showing the selected job's full detail instead of the list. */
  detail: boolean;
}

export type ScreenState = ProjectsScreenState | JobsScreenState;

export function initialScreenState(): ProjectsScreenState {
  return { kind: "projects", projects: [], selectedIndex: 0 };
}

/** Action emitted by the state machine for one finished keypress sequence. */
export type TmAction =
  | { kind: "noop" }
  | { kind: "move"; newSelectedIndex: number }
  | { kind: "open-project"; project: ProjectSummary }
  | { kind: "back" }
  | { kind: "toggle-detail" }
  | { kind: "approve"; jobId: string }
  | { kind: "reject"; jobId: string }
  | { kind: "quit" };

/**
 * Pure classifier — turn one finished key sequence + the current screen
 * into an action. Exposed for unit tests (no TTY fixture needed).
 */
export function applyScreenKey(state: ScreenState, key: string): TmAction {
  const isQuitKey = key === "\x1b" || key === "q" || key === "Q" || key === "\x03";
  if (isQuitKey) {
    if (state.kind === "jobs" && state.detail) return { kind: "toggle-detail" };
    if (state.kind === "jobs") return { kind: "back" };
    return { kind: "quit" };
  }

  if (state.kind === "projects") {
    if (state.projects.length === 0) return { kind: "noop" };
    if (key === "\x1b[A") {
      return { kind: "move", newSelectedIndex: (state.selectedIndex - 1 + state.projects.length) % state.projects.length };
    }
    if (key === "\x1b[B") {
      return { kind: "move", newSelectedIndex: (state.selectedIndex + 1) % state.projects.length };
    }
    if (key === "\r" || key === "\n") {
      const project = state.projects[state.selectedIndex];
      return project ? { kind: "open-project", project } : { kind: "noop" };
    }
    return { kind: "noop" };
  }

  // Jobs screen.
  if (state.detail) {
    // Any other key just no-ops; Enter (or the quit keys, handled above) closes detail.
    if (key === "\r" || key === "\n") return { kind: "toggle-detail" };
    return { kind: "noop" };
  }
  if (state.jobs.length === 0) return { kind: "noop" };
  if (key === "\x1b[A") {
    return { kind: "move", newSelectedIndex: (state.selectedIndex - 1 + state.jobs.length) % state.jobs.length };
  }
  if (key === "\x1b[B") {
    return { kind: "move", newSelectedIndex: (state.selectedIndex + 1) % state.jobs.length };
  }
  if (key === "\r" || key === "\n") {
    return { kind: "toggle-detail" };
  }
  if (key === "a" || key === "A") {
    const job = state.jobs[state.selectedIndex];
    return job && job.status === "checkpoint" ? { kind: "approve", jobId: job.id } : { kind: "noop" };
  }
  if (key === "r" || key === "R") {
    const job = state.jobs[state.selectedIndex];
    return job && job.status === "checkpoint" ? { kind: "reject", jobId: job.id } : { kind: "noop" };
  }
  return { kind: "noop" };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusBadge(status: TaskmasterJobSummary["status"]): string {
  switch (status) {
    case "checkpoint": return "⏸ checkpoint";
    case "running": return "▶ running";
    case "pending": return "… pending";
    case "complete": return "✓ complete";
    case "failed": return "✗ failed";
    default: return status;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function renderProjectsScreen(state: ProjectsScreenState): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  agi taskmaster — projects (arrow keys, Enter to open, Esc/q to quit)");
  lines.push("");
  if (state.projects.length === 0) {
    lines.push("  No projects found.");
  } else {
    state.projects.forEach((p, idx) => {
      const marker = idx === state.selectedIndex ? "▶ " : "  ";
      lines.push(`  ${marker}${p.name}`);
      lines.push(`       ${p.path}`);
    });
  }
  lines.push("");
  return lines.join("\n");
}

export function renderJobsScreen(state: JobsScreenState): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  agi taskmaster — ${state.project.name} (arrows, Enter view, [a]pprove/[r]eject a checkpoint, Esc/q back)`);
  lines.push("");

  if (state.jobs.length === 0) {
    lines.push("  No Taskmaster jobs for this project.");
    lines.push("");
    return lines.join("\n");
  }

  if (state.detail) {
    const job = state.jobs[state.selectedIndex];
    if (job) {
      lines.push(`  ${job.id}  ${statusBadge(job.status)}`);
      lines.push(`  ${job.description}`);
      lines.push(`  workers: ${job.workers.join(", ") || "—"}`);
      lines.push(`  phase: ${job.currentPhase ?? "—"}   gate: ${job.gate}`);
      lines.push("");
      if (job.summary) {
        lines.push("  Summary:");
        lines.push(`  ${job.summary}`);
        lines.push("");
      }
      if (job.error) {
        lines.push("  Error:");
        lines.push(`  ${job.error}`);
        lines.push("");
      }
      lines.push("  (Enter or Esc/q to go back to the list)");
    }
    lines.push("");
    return lines.join("\n");
  }

  state.jobs.forEach((job, idx) => {
    const marker = idx === state.selectedIndex ? "▶ " : "  ";
    lines.push(`  ${marker}${statusBadge(job.status)}  ${truncate(job.description, 60)}`);
  });
  lines.push("");
  return lines.join("\n");
}

export function renderScreen(state: ScreenState): string {
  return state.kind === "projects" ? renderProjectsScreen(state) : renderJobsScreen(state);
}

// ---------------------------------------------------------------------------
// Interactive wrapper
// ---------------------------------------------------------------------------

export async function runTaskmasterMenu(opts?: { client?: GatewayClient; pollIntervalMs?: number }): Promise<void> {
  if (!canUseRawTty()) {
    console.log("agi taskmaster menu requires an interactive terminal (TTY). Use `agi taskmaster [--project <path>]` for a one-shot listing.");
    return;
  }

  const client = opts?.client ?? new GatewayClient("127.0.0.1", 3100);
  const pollIntervalMs = opts?.pollIntervalMs ?? TASKMASTER_POLL_INTERVAL_MS;

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let screen: ScreenState = initialScreenState();
  let bufferState = initialEscapeBufferState();
  let escapeTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let lastRenderedLines = 0;
  let statusLine = "";

  function render(): void {
    const erase = eraseLines(lastRenderedLines);
    const body = renderScreen(screen) + (statusLine ? `  ${statusLine}\n` : "");
    process.stdout.write(erase + body);
    lastRenderedLines = countRenderLines(body);
  }

  async function loadProjects(): Promise<void> {
    try {
      const projects = await client.projects();
      if (screen.kind === "projects") {
        const selectedIndex = Math.min(screen.selectedIndex, Math.max(0, projects.length - 1));
        screen = { kind: "projects", projects, selectedIndex };
        statusLine = "";
      }
    } catch (err) {
      statusLine = `Failed to load projects: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function loadJobs(): Promise<void> {
    if (screen.kind !== "jobs") return;
    try {
      const jobs = await client.taskmasterJobs(screen.project.path);
      const selectedIndex = Math.min(screen.selectedIndex, Math.max(0, jobs.length - 1));
      screen = { ...screen, jobs, selectedIndex };
    } catch (err) {
      statusLine = `Failed to load jobs: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function startPolling(): void {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      void (async () => {
        if (screen.kind === "jobs" && !screen.detail) {
          await loadJobs();
          render();
        }
      })();
    }, pollIntervalMs);
  }

  return new Promise<void>((resolve) => {
    function cleanup(): void {
      if (escapeTimer !== null) clearTimeout(escapeTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    async function dispatchAction(action: TmAction): Promise<void> {
      switch (action.kind) {
        case "quit":
          cleanup();
          process.stdout.write("\n");
          resolve();
          return;
        case "move":
          screen = { ...screen, selectedIndex: action.newSelectedIndex };
          render();
          return;
        case "open-project":
          screen = { kind: "jobs", project: action.project, jobs: [], selectedIndex: 0, detail: false };
          statusLine = "";
          render();
          await loadJobs();
          render();
          return;
        case "back":
          screen = { kind: "projects", projects: [], selectedIndex: 0 };
          statusLine = "";
          render();
          await loadProjects();
          render();
          return;
        case "toggle-detail":
          if (screen.kind === "jobs") {
            screen = { ...screen, detail: !screen.detail };
            render();
          }
          return;
        case "approve":
          try {
            await client.approveTaskmasterJob(action.jobId);
            statusLine = `Approved ${action.jobId} — resuming next phase.`;
          } catch (err) {
            statusLine = `Approve failed: ${err instanceof Error ? err.message : String(err)}`;
          }
          await loadJobs();
          render();
          return;
        case "reject":
          try {
            await client.rejectTaskmasterJob(action.jobId, "Rejected via agi taskmaster menu");
            statusLine = `Rejected ${action.jobId}.`;
          } catch (err) {
            statusLine = `Reject failed: ${err instanceof Error ? err.message : String(err)}`;
          }
          await loadJobs();
          render();
          return;
        case "noop":
        default:
          return;
      }
    }

    function dispatchKey(key: string): void {
      void dispatchAction(applyScreenKey(screen, key));
    }

    function scheduleEscapeFlush(): void {
      if (escapeTimer !== null) clearTimeout(escapeTimer);
      escapeTimer = setTimeout(() => {
        escapeTimer = null;
        const flush = flushEscapeBuffer(bufferState);
        bufferState = flush.newState;
        if (flush.emit !== null) dispatchKey(flush.emit);
      }, ESCAPE_BUFFER_TIMEOUT_MS + 5);
    }

    function onData(key: string): void {
      for (const byte of key) {
        const result = bufferKey(bufferState, byte);
        bufferState = result.newState;
        if (result.emit !== null) dispatchKey(result.emit);
      }
      if (bufferState.pending !== "") {
        scheduleEscapeFlush();
      } else if (escapeTimer !== null) {
        clearTimeout(escapeTimer);
        escapeTimer = null;
      }
    }

    stdin.on("data", onData);
    render();
    void (async () => {
      await loadProjects();
      render();
      startPolling();
    })();
    stdin.once("end", () => {
      cleanup();
      resolve();
    });
  });
}
