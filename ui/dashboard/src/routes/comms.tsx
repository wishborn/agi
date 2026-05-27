/**
 * Communications page — /system/comms
 *
 * s190: Two-tab layout — Overview (stats + recent) and All Messages
 * (daily rotating conversation view per channel).
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { PageScroll } from "@/components/PageScroll.js";
import { DayNavigator } from "@/components/DayNavigator.js";
import { ConversationView } from "@/components/ConversationView.js";
import { CommsOverview } from "@/components/CommsOverview.js";
import { fetchCommsLog, fetchAmbientLog } from "@/api.js";
import type { ConversationEntry, CommsLogEntry, AmbientLogEntry } from "@/types.js";

const CHANNELS = ["All", "discord", "gmail", "telegram", "signal", "whatsapp", "email"] as const;
type ChannelFilter = (typeof CHANNELS)[number];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function mergeEntries(
  commsEntries: CommsLogEntry[],
  ambientEntries: AmbientLogEntry[],
  channelFilter: ChannelFilter,
): ConversationEntry[] {
  const result: ConversationEntry[] = [];

  for (const e of commsEntries) {
    if (channelFilter !== "All" && e.channel !== channelFilter) continue;
    if (e.direction === "outbound") {
      result.push({ kind: "comms-out", id: e.id, ts: e.createdAt, text: e.preview, channel: e.channel });
    } else {
      result.push({ kind: "comms-in", id: e.id, ts: e.createdAt, senderName: e.senderName, text: e.preview, channel: e.channel });
    }
  }

  // Add ambient entries not already covered by a comms-in entry (dedup within 2s)
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

export default function CommsPage() {
  const [tab, setTab] = useState<"overview" | "messages">("overview");
  const [channel, setChannel] = useState<ChannelFilter>("All");
  const [day, setDay] = useState(todayIso());
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadMessages = useCallback(async (ch: ChannelFilter, d: string) => {
    setLoading(true);
    try {
      const commsPromise = fetchCommsLog({
        channel: ch === "All" ? undefined : ch,
        date: d,
        limit: 200,
      });
      const ambientPromise = (ch !== "All")
        ? fetchAmbientLog({ channelId: ch, date: d, limit: 200 })
        : Promise.resolve({ entries: [] as AmbientLogEntry[] });

      const [comms, ambient] = await Promise.all([commsPromise, ambientPromise]);
      setEntries(mergeEntries(comms.entries, ambient.entries, ch));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "messages") {
      void loadMessages(channel, day);
    }
  }, [tab, channel, day, loadMessages]);

  return (
    <PageScroll>
      <div className="space-y-4">
        {/* Main tabs */}
        <div className="flex gap-1">
          {(["overview", "messages"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-4 py-2 md:py-1.5 rounded-lg text-[12px] border-none cursor-pointer transition-colors font-medium capitalize",
                tab === t
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-foreground hover:bg-secondary/80",
              )}
            >
              {t === "overview" ? "Overview" : "All Messages"}
            </button>
          ))}
        </div>

        {tab === "overview" && <CommsOverview />}

        {tab === "messages" && (
          <div className="space-y-3">
            {/* Day navigator */}
            <DayNavigator date={day} onChange={(d) => { setDay(d); }} />

            {/* Channel sub-tabs */}
            <div className="flex gap-1 flex-wrap">
              {CHANNELS.map((ch) => (
                <button
                  key={ch}
                  onClick={() => setChannel(ch)}
                  className={cn(
                    "px-3 py-1.5 md:py-1 rounded-lg text-[12px] border-none cursor-pointer transition-colors",
                    channel === ch
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "bg-secondary text-foreground hover:bg-secondary/80",
                  )}
                >
                  {ch === "All" ? "All Channels" : ch.charAt(0).toUpperCase() + ch.slice(1)}
                </button>
              ))}
            </div>

            {/* Conversation view */}
            <div className="rounded-xl border border-border min-h-[300px] px-4 py-2">
              <ConversationView entries={entries} loading={loading} />
            </div>
          </div>
        )}
      </div>
    </PageScroll>
  );
}
