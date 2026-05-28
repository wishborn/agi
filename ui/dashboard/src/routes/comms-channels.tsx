/**
 * Channel Management — /comms/channels
 *
 * Per-channel mode picker, config cards (agent assignment, memory scope,
 * tool access, auto-moderation, escalation rules, prompt override, role
 * overrides, rate limits, semantic topic detection) and a live-preview
 * right panel showing recent comms log entries for the selected channel.
 *
 * Matches the Aionima Channel design pack (screens/channels.jsx).
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { PageScroll } from "@/components/PageScroll.js";
import {
  CHANNEL_MODES,
  CHANNEL_MODE_META,
  type DiscordChannelMode,
} from "@/components/ChannelModeBadge.js";
import {
  fetchChannels,
  fetchChannelConfig,
  updateChannelConfig,
  fetchCommsLog,
  type ChannelListEntry,
} from "@/api.js";
import type { CommsLogEntry } from "@/types.js";

// ---------------------------------------------------------------------------
// ConfigCard — aio-panel style card with header
// ---------------------------------------------------------------------------

function ConfigCard({
  title,
  right,
  children,
  accent,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card flex flex-col min-w-0">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border shrink-0">
        {accent && <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", accent)} />}
        <span className="text-[11.5px] font-semibold text-foreground flex-1 truncate">{title}</span>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      <div className="p-3.5 flex-1 min-h-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfBar — confidence / value fill bar
// ---------------------------------------------------------------------------

function ConfBar({ value, color = "violet" }: { value: number; color?: string }) {
  const colorCls =
    color === "amber" ? "bg-amber-400" :
    color === "rose"  ? "bg-rose-400"  :
    color === "em"    ? "bg-emerald-400" :
    color === "sky"   ? "bg-sky-400"   :
    "bg-violet-400";
  return (
    <div className="flex-1 h-[4px] bg-border rounded-full overflow-hidden">
      <div className={cn("h-full rounded-full", colorCls)} style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle row — label + sub + on/off pill
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  sub,
  on,
  onChange,
}: {
  label: string;
  sub?: string;
  on: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2.5 py-2 border-b border-border/60 last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-foreground">{label}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange?.(!on)}
        className={cn(
          "w-[30px] h-[18px] rounded-full relative shrink-0 transition-colors",
          on ? "bg-violet-500" : "bg-border",
        )}
        aria-pressed={on}
      >
        <span
          className={cn(
            "absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all",
            on ? "left-[14px]" : "left-[2px]",
          )}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool tag
// ---------------------------------------------------------------------------

function ToolTag({ label, on, locked }: { label: string; on: boolean; locked?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono border transition-colors",
        on
          ? "bg-sky-500/10 text-sky-500 border-sky-500/25 dark:text-sky-300"
          : "bg-secondary/30 text-muted-foreground border-border/50",
        locked && "opacity-50 cursor-not-allowed",
      )}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// MemoryScopeToggle — 2×2 card grid
// ---------------------------------------------------------------------------

const MEMORY_SCOPES = [
  { key: "channel",  label: "Channel memory", sub: "Last 1,000 msgs · 30d" },
  { key: "server",   label: "Server memory",  sub: "Cross-channel, shared" },
  { key: "user",     label: "User memory",    sub: "Per-user profile + history" },
  { key: "thread",   label: "Thread memory",  sub: "Per-thread isolated" },
] as const;

function MemoryScope({ enabled }: { enabled: Record<string, boolean> }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {MEMORY_SCOPES.map((s) => {
          const on = enabled[s.key] ?? false;
          return (
            <div
              key={s.key}
              className={cn(
                "rounded-lg border px-3 py-2",
                on ? "border-violet-500/25 bg-violet-500/5" : "border-border bg-secondary/20",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", on ? "bg-violet-400" : "bg-zinc-500")} />
                <span className="text-[12px] font-semibold">{s.label}</span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">{s.sub}</div>
            </div>
          );
        })}
      </div>
      <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
        <span>Expiration:</span>
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 text-[10px] font-medium">rolling · 90d</span>
        <span>· PII:</span>
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 text-[10px] font-medium">redacted</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModThresholds — auto-moderation threshold bars
// ---------------------------------------------------------------------------

const MOD_THRESHOLDS = [
  { label: "Toxicity threshold", value: 0.72, color: "amber" },
  { label: "Spam detection",     value: 0.85, color: "violet" },
  { label: "PII redaction",      value: 0.95, color: "em" },
  { label: "Jailbreak guard",    value: 0.78, color: "rose" },
] as const;

function ModThresholds() {
  return (
    <div className="space-y-0">
      {MOD_THRESHOLDS.map((t, i) => (
        <div
          key={t.label}
          className={cn("grid items-center gap-2.5 py-2", i < MOD_THRESHOLDS.length - 1 && "border-b border-border/60")}
          style={{ gridTemplateColumns: "130px 1fr 32px" }}
        >
          <span className="text-[12px] text-foreground">{t.label}</span>
          <ConfBar value={t.value} color={t.color} />
          <span className="text-[11px] font-mono text-muted-foreground text-right">{t.value.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EscalationRules
// ---------------------------------------------------------------------------

const ESCALATION_RULES = [
  { trigger: "sentiment < -0.6",              to: "@willow + #moderator-only", live: false },
  { trigger: "keyword: refund | chargeback",   to: "#funding-leads",           live: false },
  { trigger: "VIP role mention",              to: "PagerDuty · ops on-call",  live: true  },
  { trigger: "conf < 0.45 AND length > 60w",  to: "human approval queue",     live: false },
] as const;

function EscalationRules() {
  const active = ESCALATION_RULES.filter((r) => r.live).length;
  return (
    <div className="space-y-1.5">
      {ESCALATION_RULES.map((r, i) => (
        <div
          key={i}
          className={cn(
            "grid items-center gap-2 px-2.5 py-2 rounded-lg border",
            r.live ? "border-amber-500/25 bg-amber-500/5" : "border-border bg-secondary/10",
          )}
          style={{ gridTemplateColumns: "1fr auto" }}
        >
          <div className="min-w-0">
            <div className={cn("text-[11.5px] font-mono", r.live ? "text-amber-400" : "text-foreground")}>{r.trigger}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">→ {r.to}</div>
          </div>
          {r.live
            ? <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0 animate-pulse" />
            : <span className="text-[10.5px] text-muted-foreground/60">idle</span>
          }
        </div>
      ))}
      {active > 0 && (
        <div className="text-[10px] text-amber-500 font-medium pt-0.5">{active} rule active</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PromptOverride
// ---------------------------------------------------------------------------

function PromptOverride() {
  return (
    <div className="rounded-lg bg-zinc-950 border border-border/60 p-3 font-mono text-[11px] leading-relaxed overflow-x-auto">
      <div><span className="text-zinc-500">// inherits: system.md → scope</span></div>
      <div className="mt-1">
        <span className="text-sky-400">system</span>
        <span className="text-zinc-400">: </span>
        <span className="text-amber-300">"You are Aion, helping this channel's members. Lead with context, never with names."</span>
      </div>
      <div>
        <span className="text-sky-400">tone</span>
        <span className="text-zinc-400">:   </span>
        <span className="text-amber-300">"warm, direct, no exclamation marks"</span>
      </div>
      <div>
        <span className="text-sky-400">refuse</span>
        <span className="text-zinc-400">: </span>
        <span className="text-emerald-400">["pricing", "investor intros"]</span>
        <span className="text-zinc-400"> → escalate</span>
      </div>
      <div>
        <span className="text-sky-400">temp</span>
        <span className="text-zinc-400">:   </span>
        <span className="text-violet-400">0.4</span>
        <span className="text-zinc-400">   </span>
        <span className="text-sky-400">max_turn</span>
        <span className="text-zinc-400">: </span>
        <span className="text-violet-400">6</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentAssignment
// ---------------------------------------------------------------------------

const MOCK_AGENTS = [
  { name: "Aion",     model: "claude-4",    role: "Primary",    weight: 70,  brand: true },
  { name: "ModBot",   model: "opus-4",      role: "Moderation", weight: 20,  brand: false },
  { name: "Digest",   model: "sonnet-4",    role: "Background", weight: 10,  brand: false },
] as const;

function AgentAssignment() {
  return (
    <div>
      {MOCK_AGENTS.map((a, i) => (
        <div
          key={a.name}
          className={cn("grid items-center gap-2.5 py-2", i < MOCK_AGENTS.length - 1 && "border-b border-border/60")}
          style={{ gridTemplateColumns: "32px 1fr 80px 40px" }}
        >
          <div className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0",
            a.brand
              ? "bg-gradient-to-br from-violet-500 to-violet-700 text-white"
              : "bg-secondary border border-border text-muted-foreground",
          )}>
            {a.name.slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold text-foreground">
              {a.name}
              <span className="ml-1.5 text-[10px] font-mono text-muted-foreground/70 font-normal">{a.model}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">{a.role}</div>
          </div>
          <ConfBar value={a.weight / 100} color={a.brand ? "violet" : "sky"} />
          <div className="text-[11px] font-mono text-muted-foreground text-right">{a.weight}%</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoleOverrides
// ---------------------------------------------------------------------------

const ROLE_OVERRIDES = [
  { role: "admin",         allow: "all",                color: "emerald" },
  { role: "Leaders",       allow: "all",                color: "emerald" },
  { role: "Interns",       allow: "respond",            color: "violet" },
  { role: "Clients",       allow: "respond + memory",   color: "violet" },
  { role: "Mentors",       allow: "monitor",            color: "sky" },
  { role: "Testers",       allow: "none",               color: "zinc" },
] as const;

const ROLE_BADGE: Record<string, string> = {
  emerald: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  violet:  "bg-violet-500/10 text-violet-500 border-violet-500/20",
  sky:     "bg-sky-500/10 text-sky-500 border-sky-500/20",
  zinc:    "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

function RoleOverrides() {
  return (
    <div className="space-y-0">
      {ROLE_OVERRIDES.map((r, i) => (
        <div
          key={r.role}
          className={cn("flex items-center justify-between py-1.5", i < ROLE_OVERRIDES.length - 1 && "border-b border-border/60")}
        >
          <span className="text-[12px] text-foreground">{r.role}</span>
          <span className={cn("inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium", ROLE_BADGE[r.color] ?? "")}>
            {r.allow}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopicTags
// ---------------------------------------------------------------------------

const TOPIC_TAGS = [
  ["sprint-matching", 38],
  ["payments",        18],
  ["dev-stack",       24],
  ["pitch-help",      12],
  ["intros",           8],
  ["scheduling",       5],
] as const;

function TopicTags() {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {TOPIC_TAGS.map(([label, count]) => (
          <span key={label} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-secondary border border-border text-[11px] text-foreground">
            {label}
            <span className="text-[10px] font-mono text-muted-foreground">{count}</span>
          </span>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Auto-tagged threads route to relevant agents.{" "}
        <span className="text-sky-400 cursor-pointer hover:text-sky-300">Review →</span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LivePreviewPanel — right inspector for channel management
// ---------------------------------------------------------------------------

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function LivePreviewPanel({
  channelId,
  channelName,
}: {
  channelId: string;
  channelName: string;
}) {
  const [entries, setEntries] = useState<CommsLogEntry[]>([]);
  const [paused, setPaused] = useState(false);

  const load = useCallback(async () => {
    if (paused) return;
    try {
      const res = await fetchCommsLog({ channel: channelId, limit: 10 });
      setEntries(res.entries.slice(0, 10));
    } catch {
      // silently ignore — preview is best-effort
    }
  }, [channelId, paused]);

  useEffect(() => { void load(); }, [load]);

  return (
    <aside className="w-[300px] shrink-0 border-l border-border bg-card flex flex-col min-h-0">
      {/* Panel header */}
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border shrink-0">
        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse" />
        <span className="text-[12.5px] font-semibold text-foreground flex-1">Live preview</span>
        <span className="text-[11px] text-muted-foreground truncate max-w-[70px]">· {channelName}</span>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="p-1 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors ml-1"
          aria-label={paused ? "Resume preview" : "Pause preview"}
          title={paused ? "Resume" : "Pause"}
        >
          {paused ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5,3 19,12 5,21" /></svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="6" y1="4" x2="6" y2="20" /><line x1="18" y1="4" x2="18" y2="20" /></svg>
          )}
        </button>
      </div>

      {/* Message thread */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-1.5">
            <span className="text-muted-foreground/30 text-2xl">✦</span>
            <p className="text-[12px] text-muted-foreground text-center">No recent messages</p>
          </div>
        ) : (
          entries.map((e) => {
            const isOutbound = e.direction === "outbound";
            const initials = (e.senderName ?? e.senderId).slice(0, 2).toUpperCase();
            return (
              <div key={e.id} className="grid gap-2" style={{ gridTemplateColumns: "24px 1fr" }}>
                <div className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5",
                  isOutbound
                    ? "bg-gradient-to-br from-violet-500 to-violet-700 text-white"
                    : "bg-secondary border border-border text-muted-foreground",
                )}>
                  {initials}
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5 mb-0.5">
                    <span className={cn("text-[12px] font-semibold", isOutbound ? "text-violet-400" : "text-foreground")}>
                      {e.senderName ?? e.senderId}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 font-mono">{relTime(e.createdAt)}</span>
                  </div>
                  <p className="text-[12px] text-muted-foreground leading-relaxed line-clamp-3">{e.preview}</p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="px-3.5 py-2 border-t border-border shrink-0 flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground/60 flex-1">Last decision</span>
        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 text-[10px] font-medium">routed</span>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Mode picker
// ---------------------------------------------------------------------------

interface ModPickerProps {
  current: DiscordChannelMode;
  onChange: (mode: DiscordChannelMode) => void;
  disabled?: boolean;
}

function ModePicker({ current, onChange, disabled }: ModPickerProps) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
      {CHANNEL_MODES.map((m) => {
        const meta = CHANNEL_MODE_META[m];
        const selected = m === current;
        return (
          <button
            key={m}
            type="button"
            disabled={disabled}
            onClick={() => onChange(m)}
            className={cn(
              "rounded-lg p-2.5 text-left border transition-colors",
              selected
                ? "border-violet-500/40 bg-violet-500/8"
                : "border-border bg-card hover:border-border/80 hover:bg-secondary/30",
              disabled && "opacity-50 pointer-events-none",
            )}
          >
            <div className="flex items-center gap-1.5 mb-2">
              <span className={cn(
                "inline-flex items-center gap-1 h-[18px] px-1.5 rounded-full border text-[9.5px] font-semibold uppercase tracking-wide",
                meta.badge,
              )}>
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", meta.dot)} />
                {meta.label}
              </span>
              {selected && <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0 ml-auto animate-pulse" />}
            </div>
            <div className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">{meta.description}</div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool access — static list (config.tools overlay from channel config)
// ---------------------------------------------------------------------------

const TOOL_LIST = [
  { label: "memory.recall",   on: true  },
  { label: "memory.write",    on: true  },
  { label: "web.search",      on: true  },
  { label: "discord.react",   on: true  },
  { label: "discord.timeout", on: false },
  { label: "discord.ban",     on: false, locked: true },
  { label: "user.profile",    on: true  },
  { label: "knowledge.query", on: true  },
  { label: "calendar.book",   on: false },
  { label: "code.run",        on: false, locked: true },
  { label: "sentiment.score", on: true  },
  { label: "summarize.thread",on: true  },
] as const;

function ToolAccess() {
  const enabled = TOOL_LIST.filter((t) => t.on).length;
  return (
    <div className="flex flex-wrap gap-1.5">
      {TOOL_LIST.map((t) => (
        <ToolTag key={t.label} label={t.label} on={t.on} locked={"locked" in t ? t.locked : false} />
      ))}
      <div className="w-full text-[10.5px] text-muted-foreground/60 mt-1">{enabled} of {TOOL_LIST.length} enabled</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rate limits — toggle rows
// ---------------------------------------------------------------------------

const RATE_LIMITS = [
  { label: "Replies / minute",    sub: "Soft cap 6 · Hard cap 12",           on: true  },
  { label: "Tokens / hour",       sub: "Cap 220k · Now 38k",                 on: true  },
  { label: "Per-user cooldown",   sub: "30s between replies to same user",   on: true  },
  { label: "Backoff on errors",   sub: "Exponential · max 5m",               on: false },
];

function RateLimits() {
  const [rows, setRows] = useState(RATE_LIMITS.map((r) => ({ ...r })));
  return (
    <div>
      {rows.map((r, i) => (
        <ToggleRow
          key={i}
          label={r.label}
          sub={r.sub}
          on={r.on}
          onChange={(v) => setRows((prev) => prev.map((row, j) => j === i ? { ...row, on: v } : row))}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CommsChannelsPage() {
  const [channels, setChannels] = useState<ChannelListEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<DiscordChannelMode>("respond");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [memScope, setMemScope] = useState<Record<string, boolean>>({
    channel: true, server: true, user: true, thread: false,
  });

  // Load channel list
  useEffect(() => {
    fetchChannels()
      .then((list) => {
        setChannels(list);
        if (list.length > 0 && selectedId === null) setSelectedId(list[0].id);
      })
      .catch(() => {/* best-effort */});
  }, [selectedId]);

  // Load config when channel changes
  useEffect(() => {
    if (!selectedId) return;
    fetchChannelConfig(selectedId)
      .then((cfg) => {
        const m = cfg.config.mode as DiscordChannelMode | undefined;
        if (m && CHANNEL_MODES.includes(m)) setMode(m);
        else setMode("respond");
        setDirty(false);
      })
      .catch(() => {/* best-effort — keep current mode */});
  }, [selectedId]);

  const handleModeChange = useCallback((m: DiscordChannelMode) => {
    setMode(m);
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      await updateChannelConfig(selectedId, { config: { mode } });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [selectedId, mode]);

  const selected = channels.find((c) => c.id === selectedId);

  return (
    <PageScroll className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Layout: config area + live preview panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Config area — scrollable */}
        <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-[12px] text-muted-foreground font-mono">Channels</span>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground/50" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
              {/* Channel selector */}
              <select
                value={selectedId ?? ""}
                onChange={(e) => setSelectedId(e.target.value)}
                className="bg-transparent border-none outline-none text-[14px] font-semibold text-foreground font-mono cursor-pointer"
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                {channels.length === 0 && <option value="">No channels</option>}
              </select>
              {selected && (
                <span className={cn(
                  "inline-flex items-center gap-1 h-[20px] px-2 rounded-full border text-[10.5px] font-semibold",
                  CHANNEL_MODE_META[mode].badge,
                )}>
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", CHANNEL_MODE_META[mode].dot)} />
                  {CHANNEL_MODE_META[mode].label}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!dirty || saving || !selectedId}
              className={cn(
                "inline-flex items-center gap-1.5 h-[28px] px-3 rounded-lg text-[11.5px] font-semibold transition-colors border",
                dirty && !saving
                  ? "bg-violet-500 text-white border-violet-600 hover:bg-violet-600"
                  : "bg-secondary text-muted-foreground border-border cursor-not-allowed",
              )}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>

          {/* Mode picker section */}
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Mode</div>
                <div className="text-[12px] text-muted-foreground mt-0.5">How Aion participates in this channel.</div>
              </div>
            </div>
            <ModePicker current={mode} onChange={handleModeChange} disabled={!selectedId} />
          </div>

          {/* Config cards 2-col grid */}
          <div className="p-4 grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <ConfigCard
              title="Agent assignment"
              right={
                <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-secondary/50 transition-colors">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  Add
                </button>
              }
            >
              <AgentAssignment />
            </ConfigCard>

            <ConfigCard
              title="Memory scope"
              right={<span className="text-[10.5px] font-mono text-muted-foreground">2,408 vectors · 14.2 MB</span>}
            >
              <MemoryScope enabled={memScope} />
            </ConfigCard>

            <ConfigCard
              title="Tool access"
            >
              <ToolAccess />
            </ConfigCard>

            <ConfigCard
              title="Auto-moderation"
              accent="bg-amber-500"
            >
              <ModThresholds />
            </ConfigCard>

            <ConfigCard
              title="Escalation rules"
              right={
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20 text-[10px] font-medium">3 active</span>
              }
            >
              <EscalationRules />
            </ConfigCard>

            <ConfigCard
              title="Prompt override"
              right={
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 text-[10px] font-medium">channel-scoped</span>
              }
            >
              <PromptOverride />
            </ConfigCard>
          </div>

          {/* Bottom strip — 3-col */}
          <div className="px-4 pb-4 grid gap-3" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <ConfigCard title="Role overrides">
              <RoleOverrides />
            </ConfigCard>
            <ConfigCard title="Rate limits">
              <RateLimits />
            </ConfigCard>
            <ConfigCard
              title="Semantic topic detection"
              right={
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[10px] font-medium">live</span>
              }
            >
              <TopicTags />
            </ConfigCard>
          </div>
        </div>

        {/* Live preview panel */}
        <LivePreviewPanel
          channelId={selectedId ?? ""}
          channelName={selected?.name ?? ""}
        />
      </div>
    </PageScroll>
  );
}
