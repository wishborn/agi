/**
 * Settings > Identity — OAuth connections and registered identity info.
 *
 * Shows:
 *  - Your identity: GEID, COA alias, display name (read from onboarding/owner-entity)
 *  - OAuth connections: add GitHub via inline device flow, remove existing connections
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PageScroll } from "@/components/PageScroll.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Card } from "@/components/ui/card.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OwnerEntityData {
  registered: boolean;
  owner?: { displayName: string; coaAlias: string; geid: string };
  agent?: { coaAlias: string; geid: string };
}

interface Connection {
  provider: string;
  role: string;
  accountLabel: string | null;
  updatedAt?: string | null;
}

interface DeviceFlowState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateGeid(geid: string): string {
  if (geid.length <= 22) return geid;
  return `${geid.slice(0, 16)}…${geid.slice(-6)}`;
}

// ---------------------------------------------------------------------------
// Device Flow inline component
// ---------------------------------------------------------------------------

function DeviceFlowPrompt({ flow, onComplete, onCancel }: {
  flow: DeviceFlowState;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [pollStatus, setPollStatus] = useState<"pending" | "completed" | "error" | "expired">("pending");
  const [pollError, setPollError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentInterval = useRef(flow.interval * 1000);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/auth/device-flow/poll?deviceCode=${encodeURIComponent(flow.deviceCode)}`);
        const data = await res.json() as { status: string; interval?: number; error?: string };
        if (data.status === "completed") {
          clearInterval(intervalRef.current!);
          setPollStatus("completed");
          setTimeout(onComplete, 1200);
        } else if (data.status === "expired") {
          clearInterval(intervalRef.current!);
          setPollStatus("expired");
        } else if (data.status === "error") {
          clearInterval(intervalRef.current!);
          setPollStatus("error");
          setPollError(data.error ?? "Unknown error");
        } else if (data.interval && data.interval * 1000 !== currentInterval.current) {
          clearInterval(intervalRef.current!);
          currentInterval.current = data.interval * 1000;
          intervalRef.current = setInterval(() => { void poll(); }, currentInterval.current);
        }
      } catch { /* transient */ }
    };

    intervalRef.current = setInterval(() => { void poll(); }, currentInterval.current);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [flow.deviceCode, onComplete]);

  return (
    <Card className="p-4 border-primary/20 bg-primary/5">
      <p className="text-xs font-semibold text-foreground mb-3">GitHub Authorization</p>

      {pollStatus === "pending" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Open the link below in your browser and enter the code shown:
          </p>
          <a
            href={flow.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary underline break-all"
          >
            {flow.verificationUri}
          </a>
          <div className="flex items-center gap-3 bg-card rounded px-4 py-3 border border-border">
            <code className="text-2xl font-mono font-bold tracking-widest text-foreground flex-1">
              {flow.userCode}
            </code>
            <span className="text-[11px] text-muted-foreground animate-pulse">Waiting…</span>
          </div>
          <button onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground self-start">
            Cancel
          </button>
        </div>
      )}

      {pollStatus === "completed" && (
        <p className="text-sm text-green font-medium">GitHub connected successfully.</p>
      )}

      {(pollStatus === "expired" || pollStatus === "error") && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">
            {pollStatus === "expired" ? "Code expired." : `Error: ${pollError}`}
          </p>
          <button onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground self-start">
            Dismiss
          </button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SettingsIdentityPage() {
  const [entity, setEntity] = useState<OwnerEntityData>({ registered: false });
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFlow, setActiveFlow] = useState<DeviceFlowState | null>(null);
  const [startingFlow, setStartingFlow] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [copiedGeid, setCopiedGeid] = useState(false);

  const loadData = useCallback(async () => {
    const [entityRes, connRes] = await Promise.allSettled([
      fetch("/api/onboarding/owner-entity").then((r) => r.json() as Promise<OwnerEntityData>),
      fetch("/api/auth/device-flow/status").then((r) => r.json() as Promise<Connection[]>),
    ]);
    if (entityRes.status === "fulfilled") setEntity(entityRes.value);
    if (connRes.status === "fulfilled") setConnections(connRes.value);
  }, []);

  useEffect(() => {
    void loadData().finally(() => setLoading(false));
  }, [loadData]);

  const startGitHub = async () => {
    setStartingFlow(true);
    setFlowError(null);
    try {
      const res = await fetch("/api/auth/device-flow/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "github", role: "owner" }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setFlowError(d.error ?? "Failed to start");
        return;
      }
      setActiveFlow(await res.json() as DeviceFlowState);
    } catch {
      setFlowError("Request failed — check gateway connection");
    } finally {
      setStartingFlow(false);
    }
  };

  const removeConnection = async (provider: string, role: string) => {
    await fetch(`/api/auth/device-flow/connection?provider=${encodeURIComponent(provider)}&role=${encodeURIComponent(role)}`, {
      method: "DELETE",
    });
    await loadData();
  };

  const handleFlowComplete = async () => {
    setActiveFlow(null);
    await loadData();
  };

  const copyGeid = (geid: string) => {
    void navigator.clipboard.writeText(geid).then(() => {
      setCopiedGeid(true);
      setTimeout(() => setCopiedGeid(false), 2000);
    });
  };

  if (loading) return <PageScroll><div className="text-sm text-muted-foreground p-6">Loading…</div></PageScroll>;

  const githubConnected = connections.some((c) => c.provider === "github");

  return (
    <PageScroll>
      <div className="max-w-xl space-y-6">
        <div>
          <h2 className="text-base font-semibold mb-0.5">Identity</h2>
          <p className="text-[13px] text-muted-foreground">Your registered identity and OAuth connections.</p>
        </div>

        {/* Your Identity card */}
        <Card className="p-4 space-y-3">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Your Identity</p>

          {!entity.registered || !entity.owner ? (
            <p className="text-sm text-muted-foreground">
              No identity registered yet. Complete the <a href="/onboarding" className="text-primary underline">Onboarding</a> Owner Profile step first.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold shrink-0">
                  {entity.owner.displayName.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-medium">{entity.owner.displayName}</p>
                  <p className="text-[11px] text-muted-foreground font-mono">{entity.owner.coaAlias}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 bg-secondary/50 rounded px-3 py-2">
                <code className="text-xs font-mono text-foreground flex-1 truncate">
                  {truncateGeid(entity.owner.geid)}
                </code>
                <button
                  onClick={() => copyGeid(entity.owner!.geid)}
                  className="text-[11px] text-muted-foreground hover:text-foreground shrink-0"
                >
                  {copiedGeid ? "Copied" : "Copy GEID"}
                </button>
              </div>

              {entity.agent?.geid && (
                <div className="pt-1 border-t border-border">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Agent</p>
                  <p className="text-[11px] text-muted-foreground font-mono">{entity.agent.coaAlias}</p>
                  <code className="text-[11px] font-mono text-muted-foreground">{truncateGeid(entity.agent.geid)}</code>
                </div>
              )}
            </div>
          )}
        </Card>

        {/* OAuth Connections card */}
        <Card className="p-4 space-y-3">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">OAuth Connections</p>
          <p className="text-[12px] text-muted-foreground">
            Connect external accounts so Aion can access GitHub and other services on your behalf.
          </p>

          {connections.length === 0 && !activeFlow && (
            <p className="text-sm text-muted-foreground">No connections yet.</p>
          )}

          {connections.map((conn) => (
            <div key={`${conn.provider}-${conn.role}`} className="flex items-center justify-between gap-2 py-1">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-[10px] capitalize">{conn.provider}</Badge>
                {conn.accountLabel && (
                  <span className="text-sm text-foreground">{conn.accountLabel}</span>
                )}
              </div>
              <button
                onClick={() => void removeConnection(conn.provider, conn.role)}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors"
              >
                Remove
              </button>
            </div>
          ))}

          {activeFlow ? (
            <DeviceFlowPrompt
              flow={activeFlow}
              onComplete={() => void handleFlowComplete()}
              onCancel={() => setActiveFlow(null)}
            />
          ) : (
            <div className="pt-1 space-y-2">
              {flowError && <p className="text-xs text-destructive">{flowError}</p>}
              {!githubConnected && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void startGitHub()}
                  disabled={startingFlow}
                >
                  {startingFlow ? "Starting…" : "Connect GitHub"}
                </Button>
              )}
              {githubConnected && (
                <p className="text-xs text-muted-foreground">
                  GitHub connected. Google and Discord require Hive-ID federation (not yet active).
                </p>
              )}
            </div>
          )}
        </Card>
      </div>
    </PageScroll>
  );
}
