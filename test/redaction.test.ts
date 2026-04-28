import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redaction.js";

describe("redactSecrets", () => {
  it("redacts bearer tokens and context tokens without removing ordinary text", () => {
    const text = "Authorization: Bearer abc.def.ghi context_token=ctx-123 user=alice";

    expect(redactSecrets(text)).toBe(
      "Authorization: Bearer [REDACTED] context_token=[REDACTED] user=alice"
    );
  });
});

