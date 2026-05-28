/**
 * InboxView — thread-card list for the unified communications inbox.
 *
 * Groups CommsLogEntry items into pseudo-threads by senderId+channel,
 * showing the most recent message per group as a thread card.
 * Matches the Aionima Channel design (inbox.jsx artboard).
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { CommsLogEntry } from "@/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ---------------------------------------------------------------------------
// Source chip — color-coded badge for each channel type
// ---------------------------------------------------------------------------

const SOURCE_STYLE: Record<string, string> = {
  discord:  "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
  gmail:    "bg-red-500/15 text-red-400 border-red-500/30",
  email:    "bg-red-500/15 text-red-400 border-red-500/30",
  telegram: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  signal:   "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  whatsapp: "bg-green-500/15 text-green-400 border-green-500/30",
  sms:      "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

const SOURCE_LABEL: Record<string, string> = {
  discord: "DC", gmail: "GM", email: "ML", telegram: "TG",
  signal: "SG", whatsapp: "WA", sms: "SMS",
};

export function SourceChip({ channel, className }: { channel: string; className?: string }) {
  const style = SOURCE_STYLE[channel] ?? "bg-violet-500/15 text-violet-400 border-violet-500/30";
  const label = SOURCE_LABEL[channel] ?? channel.slice(0, 2).toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded border font-mono font-bold tracking-wide shrink-0",
        "h-[18px] min-w-[24px] px-1.5 text-[9px]",
        style,
        className,
      )}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Thread grouping — deduplicate by senderId+channel, keep latest
// ---------------------------------------------------------------------------

interface ThreadEntry {
  id: string;
  channel: string;
  senderId: string;
  senderName: string | null;
  subject: string | null;
  preview: string;
  latestAt: string;
  count: number;
  direction: "inbound" | "outbound";
  hasOutbound: boolean;
}

function groupAsThreads(entries: CommsLogEntry[]): ThreadEntry[] {
  const sorted = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const seen = new Map<string, ThreadEntry>();
  const order: string[] = [];

  for (const e of sorted) {
    const key = `${e.channel}:${e.senderId}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count++;
      if (e.direction === "outbound") existing.hasOutbound = true;
    } else {
      const t: ThreadEntry = {
        id: e.id,
        channel: e.channel,
        senderId: e.senderId,
        senderName: e.senderName,
        subject: e.subject,
        preview: e.preview,
        latestAt: e.createdAt,
        count: 1,
        direction: e.direction,
        hasOutbound: e.direction === "outbound",
      };
      seen.set(key, t);
      order.push(key);
    }
  }

  return order.map((k) => seen.get(k)!);
}

// ---------------------------------------------------------------------------
// ThreadCard
// ---------------------------------------------------------------------------

function ThreadCard({ thread }: { thread: ThreadEntry }) {
  const displayName = thread.senderName ?? thread.senderId;
  const title = thread.subject ?? thread.preview.slice(0, 80);
  const isInbound = thread.direction === "inbound";

  return (
    <div className="px-4 py-3 border-b border-border/60 cursor-pointer transition-colors hover:bg-secondary/30 group">
      {/* Row 1: source chip · channel · message count · time */}
      <div className="flex items-center gap-1.5 mb-1.5 min-w-0">
        <SourceChip channel={thread.channel} />
        <span className="text-[11px] font-mono text-muted-foreground truncate flex-1 min-w-0">
          {thread.channel}
        </span>
        {thread.count > 1 && (
          <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">{thread.count}</span>
        )}
        <span className="text-[10.5px] font-mono text-muted-foreground shrink-0">
          {relTime(thread.latestAt)}
        </span>
      </div>

      {/* Row 2: sender */}
      <div className="flex items-center gap-1.5 mb-1 min-w-0">
        <span className="text-[12px] font-medium text-foreground truncate min-w-0 flex-1">
          {displayName}
        </span>
        {!isInbound && (
          <span className="text-[10.5px] text-muted-foreground shrink-0">← Aion</span>
        )}
        {thread.hasOutbound && isInbound && (
          <span className="text-[10.5px] text-violet-400/70 shrink-0">draft</span>
        )}
      </div>

      {/* Row 3: title */}
      <div className="text-[13px] font-semibold text-foreground leading-snug mb-1.5 line-clamp-1">
        {title}
      </div>

      {/* Row 4: AI-style preview */}
      <div className="flex items-start gap-1.5">
        <span className="text-muted-foreground/60 text-[10px] shrink-0 mt-0.5 select-none">✦</span>
        <span className="text-[11.5px] text-muted-foreground leading-relaxed line-clamp-2">
          {thread.preview}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InboxView — exported component
// ---------------------------------------------------------------------------

export interface InboxViewProps {
  entries: CommsLogEntry[];
  loading: boolean;
  emptyText?: string;
}

export function InboxView({ entries, loading, emptyText }: InboxViewProps) {
  const threads = useMemo(() => groupAsThreads(entries), [entries]);

  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-[13px] text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-[13px] text-muted-foreground">
        {emptyText ?? "No messages on this day"}
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/0">
      {/* Compact header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60 bg-secondary/20">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          {threads.length} thread{threads.length !== 1 ? "s" : ""}
        </span>
        <span className="flex-1" />
        <span className="text-[10.5px] font-mono text-muted-foreground/60">
          {threads.filter((t) => t.direction === "inbound").length} inbound ·{" "}
          {threads.filter((t) => t.direction === "outbound" || t.hasOutbound).length} with reply
        </span>
      </div>
      {threads.map((t) => (
        <ThreadCard key={t.id} thread={t} />
      ))}
    </div>
  );
}
