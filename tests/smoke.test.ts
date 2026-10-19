import { describe, expect, it } from "vitest";
import { isValidStoreKey, secretKeyFor } from "../src/store/index.js";
import { PROFILE_NAME_RE } from "../src/types.js";

describe("skeleton", () => {
  it("derives the store key from a profile name", () => {
    expect(secretKeyFor("acme:local:admin")).toBe("agent-auth/acme:local:admin");
  });
});

describe("isValidStoreKey", () => {
  it("accepts exactly agent-auth/<valid profile name>", () => {
    for (const name of ["acme:local:admin", "acme:staging:quality-lead.v2_x", "a"]) {
      expect(PROFILE_NAME_RE.test(name)).toBe(true);
      expect(isValidStoreKey(secretKeyFor(name)), name).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const key of [
      "",
      "agent-auth/",
      "agent-auth",
      "acme:local:admin",
      "other/acme:local:admin",
      "agent-auth/Acme:local",
      "agent-auth/acme::admin",
      "agent-auth/../acme",
      "agent-auth/acme/admin",
      "agent-auth/acme:local:admin ",
      "AGENT-AUTH/acme:local:admin",
    ]) {
      expect(isValidStoreKey(key), JSON.stringify(key)).toBe(false);
    }
  });
});
