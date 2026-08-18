import { describe, it, expect } from "vitest";
import { emailSlugForFilename } from "../../src/services/rename-recordings.js";

describe("Rename Recordings Helper", () => {
  it("should generate safe filename slug for email addresses", () => {
    expect(emailSlugForFilename("")).toBe("nocred");
    expect(emailSlugForFilename(undefined)).toBe("nocred");
    expect(emailSlugForFilename("User.Name+123@Example.com")).toBe("user.name_123_example.com");
    expect(emailSlugForFilename("normal@domain.org")).toBe("normal_domain.org");
  });
});
