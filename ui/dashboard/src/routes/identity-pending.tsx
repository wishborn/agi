/**
 * /identity/pending — pending-from-channel approval queue.
 *
 * CHN-E (s166) slice 4 — owner-facing surface for the pending approval
 * records captured by InboundRouter when unknown users post in
 * project-bound channel rooms. Approve promotes the entity (slice 5
 * adds the verificationTier update); reject drops + flags the source.
 *
 * s195 — shows collected registration data (name/email/birthdate/Discord)
 * and lets the owner assign projects before approving.
 *
 * Consumes /api/identity/pending (GET/POST shipped in slice 3).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageScroll } from "@/components/PageScroll";
import {
  fetchPendingApprovals,
  approvePendingApproval,
  rejectPendingApproval,
  fetchProjects,
  type PendingApproval,
} from "../api";
import type { ProjectInfo } from "../types";

function channelEmoji(channelId: string): string {
  switch (channelId) {
    case "discord": return "💬";
    case "telegram": return "✈️";
    case "slack": return "💼";
    case "email":
    case "gmail": return "📧";
    case "whatsapp": return "🟢";
    case "signal": return "🔐";
    default: return "📡";
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const ago = Date.now() - then;
  if (ago < 60_000) return "just now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  return `${Math.floor(ago / 86_400_000)}d ago`;
}

interface ProjectSelectorProps {
  projects: ProjectInfo[];
  selected: string[];
  onChange: (paths: string[]) => void;
}

function ProjectSelector({ projects, selected, onChange }: ProjectSelectorProps): JSX.Element {
  if (projects.length === 0) {
    return <div className="text-[10px] text-muted-foreground mt-2">No projects available to assign.</div>;
  }
  return (
    <div className="mt-2">
      <div className="text-[10px] font-medium text-muted-foreground mb-1">Assign projects (optional)</div>
      <div className="flex flex-wrap gap-1.5">
        {projects.map((p) => {
          const isChecked = selected.includes(p.path);
          return (
            <button
              key={p.path}
              type="button"
              onClick={() => {
                onChange(isChecked ? selected.filter((x) => x !== p.path) : [...selected, p.path]);
              }}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                isChecked
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-foreground/40"
              }`}
            >
              {p.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function IdentityPendingPage(): JSX.Element {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedProjects, setSelectedProjects] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pendingData, projectData] = await Promise.all([
        fetchPendingApprovals(),
        fetchProjects().catch(() => [] as ProjectInfo[]),
      ]);
      setPending(pendingData);
      setProjects(projectData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const handleApprove = useCallback(async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await approvePendingApproval(id, { projectPaths: selectedProjects[id] ?? [] });
      setSelectedProjects((prev) => { const n = { ...prev }; delete n[id]; return n; });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [load, selectedProjects]);

  const handleReject = useCallback(async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await rejectPendingApproval(id);
      setSelectedProjects((prev) => { const n = { ...prev }; delete n[id]; return n; });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const byProject = useMemo(() => {
    const out: Record<string, PendingApproval[]> = {};
    for (const p of pending) {
      const key = p.projectPath;
      if (!out[key]) out[key] = [];
      out[key]!.push(p);
    }
    return out;
  }, [pending]);

  return (
    <PageScroll>
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Pending Identity Approvals</h1>
            <p className="text-[12px] text-muted-foreground mt-1">
              Unknown users who messaged a configured channel. Approve to grant verified access; reject to drop future messages.
              Bind a room to a project (via Projects → Channels tab) to enable message gating.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} data-testid="identity-pending-refresh">
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>

        {error !== null && (
          <Card className="p-4 mb-4 border-red/40 bg-red/5" data-testid="identity-pending-error">
            <span className="text-[13px] text-red">{error}</span>
          </Card>
        )}

        {!loading && pending.length === 0 && error === null && (
          <Card className="p-8 text-center" data-testid="identity-pending-empty">
            <span className="text-[14px] text-muted-foreground">
              No pending approvals. When unknown users message a configured channel, they'll appear here.
            </span>
          </Card>
        )}

        {Object.entries(byProject).map(([projectPath, entries]) => (
          <Card key={projectPath || "__unbound__"} className="p-4 mb-4" data-testid={`identity-pending-project-${(projectPath || "unbound").replace(/[^a-zA-Z0-9]/g, "_")}`}>
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
              <span className="text-[13px] font-semibold text-card-foreground truncate">
                {projectPath || "Unbound Channels"}
              </span>
              <span className="text-[10px] text-muted-foreground">
                · {entries.length} pending
                {!projectPath && " · bind a room to a project to enable gating"}
              </span>
            </div>
            <div className="space-y-3">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="p-3 rounded border border-border/60 hover:border-border transition-colors"
                  data-testid={`identity-pending-entry-${entry.id.replace(/[^a-zA-Z0-9]/g, "_")}`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-[18px] shrink-0 mt-0.5" aria-hidden>
                      {channelEmoji(entry.channelId)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-foreground truncate">
                          {entry.displayName}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          · {entry.channelId} · {relativeTime(entry.createdAt)}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">
                        room: {entry.roomId} · user: {entry.channelUserId}
                      </div>
                      {entry.firstMessagePreview.length > 0 && (
                        <div className="text-[11px] text-foreground/80 mt-1.5 italic line-clamp-2">
                          "{entry.firstMessagePreview}"
                        </div>
                      )}

                      {/* s195 — registration data collected during DM flow */}
                      {entry.registrationData !== undefined && (
                        <div className="mt-2 p-2 rounded bg-muted/40 border border-border/40 space-y-0.5">
                          <div className="text-[10px] font-medium text-muted-foreground mb-1">Registration data</div>
                          {entry.registrationData.name !== undefined && (
                            <div className="text-[11px] text-foreground font-mono">Name: {entry.registrationData.name}</div>
                          )}
                          {entry.registrationData.email !== undefined && (
                            <div className="text-[11px] text-foreground font-mono">Email: {entry.registrationData.email}</div>
                          )}
                          {entry.registrationData.birthdate !== undefined && (
                            <div className="text-[11px] text-foreground font-mono">Birthdate: {entry.registrationData.birthdate}</div>
                          )}
                          {entry.registrationData.discordHandle !== undefined && (
                            <div className="text-[11px] text-foreground font-mono">Discord: @{entry.registrationData.discordHandle}</div>
                          )}
                        </div>
                      )}

                      {/* s195 — project assignment before approving */}
                      <ProjectSelector
                        projects={projects}
                        selected={selectedProjects[entry.id] ?? []}
                        onChange={(paths) => setSelectedProjects((prev) => ({ ...prev, [entry.id]: paths }))}
                      />
                    </div>

                    <div className="flex flex-col gap-1.5 shrink-0">
                      <Button
                        size="xs"
                        onClick={() => void handleApprove(entry.id)}
                        disabled={busyId === entry.id}
                        data-testid={`identity-pending-approve-${entry.id.replace(/[^a-zA-Z0-9]/g, "_")}`}
                      >
                        {busyId === entry.id ? "…" : "Approve"}
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => void handleReject(entry.id)}
                        disabled={busyId === entry.id}
                        data-testid={`identity-pending-reject-${entry.id.replace(/[^a-zA-Z0-9]/g, "_")}`}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </PageScroll>
  );
}
