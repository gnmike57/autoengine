 
import { describe, it, expect } from "vitest";

// Server-side schema contracts — imported from the shared schema module that
// server.ts re-exports, avoiding module-level side effects of importing
// server.ts directly (initDB(), WebSocket, engine instantiation, etc.).
import { SetConcurrencySchema, SetBackendSchema } from "../../src/server/schemas.js";

describe("server.ts schema exports", () => {
  it("SetConcurrencySchema validates correctly", () => {
    expect(SetConcurrencySchema.safeParse({ value: 5 }).success).toBe(true);
    expect(SetConcurrencySchema.safeParse({ value: 1 }).success).toBe(true);
    expect(SetConcurrencySchema.safeParse({ value: 500 }).success).toBe(true);
    expect(SetConcurrencySchema.safeParse({ value: -1 }).success).toBe(false);
    expect(SetConcurrencySchema.safeParse({ value: 0 }).success).toBe(false);
    expect(SetConcurrencySchema.safeParse({ value: 1000 }).success).toBe(false);
    expect(SetConcurrencySchema.safeParse({ value: "5" }).success).toBe(false);
  });

  it("SetBackendSchema validates correctly", () => {
    expect(SetBackendSchema.safeParse({ value: "stealth" }).success).toBe(true);
    expect(SetBackendSchema.safeParse({ value: "" }).success).toBe(true);
    expect(SetBackendSchema.safeParse({ value: 123 }).success).toBe(false);
    expect(SetBackendSchema.safeParse({}).success).toBe(false);
  });
});
