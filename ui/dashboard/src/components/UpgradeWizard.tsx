/**
 * UpgradeWizard — fork-aware 2-step upgrade workflow.
 *
 * Step 1 — Source Selection:
 *   Fetches /api/system/fork-status on open. Displays all available
 *   remote/branch sources with ahead/behind commit counts. User selects
 *   which ref to pull from.
 *
 * Step 2 — Preview:
 *   Fetches /api/system/upgrade-preview for the selected source. Shows
 *   version delta, impact summary (restart / DB / frontend-only), pending
 *   migrations, and changelog. "Merge & Upgrade →" executes the merge then
 *   fires upgrade.sh.
 *
 * Step 3 — Executing:
 *   Streams per-step upgrade progress from the parent-supplied upgradePhase
 *   and upgradeLogs props (driven by the system:upgrade WS event in root.tsx).
 *   After completion the embedded UpgradeNextStepsPanel renders inline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { UpgradeNextStepsPanel } from "@/components/UpgradeNextStepsPanel.js";
import {
  fetchForkStatus,
  fetchUpgradePreview,
  mergeForkSource,
} from "@/api.js";
import type {
  ForkStatus,
  ForkBranchInfo,
  UpgradePreview,
  MergeResult,
  SystemUpgradedEvent,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fine-step label map (upgrade.sh phase names → human-readable labels)
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<string, string> = {
  preflight: "Preflight checks",
  "origin-agi": "Verify fork origin",
  "origin-prime": "Verify PRIME origin",
  "pull-agi": "Pull latest AGI",
  "pull-prime": "Pull latest PRIME",
  "pull-marketplace": "Pull Plugin Marketplace",
  "pull-mapp-marketplace": "Pull MApp Marketplace",
  submodules: "Initialize submodules",
  "protocol-check": "Protocol version check",
  install: "Install dependencies",
  rebuild: "Rebuild native modules",
  build: "Build frontend",
  "build-marketplace": "Build Marketplace",
  "db-push": "Database migration",
  systemd: "Update service config",
  restart: "Restart service",
  complete: "Complete",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface UpgradeWizardProps {
  open: boolean;
  onClose: () => void;
  /** Coarse upgrade phase from root.tsx ("pulling" | "building" | "restarting" | "complete" | "error" | null) */
  upgradePhase: string | null;
  /** Fine-step log entries from upgrade.sh, streamed via WS. */
  upgradeLogs: { step: string; status: string; message: string; timestamp: string }[];
  /** Set by root.tsx when system:upgraded event fires. */
  upgradedEvent: SystemUpgradedEvent | null;
  /** Whether the post-upgrade steps panel should be shown. */
  showUpgradePanel: boolean;
  /** Called when user closes the post-upgrade steps panel. */
  onCloseUpgradePanel: () => void;
  /** Starts upgrade.sh and sets up completion polling — provided by root.tsx. */
  doUpgrade: () => void;
}

type Step = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UpgradeWizard({
  open,
  onClose,
  upgradePhase,
  upgradeLogs,
  upgradedEvent,
  showUpgradePanel,
  onCloseUpgradePanel,
  doUpgrade,
}: UpgradeWizardProps) {
  const [step, setStep] = useState<Step>(1);

  // Step 1 state
  const [forkStatus, setForkStatus] = useState<ForkStatus | null>(null);
  const [forkLoading, setForkLoading] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string>("");

  // Step 2 state
  const [preview, setPreview] = useState<UpgradePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Merge state (step 2 → 3 transition)
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeConflict, setMergeConflict] = useState<MergeResult | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);

  // Merge result to display in step 3
  const [mergeResult, setMergeResult] = useState<{ fastForward: boolean; commits: number } | null>(null);

  // Track already-seen fine steps so the list grows monotonically
  const seenStepsRef = useRef<Map<string, { status: string; message: string }>>(new Map());

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // Load fork status on open
  useEffect(() => {
    if (!open) return;
    setStep(upgradePhase !== null ? 3 : 1);
    if (upgradePhase !== null) return; // already upgrading — skip to step 3

    setForkLoading(true);
    setForkError(null);
    fetchForkStatus()
      .then((status) => {
        setForkStatus(status);
        const current = status.sources.find((s) => s.isCurrentChannel) ?? status.sources[0];
        if (current) setSelectedSource(current.ref);
        setForkLoading(false);
      })
      .catch((err: unknown) => {
        setForkError(err instanceof Error ? err.message : "Failed to load fork status");
        setForkLoading(false);
      });
  }, [open, upgradePhase]);

  // Dismiss on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step !== 3) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, step, onClose]);

  // Keep seenSteps current as upgradeLogs grows
  useEffect(() => {
    for (const entry of upgradeLogs) {
      if (entry.step) {
        seenStepsRef.current.set(entry.step, { status: entry.status, message: entry.message });
      }
    }
  }, [upgradeLogs]);

  // Reset state when closed
  useEffect(() => {
    if (!open) {
      setStep(1);
      setForkStatus(null);
      setForkError(null);
      setPreview(null);
      setPreviewError(null);
      setMergeConflict(null);
      setMergeResult(null);
      setDoctorError(null);
      seenStepsRef.current.clear();
    }
  }, [open]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handlePreview = useCallback(() => {
    if (!selectedSource) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    fetchUpgradePreview(selectedSource)
      .then((p) => { setPreview(p); setPreviewLoading(false); setStep(2); })
      .catch((err: unknown) => {
        setPreviewError(err instanceof Error ? err.message : "Failed to load preview");
        setPreviewLoading(false);
      });
  }, [selectedSource]);

  const handleMergeAndUpgrade = useCallback(async () => {
    if (!selectedSource) return;
    setMergeLoading(true);
    setMergeConflict(null);
    setDoctorError(null);

    try {
      const result = await mergeForkSource(selectedSource);
      if (!result.ok && result.aborted) {
        setMergeConflict(result);
        setMergeLoading(false);
        return;
      }
      setMergeResult({ fastForward: result.fastForward, commits: result.mergedCommits });
      setStep(3);
      doUpgrade();
    } catch (err: unknown) {
      setPreviewError(err instanceof Error ? err.message : "Merge failed");
    }
    setMergeLoading(false);
  }, [selectedSource, doUpgrade]);

  const handleDoctorResolve = useCallback(async () => {
    setDoctorLoading(true);
    setDoctorError(null);
    try {
      const res = await fetch("/api/system/doctor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve-merge" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Doctor resolved the conflict — clear conflict state, move to step 3 and upgrade
      setMergeConflict(null);
      setStep(3);
      doUpgrade();
    } catch (err: unknown) {
      setDoctorError(err instanceof Error ? err.message : "Aion Doctor could not resolve conflicts");
    }
    setDoctorLoading(false);
  }, [doUpgrade]);

  if (!open) return null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const upgradeComplete = upgradePhase === "complete";
  const upgradeError = upgradePhase === "error";

  // Build ordered step rows for step 3 from accumulated log entries
  const stepRows = Object.entries(STEP_LABELS).map(([key, label]) => {
    const entry = seenStepsRef.current.get(key);
    const status = entry?.status ?? "pending";
    return { key, label, status };
  }).filter(({ key }) => {
    // Only show steps that have been seen or are the next expected one
    const seen = seenStepsRef.current.has(key);
    const anyRunning = [...seenStepsRef.current.values()].some(e => e.status === "start");
    if (seen) return true;
    // Show the first unseen step as "pending" when something is running
    if (anyRunning) {
      const keys = Object.keys(STEP_LABELS);
      const lastSeen = keys.filter(k => seenStepsRef.current.has(k)).pop();
      const lastSeenIdx = lastSeen ? keys.indexOf(lastSeen) : -1;
      const thisIdx = keys.indexOf(key);
      return thisIdx === lastSeenIdx + 1;
    }
    return false;
  });

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function StepIndicator() {
    const steps = [
      { n: 1, label: "Source" },
      { n: 2, label: "Preview" },
      { n: 3, label: "Executing" },
    ] as const;
    return (
      <div className="flex items-center gap-0 border-b border-border">
        {steps.map(({ n, label }, i) => (
          <div key={n} className="flex items-center">
            <button
              data-testid={`upgrade-wizard-step-indicator-${n}`}
              data-active={step === n ? "true" : "false"}
              disabled={n >= step || step === 3}
              onClick={() => { if (n < step && step !== 3) setStep(n as Step); }}
              className={cn(
                "flex items-center gap-1.5 px-4 py-3 text-xs font-medium transition-colors",
                step === n
                  ? "text-foreground border-b-2 border-primary -mb-px"
                  : n < step && step !== 3
                  ? "text-muted-foreground hover:text-foreground cursor-pointer"
                  : "text-muted-foreground/50 cursor-default",
              )}
            >
              <span className={cn(
                "inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold",
                step === n ? "bg-primary text-primary-foreground"
                  : n < step ? "bg-green text-white"
                  : "bg-muted text-muted-foreground",
              )}>
                {n < step ? "✓" : n}
              </span>
              {label}
            </button>
            {i < steps.length - 1 && (
              <span className="text-border text-xs mx-0.5">›</span>
            )}
          </div>
        ))}
      </div>
    );
  }

  function SourceCard({ source, selected, onSelect }: {
    source: ForkBranchInfo;
    selected: boolean;
    onSelect: () => void;
  }) {
    const upToDate = source.commitsBehind === 0;
    return (
      <button
        data-testid={source.isCurrentChannel ? "upgrade-source-card-current" : "upgrade-source-card"}
        data-selected={selected ? "true" : "false"}
        onClick={onSelect}
        className={cn(
          "w-full text-left rounded-lg border p-3 transition-all",
          selected
            ? "border-primary bg-primary/5"
            : "border-border bg-card hover:border-primary/40",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className={cn(
              "mt-0.5 w-3 h-3 rounded-full border-2 shrink-0",
              selected ? "border-primary bg-primary" : "border-muted-foreground",
            )} />
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-semibold text-foreground">{source.label}</span>
                {source.isCurrentChannel && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue/15 text-blue font-bold uppercase tracking-wide">
                    Current channel
                  </span>
                )}
                {upToDate && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-green/15 text-green font-semibold">
                    Up to date
                  </span>
                )}
              </div>
              {!upToDate && (
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  <span className="text-foreground font-medium">{source.commitsBehind}</span> commit{source.commitsBehind !== 1 ? "s" : ""} behind
                  {source.latestVersion && source.commitsBehind > 0 && (
                    <span className="ml-1.5 font-mono text-muted-foreground/80">
                      → v{source.latestVersion}
                    </span>
                  )}
                </div>
              )}
              {source.latestCommit && (
                <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                  <span className="font-mono">{source.latestCommit.hash.slice(0, 7)}</span>
                  {" "}{source.latestCommit.message}
                </div>
              )}
            </div>
          </div>
        </div>
      </button>
    );
  }

  function StepRow({ label, status, first }: { label: string; status: string; first?: boolean }) {
    const isDone = status === "ok" || status === "skip";
    const isRunning = status === "start";
    const isError = status === "fail";
    const isPending = status === "pending";
    return (
      <div className={cn("flex items-center gap-3 py-1.5", !first && "border-t border-border/50")}>
        <span className={cn(
          "w-2 h-2 rounded-full shrink-0",
          isDone ? "bg-green"
            : isRunning ? "bg-blue animate-pulse"
            : isError ? "bg-red"
            : "bg-muted",
        )} />
        <span className={cn(
          "text-[12px]",
          isDone ? "text-muted-foreground line-through decoration-muted-foreground/40"
            : isRunning ? "text-foreground font-medium"
            : isPending ? "text-muted-foreground/50"
            : "text-foreground",
        )}>
          {label}
        </span>
        {isRunning && <span className="text-[10px] text-blue ml-auto">running…</span>}
        {isError && <span className="text-[10px] text-red ml-auto">failed</span>}
        {status === "skip" && <span className="text-[10px] text-muted-foreground/60 ml-auto">skipped</span>}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  return (
    <div
      data-testid="upgrade-wizard-overlay"
      className="fixed inset-0 z-[400] flex flex-col bg-background"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <span className="text-[15px] font-bold text-foreground">Upgrade Manager</span>
        {step !== 3 && (
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xl leading-none px-1"
            aria-label="Close upgrade wizard"
          >
            ×
          </button>
        )}
      </div>

      <StepIndicator />

      {/* Body — scrollable */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto w-full px-5 py-6">

          {/* ------------------------------------------------------------------ */}
          {/* STEP 1 — Source Selection */}
          {/* ------------------------------------------------------------------ */}

          {step === 1 && (
            <div data-testid="upgrade-wizard-step-1" className="flex flex-col gap-4">
              {/* Current state chip */}
              {forkStatus && (
                <div className="text-[11px] text-muted-foreground bg-surface0 rounded-lg px-3 py-2 font-mono">
                  {forkStatus.devModeEnabled ? "fork" : "origin"} · {forkStatus.currentBranch} · v{forkStatus.currentVersion}
                </div>
              )}

              <div>
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Available sources
                </div>

                {forkLoading && (
                  <div className="text-[12px] text-muted-foreground py-6 text-center animate-pulse">
                    Fetching remote status…
                  </div>
                )}

                {forkError && (
                  <div className="text-[12px] text-red bg-red/5 border border-red/20 rounded-lg px-3 py-2">
                    {forkError}
                  </div>
                )}

                {!forkLoading && !forkError && forkStatus && (
                  <div className="flex flex-col gap-2">
                    {forkStatus.sources.map((source) => (
                      <SourceCard
                        key={source.ref}
                        source={source}
                        selected={selectedSource === source.ref}
                        onSelect={() => setSelectedSource(source.ref)}
                      />
                    ))}
                  </div>
                )}
              </div>

              {previewError && (
                <div className="text-[12px] text-red bg-red/5 border border-red/20 rounded-lg px-3 py-2">
                  {previewError}
                </div>
              )}

              <div className="flex justify-end pt-1">
                <Button
                  data-testid="upgrade-wizard-preview-btn"
                  onClick={handlePreview}
                  disabled={!selectedSource || forkLoading || previewLoading}
                >
                  {previewLoading ? "Loading…" : "Preview →"}
                </Button>
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* STEP 2 — Upgrade Preview */}
          {/* ------------------------------------------------------------------ */}

          {step === 2 && (
            <div data-testid="upgrade-wizard-step-2" className="flex flex-col gap-5">
              {/* Version delta */}
              {preview && (
                <div
                  data-testid="upgrade-preview-version-delta"
                  className="flex items-center gap-2 font-mono text-[13px]"
                >
                  <span className="text-muted-foreground">v{preview.fromVersion}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-bold text-foreground">v{preview.toVersion}</span>
                  <span className="text-[11px] text-muted-foreground ml-1">
                    · {preview.commitCount} commit{preview.commitCount !== 1 ? "s" : ""}
                  </span>
                </div>
              )}

              {/* Impact row */}
              {preview && (
                <div
                  data-testid="upgrade-preview-impact-row"
                  className="flex items-center gap-2 flex-wrap"
                >
                  {preview.impact.requiresRestart && (
                    <span className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-yellow/10 text-yellow border border-yellow/20">
                      <span>↺</span> Service restart
                    </span>
                  )}
                  {preview.impact.requiresDbMigration && (
                    <span className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-blue/10 text-blue border border-blue/20">
                      <span>⊞</span> DB migration
                    </span>
                  )}
                  {preview.impact.frontendOnly && !preview.impact.requiresRestart && (
                    <span className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-green/10 text-green border border-green/20">
                      <span>⚡</span> Frontend only
                    </span>
                  )}
                  {preview.impact.changedAreas.map((area) => (
                    <span key={area} className="text-[10px] px-1.5 py-0.5 rounded bg-surface1 text-muted-foreground">
                      {area}
                    </span>
                  ))}
                </div>
              )}

              {/* Migrations */}
              {preview && preview.migrations.length > 0 && (
                <div className="rounded-lg border border-border bg-card">
                  <div className="px-3 py-2 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Migrations ({preview.migrations.length})
                  </div>
                  <div className="divide-y divide-border">
                    {preview.migrations.map((m) => (
                      <div key={m.id} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] text-muted-foreground">v{m.version}</span>
                          <span className="text-[11px] font-medium text-foreground">{m.id}</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{m.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Changelog */}
              {preview && preview.commits.length > 0 && (
                <div
                  data-testid="upgrade-preview-changelog"
                  className="rounded-lg border border-border bg-card"
                >
                  <div className="px-3 py-2 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Changelog ({preview.commits.length} commits)
                  </div>
                  <div className="divide-y divide-border max-h-[240px] overflow-y-auto">
                    {preview.commits.map((c) => (
                      <div key={c.hash} className="flex items-start gap-2 px-3 py-1.5 text-[11px]">
                        <span className="font-mono text-muted-foreground shrink-0 mt-px">{c.hash.slice(0, 7)}</span>
                        <span className="text-foreground leading-relaxed">{c.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* No commits */}
              {preview && preview.commitCount === 0 && (
                <div className="text-[12px] text-muted-foreground bg-surface0 rounded-lg px-3 py-3 text-center">
                  Already up to date — no commits to merge.
                </div>
              )}

              {/* Merge conflict panel */}
              {mergeConflict && (
                <div className="rounded-lg border border-red/30 bg-red/5 p-3">
                  <div className="text-[12px] font-semibold text-red mb-1">
                    Merge conflict — {mergeConflict.conflicts?.length ?? 0} file{(mergeConflict.conflicts?.length ?? 0) !== 1 ? "s" : ""}
                  </div>
                  <div className="mb-2 space-y-0.5 max-h-[100px] overflow-y-auto">
                    {(mergeConflict.conflicts ?? []).map((f) => (
                      <div key={f} className="font-mono text-[10px] text-muted-foreground">{f}</div>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mb-2">
                    The merge was aborted. Ask Aion Doctor to resolve, or pick a different source.
                  </p>
                  {doctorError && (
                    <div className="text-[11px] text-red mb-2">{doctorError}</div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleDoctorResolve()}
                      disabled={doctorLoading}
                      className="text-[11px] h-7"
                    >
                      {doctorLoading ? "Resolving…" : "Let Aion Doctor resolve"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setMergeConflict(null); setStep(1); }}
                      className="text-[11px] h-7"
                    >
                      Pick different source
                    </Button>
                  </div>
                </div>
              )}

              {previewError && !mergeConflict && (
                <div className="text-[12px] text-red bg-red/5 border border-red/20 rounded-lg px-3 py-2">
                  {previewError}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-between pt-1">
                <Button
                  data-testid="upgrade-wizard-back-btn"
                  variant="outline"
                  onClick={() => { setStep(1); setMergeConflict(null); }}
                >
                  ← Back
                </Button>
                {!mergeConflict && (
                  <Button
                    onClick={() => void handleMergeAndUpgrade()}
                    disabled={mergeLoading || (preview?.commitCount === 0)}
                  >
                    {mergeLoading ? "Merging…" : preview?.commitCount === 0 ? "Up to date" : "Merge & Upgrade →"}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* STEP 3 — Executing */}
          {/* ------------------------------------------------------------------ */}

          {step === 3 && (
            <div data-testid="upgrade-wizard-step-3" className="flex flex-col gap-4">
              {/* Merge result line */}
              {mergeResult && (
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground bg-surface0 rounded-lg px-3 py-2">
                  <span className="text-green">✓</span>
                  Merged {mergeResult.commits} commit{mergeResult.commits !== 1 ? "s" : ""}
                  {mergeResult.fastForward ? " (fast-forward)" : ""}
                </div>
              )}

              {/* Step progress */}
              <div className="rounded-lg border border-border bg-card px-3 py-1.5">
                {stepRows.length === 0 && !upgradeComplete && !upgradeError && (
                  <div className="py-4 text-center text-[12px] text-muted-foreground animate-pulse">
                    Starting upgrade…
                  </div>
                )}
                {stepRows.map((row, i) => (
                  <StepRow key={row.key} label={row.label} status={row.status} first={i === 0} />
                ))}
                {upgradeError && (
                  <div className="flex items-center gap-2 py-1.5 border-t border-border/50">
                    <span className="w-2 h-2 rounded-full bg-red shrink-0" />
                    <span className="text-[12px] text-red font-medium">Upgrade failed — check the log below</span>
                  </div>
                )}
              </div>

              {/* Live log */}
              {upgradeLogs.length > 0 && (
                <details className="group">
                  <summary className="text-[11px] text-muted-foreground cursor-pointer list-none flex items-center gap-1 select-none">
                    <span className="group-open:rotate-90 inline-block transition-transform">›</span>
                    Live log ({upgradeLogs.length} entries)
                  </summary>
                  <div className="mt-1.5 rounded-lg bg-surface0 border border-border p-2 max-h-[160px] overflow-y-auto font-mono text-[10px] space-y-0.5">
                    {upgradeLogs.map((entry, i) => (
                      <div key={i} className={cn(
                        "flex gap-2",
                        entry.status === "fail" ? "text-red" : "text-subtext0",
                      )}>
                        <span className="text-subtext1 shrink-0">[{entry.step}:{entry.status}]</span>
                        <span className="truncate">{entry.message}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Post-upgrade steps (after completion) */}
              {upgradeComplete && upgradedEvent && (
                <UpgradeNextStepsPanel
                  open={showUpgradePanel}
                  toVersion={upgradedEvent.toVersion}
                  fromVersion={upgradedEvent.fromVersion}
                  embedded
                  onClose={onCloseUpgradePanel}
                />
              )}

              {upgradeComplete && !upgradedEvent && (
                <div className="text-center py-4">
                  <div className="text-[14px] font-bold text-green mb-1">Upgrade complete</div>
                  <p className="text-[12px] text-muted-foreground">The service is restarting. The page will reload automatically.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
