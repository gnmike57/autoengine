/**
 * Classification Gate Exhaustiveness Tests
 *
 * Exercises every branch of classifyLoginResponse() with synthetic
 * LoginSignals, verifying that all possible body text patterns map
 * to the correct outcome and no input falls through to an unexpected
 * result.
 */
import { describe, it, expect } from "vitest";
import {
  classifyLoginResponse,
  type LoginSignals,
} from "../../src/core/engine.js";
import { detectLoginTrigger } from "../../src/targets/login-flow.js";

/** Helper: create a LoginSignals object with sensible defaults. */
function makeSignals(overrides: Partial<LoginSignals> = {}): LoginSignals {
  return {
    bodyText: "",
    passwordPresent: true,
    urlMoved: false,
    hasSuccessSelector: false,
    submitGone: false,
    alertPresent: false,
    promoPresent: false,
    ...overrides,
  };
}

describe("classifyLoginResponse — exhaustiveness", () => {
  // ─── Temp disabled ──────────────────────────────────────────────────
  describe("tempdisabled detection (highest priority)", () => {
    const tempPhrases = [
      "Your account has been temporarily disabled",
      "Too many failed attempts - try again later",
      "You are locked out of your account",
      "Please try again in 30 minutes",
      "try again later",
      "too many attempts",
    ];

    for (const phrase of tempPhrases) {
      it(`detects tempdisabled: "${phrase.slice(0, 40)}..."`, () => {
        const result = classifyLoginResponse(makeSignals({ bodyText: phrase }), "joe");
        expect(result).toBe("tempdisabled");
      });
    }

    it("tempdisabled takes priority over permdisabled when both present", () => {
      const body = "has been disabled temporarily disabled";
      const result = classifyLoginResponse(makeSignals({ bodyText: body }), "joe");
      expect(result).toBe("tempdisabled");
    });
  });

  // ─── Permdisabled ───────────────────────────────────────────────────
  describe("permdisabled / disabled detection", () => {
    const permPhrases = [
      "Your account has been permanently disabled",
      "This account closed for security reasons",
      "Your account has been disabled",
      "Account suspended due to violation",
      "This account is no longer active",
    ];

    for (const phrase of permPhrases) {
      it(`detects disabled: "${phrase.slice(0, 40)}..."`, () => {
        const result = classifyLoginResponse(makeSignals({ bodyText: phrase }), "joe");
        expect(result).toBe("disabled");
      });
    }
  });

  // ─── Honeypot ───────────────────────────────────────────────────────
  describe("honeypot detection", () => {
    it("detects 'under review'", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "Your account is under review" }), "joe"
      );
      expect(result).toBe("honeypot");
    });

    it("detects 'upload identity'", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "Please upload identity documents" }), "joe"
      );
      expect(result).toBe("honeypot");
    });
  });

  // ─── Incorrect / alert ─────────────────────────────────────────────
  describe("incorrect detection", () => {
    it("detects alertPresent signal", () => {
      const result = classifyLoginResponse(
        makeSignals({ alertPresent: true }), "joe"
      );
      expect(result).toBe("incorrect");
    });

    it("detects 'incorrect' in body text", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "The password you entered is incorrect" }), "joe"
      );
      expect(result).toBe("incorrect");
    });
  });

  // ─── Ignition verification ─────────────────────────────────────────
  describe("ignition-verification (site-gated)", () => {
    it("fires for ignition site only", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "LOGIN VERIFICATION required" }), "ignition"
      );
      expect(result).toBe("ignition-verification");
    });

    it("does NOT fire for joe site", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "LOGIN VERIFICATION required" }), "joe"
      );
      // On joe, "LOGIN VERIFICATION" is not a trigger — falls through to "other"
      expect(result).not.toBe("ignition-verification");
    });
  });

  // ─── Phase-gated triggers (require form change) ────────────────────
  describe("phase-gated triggers (formChanged required)", () => {
    it("authenticator fires when password is gone", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "Enter your AUTHENTICATOR code", passwordPresent: false }), "joe"
      );
      expect(result).toBe("authenticator");
    });

    it("authenticator does NOT fire when password is still present", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "Enter your AUTHENTICATOR code", passwordPresent: true }), "joe"
      );
      // Phase gate blocks → falls to "other"
      expect(result).toBe("other");
    });

    it("verify-phone fires when URL moved", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "VERIFY YOUR PHONE +61", urlMoved: true }), "joe"
      );
      expect(result).toBe("verify-phone");
    });

    it("pin-misdirection fires when form changed", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "UPDATE YOUR PIN", passwordPresent: false }), "joe"
      );
      expect(result).toBe("pin-misdirection");
    });

    it("pin-misdirection does NOT fire without form change", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "UPDATE YOUR PIN", passwordPresent: true }), "joe"
      );
      expect(result).toBe("other");
    });

    it("promo-based success fires when form changed", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "Welcome back!", promoPresent: true, passwordPresent: false }), "joe"
      );
      expect(result).toBe("success");
    });
  });

  // ─── Success paths ─────────────────────────────────────────────────
  describe("success detection", () => {
    it("hasSuccessSelector → success", () => {
      const result = classifyLoginResponse(
        makeSignals({ hasSuccessSelector: true }), "joe"
      );
      expect(result).toBe("success");
    });

    

    

    

    it("submitGone + passwordPresent=false → other (form-vanished no longer triggers success)", () => {
      const result = classifyLoginResponse(
        makeSignals({ submitGone: true, passwordPresent: false }), "joe"
      );
      // Form-vanished was removed as a success signal — too ambiguous.
      // No-response handling flow takes over instead.
      expect(result).toBe("other");
    });

    it("submitGone alone (password still present) does NOT trigger success", () => {
      const result = classifyLoginResponse(
        makeSignals({ submitGone: true, passwordPresent: true }), "joe"
      );
      expect(result).not.toBe("success");
    });
  });

  // ─── Fallback ───────────────────────────────────────────────────────
  describe("fallback to 'other'", () => {
    it("empty signals → other", () => {
      const result = classifyLoginResponse(makeSignals(), "joe");
      expect(result).toBe("other");
    });

    it("random text → other", () => {
      const result = classifyLoginResponse(
        makeSignals({ bodyText: "Lorem ipsum dolor sit amet" }), "joe"
      );
      expect(result).toBe("other");
    });
  });

  // ─── Priority ordering ─────────────────────────────────────────────
  describe("priority ordering", () => {
    it("tempdisabled beats everything", () => {
      // Body has BOTH tempdisabled and honeypot and incorrect signals
      const result = classifyLoginResponse(
        makeSignals({
          bodyText: "temporarily disabled under review incorrect",
          alertPresent: true,
          hasSuccessSelector: true,
        }),
        "joe"
      );
      expect(result).toBe("tempdisabled");
    });

    it("permdisabled beats honeypot and incorrect", () => {
      const result = classifyLoginResponse(
        makeSignals({
          bodyText: "permanently disabled under review incorrect",
        }),
        "joe"
      );
      // tempdisabled isn't present so disabled wins
      expect(result).toBe("disabled");
    });

    it("honeypot beats incorrect", () => {
      const result = classifyLoginResponse(
        makeSignals({
          bodyText: "under review. The password is incorrect",
        }),
        "joe"
      );
      expect(result).toBe("honeypot");
    });
  });
});

describe("detectLoginTrigger — exhaustiveness", () => {
  it("returns null for empty text", () => {
    expect(detectLoginTrigger("", "joe")).toBeNull();
  });

  it("detects authenticator", () => {
    expect(detectLoginTrigger("Enter your AUTHENTICATOR code", "joe")).toBe("authenticator");
  });

  it("detects verify-phone via +61", () => {
    expect(detectLoginTrigger("Your number is +61 412 345 678", "joe")).toBe("verify-phone");
  });

  it("detects pin-misdirection via UPDATE YOUR PIN", () => {
    expect(detectLoginTrigger("Please UPDATE YOUR PIN", "joe")).toBe("pin-misdirection");
  });

  it("detects pin-misdirection via PIN UPDATE", () => {
    expect(detectLoginTrigger("A PIN UPDATE is required", "joe")).toBe("pin-misdirection");
  });

  it("ignition-verification only fires for ignition site", () => {
    expect(detectLoginTrigger("LOGIN VERIFICATION", "ignition")).toBe("ignition-verification");
    expect(detectLoginTrigger("LOGIN VERIFICATION", "joe")).toBeNull();
  });

  it("authenticator has highest priority when multiple triggers present", () => {
    const text = "AUTHENTICATOR VERIFY YOUR PHONE UPDATE YOUR PIN LOGIN VERIFICATION";
    expect(detectLoginTrigger(text, "ignition")).toBe("authenticator");
  });

  it("returns null for completely unrelated text", () => {
    expect(detectLoginTrigger("Welcome to the casino!", "joe")).toBeNull();
  });
});
