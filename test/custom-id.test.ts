import { describe, expect, it } from "vitest";
import { decodeCustomId, encodeCustomId } from "../src/discord/custom-id.ts";

describe("custom ids", () => {
  it("round-trips action, argument and target", () => {
    const id = encodeCustomId({ action: "attend", arg: "in", target: "s_123" });
    expect(id).toBe("o1:attend:in:s_123");
    expect(decodeCustomId(id)).toEqual({ action: "attend", arg: "in", target: "s_123" });
  });

  it("drops trailing empty segments", () => {
    expect(encodeCustomId({ action: "ping" })).toBe("o1:ping");
    expect(encodeCustomId({ action: "refresh", target: "s_1" })).toBe("o1:refresh::s_1");
    expect(decodeCustomId("o1:refresh::s_1")).toEqual({ action: "refresh", target: "s_1" });
  });

  it("refuses ids over Discord's 100-character limit", () => {
    expect(() => encodeCustomId({ action: "a", target: "x".repeat(100) })).toThrow(/too long/);
  });

  it("returns undefined for anything Orrey did not mint", () => {
    // Hermuz-era ids, and ids from a hypothetical older schema version.
    for (const raw of ["", "attend_in_123", "gameday:rsvp:yes", "o0:attend:in:1", "o1", "o1:"]) {
      expect(decodeCustomId(raw)).toBeUndefined();
    }
  });
});
