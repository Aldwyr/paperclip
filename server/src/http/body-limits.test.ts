import { describe, expect, it } from "vitest";
import { DEFAULT_BRIDGE_MAX_BODY_BYTES } from "@paperclipai/adapter-utils/sandbox-callback-bridge";

import { DEFAULT_JSON_BODY_LIMIT, DEFAULT_JSON_BODY_LIMIT_BYTES } from "./body-limits.js";

describe("JSON body limit constants", () => {
  it("keeps the byte form at 10 MiB", () => {
    expect(DEFAULT_JSON_BODY_LIMIT_BYTES).toBe(10 * 1024 * 1024);
  });

  it("derives the string form from the byte form so the two cannot drift", () => {
    // `express.json` parses the string form. The byte form derives the string,
    // so a change to one changes the other.
    expect(DEFAULT_JSON_BODY_LIMIT).toBe("10mb");
    expect(DEFAULT_JSON_BODY_LIMIT).toBe(`${DEFAULT_JSON_BODY_LIMIT_BYTES / (1024 * 1024)}mb`);
  });

  it("keeps the bridge body cap at the API limit plus one byte", () => {
    // The bridge cap lives in `@paperclipai/adapter-utils` and cannot import the
    // API limit from `server` (that creates a package cycle). This test imports
    // both packages and asserts the two agree. The `+ 1` lets a body of exactly
    // the API limit pass through the bridge so the API issues its own 413.
    expect(DEFAULT_BRIDGE_MAX_BODY_BYTES).toBe(DEFAULT_JSON_BODY_LIMIT_BYTES + 1);
  });
});
