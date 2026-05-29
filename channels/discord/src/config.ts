import type { ChannelConfigAdapter } from "@agi/sdk";

// ---------------------------------------------------------------------------
// Discord config
// ---------------------------------------------------------------------------

export interface DiscordConfig {
  /** Bot token from Discord Developer Portal */
  botToken: string;
  /** Application ID — required for slash commands (future use). */
  applicationId?: string;
  /** If non-empty, only respond to messages in these guild (server) IDs. */
  allowedGuildIds?: string[];
  /** If non-empty, only respond to messages in these channel IDs. */
  allowedChannelIds?: string[];
  /**
   * If non-empty, only allow messages from guild members that have at least
   * one of these Discord role IDs. Members without a matching role receive a
   * DM explanation and the message is dropped. Empty = open access (default).
   *
   * UI stores this as a comma-separated string; normalizeDiscordArrayField()
   * converts it to string[] before use.
   */
  allowedRoleIds?: string[];
  /**
   * Channels where Aion reads all messages for context and moderation but
   * does NOT route to the AI (no responses). Respond to @mentions only in
   * allowedChannelIds; read everything here. Empty = no monitor-only channels.
   */
  presenceChannelIds?: string[];
  /** Only respond when @mentioned or in DMs, default true. */
  mentionOnly?: boolean;
  /** Max messages per user per minute before rate-limiting (default: 20). */
  rateLimitPerMinute?: number;
}

/**
 * Normalise a DiscordConfig array field that may arrive as a comma-separated
 * string (from the generic Settings UI form) or as a proper string[] (from
 * gateway.json). Returns an empty array when the value is absent or blank.
 */
export function normalizeDiscordArrayField(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).filter((v) => typeof v === "string") as string[];
  }
  return [];
}

/**
 * Runtime type guard for {@link DiscordConfig}.
 * Keeps the discord package dependency-free from Zod.
 */
export function isDiscordConfig(value: unknown): value is DiscordConfig {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj["botToken"] !== "string" || obj["botToken"].length === 0)
    return false;

  if (
    "applicationId" in obj &&
    typeof obj["applicationId"] !== "string"
  )
    return false;

  // Accept both string[] and comma-separated string for all array fields
  // (the generic Settings UI form saves them as comma-separated strings).
  for (const field of ["allowedGuildIds", "allowedChannelIds", "allowedRoleIds", "presenceChannelIds"] as const) {
    if (field in obj) {
      const v = obj[field];
      if (
        v !== "" &&
        !Array.isArray(v) &&
        typeof v !== "string"
      ) return false;
      if (Array.isArray(v) && !(v as unknown[]).every((id) => typeof id === "string")) return false;
    }
  }

  if ("mentionOnly" in obj && typeof obj["mentionOnly"] !== "boolean")
    return false;

  if (
    "rateLimitPerMinute" in obj &&
    (typeof obj["rateLimitPerMinute"] !== "number" ||
      obj["rateLimitPerMinute"] <= 0)
  )
    return false;

  return true;
}

/** ChannelConfigAdapter for the Discord channel. */
export function createConfigAdapter(): ChannelConfigAdapter {
  return {
    validate: (config: unknown) => isDiscordConfig(config),
    getDefaults: () => ({
      botToken: "",
      applicationId: "",
      allowedGuildIds: "",
      allowedChannelIds: "",
      presenceChannelIds: "",
      allowedRoleIds: "",
      mentionOnly: true,
      rateLimitPerMinute: 20,
    }),
  };
}
