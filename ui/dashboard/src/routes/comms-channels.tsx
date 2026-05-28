/**
 * Channel Management — /comms/channels
 *
 * Per-channel behavioral config stored in gateway.json channels[].config.
 * All sections (mode, memory scope, tool access, auto-mod thresholds,
 * escalation rules, prompt override, role overrides, rate limits) read from
 * and write to the real channel config blob via fetchChannelConfig /
 * updateChannelConfig. Agent assignment uses live fetchAgents() data.
 * Live preview reads from the real comms log for the selected channel.
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
  fetchAgents,
  type ChannelListEntry,
} from "@/api.js";
import type { CommsLogEntry, AgentStatus } from "@/types.js";

// ---------------------------------------------------------------------------
// Behavior config schema — everything stored in gateway.json config blob
// ---------------------------------------------------------------------------

export interface MemoryScope {
  channel: boolean;
  server:  boolean;
  user:    boolean;
  thread:  boolean;
}

export interface AutoModConfig {
  toxicity: number;
  spam:     number;
  pii:      number;
  jailbreak: number;
}

export interface EscalationRule {
  trigger: string;
  target:  string;
  live:    boolean;
}

export interface RateLimitConfig {
  repliesPerMin: boolean;
  tokensPerHour: boolean;
  userCooldown:  boolean;
  backoff:       boolean;
}

export interface RoleOverride {
  role:  string;
  allow: string;
}

export interface BehaviorConfig {
  mode:          DiscordChannelMode;
  memory:        MemoryScope;
  tools:         Record<string, boolean>;
  autoMod:       AutoModConfig;
  escalation:    EscalationRule[];
  promptSystem:  string;
  promptTone:    string;
  promptRefuse:  string[];
  promptTemp:    number;
  promptMaxTurn: number;
  roleOverrides: RoleOverride[];
  rateLimits:    RateLimitConfig;
  agentIds:      string[];
}

const TOOL_NAMES = [
  "memory.recall", "memory.write", "web.search",
  "discord.react", "discord.timeout", "discord.ban",
  "user.profile", "knowledge.query", "calendar.book",
  "code.run", "sentiment.score", "summarize.thread",
] as const;

const TOOL_LOCKED = new Set(["discord.ban", "code.run"]);

const DEFAULT_TOOLS: Record<string, boolean> = Object.fromEntries(
  TOOL_NAMES.map((n) => [n, ["memory.recall", "memory.write", "web.search", "discord.react", "user.profile", "knowledge.query", "sentiment.score", "summarize.thread"].includes(n)]),
);

const DEFAULTS: BehaviorConfig = {
  mode: "respond",
  memory: { channel: true, server: true, user: true, thread: false },
  tools: DEFAULT_TOOLS,
  autoMod: { toxicity: 0.72, spam: 0.85, pii: 0.95, jailbreak: 0.78 },
  escalation: [],
  promptSystem: "You are Aion, the personal AI gateway. Help members of this channel.",
  promptTone: "warm, direct, no exclamation marks",
  promptRefuse: [],
  promptTemp: 0.4,
  promptMaxTurn: 6,
  roleOverrides: [],
  rateLimits: { repliesPerMin: true, tokensPerHour: true, userCooldown: true, backoff: false },
  agentIds: [],
};

function parseBehavior(raw: Record<string, unknown>): BehaviorConfig {
  function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === "boolean" ? v : fallback;
  }
  function num(v: unknown, fallback: number): number {
    return typeof v === "number" ? v : fallback;
  }
  function str(v: unknown, fallback: string): string {
    return typeof v === "string" ? v : fallback;
  }

  const mode = ((): DiscordChannelMode => {
    const m = raw["mode"] as string | undefined;
    return m && CHANNEL_MODES.includes(m as DiscordChannelMode) ? (m as DiscordChannelMode) : DEFAULTS.mode;
  })();

  const mem = (raw["memory"] ?? {}) as Partial<MemoryScope>;
  const memory: MemoryScope = {
    channel: bool(mem.channel, DEFAULTS.memory.channel),
    server:  bool(mem.server,  DEFAULTS.memory.server),
    user:    bool(mem.user,    DEFAULTS.memory.user),
    thread:  bool(mem.thread,  DEFAULTS.memory.thread),
  };

  const rawTools = (raw["tools"] ?? {}) as Record<string, unknown>;
  const tools: Record<string, boolean> = { ...DEFAULT_TOOLS };
  for (const k of TOOL_NAMES) {
    if (k in rawTools) tools[k] = bool(rawTools[k], DEFAULT_TOOLS[k]);
  }

  const am = (raw["autoMod"] ?? {}) as Partial<AutoModConfig>;
  const autoMod: AutoModConfig = {
    toxicity:  num(am.toxicity,  DEFAULTS.autoMod.toxicity),
    spam:      num(am.spam,      DEFAULTS.autoMod.spam),
    pii:       num(am.pii,       DEFAULTS.autoMod.pii),
    jailbreak: num(am.jailbreak, DEFAULTS.autoMod.jailbreak),
  };

  const escalation: EscalationRule[] = Array.isArray(raw["escalation"])
    ? (raw["escalation"] as unknown[]).filter((e): e is EscalationRule =>
        e !== null && typeof e === "object" &&
        typeof (e as EscalationRule).trigger === "string" &&
        typeof (e as EscalationRule).target === "string"
      ).map((e) => ({ trigger: e.trigger, target: e.target, live: bool(e.live, false) }))
    : DEFAULTS.escalation;

  const rl = (raw["rateLimits"] ?? {}) as Partial<RateLimitConfig>;
  const rateLimits: RateLimitConfig = {
    repliesPerMin: bool(rl.repliesPerMin, DEFAULTS.rateLimits.repliesPerMin),
    tokensPerHour: bool(rl.tokensPerHour, DEFAULTS.rateLimits.tokensPerHour),
    userCooldown:  bool(rl.userCooldown,  DEFAULTS.rateLimits.userCooldown),
    backoff:       bool(rl.backoff,       DEFAULTS.rateLimits.backoff),
  };

  const roleOverrides: RoleOverride[] = Array.isArray(raw["roleOverrides"])
    ? (raw["roleOverrides"] as unknown[]).filter((r): r is RoleOverride =>
        r !== null && typeof r === "object" &&
        typeof (r as RoleOverride).role === "string" &&
        typeof (r as RoleOverride).allow === "string"
      )
    : DEFAULTS.roleOverrides;

  const agentIds: string[] = Array.isArray(raw["agentIds"])
    ? (raw["agentIds"] as unknown[]).filter((id): id is string => typeof id === "string")
    : DEFAULTS.agentIds;

  const refuse = Array.isArray(raw["promptRefuse"])
    ? (raw["promptRefuse"] as unknown[]).filter((s): s is string => typeof s === "string")
    : DEFAULTS.promptRefuse;

  return {
    mode,
    memory,
    tools,
    autoMod,
    escalation,
    rateLimits,
    roleOverrides,
    agentIds,
    promptSystem:  str(raw["promptSystem"],  DEFAULTS.promptSystem),
    promptTone:    str(raw["promptTone"],    DEFAULTS.promptTone),
    promptRefuse:  refuse,
    promptTemp:    num(raw["promptTemp"],    DEFAULTS.promptTemp),
    promptMaxTurn: num(raw["promptMaxTurn"], DEFAULTS.promptMaxTurn),
  };
}

function serializeBehavior(b: BehaviorConfig): Record<string, unknown> {
  return {
    mode: b.mode,
    memory: b.memory,
    tools: b.tools,
    autoMod: b.autoMod,
    escalation: b.escalation,
    rateLimits: b.rateLimits,
    roleOverrides: b.roleOverrides,
    agentIds: b.agentIds,
    promptSystem: b.promptSystem,
    promptTone: b.promptTone,
    promptRefuse: b.promptRefuse,
    promptTemp: b.promptTemp,
    promptMaxTurn: b.promptMaxTurn,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ConfBar({ value, color = "violet" }: { value: number; color?: string }) {
  const cls =
    color === "amber"   ? "bg-amber-400"   :
    color === "rose"    ? "bg-rose-400"    :
    color === "emerald" ? "bg-emerald-400" :
    color === "sky"     ? "bg-sky-400"     :
    "bg-violet-400";
  return (
    <div className="flex-1 h-[4px] bg-border rounded-full overflow-hidden">
      <div className={cn("h-full rounded-full", cls)} style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange?.(!on)}
      disabled={disabled}
      className={cn(
        "w-[30px] h-[18px] rounded-full relative shrink-0 transition-colors",
        on ? "bg-violet-500" : "bg-border",
        disabled && "opacity-40 pointer-events-none",
      )}
      aria-pressed={on}
    >
      <span className={cn("absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all", on ? "left-[14px]" : "left-[2px]")} />
    </button>
  );
}

function ConfigCard({
  title, right, children, accent,
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
// AgentAssignment — real agents from /api/agents
// ---------------------------------------------------------------------------

function AgentAssignment({
  agents,
  assignedIds,
  onChange,
}: {
  agents: AgentStatus[];
  assignedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  if (agents.length === 0) {
    return <p className="text-[12px] text-muted-foreground py-2">No agents running.</p>;
  }
  return (
    <div>
      {agents.map((a, i) => {
        const assigned = assignedIds.includes(a.id);
        return (
          <div
            key={a.id}
            className={cn("flex items-center gap-2.5 py-2", i < agents.length - 1 && "border-b border-border/60")}
          >
            <div className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0",
              a.status === "running"
                ? "bg-gradient-to-br from-violet-500 to-violet-700 text-white"
                : "bg-secondary border border-border text-muted-foreground",
            )}>
              {a.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-foreground flex items-center gap-1.5">
                {a.name}
                <span className={cn(
                  "inline-block w-1.5 h-1.5 rounded-full shrink-0",
                  a.status === "running" ? "bg-emerald-500" : "bg-zinc-500",
                )} />
              </div>
              <div className="text-[11px] text-muted-foreground capitalize">{a.type} · {a.status}</div>
            </div>
            <Toggle
              on={assigned}
              onChange={(v) => onChange(v ? [...assignedIds, a.id] : assignedIds.filter((id) => id !== a.id))}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MemoryScope
// ---------------------------------------------------------------------------

const MEMORY_OPTS: { key: keyof MemoryScope; label: string; sub: string }[] = [
  { key: "channel", label: "Channel memory", sub: "Last 1,000 msgs · 30d" },
  { key: "server",  label: "Server memory",  sub: "Cross-channel, shared" },
  { key: "user",    label: "User memory",    sub: "Per-user profile + history" },
  { key: "thread",  label: "Thread memory",  sub: "Per-thread isolated" },
];

function MemoryScopeCard({ value, onChange }: { value: MemoryScope; onChange: (v: MemoryScope) => void }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {MEMORY_OPTS.map(({ key, label, sub }) => {
          const on = value[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange({ ...value, [key]: !on })}
              className={cn(
                "rounded-lg border px-3 py-2 text-left transition-colors",
                on ? "border-violet-500/25 bg-violet-500/5" : "border-border bg-secondary/20 hover:bg-secondary/40",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", on ? "bg-violet-400" : "bg-zinc-500")} />
                <span className="text-[12px] font-semibold">{label}</span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">{sub}</div>
            </button>
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
// ToolAccess
// ---------------------------------------------------------------------------

function ToolAccessCard({ tools, onChange }: { tools: Record<string, boolean>; onChange: (v: Record<string, boolean>) => void }) {
  const enabled = TOOL_NAMES.filter((n) => tools[n]).length;
  return (
    <div className="flex flex-wrap gap-1.5">
      {TOOL_NAMES.map((name) => {
        const on = tools[name] ?? false;
        const locked = TOOL_LOCKED.has(name);
        return (
          <button
            key={name}
            type="button"
            disabled={locked}
            onClick={() => !locked && onChange({ ...tools, [name]: !on })}
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono transition-colors",
              on ? "bg-sky-500/10 text-sky-500 border-sky-500/25 dark:text-sky-300" : "bg-secondary/30 text-muted-foreground border-border/50 hover:border-border",
              locked && "opacity-40 cursor-not-allowed",
            )}
          >
            {name}
          </button>
        );
      })}
      <div className="w-full text-[10.5px] text-muted-foreground/60 mt-1">{enabled} of {TOOL_NAMES.length} enabled</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AutoMod
// ---------------------------------------------------------------------------

const AUTO_MOD_ROWS: { key: keyof AutoModConfig; label: string; color: string }[] = [
  { key: "toxicity",  label: "Toxicity threshold", color: "amber"   },
  { key: "spam",      label: "Spam detection",      color: "violet"  },
  { key: "pii",       label: "PII redaction",       color: "emerald" },
  { key: "jailbreak", label: "Jailbreak guard",     color: "rose"    },
];

function AutoModCard({ value, onChange }: { value: AutoModConfig; onChange: (v: AutoModConfig) => void }) {
  return (
    <div className="space-y-0">
      {AUTO_MOD_ROWS.map(({ key, label, color }, i) => (
        <div
          key={key}
          className={cn("grid items-center gap-2.5 py-2", i < AUTO_MOD_ROWS.length - 1 && "border-b border-border/60")}
          style={{ gridTemplateColumns: "130px 1fr 56px" }}
        >
          <span className="text-[12px] text-foreground">{label}</span>
          <div className="relative flex items-center gap-2">
            <ConfBar value={value[key]} color={color} />
          </div>
          <input
            type="number"
            min="0" max="1" step="0.01"
            value={value[key].toFixed(2)}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (!isNaN(n) && n >= 0 && n <= 1) onChange({ ...value, [key]: n });
            }}
            className="w-full text-[11px] font-mono text-right bg-transparent border border-border/50 rounded px-1 py-0.5 focus:outline-none focus:border-violet-500/50 text-muted-foreground"
          />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Escalation rules
// ---------------------------------------------------------------------------

function EscalationCard({ rules, onChange }: { rules: EscalationRule[]; onChange: (v: EscalationRule[]) => void }) {
  function addRule() {
    onChange([...rules, { trigger: "", target: "", live: false }]);
  }
  function removeRule(i: number) {
    onChange(rules.filter((_, j) => j !== i));
  }
  function updateRule(i: number, patch: Partial<EscalationRule>) {
    onChange(rules.map((r, j) => j === i ? { ...r, ...patch } : r));
  }

  return (
    <div className="space-y-2">
      {rules.length === 0 && (
        <p className="text-[12px] text-muted-foreground py-1">No escalation rules. Add one to route flagged messages.</p>
      )}
      {rules.map((r, i) => (
        <div
          key={i}
          className={cn(
            "rounded-lg border p-2.5 space-y-1.5",
            r.live ? "border-amber-500/25 bg-amber-500/5" : "border-border bg-secondary/10",
          )}
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Trigger condition (e.g. sentiment < -0.6)"
              value={r.trigger}
              onChange={(e) => updateRule(i, { trigger: e.target.value })}
              className="flex-1 text-[11.5px] font-mono bg-transparent border-b border-border/50 focus:outline-none focus:border-violet-500/50 text-foreground pb-0.5"
            />
            <button type="button" onClick={() => removeRule(i)} className="text-muted-foreground/50 hover:text-muted-foreground">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] text-muted-foreground shrink-0">→</span>
            <input
              type="text"
              placeholder="Target (e.g. @operator, #channel, pagerduty)"
              value={r.target}
              onChange={(e) => updateRule(i, { target: e.target.value })}
              className="flex-1 text-[11px] text-muted-foreground bg-transparent border-b border-border/50 focus:outline-none focus:border-violet-500/50 pb-0.5"
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={addRule}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border/50 hover:border-border transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        Add rule
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompt override
// ---------------------------------------------------------------------------

function PromptCard({
  system, tone, refuse, temp, maxTurn,
  onChange,
}: {
  system: string; tone: string; refuse: string[]; temp: number; maxTurn: number;
  onChange: (patch: Partial<Pick<BehaviorConfig, "promptSystem" | "promptTone" | "promptRefuse" | "promptTemp" | "promptMaxTurn">>) => void;
}) {
  const refuseStr = refuse.join(", ");
  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">System</div>
        <textarea
          value={system}
          onChange={(e) => onChange({ promptSystem: e.target.value })}
          rows={3}
          className="w-full text-[12px] font-mono bg-zinc-950/80 border border-border/60 rounded-lg px-3 py-2 text-amber-300 focus:outline-none focus:border-violet-500/50 resize-none"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tone</div>
          <input
            type="text"
            value={tone}
            onChange={(e) => onChange({ promptTone: e.target.value })}
            className="w-full text-[12px] font-mono bg-zinc-950/80 border border-border/60 rounded px-2 py-1.5 text-amber-300 focus:outline-none focus:border-violet-500/50"
          />
        </div>
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Refuse topics (comma-sep)</div>
          <input
            type="text"
            value={refuseStr}
            onChange={(e) => onChange({ promptRefuse: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            className="w-full text-[12px] font-mono bg-zinc-950/80 border border-border/60 rounded px-2 py-1.5 text-emerald-400 focus:outline-none focus:border-violet-500/50"
          />
        </div>
      </div>
      <div className="flex items-center gap-4 text-[11px] font-mono">
        <label className="flex items-center gap-1.5 text-muted-foreground">
          temp
          <input
            type="number" min="0" max="2" step="0.1"
            value={temp}
            onChange={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) onChange({ promptTemp: n }); }}
            className="w-14 bg-secondary border border-border/50 rounded px-1.5 py-0.5 text-violet-400 focus:outline-none focus:border-violet-500/50"
          />
        </label>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          max_turn
          <input
            type="number" min="1" max="20" step="1"
            value={maxTurn}
            onChange={(e) => { const n = parseInt(e.target.value, 10); if (!isNaN(n)) onChange({ promptMaxTurn: n }); }}
            className="w-14 bg-secondary border border-border/50 rounded px-1.5 py-0.5 text-violet-400 focus:outline-none focus:border-violet-500/50"
          />
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Role overrides
// ---------------------------------------------------------------------------

function RoleOverridesCard({ roles, onChange }: { roles: RoleOverride[]; onChange: (v: RoleOverride[]) => void }) {
  function add() { onChange([...roles, { role: "", allow: "respond" }]); }
  function remove(i: number) { onChange(roles.filter((_, j) => j !== i)); }
  function update(i: number, patch: Partial<RoleOverride>) { onChange(roles.map((r, j) => j === i ? { ...r, ...patch } : r)); }

  return (
    <div className="space-y-1.5">
      {roles.length === 0 && (
        <p className="text-[12px] text-muted-foreground py-1">No role overrides. Defaults apply to all users.</p>
      )}
      {roles.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Role name or ID"
            value={r.role}
            onChange={(e) => update(i, { role: e.target.value })}
            className="flex-1 text-[12px] bg-transparent border-b border-border/50 focus:outline-none focus:border-violet-500/50 text-foreground pb-0.5"
          />
          <select
            value={r.allow}
            onChange={(e) => update(i, { allow: e.target.value })}
            className="text-[11px] bg-secondary border border-border/50 rounded px-1.5 py-0.5 text-muted-foreground focus:outline-none"
          >
            {["all", "respond", "respond + memory", "monitor", "none"].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <button type="button" onClick={() => remove(i)} className="text-muted-foreground/50 hover:text-muted-foreground">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border/50 hover:border-border transition-colors mt-1">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        Add override
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

const RATE_LIMIT_ROWS: { key: keyof RateLimitConfig; label: string; sub: string }[] = [
  { key: "repliesPerMin", label: "Replies / minute",  sub: "Soft cap 6 · Hard cap 12"         },
  { key: "tokensPerHour", label: "Tokens / hour",     sub: "Cap 220k"                          },
  { key: "userCooldown",  label: "Per-user cooldown", sub: "30s between replies to same user"  },
  { key: "backoff",       label: "Backoff on errors", sub: "Exponential · max 5m"              },
];

function RateLimitsCard({ value, onChange }: { value: RateLimitConfig; onChange: (v: RateLimitConfig) => void }) {
  return (
    <div>
      {RATE_LIMIT_ROWS.map(({ key, label, sub }, i) => (
        <div key={key} className={cn("flex items-center gap-2.5 py-2", i < RATE_LIMIT_ROWS.length - 1 && "border-b border-border/60")}>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-medium text-foreground">{label}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
          </div>
          <Toggle on={value[key]} onChange={(v) => onChange({ ...value, [key]: v })} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode picker
// ---------------------------------------------------------------------------

function ModePicker({ current, onChange, disabled }: { current: DiscordChannelMode; onChange: (m: DiscordChannelMode) => void; disabled?: boolean }) {
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
              selected ? "border-violet-500/40 bg-violet-500/10" : "border-border bg-card hover:border-border/80 hover:bg-secondary/30",
              disabled && "opacity-50 pointer-events-none",
            )}
          >
            <div className="flex items-center gap-1.5 mb-2">
              <span className={cn("inline-flex items-center gap-1 h-[18px] px-1.5 rounded-full border text-[9.5px] font-semibold uppercase tracking-wide", meta.badge)}>
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
// Live preview panel
// ---------------------------------------------------------------------------

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function LivePreviewPanel({ channelId, channelName }: { channelId: string; channelName: string }) {
  const [entries, setEntries] = useState<CommsLogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const prevIdRef = useRef("");

  useEffect(() => {
    if (!channelId || paused) return;
    if (prevIdRef.current !== channelId) { setEntries([]); prevIdRef.current = channelId; }
    fetchCommsLog({ channel: channelId, limit: 10 })
      .then((res) => setEntries(res.entries.slice(0, 10)))
      .catch(() => {/* best-effort */});
  }, [channelId, paused]);

  return (
    <aside className="w-[280px] shrink-0 border-l border-border bg-card flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border shrink-0">
        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse" />
        <span className="text-[12.5px] font-semibold flex-1">Live preview</span>
        {channelName && <span className="text-[11px] text-muted-foreground truncate">· {channelName}</span>}
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="p-1 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={paused ? "Resume" : "Pause"}
        >
          {paused
            ? <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5,3 19,12 5,21" /></svg>
            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="6" y1="4" x2="6" y2="20" /><line x1="18" y1="4" x2="18" y2="20" /></svg>
          }
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {entries.length === 0
          ? (
            <div className="flex flex-col items-center justify-center py-10 gap-1.5">
              <span className="text-muted-foreground/30 text-2xl">✦</span>
              <p className="text-[12px] text-muted-foreground text-center">No recent messages</p>
            </div>
          )
          : entries.map((e) => {
            const isOut = e.direction === "outbound";
            const initials = (e.senderName ?? e.senderId).slice(0, 2).toUpperCase();
            return (
              <div key={e.id} className="grid gap-2" style={{ gridTemplateColumns: "24px 1fr" }}>
                <div className={cn("w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5", isOut ? "bg-gradient-to-br from-violet-500 to-violet-700 text-white" : "bg-secondary border border-border text-muted-foreground")}>
                  {initials}
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5 mb-0.5">
                    <span className={cn("text-[12px] font-semibold", isOut ? "text-violet-400" : "text-foreground")}>
                      {e.senderName ?? e.senderId}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 font-mono">{relTime(e.createdAt)}</span>
                  </div>
                  <p className="text-[12px] text-muted-foreground leading-relaxed line-clamp-3">{e.preview}</p>
                </div>
              </div>
            );
          })
        }
      </div>
      <div className="px-3.5 py-2 border-t border-border shrink-0">
        <span className="text-[10px] text-muted-foreground/60">{entries.length} recent message{entries.length !== 1 ? "s" : ""}</span>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CommsChannelsPage() {
  const [channels, setChannels]   = useState<ChannelListEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [behavior, setBehavior]   = useState<BehaviorConfig>(DEFAULTS);
  const [agents, setAgents]       = useState<AgentStatus[]>([]);
  const [saving, setSaving]       = useState(false);
  const [dirty, setDirty]         = useState(false);
  const [error, setError]         = useState<string | null>(null);

  // Load channel list and agents in parallel on mount
  useEffect(() => {
    fetchChannels()
      .then((list) => {
        setChannels(list);
        if (list.length > 0) setSelectedId((prev) => prev ?? list[0].id);
      })
      .catch(() => {});

    fetchAgents()
      .then((list) => setAgents(list))
      .catch(() => {});
  }, []);

  // Load config whenever the selected channel changes
  useEffect(() => {
    if (!selectedId) return;
    setDirty(false);
    setError(null);
    fetchChannelConfig(selectedId)
      .then((cfg) => {
        setBehavior(parseBehavior(cfg.config));
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBehavior(DEFAULTS);
      });
  }, [selectedId]);

  const patch = useCallback(<K extends keyof BehaviorConfig>(key: K, value: BehaviorConfig[K]) => {
    setBehavior((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedId) return;
    setSaving(true);
    setError(null);
    try {
      await updateChannelConfig(selectedId, { config: serializeBehavior(behavior) });
      setDirty(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selectedId, behavior]);

  const selected = channels.find((c) => c.id === selectedId);

  return (
    <PageScroll className="flex flex-col h-full min-h-0 overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Config area */}
        <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-[12px] text-muted-foreground font-mono">Channels</span>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground/50" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
              <select
                value={selectedId ?? ""}
                onChange={(e) => setSelectedId(e.target.value)}
                className="bg-transparent border-none outline-none text-[14px] font-semibold text-foreground font-mono cursor-pointer"
              >
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                {channels.length === 0 && <option value="">No channels</option>}
              </select>
              {selected && (
                <span className={cn("inline-flex items-center gap-1 h-[20px] px-2 rounded-full border text-[10.5px] font-semibold", CHANNEL_MODE_META[behavior.mode].badge)}>
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", CHANNEL_MODE_META[behavior.mode].dot)} />
                  {CHANNEL_MODE_META[behavior.mode].label}
                </span>
              )}
            </div>
            {error && <span className="text-[11px] text-red-400 truncate max-w-[200px]">{error}</span>}
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

          {/* Mode picker */}
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Mode</div>
                <div className="text-[12px] text-muted-foreground mt-0.5">How Aion participates in this channel.</div>
              </div>
            </div>
            <ModePicker
              current={behavior.mode}
              onChange={(m) => patch("mode", m)}
              disabled={!selectedId}
            />
          </div>

          {/* 2-col config grid */}
          <div className="p-4 grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <ConfigCard
              title="Agent assignment"
              right={<span className="text-[10.5px] text-muted-foreground font-mono">{behavior.agentIds.length} assigned</span>}
            >
              <AgentAssignment
                agents={agents}
                assignedIds={behavior.agentIds}
                onChange={(ids) => patch("agentIds", ids)}
              />
            </ConfigCard>

            <ConfigCard title="Memory scope">
              <MemoryScopeCard
                value={behavior.memory}
                onChange={(v) => patch("memory", v)}
              />
            </ConfigCard>

            <ConfigCard title="Tool access">
              <ToolAccessCard
                tools={behavior.tools}
                onChange={(v) => patch("tools", v)}
              />
            </ConfigCard>

            <ConfigCard title="Auto-moderation" accent="bg-amber-500">
              <AutoModCard
                value={behavior.autoMod}
                onChange={(v) => patch("autoMod", v)}
              />
            </ConfigCard>

            <ConfigCard
              title="Escalation rules"
              right={behavior.escalation.length > 0
                ? <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20 text-[10px] font-medium">{behavior.escalation.length} rule{behavior.escalation.length !== 1 ? "s" : ""}</span>
                : undefined
              }
            >
              <EscalationCard
                rules={behavior.escalation}
                onChange={(v) => patch("escalation", v)}
              />
            </ConfigCard>

            <ConfigCard
              title="Prompt override"
              right={<span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 text-[10px] font-medium">channel-scoped</span>}
            >
              <PromptCard
                system={behavior.promptSystem}
                tone={behavior.promptTone}
                refuse={behavior.promptRefuse}
                temp={behavior.promptTemp}
                maxTurn={behavior.promptMaxTurn}
                onChange={(p) => { setBehavior((prev) => ({ ...prev, ...p })); setDirty(true); }}
              />
            </ConfigCard>
          </div>

          {/* 3-col bottom strip */}
          <div className="px-4 pb-4 grid gap-3" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <ConfigCard title="Role overrides">
              <RoleOverridesCard
                roles={behavior.roleOverrides}
                onChange={(v) => patch("roleOverrides", v)}
              />
            </ConfigCard>
            <ConfigCard title="Rate limits">
              <RateLimitsCard
                value={behavior.rateLimits}
                onChange={(v) => patch("rateLimits", v)}
              />
            </ConfigCard>
            <ConfigCard
              title="Semantic topic detection"
              right={<span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[10px] font-medium">coming soon</span>}
            >
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                Automatic thread tagging routes messages to relevant agents. Topic model training requires channel history.
              </p>
            </ConfigCard>
          </div>
        </div>

        {/* Live preview */}
        <LivePreviewPanel
          channelId={selectedId ?? ""}
          channelName={selected?.name ?? ""}
        />
      </div>
    </PageScroll>
  );
}
