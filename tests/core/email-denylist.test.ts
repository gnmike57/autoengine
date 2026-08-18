import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EmailDenylist } from "../../src/core/email-denylist.js";
import fs from "node:fs";

describe("EmailDenylist", () => {
  let denylist: EmailDenylist;

  beforeEach(() => {
    denylist = new EmailDenylist();
    // Override the savePath in tests indirectly if needed, but the current class hardcodes the file path relative to cwd.
    // For tests, we'll just mock fs or run it in a clean dir, but since we are just doing unit tests, let's test memory behavior.
  });

  afterEach(() => {
    if (fs.existsSync("email-denylist-joe.json")) fs.unlinkSync("email-denylist-joe.json");
    if (fs.existsSync("email-denylist-ignition.json")) fs.unlinkSync("email-denylist-ignition.json");
  });

  it("normalizes emails", () => {
    expect(denylist.add("  TeSt@ExAmPlE.com  ", "joe")).toBe(true);
    expect(denylist.has("test@example.com", "joe")).toBe(true);
    expect(denylist.has("TEST@example.com", "joe")).toBe(true);
    // adding duplicate returns false
    expect(denylist.add("test@example.com", "joe")).toBe(false);
  });

  it("returns sorted emails per site", () => {
    denylist.add("z@example.com", "joe");
    denylist.add("a@example.com", "joe");
    denylist.add("m@example.com", "joe");
    expect(denylist.getAll("joe")).toEqual(["a@example.com", "m@example.com", "z@example.com"]);
    expect(denylist.getAll("ignition")).toEqual([]);
  });

  it("saves and loads from disk atomically", async () => {
    denylist.add("disk@test.com", "joe");
    await denylist.saveAll();
    
    expect(fs.existsSync("email-denylist-joe.json")).toBe(true);
    
    const loaded = new EmailDenylist();
    loaded.loadSite("joe");
    expect(loaded.has("disk@test.com", "joe")).toBe(true);
    expect(loaded.getAll("joe")).toEqual(["disk@test.com"]);
  });

  it("ignores non-existent files gracefully", () => {
    expect(() => denylist.loadSite("does-not-exist")).not.toThrow();
  });

  it("handles null/undefined gracefully", () => {
    expect(denylist.has(null, "joe")).toBe(false);
    expect(denylist.has(undefined, "joe")).toBe(false);
    expect(denylist.has("", "joe")).toBe(false);
  });
});
