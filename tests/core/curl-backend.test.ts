import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCurlRestFlow } from "../../src/core/curl-backend.js";
import { post } from "curl-cffi-node";

vi.mock("curl-cffi-node", () => {
  return {
    post: vi.fn(),
    BrowserType: { Chrome120: "chrome120" }
  };
});

describe("curl-backend", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target: any = {
    name: "test-site",
    apiLoginEndpoint: "https://api.example.com/login",
    selectors: {
      username: "user",
      password: "pwd"
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credential: any = {
    email: "test@example.com",
    passwords: ["pass1"]
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns N/A if no apiLoginEndpoint", async () => {
     
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await executeCurlRestFlow({} as any, credential, null);
    expect(result.outcome).toBe("N/A");
  });

  it("sends form data if apiPayloadFormat is form", async () => {
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(post).mockResolvedValue({ status: 200, text: () => "token: 123" } as any);
    
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await executeCurlRestFlow({ ...target, apiPayloadFormat: "form" }, credential, null);
    
    expect(post).toHaveBeenCalledTimes(1);
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const options = vi.mocked(post).mock.calls[0]![1] as any;
    expect(options.data).toContain("user=test%40example.com");
    expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("handles successful login via JSON", async () => {
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(post).mockResolvedValue({ status: 200, text: () => "success" } as any);
    
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await executeCurlRestFlow(target, credential, "http://proxy");
    
    expect(result.outcome).toBe("inconclusive");
    expect(result.reason).toBe("curl-backend-missing-required-visual-and-browser-evidence");
    expect(result.attempts).toBe(1);
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const options = vi.mocked(post).mock.calls[0]![1] as any;
    expect(options.proxy).toBe("http://proxy");
    expect(options.data).toEqual({ user: "test@example.com", pwd: "pass1" });
  });

  it("handles redirect as success", async () => {
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(post).mockResolvedValue({ status: 302, text: () => "" } as any);
    
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await executeCurlRestFlow(target, credential, null);
    expect(result.outcome).toBe("inconclusive");
    expect(result.reason).toBe("curl-backend-missing-required-visual-and-browser-evidence");
  });

  it("handles incorrect password (401)", async () => {
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(post).mockResolvedValue({ status: 401, text: () => "invalid" } as any);
    
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await executeCurlRestFlow(target, { ...credential, passwords: ["bad1", "bad2"] }, null);
    expect(result.outcome).toBe("inconclusive");
    expect(result.reason).toBe("curl-backend-missing-required-visual-and-browser-evidence");
    expect(result.attempts).toBe(2);
  });

  it("handles cloudflare block (403) and legacy fuzzing success", async () => {
    vi.mocked(post)
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      .mockResolvedValueOnce({ status: 403, text: () => "cloudflare" } as any) // main api block
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      .mockResolvedValueOnce({ status: 404, text: () => "" } as any) // legacy 1 fail
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      .mockResolvedValueOnce({ status: 200, text: () => "token" } as any); // legacy 2 success
    
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const targetWithLegacy = { ...target, legacyApiEndpoints: ["https://api.example.com/leg1", "https://api.example.com/leg2"] };
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await executeCurlRestFlow(targetWithLegacy, credential, null);
    
    expect(result.outcome).toBe("inconclusive");
    expect(result.reason).toBe("curl-backend-missing-required-visual-and-browser-evidence");
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("handles cloudflare block (429) and legacy fuzzing fail as tempdisabled", async () => {
    vi.mocked(post)
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      .mockResolvedValue({ status: 429, text: () => "cloudflare" } as any);
    
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await executeCurlRestFlow(target, credential, null);
    
    expect(result.outcome).toBe("inconclusive");
    expect(result.reason).toBe("curl-backend-missing-required-visual-and-browser-evidence");
  });

  it("handles error during request", async () => {
    vi.mocked(post).mockRejectedValue(new Error("Network Error"));
    
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const result = await executeCurlRestFlow(target, credential, null);
    expect(result.outcome).toBe("N/A");
  });
});
