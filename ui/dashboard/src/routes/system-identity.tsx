/**
 * System ▸ Identity — the single home for Identity Management (story #212).
 *
 * Owner directive 2026-06-12: identity lives in ONE place, not buried in or
 * duplicated across Settings. This page consolidates:
 *   - Your Identity (GEID / COA alias)         — was Settings ▸ Identity
 *   - Identity Providers (canonical 6)          — GitHub · Google · Meta · X · Tynn.ai · Civicognita
 *   - Federation / Civicognita (HIVE network)   — was Settings ▸ Gateway
 *
 * Dashboard login accounts stay in Machine Admin (cross-linked below) — this
 * page is about external provider identity + federation, not local access control.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { PageScroll } from "@/components/PageScroll.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Card } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { DevNote } from "@/components/ui/dev-notes.js";
import { cn } from "@/lib/utils";
import { fetchIdentityProviders } from "@/api.js";
import { useConfig } from "@/hooks.js";
import type { AionimaConfig, IdentityProviderView, IdentityProviderStatus } from "@/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OwnerEntityData {
  registered: boolean;
  owner?: { displayName: string; coaAlias: string; geid: string };
  agent?: { coaAlias: string; geid: string };
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

const STATUS_BADGE: Record<IdentityProviderStatus, { label: string; cls: string }> = {
  connected: { label: "Connected", cls: "bg-green/15 text-green border-green/30" },
  available: { label: "Available", cls: "bg-primary/10 text-primary border-primary/30" },
  "needs-config": { label: "Needs OAuth app", cls: "bg-surface1 text-muted-foreground border-border" },
  "federation-gated": { label: "Federation", cls: "bg-surface1 text-muted-foreground border-border" },
};

/** Single-letter brand glyph (icon set registered upstream later). */
function ProviderGlyph({ provider }: { provider: IdentityProviderView }) {
  return (
    <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center text-foreground font-bold shrink-0 text-sm">
      {provider.displayName.charAt(0).toUpperCase()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Device flow (GitHub) — inline, no redirect
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
    <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3" data-testid="identity-device-flow">
      {pollStatus === "pending" && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] text-muted-foreground">Open this link and enter the code:</p>
          <a href={flow.verificationUri} target="_blank" rel="noopener noreferrer" className="text-[11px] text-primary underline break-all">
            {flow.verificationUri}
          </a>
          <div className="flex items-center gap-3 bg-card rounded px-3 py-2 border border-border">
            <code className="text-xl font-mono font-bold tracking-widest text-foreground flex-1">{flow.userCode}</code>
            <span className="text-[10px] text-muted-foreground animate-pulse">Waiting…</span>
          </div>
          <button onClick={onCancel} className="text-[11px] text-muted-foreground hover:text-foreground self-start">Cancel</button>
        </div>
      )}
      {pollStatus === "completed" && <p className="text-sm text-green font-medium">Connected successfully.</p>}
      {(pollStatus === "expired" || pollStatus === "error") && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">{pollStatus === "expired" ? "Code expired." : `Error: ${pollError}`}</p>
          <button onClick={onCancel} className="text-[11px] text-muted-foreground hover:text-foreground self-start">Dismiss</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider card
// ---------------------------------------------------------------------------

function ProviderCard({ provider, onConnectGitHub, onConnectRedirect, onRemove, activeFlow, onFlowComplete, onFlowCancel, flowError }: {
  provider: IdentityProviderView;
  onConnectGitHub: () => void;
  onConnectRedirect: (id: string) => void;
  onRemove: (id: string) => void;
  activeFlow: DeviceFlowState | null;
  onFlowComplete: () => void;
  onFlowCancel: () => void;
  flowError: string | null;
}) {
  const badge = STATUS_BADGE[provider.status];
  const isGitHubFlow = provider.id === "github" && activeFlow;

  return (
    <Card className="p-4 flex flex-col gap-3" data-testid={`identity-provider-${provider.id}`}>
      <div className="flex items-start gap-3">
        <ProviderGlyph provider={provider} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{provider.displayName}</p>
            <Badge
              variant="outline"
              className={cn("text-[10px] border", badge.cls)}
              data-testid={`identity-provider-${provider.id}-status`}
            >
              {provider.status === "connected" && provider.connectedLabel
                ? provider.connectedLabel
                : badge.label}
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{provider.blurb}</p>
        </div>
      </div>

      {/* Action row */}
      <div className="mt-auto">
        {provider.status === "connected" && (
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(provider.id)} data-testid={`identity-remove-${provider.id}`}>
            Remove
          </Button>
        )}

        {provider.status === "available" && provider.id === "github" && !isGitHubFlow && (
          <Button variant="outline" size="sm" onClick={onConnectGitHub} data-testid="identity-connect-github">
            Connect
          </Button>
        )}

        {provider.status === "available" && provider.id !== "github" && (
          <Button variant="outline" size="sm" onClick={() => onConnectRedirect(provider.id)}
            data-testid={`identity-connect-${provider.id}`}>
            Connect
          </Button>
        )}

        {provider.status === "needs-config" && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled className="text-xs opacity-60"
              data-testid={`identity-configure-${provider.id}`}>
              Add OAuth app
            </Button>
            <span className="text-[10px] text-muted-foreground">paste your client ID/secret to enable</span>
          </div>
        )}

        {provider.status === "federation-gated" && (
          <span className="text-[11px] text-muted-foreground" data-testid={`identity-gated-${provider.id}`}>
            Available when federation is online ↓
          </span>
        )}
      </div>

      {isGitHubFlow && (
        <DeviceFlowPrompt flow={activeFlow!} onComplete={onFlowComplete} onCancel={onFlowCancel} />
      )}
      {provider.id === "github" && flowError && (
        <p className="text-[11px] text-destructive">{flowError}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Federation / Civicognita card (relocated from Settings ▸ Gateway)
// ---------------------------------------------------------------------------

function FederationCard() {
  const configHook = useConfig();
  const config = configHook.data;
  const federation = (config as Record<string, unknown> | undefined)?.federation as {
    enabled?: boolean; publicUrl?: string; autoGeid?: boolean; allowVisitors?: boolean;
  } | undefined;
  const [saving, setSaving] = useState(false);

  const setNested = async (patch: (prev: AionimaConfig) => AionimaConfig) => {
    if (!config) return;
    setSaving(true);
    try {
      await configHook.save(patch(config));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: "enabled" | "autoGeid" | "allowVisitors", next: boolean) =>
    void setNested((prev) => ({
      ...prev,
      federation: { ...((prev as Record<string, unknown>).federation as object), [key]: next },
    } as AionimaConfig));

  return (
    <Card className="p-4 space-y-3" data-testid="federation-card">
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          Civicognita Identity · HIVE Federation
        </p>
        <p className="text-[12px] text-muted-foreground mt-1">
          Civicognita is Aionima's federated identity network (formerly Hive-ID). Enabling federation
          brings cross-node entity resolution, Global Entity IDs (GEIDs), and makes the Civicognita
          provider connectable above.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[13px] text-foreground">Enable Federation</span>
        <button
          type="button"
          disabled={saving || !config}
          onClick={() => toggle("enabled", !federation?.enabled)}
          data-testid="federation-toggle"
          className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50",
            federation?.enabled ? "bg-green" : "bg-surface1")}
        >
          <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
            federation?.enabled ? "translate-x-4" : "translate-x-0.5")} />
        </button>
      </div>

      {federation?.enabled && (
        <>
          <div>
            <label className="text-[11px] text-muted-foreground">Public URL</label>
            <Input
              type="text"
              defaultValue={federation.publicUrl ?? ""}
              placeholder="https://your-node.example.com"
              className="text-[13px] mt-1"
              onBlur={(e) => void setNested((prev) => ({
                ...prev,
                federation: { ...((prev as Record<string, unknown>).federation as object), publicUrl: e.target.value },
              } as AionimaConfig))}
            />
            <p className="text-[10px] text-muted-foreground mt-1">Your node's public URL for HIVE registration and peer discovery.</p>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-foreground">Auto-generate GEIDs</span>
            <button type="button" onClick={() => toggle("autoGeid", !(federation.autoGeid !== false))}
              className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                federation.autoGeid !== false ? "bg-green" : "bg-surface1")}>
              <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                federation.autoGeid !== false ? "translate-x-4" : "translate-x-0.5")} />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-foreground">Allow Visitors</span>
            <button type="button" onClick={() => toggle("allowVisitors", !(federation.allowVisitors !== false))}
              className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                federation.allowVisitors !== false ? "bg-green" : "bg-surface1")}>
              <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                federation.allowVisitors !== false ? "translate-x-4" : "translate-x-0.5")} />
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function IdentityServicePage() {
  const [providers, setProviders] = useState<IdentityProviderView[]>([]);
  const [entity, setEntity] = useState<OwnerEntityData>({ registered: false });
  const [loading, setLoading] = useState(true);
  const [activeFlow, setActiveFlow] = useState<DeviceFlowState | null>(null);
  const [startingFlow, setStartingFlow] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [copiedGeid, setCopiedGeid] = useState(false);

  const loadData = useCallback(async () => {
    const [provRes, entityRes] = await Promise.allSettled([
      fetchIdentityProviders(),
      fetch("/api/onboarding/owner-entity").then((r) => r.json() as Promise<OwnerEntityData>),
    ]);
    if (provRes.status === "fulfilled") setProviders(provRes.value);
    if (entityRes.status === "fulfilled") setEntity(entityRes.value);
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

  const connectRedirect = async (provider: string) => {
    try {
      const res = await fetch(`/api/auth/start/${encodeURIComponent(provider)}`, { method: "POST" });
      const data = await res.json() as { authUrl?: string; error?: string };
      if (data.authUrl) { window.location.href = data.authUrl; return; }
      setFlowError(data.error ?? `Could not start ${provider} sign-in`);
    } catch {
      setFlowError(`Request failed for ${provider}`);
    }
  };

  const removeConnection = async (provider: string) => {
    await fetch(`/api/auth/device-flow/connection?provider=${encodeURIComponent(provider)}&role=owner`, { method: "DELETE" });
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

  return (
    <PageScroll>
      <div className="max-w-4xl space-y-6" data-testid="system-identity-page">
        <DevNote heading="Cycle — Identity unified into one page (story #212)" kind="info">
          Identity Management now lives only here. The six canonical providers (GitHub, Google, Meta,
          X, Tynn.ai, Civicognita) render from a single backend registry. GitHub connects today via
          device flow; Google/Meta/X/Tynn.ai become connectable once you add their OAuth app (setup
          ships in Slice 2); Civicognita unlocks when federation is enabled below. Settings ▸ Identity
          now redirects here, and federation config moved off Settings ▸ Gateway.
        </DevNote>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Identity</h1>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              The single home for your identity, connected providers, and federation.
            </p>
          </div>
          <Link
            to="/admin"
            className="text-[12px] text-primary hover:underline shrink-0 mt-1"
            data-testid="identity-machine-admin-link"
          >
            Dashboard login accounts → Machine Admin
          </Link>
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground p-6">Loading…</div>
        ) : (
          <>
            {/* Your Identity */}
            <Card className="p-4 space-y-3" data-testid="your-identity-card">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Your Identity</p>
              {!entity.registered || !entity.owner ? (
                <p className="text-sm text-muted-foreground">
                  No identity registered yet. Complete the{" "}
                  <a href="/onboarding" className="text-primary underline">Onboarding</a> Owner Profile step first.
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
                    <code className="text-xs font-mono text-foreground flex-1 truncate">{truncateGeid(entity.owner.geid)}</code>
                    <button onClick={() => copyGeid(entity.owner!.geid)} className="text-[11px] text-muted-foreground hover:text-foreground shrink-0">
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

            {/* Identity Providers */}
            <div className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Identity Providers</h2>
                <p className="text-[12px] text-muted-foreground">
                  Connect external accounts so Aion can act on your behalf. Identity services are core,
                  critical infrastructure — these are the common providers.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="identity-provider-grid">
                {providers.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    onConnectGitHub={() => void startGitHub()}
                    onConnectRedirect={(id) => void connectRedirect(id)}
                    onRemove={(id) => void removeConnection(id)}
                    activeFlow={activeFlow}
                    onFlowComplete={() => void handleFlowComplete()}
                    onFlowCancel={() => setActiveFlow(null)}
                    flowError={p.id === "github" && !startingFlow ? flowError : null}
                  />
                ))}
              </div>
            </div>

            {/* Federation / Civicognita */}
            <FederationCard />
          </>
        )}
      </div>
    </PageScroll>
  );
}
