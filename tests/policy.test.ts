import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_TTL_MINUTES, assertAllowed, hostOf, isAllowedHost, hostnameOf } from "../src/policy.js";
import { getProfile, parseRegistry } from "../src/profiles.js";
import { PolicyError, type Profile } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.resolve(here, "..", "examples", "testlane.profiles.json");

function catchPolicy(fn: () => unknown): PolicyError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyError);
    return err as PolicyError;
  }
  throw new Error("expected a PolicyError");
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "demo:testing:sales",
    app: "demo-app",
    environment: "testing",
    baseUrl: "https://demo.testing.test",
    strategy: "nextauth-credentials",
    account: { email: "agent.sales@demo.test", role: "Sales" },
    session: { ttlMinutes: 120 },
    ...overrides,
  };
}

const ENV_KEYS = ["TESTLANE_HOME", "TESTLANE_ALLOW_PRODUCTION", "AGENT_AUTH_ALLOW_PRODUCTION"] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmp = "";

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-policy-"));
  process.env["TESTLANE_HOME"] = tmp;
  delete process.env["TESTLANE_ALLOW_PRODUCTION"];
  delete process.env["AGENT_AUTH_ALLOW_PRODUCTION"];
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("production refusal", () => {
  it("refuses the example production profile, interactive or not", async () => {
    const reg = parseRegistry(JSON.parse(await fs.readFile(examplePath, "utf8")), examplePath);
    const live = getProfile(reg, "acme:production");
    for (const interactive of [false, true]) {
      const err = catchPolicy(() => assertAllowed(live, { interactive }));
      expect(err.code).toBe("production-refused");
      expect(err.message).toMatch(/no override/i);
    }
  });

  it("has no override: TESTLANE_ALLOW_PRODUCTION=1 / AGENT_AUTH_ALLOW_PRODUCTION=1 plus interactive still refuses", () => {
    process.env["TESTLANE_ALLOW_PRODUCTION"] = "1";
    process.env["AGENT_AUTH_ALLOW_PRODUCTION"] = "1";
    const prod = profile({
      name: "demo:prod",
      environment: "production",
      baseUrl: "https://prod.demo.test",
      session: { ttlMinutes: 60 },
    });
    const err = catchPolicy(() =>
      assertAllowed(prod, {
        interactive: true,
        requestedTtlMinutes: 1,
        targetUrl: "https://prod.demo.test/",
      }),
    );
    expect(err.code).toBe("production-refused");
  });

  it("refuses production before any other check (even a well-formed https profile)", () => {
    const err = catchPolicy(() =>
      assertAllowed(profile({ environment: "production", baseUrl: "http://evil.demo.test" }), {
        interactive: true,
      }),
    );
    expect(err.code).toBe("production-refused");
  });
});

describe("production host set (ctx.productionHosts)", () => {
  const prodHosts = new Set(["prod.demo.test", "api.prod.demo.test"]);

  it("compares production hosts by hostname: another port or a trailing dot does not escape the denylist", () => {
    for (const baseUrl of ["https://prod.demo.test:8443/", "https://prod.demo.test./", "https://PROD.demo.test.:9443/x"]) {
      const err = catchPolicy(() => assertAllowed(profile({ baseUrl }), { interactive: false, productionHosts: prodHosts }));
      expect(err.code).toBe("production-refused");
    }
  });

  it("hostnameOf strips ports and trailing dots, keeps IPv6 brackets", () => {
    expect(hostnameOf("prod.demo.test:8443")).toBe("prod.demo.test");
    expect(hostnameOf("PROD.demo.test.")).toBe("prod.demo.test");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
    expect(hostnameOf("[::1]")).toBe("[::1]");
    expect(hostOf("https://prod.demo.test./x")).toBe("prod.demo.test");
  });

  it("refuses a non-production profile whose baseUrl host is a production host", () => {
    const err = catchPolicy(() =>
      assertAllowed(profile({ baseUrl: "https://PROD.demo.test/app" }), { interactive: false, productionHosts: prodHosts }),
    );
    expect(err.code).toBe("production-refused");
    expect(err.message).toContain("prod.demo.test");
  });

  it("refuses production hosts before transport checks", () => {
    const err = catchPolicy(() =>
      assertAllowed(profile({ baseUrl: "http://prod.demo.test" }), { interactive: false, productionHosts: prodHosts }),
    );
    expect(err.code).toBe("production-refused");
  });

  it("refuses a target on a production host, even one the profile lists", () => {
    const p = profile({ allowedHosts: ["api.prod.demo.test:8443"] });
    const err = catchPolicy(() =>
      assertAllowed(p, {
        interactive: false,
        productionHosts: prodHosts,
        targetUrl: "https://api.prod.demo.test:8443/v1",
      }),
    );
    expect(err.code).toBe("production-refused");
  });

  it("allows other hosts and behaves as before without the set", () => {
    expect(assertAllowed(profile(), { interactive: false, productionHosts: prodHosts }).host).toBe("demo.testing.test");
    expect(assertAllowed(profile({ baseUrl: "https://prod.demo.test" }), { interactive: false }).host).toBe(
      "prod.demo.test",
    );
  });
});

describe("transport", () => {
  it("refuses plain http on non-loopback hosts", () => {
    const err = catchPolicy(() =>
      assertAllowed(profile({ baseUrl: "http://demo.testing.test" }), { interactive: false }),
    );
    expect(err.code).toBe("insecure-transport");
  });

  it("accepts plain http on loopback hosts", () => {
    for (const baseUrl of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      "http://LOCALHOST",
    ]) {
      expect(assertAllowed(profile({ baseUrl }), { interactive: false }).ttlMinutes).toBe(120);
    }
  });

  it("does not treat look-alike hosts as loopback", () => {
    // A *.localhost subdomain goes through the system resolver, so it is not loopback (tests/security-hardening.test.ts).
    for (const baseUrl of ["http://localhost.demo.test", "http://127.0.0.2", "http://notlocalhost", "http://acme.localhost:3000"]) {
      expect(catchPolicy(() => assertAllowed(profile({ baseUrl }), { interactive: false })).code).toBe(
        "insecure-transport",
      );
    }
  });

  it("refuses a plain-http target on an allowed non-loopback host", () => {
    const err = catchPolicy(() =>
      assertAllowed(profile(), { interactive: false, targetUrl: "http://demo.testing.test/x" }),
    );
    expect(err.code).toBe("insecure-transport");
  });
});

describe("host allowlist", () => {
  const p = profile({ allowedHosts: ["api.demo.testing.test", "assets.demo.testing.test:8443"] });

  it("accepts baseUrl's host and allowedHosts entries", () => {
    for (const targetUrl of [
      "https://demo.testing.test/dashboard?x=1",
      "https://DEMO.testing.test:443/",
      "https://api.demo.testing.test/v1",
      "https://assets.demo.testing.test:8443/a.png",
    ]) {
      expect(assertAllowed(p, { interactive: false, targetUrl }).host).toBe("demo.testing.test");
    }
  });

  it("rejects other hosts, other ports and suffix look-alikes", () => {
    for (const targetUrl of [
      "https://evil.test/",
      "https://demo.testing.test.evil.test/",
      "https://demo.testing.test:8443/",
      "https://assets.demo.testing.test/",
      "https://x.api.demo.testing.test/",
      "ftp://demo.testing.test/",
      "not a url",
    ]) {
      const err = catchPolicy(() => assertAllowed(p, { interactive: false, targetUrl }));
      expect(err.code, targetUrl).toBe("host-not-allowed");
    }
  });

  it("hostOf normalises case and default ports", () => {
    expect(hostOf("https://Demo.Test:443/a")).toBe("demo.test");
    expect(hostOf("http://demo.test:80")).toBe("demo.test");
    expect(hostOf("http://localhost:3000/")).toBe("localhost:3000");
    expect(hostOf("https://demo.test:80/")).toBe("demo.test:80");
    expect(hostOf("http://[::1]:3000")).toBe("[::1]:3000");
  });

  it("isAllowedHost matches exact hosts only", () => {
    expect(isAllowedHost(p, "demo.testing.test")).toBe(true);
    expect(isAllowedHost(p, "API.demo.testing.test")).toBe(true);
    expect(isAllowedHost(p, "assets.demo.testing.test:8443")).toBe(true);
    expect(isAllowedHost(p, "assets.demo.testing.test")).toBe(false);
    expect(isAllowedHost(p, "evil.test")).toBe(false);
  });
});

describe("ttl", () => {
  it("refuses a profile with ttlMinutes 0", () => {
    const err = catchPolicy(() =>
      assertAllowed(profile({ session: { ttlMinutes: 0 } }), { interactive: true }),
    );
    expect(err.code).toBe("ttl-exceeded");
  });

  it("refuses a requested ttl above the profile ttl instead of capping it", () => {
    const err = catchPolicy(() =>
      assertAllowed(profile({ session: { ttlMinutes: 60 } }), {
        interactive: false,
        requestedTtlMinutes: 61,
      }),
    );
    expect(err.code).toBe("ttl-exceeded");
  });

  it("refuses non-positive or fractional requested ttl", () => {
    for (const requestedTtlMinutes of [0, -5, 1.5, Number.NaN]) {
      expect(
        catchPolicy(() => assertAllowed(profile(), { interactive: false, requestedTtlMinutes })).code,
      ).toBe("ttl-exceeded");
    }
  });

  it("honours a requested ttl at or below the profile ttl", () => {
    expect(assertAllowed(profile(), { interactive: false, requestedTtlMinutes: 30 }).ttlMinutes).toBe(30);
    expect(assertAllowed(profile(), { interactive: false, requestedTtlMinutes: 120 }).ttlMinutes).toBe(120);
  });

  it("issues min(profile ttl, MAX_TTL_MINUTES) when no ttl is requested", () => {
    expect(MAX_TTL_MINUTES).toBe(480);
    const long = profile({ session: { ttlMinutes: 1440 } });
    expect(assertAllowed(long, { interactive: false }).ttlMinutes).toBe(MAX_TTL_MINUTES);
  });

  it("refuses (never caps) a requested ttl above MAX_TTL_MINUTES even when the profile allows more", () => {
    const long = profile({ session: { ttlMinutes: 1440 } });
    const err = catchPolicy(() => assertAllowed(long, { interactive: false, requestedTtlMinutes: 1000 }));
    expect(err.code).toBe("ttl-exceeded");
    expect(err.message).toContain(`global maximum of ${MAX_TTL_MINUTES}`);
    expect(catchPolicy(() => assertAllowed(long, { interactive: false, requestedTtlMinutes: MAX_TTL_MINUTES + 1 })).code).toBe(
      "ttl-exceeded",
    );
    expect(assertAllowed(long, { interactive: false, requestedTtlMinutes: MAX_TTL_MINUTES }).ttlMinutes).toBe(
      MAX_TTL_MINUTES,
    );
    expect(assertAllowed(long, { interactive: false, requestedTtlMinutes: 90 }).ttlMinutes).toBe(90);
  });

  it("returns the baseUrl host including a non-default port", () => {
    expect(
      assertAllowed(profile({ baseUrl: "http://localhost:3000" }), { interactive: false }),
    ).toEqual({ ttlMinutes: 120, host: "localhost:3000" });
  });
});

describe("example registry", () => {
  it("allows every non-production example profile with default context", async () => {
    const reg = parseRegistry(JSON.parse(await fs.readFile(examplePath, "utf8")), examplePath);
    for (const p of Object.values(reg.profiles)) {
      if (p.environment === "production") continue;
      const decision = assertAllowed(p, { interactive: false });
      expect(decision.ttlMinutes).toBe(Math.min(p.session.ttlMinutes, MAX_TTL_MINUTES));
    }
  });
});
