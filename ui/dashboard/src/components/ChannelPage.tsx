/**
 * ChannelPage — per-channel conversation history page.
 *
 * s190: Replaced the status-header+table layout with a day-navigated
 * chat-bubble conversation view. Start/Stop/Restart controls moved to
 * Settings — this page is for reading channel history, not managing the bot.
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { DayNavigator } from "@/components/DayNavigator.js";
import { ConversationView } from "@/components/ConversationView.js";
import { fetchCommsLog, fetchAmbientLog } from "@/api.js";
import type { ConversationEntry, CommsLogEntry, AmbientLogEntry } from "@/types.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChannelPageProps {
  channelId: string;
  channelName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function mergeEntries(commsEntries: CommsLogEntry[], ambientEntries: AmbientLogEntry[]): ConversationEntry[] {
  const result: ConversationEntry[] = [];

  for (const e of commsEntries) {
    if (e.direction === "outbound") {
      result.push({ kind: "comms-out", id: e.id, ts: e.createdAt, text: e.preview, channel: e.channel });
    } else {
      result.push({ kind: "comms-in", id: e.id, ts: e.createdAt, senderName: e.senderName, text: e.preview, channel: e.channel });
    }
  }

  const commsInTimes = result.filter((e) => e.kind === "comms-in").map((e) => new Date(e.ts).getTime());
  for (const a of ambientEntries) {
    const t = new Date(a.ts).getTime();
    const isDup = commsInTimes.some((ct) => Math.abs(ct - t) < 2000);
    if (!isDup) {
      result.push({ kind: "ambient", ts: a.ts, authorId: a.authorId, displayName: a.displayName, text: a.text });
    }
  }

  return result.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChannelPage({ channelId, channelName }: ChannelPageProps) {
  const [day, setDay] = useState(todayIso());
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDay = useCallback(async (d: string) => {
    setLoading(true);
    try {
      const [comms, ambient] = await Promise.all([
        fetchCommsLog({ channel: channelId, date: d, limit: 200 }),
        fetchAmbientLog({ channelId, date: d, limit: 200 }),
      ]);
      setEntries(mergeEntries(comms.entries, ambient.entries));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => { void loadDay(day); }, [day, loadDay]);

  return (
    <div className="space-y-4">
      {/* Channel header */}
      <div className="flex items-center justify-between">
        <h2 className={cn("text-[15px] font-semibold text-foreground capitalize")}>{channelName}</h2>
        <DayNavigator date={day} onChange={setDay} />
      </div>

      {/* Conversation */}
      <div className="rounded-xl border border-border min-h-[400px] px-4 py-2">
        <ConversationView entries={entries} loading={loading} />
      </div>
    </div>
  );
}
