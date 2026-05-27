/**
 * CommsOverview — stats dashboard + recent messages for the Communications Overview tab.
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { fetchCommsStats, fetchCommsLog } from "@/api.js";
import type { CommsStats, CommsLogEntry } from "@/types.js";

function channelColor(channel: string): string {
  switch (channel.toLowerCase()) {
    case "gmail":
    case "email": return "text-blue";
    case "telegram": return "text-sky-400";
    case "discord": return "text-[#5865F2]";
    case "signal": return "text-green";
    case "whatsapp": return "text-teal-400";
    case "slack": return "text-[#4A154B]";
    default: return "text-muted-foreground";
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function CommsOverview() {
  const [stats, setStats] = useState<CommsStats | null>(null);
  const [recent, setRecent] = useState<CommsLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([
        fetchCommsStats(),
        fetchCommsLog({ limit: 20 }),
      ]);
      setStats(s);
      setRecent(r.entries);
    } catch {
      // Show empty state on error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-[13px] text-muted-foreground">
        Loading…
      </div>
    );
  }

  const channelEntries = stats ? Object.entries(stats.byChannel).sort((a, b) => b[1].today - a[1].today) : [];

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {/* Today total card */}
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">Today</div>
          <div className="text-[22px] font-bold text-foreground">{stats?.todayTotal ?? 0}</div>
          <div className="text-[10px] text-muted-foreground">messages</div>
        </div>
        {/* Per-channel cards */}
        {channelEntries.map(([ch, counts]) => (
          <div key={ch} className="rounded-xl border border-border bg-card p-3">
            <div className={cn("text-[10px] uppercase tracking-wider font-semibold mb-1 capitalize", channelColor(ch))}>
              {ch}
            </div>
            <div className="text-[22px] font-bold text-foreground">{counts.today}</div>
            <div className="text-[10px] text-muted-foreground">{counts.total} total</div>
          </div>
        ))}
      </div>

      {/* Recent messages */}
      <div>
        <div className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider mb-2 px-1">
          Recent Messages
        </div>
        {recent.length === 0 ? (
          <div className="text-[13px] text-muted-foreground py-6 text-center">No messages yet</div>
        ) : (
          <div className="space-y-1">
            {recent.map((entry) => (
              <div
                key={entry.id}
                className={cn(
                  "flex gap-3 items-start px-3 py-2 rounded-lg",
                  entry.direction === "outbound" ? "bg-primary/5 border border-primary/10" : "bg-secondary/40",
                )}
              >
                <div className="flex-shrink-0 text-[10px] text-muted-foreground pt-0.5 w-[52px] text-right">
                  {formatTimestamp(entry.createdAt)}
                </div>
                <div className={cn("flex-shrink-0 text-[10px] font-semibold capitalize pt-0.5 w-[60px]", channelColor(entry.channel))}>
                  {entry.channel}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[12px] text-foreground/70 font-medium mr-1.5">
                    {entry.direction === "outbound" ? "Aion" : (entry.senderName ?? entry.senderId)}
                  </span>
                  <span className="text-[12px] text-foreground truncate">
                    {entry.subject ? <span className="font-medium mr-1">{entry.subject}:</span> : null}
                    {entry.preview}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
