/**
 * ConversationView — chat-bubble renderer for channel conversation history.
 *
 * Renders a list of ConversationEntry items as a chat UI:
 *   - inbound / ambient: left-aligned, secondary background
 *   - outbound (Aion): right-aligned, primary background
 */

import { cn } from "@/lib/utils";
import type { ConversationEntry } from "@/types.js";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function senderLabel(entry: ConversationEntry): string {
  if (entry.kind === "comms-out") return "Aion";
  if (entry.kind === "comms-in") return entry.senderName ?? "Unknown";
  return entry.displayName;
}

function messageText(entry: ConversationEntry): string {
  if (entry.kind === "comms-out" || entry.kind === "comms-in") return entry.text;
  return entry.text;
}

function entryTs(entry: ConversationEntry): string {
  return entry.ts;
}

export interface ConversationViewProps {
  entries: ConversationEntry[];
  loading: boolean;
  emptyText?: string;
}

export function ConversationView({ entries, loading, emptyText }: ConversationViewProps) {
  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-[13px] text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-[13px] text-muted-foreground">
        {emptyText ?? "No messages on this day"}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 py-2">
      {entries.map((entry, i) => {
        const isOutbound = entry.kind === "comms-out";
        return (
          <div
            key={entry.kind === "ambient" ? `amb-${entry.ts}-${i}` : entry.id}
            className={cn("flex flex-col gap-0.5 max-w-[80%]", isOutbound ? "self-end items-end" : "self-start items-start")}
          >
            <div className="flex items-center gap-1.5 px-1">
              <span className="text-[10px] text-muted-foreground font-medium">
                {senderLabel(entry)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {formatTime(entryTs(entry))}
              </span>
            </div>
            <div
              className={cn(
                "px-3 py-2 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap break-words",
                isOutbound
                  ? "bg-primary text-primary-foreground rounded-tr-sm"
                  : "bg-secondary text-foreground rounded-tl-sm",
              )}
            >
              {messageText(entry)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
