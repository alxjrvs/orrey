export interface Env {
  // Bindings
  DB: D1Database;
  OUTBOX: Queue<OutboxMessage>;
  ASSETS: Fetcher;
  GUILD: DurableObjectNamespace;
  SESSION_LOCK: DurableObjectNamespace;

  // Vars
  ENVIRONMENT: "development" | "production";

  // Secrets
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_GUILD_ID: string;
  GOOGLE_CALENDAR_ID: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_KEY: string;
  CONSOLE_SESSION_SECRET: string;
}

/**
 * Everything Orrey projects outward. Note what is absent: Discord *messages*.
 * Messages are send-only and are never reconciled, so they never ride the queue.
 */
export type OutboxMessage =
  | { kind: "gcal.upsert"; sessionId: string }
  | { kind: "gcal.delete"; sessionId: string }
  | { kind: "discord.event.upsert"; sessionId: string }
  | { kind: "discord.event.delete"; sessionId: string };
