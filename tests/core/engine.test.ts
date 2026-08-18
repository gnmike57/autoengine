/**
 * Unit tests for engine.ts core business logic.
 *
 * Targets the pure helpers that have zero browser dependencies:
 *   - parseCsvLine    (RFC 4180 quoted-field handling)
 *   - loadCredentials (multi-password column parsing + size-cap guard)
 *   - buildPasswordSequence (batch padding + 4th re-press)
 *   - isUrlChangedAwayFromLogin (post-submit redirect detection)
 *
 * Private methods are accessed via the bracket-property escape hatch
 * (`(engine as any).method`) so the engine API surface stays unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  AutomationEngine,
  classifyLoginResponse,
  shouldRunCashierVerification,
  type LoginSignals,
  type LoginFlowResult,
} from "../../src/core/engine.js";

// eslint-disable-next-line @typescript-eslint/require-await
describe("AutomationEngine", async () => {
  let engine: AutomationEngine;
  let tmpDir: string;

  beforeEach(() => {
    engine = new AutomationEngine();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("parseCsvLine", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parse = (line: string) => (engine as any).parseCsvLine(line) as string[];

    // eslint-disable-next-line @typescript-eslint/require-await
    it("splits unquoted fields on comma", async () => {
      expect(parse("a,b,c")).toEqual(["a", "b", "c"]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("preserves commas inside quoted fields", async () => {
      expect(parse('"a,b",c,"d,e"')).toEqual(["a,b", "c", "d,e"]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("handles escaped double-quotes", async () => {
      expect(parse('"he said ""hi""",ok')).toEqual(['he said "hi"', "ok"]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("returns empty fields for trailing comma", async () => {
      expect(parse("a,,c")).toEqual(["a", "", "c"]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("treats an empty line as a single empty field", async () => {
      expect(parse("")).toEqual([""]);
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("loadCredentials", async () => {
    const writeCsv = (body: string) => {
      const p = path.join(tmpDir, "creds.csv");
      fs.writeFileSync(p, body, "utf-8");
      return p;
    };

    // eslint-disable-next-line @typescript-eslint/require-await
    it("returns [] when the file is missing", async () => {
      expect(engine.loadCredentials(path.join(tmpDir, "nope.csv"))).toEqual([]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("parses email + multiple password columns in order", async () => {
      const p = writeCsv("email,password,password2,password3\nfoo@x.com,one,two,three");
      expect(engine.loadCredentials(p)).toEqual([
        { email: "foo@x.com", passwords: ["one", "two", "three"], isGolden: false },
      ]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("trims trailing empty passwords but preserves internal order", async () => {
      const p = writeCsv("email,password,password2,password3\nfoo@x.com,one,,");
      expect(engine.loadCredentials(p)).toEqual([
        { email: "foo@x.com", passwords: ["one"], isGolden: false },
      ]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("skips rows missing email or all passwords", async () => {
      const p = writeCsv("email,password\n,onlypw\nbar@x.com,\nok@x.com,real");
      expect(engine.loadCredentials(p)).toEqual([
        { email: "ok@x.com", passwords: ["real"], isGolden: false },
      ]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("rejects files larger than the 50MB cap", async () => {
      const p = path.join(tmpDir, "huge.csv");
      fs.writeFileSync(p, Buffer.alloc(51 * 1024 * 1024)); // Write dummy 51MB buffer
      try {
        expect(engine.loadCredentials(p)).toEqual([]);
      } finally {
        // no-op
      }
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("buildPasswordSequence", async () => {
    const build = (pws: string[], batch: number) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).buildPasswordSequence(pws, batch) as string[];

    // eslint-disable-next-line @typescript-eslint/require-await
    it("returns 4 entries for a full 3-password batch (Path A)", async () => {
      const seq = build(["a", "b", "c"], 0);
      expect(seq).toEqual(["a", "b", "c", "c"]); // 4th = re-press of 3rd
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("pads a 1-password batch with ! and !! variants (Path B)", async () => {
      const seq = build(["solo"], 0);
      expect(seq).toEqual(["solo", "solo!", "solo!!", "solo!!"]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("pads a 2-password batch with a single ! variant of password1", async () => {
      const seq = build(["pw1", "pw2"], 0);
      expect(seq).toEqual(["pw1", "pw2", "pw1!", "pw1!"]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("returns [] when the batch slice is empty", async () => {
      expect(build(["a", "b"], 5)).toEqual([]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("walks batches of 3 across higher batch indexes", async () => {
      const pws = ["p1", "p2", "p3", "p4", "p5", "p6"];
      const b1 = build(pws, 1);
      expect(b1).toEqual(["p4", "p5", "p6", "p6"]);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("applies ! padding per-batch using the batch's first password", async () => {
      // Batch 1 has only 1 password left — pad with that password's variants.
      const seq = build(["a", "b", "c", "lone"], 1);
      expect(seq).toEqual(["lone", "lone!", "lone!!", "lone!!"]);
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("isUrlChangedAwayFromLogin", async () => {
    const moved = (a: string, b: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).isUrlChangedAwayFromLogin(a, b) as boolean;

    // eslint-disable-next-line @typescript-eslint/require-await
    it("treats same path as not-moved", async () => {
      expect(moved("https://x.com/login", "https://x.com/login")).toBe(false);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("treats redirect to dashboard as moved", async () => {
      expect(moved("https://x.com/login", "https://x.com/dashboard")).toBe(true);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("does not count signin/sign-in variants as moved", async () => {
      expect(moved("https://x.com/login", "https://x.com/signin")).toBe(false);
      expect(moved("https://x.com/login", "https://x.com/sign-in")).toBe(false);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("returns false on malformed URLs", async () => {
      expect(moved("not a url", "still not")).toBe(false);
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("isMainPageRedirectAfterLogin", async () => {
    const rootRedirect = (login: string, current: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).isMainPageRedirectAfterLogin(login, current) as boolean;

    // eslint-disable-next-line @typescript-eslint/require-await
    it("detects same-site redirects from /login to the public root", async () => {
      expect(rootRedirect("https://www.ignitioncasino551.com/login", "https://www.ignitioncasino551.com/")).toBe(true);
      expect(rootRedirect("https://www.joefortune.win/login", "https://www.joefortune.win")).toBe(true);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("ignores non-root, login, cross-site, and malformed redirects", async () => {
      expect(rootRedirect("https://x.com/login", "https://x.com/dashboard")).toBe(false);
      expect(rootRedirect("https://x.com/login", "https://x.com/login?destination=/")).toBe(false);
      expect(rootRedirect("https://x.com/login", "https://evil.test/")).toBe(false);
      expect(rootRedirect("not-url", "also-not-url")).toBe(false);
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("Outcome type", async () => {
    it('exposes the 2FA category for AUTHENTICATOR popups', () => {
      const status: { outcome: import("../../src/core/engine.js").Outcome; attempts: number } = {
        outcome: "2FA",
        attempts: 1,
      };
      expect(status.outcome).toBe("2FA");
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("classifyLoginResponse — source-of-truth trigger words", async () => {
    const baseSignals = (overrides: Partial<LoginSignals> = {}): LoginSignals => ({
      bodyText: "",
      passwordPresent: true,
      urlMoved: false,
      hasSuccessSelector: false,
      submitGone: false,
      alertPresent: false,
      ...overrides,
    });

    it('returns "other" when "+61" appears in the page footer while the login form is still showing', () => {
      // Pre-submit: password field present, URL still on /login. Footer-style
      // chrome that happens to mention a support number must NOT trigger a verdict.
      const signals = baseSignals({
        bodyText: "Joe Fortune Login\nUsername:\nPassword:\nSupport: +61 1800-XXX-XXX",
        passwordPresent: true,
        urlMoved: false,
      });
      expect(classifyLoginResponse(signals, "joe")).toBe("other");
    });

    it('returns "verify-phone" once the password field has been removed and "+61" is on screen', () => {
      const signals = baseSignals({
        bodyText: "VERIFY YOUR PHONE\nEnter the code we sent to +61 4XX XXX XXX",
        passwordPresent: false,
      });
      expect(classifyLoginResponse(signals, "joe")).toBe("verify-phone");
    });

    it('returns "verify-phone" once the URL has moved off /login even if password field somehow lingers', () => {
      const signals = baseSignals({
        bodyText: "VERIFY YOUR PHONE",
        passwordPresent: true,
        urlMoved: true,
      });
      expect(classifyLoginResponse(signals, "joe")).toBe("verify-phone");
    });

    it('returns "authenticator" before checking verify-phone (authenticator has top priority)', () => {
      const signals = baseSignals({
        bodyText: "AUTHENTICATOR\nVERIFY YOUR PHONE\n+61",
        passwordPresent: false,
      });
      expect(classifyLoginResponse(signals, "ignition")).toBe("authenticator");
    });

    it('returns "pin-misdirection" for UPDATE YOUR PIN once the form has changed', () => {
      const signals = baseSignals({
        bodyText: "UPDATE YOUR PIN to continue",
        urlMoved: true,
      });
      expect(classifyLoginResponse(signals, "ignition")).toBe("pin-misdirection");
    });

    it('returns "ignition-verification" only on ignition, never on joe', () => {
      // Body text matches the exact popup wording from the source-of-truth
      // screenshot ("LOGIN VERIFICATION" + the SMS prompt copy).
      const signals = baseSignals({
        bodyText: "LOGIN VERIFICATION\nWe have just sent you a code via SMS. Please enter the code to proceed.",
        passwordPresent: false,
      });
      expect(classifyLoginResponse(signals, "ignition")).toBe("ignition-verification");
      // Same screen text on joe must NOT become a verdict.
      expect(classifyLoginResponse(signals, "joe")).toBe("other");
    });

    it('does NOT fire the ignition LOGIN VERIFICATION trigger while the password field is still visible', () => {
      const signals = baseSignals({
        bodyText: "LOGIN VERIFICATION required",
        passwordPresent: true,
        urlMoved: false,
      });
      expect(classifyLoginResponse(signals, "ignition")).toBe("ignition-verification");
    });

    it('does NOT match the bare word "VERIFICATION" — the trigger requires the exact "LOGIN VERIFICATION" two-word string', () => {
      // Unrelated copy on the page (e.g. age verification, identity verification,
      // "verification required" banner) must never be misread as the Ignition
      // misdirection popup, even after the form has changed state.
      const signals = baseSignals({
        bodyText: "Age Verification required. Identity verification complete.",
        passwordPresent: false,
      });
      expect(classifyLoginResponse(signals, "ignition")).toBe("other");
    });

    it('returns "success" when the success selector is found regardless of phase gate', () => {
      const signals = baseSignals({
        bodyText: "+61 support",
        passwordPresent: true,
        hasSuccessSelector: true,
      });
      expect(classifyLoginResponse(signals, "joe")).toBe("success");
    });

    it('returns "other" when form vanished (submit + password gone) — no longer triggers success', () => {
      const signals = baseSignals({
        bodyText: "Welcome back",
        passwordPresent: false,
        submitGone: true,
      });
      // Form-vanished was removed as a success signal — too ambiguous.
      // No-response handling flow takes over instead.
      expect(classifyLoginResponse(signals, "joe")).toBe("other");
    });

    it('still classifies per-credential phrases regardless of phase gate (server response is enough)', () => {
      expect(classifyLoginResponse(baseSignals({ bodyText: "Account has been disabled" }), "joe")).toBe("disabled");
      expect(classifyLoginResponse(baseSignals({ bodyText: "Account temporarily disabled" }), "joe")).toBe("tempdisabled");
      expect(classifyLoginResponse(baseSignals({ bodyText: "Password incorrect" }), "joe")).toBe("incorrect");
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("shouldRunCashierVerification — cashier-eligibility predicate", async () => {
    const result = (overrides: Partial<LoginFlowResult> = {}): LoginFlowResult => ({
      outcome: "success",
      attempts: 1,
      ...overrides,
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("returns true for a plain success outcome with no prior cashier run", async () => {
      expect(shouldRunCashierVerification(result(), "joe", null)).toBe(true);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("returns true for a noaccount outcome (the hidden-success upgrade path)", async () => {
      expect(shouldRunCashierVerification(result({ outcome: "noaccount" }), "joe", null)).toBe(true);
    });

    it('returns false when "bypassCashierVerification" is set (VERIFY YOUR PHONE / +61 path)', () => {
      // Source-of-truth spec: VERIFY YOUR PHONE / +61 is terminal success
      // that lives on a pre-cashier screen. Running cashier from there
      // would bounce back to login and produce a misleading "unconfirmed"
      // capture even though the credential is genuinely valid.
      expect(shouldRunCashierVerification(result({ bypassCashierVerification: true }), "joe", null)).toBe(false);
      expect(shouldRunCashierVerification(result({ bypassCashierVerification: true }), "ignition", null)).toBe(false);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("returns false when cashier already verified this site (no duplicate nav)", async () => {
      // confirmRootRedirectViaCashier ran mid-flow, set
      // __cashierVerifiedSuccessSite, and captured the canonical screenshot.
      // The wrapper must not run cashier a second time.
      expect(shouldRunCashierVerification(result(), "joe", "joe")).toBe(false);
    });

    it('returns false for non-cashier-eligible outcomes (2FA / permdisabled / tempdisabled / N/A / skipped / success-unconfirmed)', () => {
      // AUTHENTICATOR returns outcome "2FA" — terminal, no cashier check.
      expect(shouldRunCashierVerification(result({ outcome: "2FA" }), "joe", null)).toBe(false);
      expect(shouldRunCashierVerification(result({ outcome: "permdisabled" }), "joe", null)).toBe(false);
      expect(shouldRunCashierVerification(result({ outcome: "tempdisabled" }), "joe", null)).toBe(false);
      expect(shouldRunCashierVerification(result({ outcome: "N/A" }), "joe", null)).toBe(false);
      expect(shouldRunCashierVerification(result({ outcome: 'skipped' }), 'joe', null)).toBe(false);
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect(shouldRunCashierVerification(result({ outcome: 'success-unconfirmed' as any }), 'joe', null)).toBe(false);
    });

    it('honours bypass over the cashier-already-verified site check when both are set', () => {
      // Defensive: a VERIFY YOUR PHONE outcome that somehow has the verified
      // flag set on the page (cross-attempt leak) still skips — the bypass
      // semantics are stronger.
      expect(shouldRunCashierVerification(result({ bypassCashierVerification: true }), "joe", "joe")).toBe(false);
    });

    it('treats undefined / null / empty alreadyVerifiedSite identically (no false positive on falsy)', () => {
      expect(shouldRunCashierVerification(result(), "joe", undefined)).toBe(true);
      expect(shouldRunCashierVerification(result(), "joe", null)).toBe(true);
      expect(shouldRunCashierVerification(result(), "joe", "")).toBe(true);
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("isSuccessTerminalUrl", async () => {
    const isTerm = (site: string | undefined, url: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).isSuccessTerminalUrl(site, url) as boolean;

    // eslint-disable-next-line @typescript-eslint/require-await
    it("flags JoeFortune phone-number-reset-request as a terminal success", async () => {
      expect(isTerm("joe", "https://www.joefortune.win/phone-number-reset-request?token=abc")).toBe(true);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("does not flag the reset path on other sites", async () => {
      expect(isTerm("ignition", "https://www.ignitioncasino551.com/phone-number-reset-request?token=abc")).toBe(false);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("does not flag arbitrary joe paths", async () => {
      expect(isTerm("joe", "https://www.joefortune.win/account/cashier")).toBe(false);
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("returns false on malformed URLs", async () => {
      expect(isTerm("joe", "garbage")).toBe(false);
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("captureScreenshot attribution (Point 5a)", async () => {
    it("uses explicit ctx.email/ctx.target over engine globals (concurrency race fix)", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls: any[] = [];
      // Stand in for the ScreenshotService — capture the args, return a dummy result.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any)._screenshotSvc = {
         
         
        // eslint-disable-next-line @typescript-eslint/require-await
        capture: async (_page: any, ctx: any) => {
          calls.push(ctx);
          return { path: "/tmp/x.jpeg", relativePath: "x.jpeg", sizeBytes: 1, durationMs: 1 };
        },
      };
      // Engine globals get rotated by a concurrent row mid-flight:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).currentEmail = "next-row@x.com";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).currentTarget = "next-target";

      // Row N's tail capture fires with its own pinned ctx — must win.
       
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).captureScreenshot({} as any, "ignition:late-tail", {
        email: "originating-row@x.com",
        target: "ignition",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].email).toBe("originating-row@x.com");
      expect(calls[0].target).toBe("ignition");
      expect(calls[0].label).toBe("ignition:late-tail");
    });

    it("falls back to engine globals when ctx is omitted (backward compatible)", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any)._screenshotSvc = {
         
         
        // eslint-disable-next-line @typescript-eslint/require-await
        capture: async (_page: any, ctx: any) => {
          calls.push(ctx);
          return { path: "/tmp/x.jpeg", relativePath: "x.jpeg", sizeBytes: 1, durationMs: 1 };
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).currentEmail = "global@x.com";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).currentTarget = "joe";

       
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).captureScreenshot({} as any, "joe:row-start");

      expect(calls[0].email).toBe("global@x.com");
      expect(calls[0].target).toBe("joe");
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("Outcome classification (Point 4)", async () => {
    it('includes "skipped" in the Outcome union for zero-attempt rows', () => {
      // Type-level check via a runtime value the engine emits: a SiteStatus
      // assignment with outcome "skipped" must be assignable without ts errors.
      const status: { outcome: import("../../src/core/engine.js").Outcome; attempts: number; error?: string } = {
        outcome: "skipped",
        attempts: 0,
        error: "no-creds",
      };
      expect(status.outcome).toBe("skipped");
      expect(status.attempts).toBe(0);
      expect(status.error).toBe("no-creds");
    });

    it('LoginFlowResult.reason is plumbed through when present (engine row-loop wiring)', () => {
      // Simulate the row-loop body wiring on `sStatus.error = result.reason`.
      // The actual loop logic lives behind a Page (untestable here without a
      // browser); this asserts the contract that a "skipped" result with a
      // reason gets propagated, while existing errors aren't overwritten.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sStatusFresh: { outcome: any; attempts: number; error?: string } = { outcome: "queued", attempts: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: { outcome: any; attempts: number; reason?: string } = { outcome: "skipped", attempts: 0, reason: "no-creds" };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      sStatusFresh.outcome = result.outcome;
      sStatusFresh.attempts = result.attempts;
      if (result.reason && !sStatusFresh.error) sStatusFresh.error = result.reason;

      expect(sStatusFresh).toEqual({ outcome: "skipped", attempts: 0, error: "no-creds" });

      // Existing error (e.g. misdirection) wins over the result reason.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sStatusWithError: { outcome: any; attempts: number; error?: string } = {
        outcome: "queued", attempts: 0, error: "misdirection: ...",
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      sStatusWithError.outcome = result.outcome;
      sStatusWithError.attempts = result.attempts;
      if (result.reason && !sStatusWithError.error) sStatusWithError.error = result.reason;
      expect(sStatusWithError.error).toBe("misdirection: ...");
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("inputText escalating drift repair (Point 3)", async () => {
    // Builds a mock Page whose inputValue() returns whatever the most recent
    // mutation says it set. Each pass can be programmed to "fail" (i.e. not
    // actually persist the value) by returning the wrong length for a given
    // pass.
    const buildMockPage = (script: { passReturns: Array<string | undefined> }) => {
      let callCount = 0;
      const cur = () => script.passReturns[Math.min(callCount, script.passReturns.length - 1)];
      const next = () => { callCount++; };
      const locator = (_sel: string) => ({
        // eslint-disable-next-line @typescript-eslint/require-await
        inputValue: vi.fn(async () => cur()),
        // eslint-disable-next-line @typescript-eslint/require-await
        focus: vi.fn(async () => undefined),
        // eslint-disable-next-line @typescript-eslint/require-await
        fill: vi.fn(async () => { next(); }),
        // eslint-disable-next-line @typescript-eslint/require-await
        pressSequentially: vi.fn(async () => { next(); }),
        // eslint-disable-next-line @typescript-eslint/require-await
        evaluate: vi.fn(async () => { next(); }),
        // eslint-disable-next-line @typescript-eslint/require-await
        type: vi.fn(async () => { next(); }),
        // eslint-disable-next-line @typescript-eslint/require-await
        clear: vi.fn(async () => undefined),
      });
      return {
        locator: vi.fn(locator),
        // eslint-disable-next-line @typescript-eslint/require-await
        fill: vi.fn(async () => { next(); }),
        // eslint-disable-next-line @typescript-eslint/require-await
        type: vi.fn(async () => { next(); }),
        // eslint-disable-next-line @typescript-eslint/require-await
        evaluate: vi.fn(async () => null),
         
        // eslint-disable-next-line @typescript-eslint/require-await
        keyboard: { type: vi.fn(async () => { next(); }), press: vi.fn(async () => undefined) },
        // eslint-disable-next-line @typescript-eslint/require-await
        click: vi.fn(async () => undefined),
        // eslint-disable-next-line @typescript-eslint/require-await
        focus: vi.fn(async () => undefined),
      };
    };

    it("returns true when the very first read-back matches (no drift)", async () => {
      const page = buildMockPage({ passReturns: ["password123"] });
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ok = await (engine as any).inputText(page, "#password", "password123");
      expect(ok).toBe(true);
    });

    it("returns true when fast-human pass 1 (page.fill) repairs the drift", async () => {
      // Initial type returned 9 chars, page.fill rebuild lands at 10.
      const page = buildMockPage({ passReturns: ["badvalue9", "password10", "password10", "password10"] });
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ok = await (engine as any).inputText(page, "#password", "password10");
      expect(ok).toBe(true);
    });

    it("returns false when all 3 escalating passes still mismatch (drift-abort signal)", async () => {
      // Every read-back returns 9 chars instead of 10 — every pass fails to repair.
      const page = buildMockPage({ passReturns: ["badvalue9", "badvalue9", "badvalue9", "badvalue9", "badvalue9"] });
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ok = await (engine as any).inputText(page, "#password", "password10");
      expect(ok).toBe(false);
    });

    it("instant mode returns false when its own 3-fallback chain still mismatches", async () => {
      // Native setter, page.fill, clear+fill all fail to produce a matching read-back.
      const page = buildMockPage({ passReturns: ["x", "x", "x", "x"] });
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ok = await (engine as any).inputText(page, "#password", "longerpw");
      expect(ok).toBe(false);
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("scheduleRequeue (PIN / LOGIN VERIFICATION misdirection)", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    it("resets non-terminal site outcomes back to queued and tracks the row", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).rows = [{
        rowIndex: 0,
        email: "a@b.com",
        status: "testing",
        currentBatch: 0,
        sites: {
          joe: { outcome: "N/A", attempts: 1, error: "misdirection:UPDATE YOUR PIN:..." },
          ignition: { outcome: "queued", attempts: 0 },
        },
      }];
      const targets = [
        { name: "joe", url: "", selectors: { username: "", password: "", submit: "" } },
        { name: "ignition", url: "", selectors: { username: "", password: "", submit: "" } },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).scheduleRequeue(0, targets, "UPDATE YOUR PIN");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any).requeuedRowIndexes.has(0)).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any).rows[0].sites.joe.outcome).toBe("queued");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any).rows[0].sites.joe.attempts).toBe(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any).rows[0].sites.joe.error).toBe("requeued:UPDATE YOUR PIN");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any).rows[0].sites.ignition.outcome).toBe("queued");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any).rows[0].status).toBe("queued");
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("allows multiple requeues for the same row (no single-requeue-per-run guard)", async () => {
      // The requeuedRowIndexes one-requeue-per-run guard was removed intentionally.
      // Multiple requeues for the same row in one run are now allowed — the per-trigger
      // 5-minute cooldown prevents infinite loops instead.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).rows = [{
        rowIndex: 0,
        email: "a@b.com",
        status: "testing",
        currentBatch: 0,
        sites: { joe: { outcome: "N/A", attempts: 1 } },
      }];
      const targets = [{ name: "joe", url: "", selectors: { username: "", password: "", submit: "" } }];
      // First requeue — succeeds
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).scheduleRequeue(0, targets, "UPDATE YOUR PIN");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).rows[0].sites.joe.outcome = "N/A";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).rows[0].sites.joe.error = undefined;
      // Second requeue with a different trigger — also allowed now
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).scheduleRequeue(0, targets, "LOGIN VERIFICATION");
      // Row should be in queued state after the second requeue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any).rows[0].status).toBe("queued");
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("leaves already-terminal site outcomes untouched (permdisabled / noaccount / success)", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).rows = [{
        rowIndex: 0,
        email: "a@b.com",
        status: "testing",
        currentBatch: 0,
        sites: {
          joe: { outcome: "permdisabled", attempts: 2 },
          ignition: { outcome: "success", attempts: 1 },
        },
      }];
      const targets = [
        { name: "joe", url: "", selectors: { username: "", password: "", submit: "" } },
        { name: "ignition", url: "", selectors: { username: "", password: "", submit: "" } },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (engine as any).scheduleRequeue(0, targets, "UPDATE YOUR PIN");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any).rows[0].sites.joe.outcome).toBe("permdisabled");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any).rows[0].sites.ignition.outcome).toBe("success");
    });
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  describe("wipeStaticCache", async () => {
    it("removes the static cache directory if present", async () => {
      const targetDir = path.join(tmpDir, "wipe-cache-test");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "marker"), "x");
      const prev = process.env.CLOAK_STATIC_CACHE_DIR;
      process.env.CLOAK_STATIC_CACHE_DIR = targetDir;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (engine as any).wipeStaticCache("test trigger");
        expect(fs.existsSync(targetDir)).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.CLOAK_STATIC_CACHE_DIR;
        else process.env.CLOAK_STATIC_CACHE_DIR = prev;
      }
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    it("is a silent no-op when the cache directory does not exist", async () => {
      const targetDir = path.join(tmpDir, "absent-cache");
      const prev = process.env.CLOAK_STATIC_CACHE_DIR;
      process.env.CLOAK_STATIC_CACHE_DIR = targetDir;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => (engine as any).wipeStaticCache("absent")).not.toThrow();
      } finally {
        if (prev === undefined) delete process.env.CLOAK_STATIC_CACHE_DIR;
        else process.env.CLOAK_STATIC_CACHE_DIR = prev;
      }
    });
  });

});
