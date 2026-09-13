import { describe, expect, it } from "vitest";
import { verifyDiscordRequest } from "../src/discord/verify.ts";
import { fakeDiscord } from "./discord.ts";

const discord = await fakeDiscord();
const body = JSON.stringify({ type: 1 });

describe("verifyDiscordRequest", () => {
  it("accepts a signature over timestamp + body", async () => {
    const { signature, timestamp } = await discord.sign(body);
    expect(await verifyDiscordRequest(discord.publicKeyHex, signature, timestamp, body)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const { signature, timestamp } = await discord.sign(body);
    expect(await verifyDiscordRequest(discord.publicKeyHex, signature, timestamp, body + " ")).toBe(false);
  });

  it("rejects a tampered timestamp", async () => {
    const { signature, timestamp } = await discord.sign(body);
    expect(await verifyDiscordRequest(discord.publicKeyHex, signature, `${timestamp}0`, body)).toBe(false);
  });

  it("rejects a signature from another key", async () => {
    const other = await fakeDiscord();
    const { signature, timestamp } = await other.sign(body);
    expect(await verifyDiscordRequest(discord.publicKeyHex, signature, timestamp, body)).toBe(false);
  });

  it("rejects missing or malformed headers without throwing", async () => {
    const { signature, timestamp } = await discord.sign(body);
    expect(await verifyDiscordRequest(discord.publicKeyHex, null, timestamp, body)).toBe(false);
    expect(await verifyDiscordRequest(discord.publicKeyHex, signature, null, body)).toBe(false);
    expect(await verifyDiscordRequest(discord.publicKeyHex, "not-hex", timestamp, body)).toBe(false);
    expect(await verifyDiscordRequest(discord.publicKeyHex, signature.slice(2), timestamp, body)).toBe(false);
    expect(await verifyDiscordRequest("00", signature, timestamp, body)).toBe(false);
  });
});
