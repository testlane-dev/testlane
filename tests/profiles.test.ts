import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getProfile,
  loadProfiles,
  parseRegistry,
  productionHosts,
  readAccountOverrides,
  summarizeProfile,
  writeAccountOverrides,
} from "../src/profiles.js";
import { accountOverridesPath, userProfilesPath } from "../src/paths.js";
import { PolicyError } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const examplePath = path.join(repoRoot, "examples", "testlane.profiles.json");
const fixture = (name: string) => path.join(here, "fixtures", "profiles", name);

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

function catchPolicy(fn: () => unknown): PolicyError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyError);
    return err as PolicyError;
  }
  throw new Error("expected a PolicyError");
}

async function catchPolicyAsync(p: Promise<unknown>): Promise<PolicyError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyError);
    return err as PolicyError;
  }
  throw new Error("expected a PolicyError");
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: "demo-app",
    environment: "sandbox",
    baseUrl: "http://localhost:3000",
    strategy: "nextauth-credentials",
    account: { email: "a@demo.test", role: "Sales" },
    session: { ttlMinutes: 60 },
    ...overrides,
  };
}

function registryJson(profiles: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, profiles }, null, 2);
}

function parseOne(e: Record<string, unknown>, name = "demo:local:x") {
  return parseRegistry({ version: 1, profiles: { [name]: e } }, "inline.json");
}

const ENV_KEYS = ["TESTLANE_HOME", "TESTLANE_PROFILES"] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmp = "";
let home = "";

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-profiles-"));
  home = path.join(tmp, "home");
  await fs.mkdir(home, { recursive: true });
  process.env["TESTLANE_HOME"] = home;
  delete process.env["TESTLANE_PROFILES"];
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("parseRegistry", () => {
  it("parses the example registry, including the production entry", async () => {
    const reg = parseRegistry(await readJson(examplePath), examplePath);
    expect(reg.version).toBe(1);
    expect(reg.sources).toEqual([examplePath]);
    expect(Object.keys(reg.profiles).sort()).toEqual([
      "acme:local:admin",
      "acme:production",
      "acme:staging:handoff:qa",
      "acme:staging:qa",
      "acme:testing:reader",
      "acme:testing:service",
    ]);
    const live = getProfile(reg, "acme:production");
    expect(live.name).toBe("acme:production");
    expect(live.environment).toBe("production");
    expect(live.session.ttlMinutes).toBe(0);
    const reader = getProfile(reg, "acme:testing:reader");
    expect(reader.strategy).toBe("dependent-token");
    expect(reader.account.identifier).toBe("subject-42");
    expect(reader.options?.["dependsOn"]).toBe("acme:testing:service");
    // Every host in the shipped example is reserved (.test / .example) or loopback.
    for (const p of Object.values(reg.profiles)) {
      expect(new URL(p.baseUrl).hostname).toMatch(/(^localhost$|\.test$|\.example$)/);
    }
  });

  it("parses the valid fixture and injects names from record keys", async () => {
    const reg = parseRegistry(await readJson(fixture("valid.json")), "valid.json");
    const sales = getProfile(reg, "demo:testing:sales");
    expect(sales.name).toBe("demo:testing:sales");
    expect(sales.allowedHosts).toEqual(["api.demo.testing.test", "assets.demo.testing.test:8443"]);
    expect(sales.options).toEqual({ loginPath: "/login", successPath: "/home" });
    const admin = getProfile(reg, "demo:local:admin");
    expect("allowedHosts" in admin).toBe(false);
    expect("notes" in admin).toBe(false);
    expect("identifier" in admin.account).toBe(false);
  });

  it("rejects an unregistered strategy and unknown account fields", () => {
    const strategy = catchPolicy(() => parseOne(entry({ strategy: "unregistered" })));
    expect(strategy.code).toBe("invalid-profile");
    expect(strategy.message).toContain("strategy");
    const account = catchPolicy(() =>
      parseOne(entry({ account: { email: "member@demo.test", role: "Reader", customAccountField: "subject-42" } })),
    );
    expect(account.code).toBe("invalid-profile");
    expect(account.message).toContain("customAccountField");
  });

  it("rejects unknown keys (strict)", async () => {
    const json = await readJson(fixture("unknown-key.json"));
    const err = catchPolicy(() => parseRegistry(json, "unknown.json"));
    expect(err.code).toBe("invalid-profile");
    expect(err.message).toContain('profiles["demo:local:admin"]');
    expect(err.message).toContain("rememberMe");

    const nested = catchPolicy(() =>
      parseOne(entry({ account: { email: "a@demo.test", role: "Sales", password: "x" } })),
    );
    expect(nested.message).toContain('profiles["demo:local:x"].account');
    expect(nested.message).toContain("password");

    const top = catchPolicy(() => parseRegistry({ version: 1, profiles: {}, extra: true }, "t.json"));
    expect(top.message).toContain("extra");
  });

  it("tolerates a top-level $schema pointer", () => {
    const reg = parseRegistry({ $schema: "./schema/profiles.schema.json", version: 1, profiles: {} }, "s.json");
    expect(reg.profiles).toEqual({});
  });

  it("reports every invalid field with a path-qualified message and the source", async () => {
    const json = await readJson(fixture("invalid-entries.json"));
    const err = catchPolicy(() => parseRegistry(json, "invalid-entries.json"));
    expect(err.code).toBe("invalid-profile");
    const m = err.message;
    expect(m).toContain("invalid-entries.json");
    expect(m).toContain('profiles["demo:local:bad"].environment');
    expect(m).toContain('profiles["demo:local:bad"].baseUrl: must not contain a query string');
    expect(m).toContain('profiles["demo:local:bad"].session.ttlMinutes');
    expect(m).toContain('profiles["demo:local:bad"].allowedHosts[0]');
    expect(m).toContain('profiles["Demo Bad Name"]: profile name must match');
    expect(m).toContain('profiles["Demo Bad Name"].session.ttlMinutes: must be an integer');
  });

  it("allows an empty email only on production entries", () => {
    const err = catchPolicy(() => parseOne(entry({ account: { email: "", role: "" } })));
    expect(err.message).toContain('profiles["demo:local:x"].account.email');
    const reg = parseOne(
      entry({
        environment: "production",
        baseUrl: "https://prod.demo.test",
        account: { email: "", role: "" },
        session: { ttlMinutes: 0 },
      }),
    );
    expect(getProfile(reg, "demo:local:x").environment).toBe("production");
  });

  it("validates baseUrl shape", () => {
    for (const [baseUrl, fragment] of [
      ["not a url", "absolute URL"],
      ["ftp://files.demo.test", "http: or https:"],
      ["https://user:pw@demo.test", "username or password"],
      ["https://demo.test/?", "query string"],
      ["https://demo.test/#top", "fragment"],
    ] as const) {
      const err = catchPolicy(() => parseOne(entry({ baseUrl })));
      expect(err.message).toContain(`profiles["demo:local:x"].baseUrl: `);
      expect(err.message).toContain(fragment);
    }
    expect(() => parseOne(entry({ baseUrl: "https://demo.test/app" }))).not.toThrow();
  });

  it("validates ttl bounds, enums and allowedHosts entries", () => {
    expect(() => parseOne(entry({ session: { ttlMinutes: 1440 } }))).not.toThrow();
    expect(() => parseOne(entry({ session: { ttlMinutes: 0 } }))).not.toThrow();
    expect(catchPolicy(() => parseOne(entry({ session: { ttlMinutes: 1441 } }))).message).toContain(
      "session.ttlMinutes",
    );
    expect(catchPolicy(() => parseOne(entry({ session: { ttlMinutes: -1 } }))).message).toContain(
      "session.ttlMinutes",
    );
    expect(catchPolicy(() => parseOne(entry({ strategy: "magic" }))).message).toContain(
      'profiles["demo:local:x"].strategy',
    );
    expect(() =>
      parseOne(entry({ allowedHosts: ["api.demo.test", "localhost:3001", "127.0.0.1:8080", "[::1]:3000"] })),
    ).not.toThrow();
    for (const bad of ["Api.demo.test", "https://api.demo.test", "api.demo.test/path", "api.demo.test:99999", ""]) {
      expect(catchPolicy(() => parseOne(entry({ allowedHosts: [bad] }))).message).toContain(
        'profiles["demo:local:x"].allowedHosts[0]',
      );
    }
  });

  it("rejects bad profile names and a wrong version", () => {
    for (const name of ["Upper:case", ":leading", "trailing:", "a::b", "-dash", "has space", "__proto__"]) {
      const err = catchPolicy(() => parseOne(entry(), name));
      expect(err.message).toContain("profile name must match");
    }
    expect(() => parseOne(entry(), "acme:staging:quality-lead.v2_x")).not.toThrow();
    expect(catchPolicy(() => parseRegistry({ version: 2, profiles: {} }, "v.json")).message).toContain(
      "version",
    );
    expect(catchPolicy(() => parseRegistry(null, "n.json")).code).toBe("invalid-profile");
  });

  it("rejects reserved names starting with \"encrypted-file.\" (the store's own entries)", () => {
    for (const name of ["encrypted-file.key.v1", "encrypted-file.x", "encrypted-file.salt:admin"]) {
      const err = catchPolicy(() => parseOne(entry(), name));
      expect(err.code).toBe("invalid-profile");
      expect(err.message).toContain("reserved");
    }
    // Only the prefix is reserved.
    expect(() => parseOne(entry(), "encrypted-filex:admin")).not.toThrow();
    expect(() => parseOne(entry(), "app:encrypted-file.key")).not.toThrow();
  });
});

describe("strategy options (load-time)", () => {
  it("rejects an absolute URL in a path option with a path-qualified error", () => {
    const err = catchPolicy(() =>
      parseOne(entry({ options: { callbackPath: "https://attacker.example.net/x" } })),
    );
    expect(err.code).toBe("invalid-profile");
    expect(err.message).toContain('profiles["demo:local:x"].options.callbackPath');
    expect(err.message).toContain('starting with "/"');
  });

  it("rejects protocol-relative, relative, backslash, query and whitespace paths", () => {
    for (const bad of ["//attacker.example.net/x", "api/auth/csrf", "/a\\b", "/csrf?x=1", "/csrf#f", "/a b", ""]) {
      const err = catchPolicy(() => parseOne(entry({ options: { csrfPath: bad } })));
      expect(err.message, bad).toContain('profiles["demo:local:x"].options.csrfPath');
    }
  });

  it("rejects unknown option keys per strategy", () => {
    const err = catchPolicy(() => parseOne(entry({ options: { csrfPath: "/csrf", redirectTo: "/x" } })));
    expect(err.message).toContain('profiles["demo:local:x"].options');
    expect(err.message).toContain("redirectTo");
    // A key valid for one strategy is unknown for another.
    const other = catchPolicy(() => parseOne(entry({ options: { loginPath: "/login" } })));
    expect(other.message).toContain("loginPath");
  });

  it("accepts every documented key with valid values", () => {
    expect(() =>
      parseOne(
        entry({
          options: {
            csrfPath: "/api/auth/csrf",
            callbackPath: "/api/auth/callback/credentials",
            sessionPath: "/api/auth/session",
            sessionCookieName: "__Secure-next-auth.session-token",
            emailField: "email",
            passwordField: "password",
            roleField: "user.role",
          },
        }),
      ),
    ).not.toThrow();
    const cases: [string, Record<string, string>, Record<string, unknown>?][] = [
      ["form-post", { loginPath: "/login", fields: '{"remember":"1"}', successPath: "/home" }],
      ["dependent-token", { dependsOn: "demo:local:admin", tokenPath: "/api/device/exchange", fields: '{"credential":"{{secret}}"}', tokenField: "accessToken" }],
      ["oauth-client-credentials", { tokenPath: "/oauth/token", scope: "read write" }],
      ["api-key", { headerName: "X-Api-Key" }],
      ["app-handoff", { handoffPath: "/api/agent-handoff" }],
    ];
    for (const [strategy, options, extra] of cases) {
      expect(() => parseOne(entry({ strategy, options, ...(extra ?? {}) })), strategy).not.toThrow();
    }
    const badFields = catchPolicy(() => parseOne(entry({ strategy: "form-post", options: { fields: "[1]" } })));
    expect(badFields.message).toContain("options.fields");
  });
});

describe("production host denylist (load-time)", () => {
  const prod = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    entry({
      environment: "production",
      baseUrl: "https://prod.demo.test",
      account: { email: "", role: "" },
      session: { ttlMinutes: 0 },
      ...overrides,
    });

  it("rejects a non-production baseUrl on a production host, naming both profiles", () => {
    const err = catchPolicy(() =>
      parseRegistry(
        {
          version: 1,
          profiles: {
            "demo:prod": prod(),
            "demo:testing:x": entry({ environment: "testing", baseUrl: "https://PROD.demo.test/app" }),
          },
        },
        "overlap.json",
      ),
    );
    expect(err.code).toBe("invalid-profile");
    expect(err.message).toContain("overlap.json");
    expect(err.message).toContain('profiles["demo:testing:x"].baseUrl');
    expect(err.message).toContain('"demo:prod"');
    expect(err.message).toContain('"demo:testing:x"');
  });

  it("checks allowedHosts on both sides", () => {
    const viaAllowed = catchPolicy(() =>
      parseRegistry(
        {
          version: 1,
          profiles: {
            "demo:prod": prod(),
            "demo:local:x": entry({ allowedHosts: ["api.demo.test", "prod.demo.test"] }),
          },
        },
        "a.json",
      ),
    );
    expect(viaAllowed.message).toContain('profiles["demo:local:x"].allowedHosts[1]');

    const viaProdAllowed = catchPolicy(() =>
      parseRegistry(
        {
          version: 1,
          profiles: {
            "demo:prod": prod({ allowedHosts: ["localhost:3000"] }),
            "demo:local:x": entry({ baseUrl: "http://localhost:3000" }),
          },
        },
        "b.json",
      ),
    );
    expect(viaProdAllowed.message).toContain('profiles["demo:local:x"].baseUrl');
    expect(viaProdAllowed.message).toContain('"demo:prod"');
  });

  it("rejects a non-production entry on a production hostname with another port or a trailing dot", () => {
    for (const baseUrl of ["https://prod.demo.test:8443/", "https://prod.demo.test./"]) {
      expect(() =>
        parseRegistry(
          { version: 1, profiles: { "demo:prod": prod(), "demo:testing:x": entry({ baseUrl, environment: "testing" }) } },
          "d.json",
        ),
      ).toThrow(/belongs to production profile "demo:prod"/);
    }
  });

  it("productionHosts() collects baseUrl and allowedHosts of production entries only", async () => {
    const reg = parseRegistry(
      {
        version: 1,
        profiles: {
          "demo:prod": prod({ allowedHosts: ["api.prod.demo.test:8443"] }),
          "demo:local:x": entry(),
        },
      },
      "c.json",
    );
    expect([...productionHosts(reg)].sort()).toEqual(["api.prod.demo.test", "prod.demo.test"]);
    const example = parseRegistry(await readJson(examplePath), examplePath);
    expect(productionHosts(example).size).toBe(1);
  });
});

describe("getProfile / summarizeProfile", () => {
  it("throws unknown-profile listing available names, sorted", async () => {
    const reg = parseRegistry(await readJson(fixture("valid.json")), "valid.json");
    const err = catchPolicy(() => getProfile(reg, "demo:nope"));
    expect(err.code).toBe("unknown-profile");
    expect(err.message).toContain(
      "Available profiles: demo:local:admin, demo:testing:member, demo:testing:sales",
    );
    expect(catchPolicy(() => getProfile(reg, "constructor")).code).toBe("unknown-profile");
    expect(catchPolicy(() => getProfile(reg, "toString")).code).toBe("unknown-profile");
  });

  it("summarizes only safe fields", async () => {
    const reg = parseRegistry(await readJson(fixture("valid.json")), "valid.json");
    expect(summarizeProfile(getProfile(reg, "demo:testing:sales"))).toEqual({
      name: "demo:testing:sales",
      app: "demo-app",
      environment: "testing",
      baseUrl: "https://demo.testing.test",
      strategy: "form-post",
      email: "agent.sales@demo.test",
      role: "Sales",
      ttlMinutes: 600,
    });
  });
});

describe("loadProfiles", () => {
  it("returns an empty registry when no file exists anywhere", async () => {
    const cwd = path.join(tmp, "empty", "deep");
    await fs.mkdir(cwd, { recursive: true });
    const reg = await loadProfiles({ cwd });
    expect(reg).toEqual({ version: 1, profiles: {}, sources: [], overrides: [], unusedOverrides: [] });
  });

  it("discovers the registry by walking up from cwd", async () => {
    const root = path.join(tmp, "repo");
    const cwd = path.join(root, "packages", "web", "src");
    await fs.mkdir(cwd, { recursive: true });
    const file = path.join(root, "testlane.profiles.json");
    await fs.writeFile(file, registryJson({ "repo:local:admin": entry() }));
    const reg = await loadProfiles({ cwd });
    expect(reg.sources).toEqual([file]);
    expect(Object.keys(reg.profiles)).toEqual(["repo:local:admin"]);
    expect(path.isAbsolute(reg.sources[0] ?? "")).toBe(true);
  });

  it("uses the nearest file when several ancestors have one", async () => {
    const outer = path.join(tmp, "outer");
    const inner = path.join(outer, "inner");
    await fs.mkdir(inner, { recursive: true });
    await fs.writeFile(path.join(outer, "testlane.profiles.json"), registryJson({ "outer:x": entry() }));
    await fs.writeFile(path.join(inner, "testlane.profiles.json"), registryJson({ "inner:x": entry() }));
    const reg = await loadProfiles({ cwd: inner });
    expect(Object.keys(reg.profiles)).toEqual(["inner:x"]);
  });

  it("TESTLANE_PROFILES wins over directory discovery", async () => {
    const root = path.join(tmp, "repo");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "testlane.profiles.json"), registryJson({ "discovered:x": entry() }));
    const explicit = path.join(tmp, "elsewhere", "custom.json");
    await fs.mkdir(path.dirname(explicit), { recursive: true });
    await fs.writeFile(explicit, registryJson({ "explicit:x": entry() }));
    process.env["TESTLANE_PROFILES"] = explicit;
    const reg = await loadProfiles({ cwd: root });
    expect(Object.keys(reg.profiles)).toEqual(["explicit:x"]);
    expect(reg.sources).toEqual([explicit]);
  });

  it("TESTLANE_PROFILES pointing at a missing file is an error", async () => {
    process.env["TESTLANE_PROFILES"] = path.join(tmp, "missing.json");
    const err = await catchPolicyAsync(loadProfiles({ cwd: tmp }));
    expect(err.code).toBe("invalid-profile");
    expect(err.message).toContain("TESTLANE_PROFILES");
  });

  it("merges the user-level file after the repo file", async () => {
    const root = path.join(tmp, "repo");
    await fs.mkdir(root, { recursive: true });
    const repoFile = path.join(root, "testlane.profiles.json");
    await fs.writeFile(repoFile, registryJson({ "repo:local:admin": entry() }));
    const userFile = userProfilesPath();
    expect(userFile.startsWith(home)).toBe(true);
    await fs.writeFile(userFile, registryJson({ "user:local:me": entry() }));
    const reg = await loadProfiles({ cwd: root });
    expect(reg.sources).toEqual([repoFile, userFile]);
    expect(Object.keys(reg.profiles).sort()).toEqual(["repo:local:admin", "user:local:me"]);
  });

  it("loads the user file alone when no repo file exists", async () => {
    const cwd = path.join(tmp, "norepo");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(userProfilesPath(), registryJson({ "user:local:me": entry() }));
    const reg = await loadProfiles({ cwd });
    expect(reg.sources).toEqual([userProfilesPath()]);
  });

  it("refuses a profile name defined in both repo and user files", async () => {
    const root = path.join(tmp, "repo");
    await fs.mkdir(root, { recursive: true });
    const repoFile = path.join(root, "testlane.profiles.json");
    await fs.writeFile(repoFile, registryJson({ "acme:x": entry({ environment: "testing", baseUrl: "https://t.demo.test" }) }));
    await fs.writeFile(userProfilesPath(), registryJson({ "acme:x": entry({ environment: "sandbox" }) }));
    const err = await catchPolicyAsync(loadProfiles({ cwd: root }));
    expect(err.code).toBe("invalid-profile");
    expect(err.message).toContain('"acme:x"');
    expect(err.message).toContain(repoFile);
    expect(err.message).toContain(userProfilesPath());
  });

  it("does not treat the same file reached twice as a duplicate", async () => {
    await fs.writeFile(userProfilesPath(), registryJson({ "user:local:me": entry() }));
    process.env["TESTLANE_PROFILES"] = userProfilesPath();
    const reg = await loadProfiles({ cwd: tmp });
    expect(reg.sources).toEqual([userProfilesPath()]);
  });

  it("honours explicit repoFile / userFile options", async () => {
    const repoFile = path.join(tmp, "r.json");
    const userFile = path.join(tmp, "u.json");
    await fs.writeFile(repoFile, registryJson({ "r:x": entry() }));
    await fs.writeFile(userFile, registryJson({ "u:x": entry() }));
    const reg = await loadProfiles({ cwd: tmp, repoFile, userFile });
    expect(reg.sources).toEqual([repoFile, userFile]);
  });

  it("reports invalid JSON and invalid entries with the file path", async () => {
    const root = path.join(tmp, "repo");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "testlane.profiles.json");
    const marker = `marker${randomBytes(6).toString("hex")}`;
    await fs.writeFile(file, `{ "a": ${marker} }`);
    const bad = await catchPolicyAsync(loadProfiles({ cwd: root }));
    expect(bad.code).toBe("invalid-profile");
    expect(bad.message).toContain(`invalid JSON in ${file}`);
    // The parser's quoted snippet of the file is never echoed.
    expect(bad.message).not.toContain(marker);
    expect(bad.message).not.toContain(marker.slice(0, 8));
    expect(bad.message).toMatch(/invalid JSON in .+(: Unexpected token at position \d+)?$/);

    await fs.writeFile(file, registryJson({ "a:b": entry({ session: { ttlMinutes: 5000 } }) }));
    const invalid = await catchPolicyAsync(loadProfiles({ cwd: root }));
    expect(invalid.message).toContain(file);
    expect(invalid.message).toContain('profiles["a:b"].session.ttlMinutes');
  });
});

describe("account overrides", () => {
  const exchange = (): Record<string, unknown> =>
    entry({
      strategy: "dependent-token",
      account: { email: "member@demo.test", role: "Reader", identifier: "subject-old" },
    });
  const prodEntry = (): Record<string, unknown> =>
    entry({
      environment: "production",
      baseUrl: "https://prod.demo.test",
      account: { email: "", role: "" },
      session: { ttlMinutes: 0 },
    });

  async function setup(overrides: unknown): Promise<{ root: string; repoFile: string; file: string }> {
    const root = path.join(tmp, "repo");
    await fs.mkdir(root, { recursive: true });
    const repoFile = path.join(root, "testlane.profiles.json");
    await fs.writeFile(
      repoFile,
      registryJson({ "demo:local:x": entry(), "demo:local:reader": exchange(), "demo:prod": prodEntry() }),
    );
    const file = accountOverridesPath();
    expect(file).toBe(path.join(home, "testlane.overrides.json"));
    if (overrides !== undefined) await fs.writeFile(file, JSON.stringify(overrides));
    return { root, repoFile, file };
  }

  it("replaces only account.email / account.identifier, and reports sources and overrides", async () => {
    const { root, repoFile, file } = await setup({
      version: 1,
      overrides: {
        "demo:local:x": { account: { email: "rotated+42@demo.test" } },
        "demo:local:reader": { account: { identifier: "subject-new" } },
      },
    });
    const base = await loadProfiles({ cwd: root, overridesFile: path.join(tmp, "none.json") });
    const reg = await loadProfiles({ cwd: root });
    expect(reg.sources).toEqual([repoFile, file]);
    expect(reg.overrides).toEqual(["demo:local:reader", "demo:local:x"]);
    expect(reg.unusedOverrides).toEqual([]);

    const x = getProfile(reg, "demo:local:x");
    expect(x.account).toEqual({ email: "rotated+42@demo.test", role: "Sales" });
    // Everything else is exactly the repo entry.
    expect({ ...x, account: undefined }).toEqual({ ...getProfile(base, "demo:local:x"), account: undefined });

    const reader = getProfile(reg, "demo:local:reader");
    expect(reader.account).toEqual({ email: "member@demo.test", role: "Reader", identifier: "subject-new" });
    expect(getProfile(reg, "demo:prod").account.email).toBe("");
    expect(base.sources).toEqual([repoFile]);
    expect(base.overrides).toEqual([]);
  });

  it("a missing or empty overrides file changes nothing and is not listed in sources", async () => {
    const { root, repoFile } = await setup(undefined);
    const none = await loadProfiles({ cwd: root });
    expect(none.sources).toEqual([repoFile]);
    expect(none.overrides).toEqual([]);

    await fs.writeFile(accountOverridesPath(), JSON.stringify({ version: 1, overrides: {} }));
    const empty = await loadProfiles({ cwd: root });
    expect(empty.sources).toEqual([repoFile]);
    expect(empty.overrides).toEqual([]);
  });

  it("ignores an override for a profile this registry does not define and reports it in unusedOverrides", async () => {
    const { root, repoFile, file } = await setup({
      version: 1,
      overrides: {
        "other-repo:x": { account: { email: "a@b.test" } },
        "demo:local:x": { account: { email: "rotated@demo.test" } },
        "another:y": { account: { identifier: "subject-y" } },
      },
    });
    const reg = await loadProfiles({ cwd: root });
    expect(reg.unusedOverrides).toEqual(["another:y", "other-repo:x"]);
    expect(reg.overrides).toEqual(["demo:local:x"]);
    expect(reg.sources).toEqual([repoFile, file]);
    expect(Object.keys(reg.profiles).sort()).toEqual(["demo:local:reader", "demo:local:x", "demo:prod"]);
    expect(getProfile(reg, "demo:local:x").account.email).toBe("rotated@demo.test");

    // Only unused overrides: nothing applied, so the file is not a source.
    await fs.writeFile(file, JSON.stringify({ version: 1, overrides: { "other-repo:x": { account: { email: "a@b.test" } } } }));
    const only = await loadProfiles({ cwd: root });
    expect(only.unusedOverrides).toEqual(["other-repo:x"]);
    expect(only.overrides).toEqual([]);
    expect(only.sources).toEqual([repoFile]);
  });

  it("refuses an override on a production profile", async () => {
    const { root, file } = await setup({ version: 1, overrides: { "demo:prod": { account: { email: "a@b.test" } } } });
    const err = await catchPolicyAsync(loadProfiles({ cwd: root }));
    expect(err.code).toBe("invalid-profile");
    expect(err.message).toContain('"demo:prod"');
    expect(err.message).toContain("production");
    expect(err.message).toContain(file);
  });

  it("refuses unknown keys anywhere (only account.email / account.identifier are overridable)", async () => {
    const cases: [unknown, string][] = [
      [{ version: 1, overrides: { "demo:local:x": { account: { email: "a@b.test", role: "Admin" } } } }, "role"],
      [{ version: 1, overrides: { "demo:local:x": { account: { email: "a@b.test" }, baseUrl: "https://evil.test" } } }, "baseUrl"],
      [{ version: 1, overrides: { "demo:local:x": { account: { email: "a@b.test" }, environment: "sandbox" } } }, "environment"],
      [{ version: 1, overrides: { "demo:local:x": { account: { email: "a@b.test" }, options: {} } } }, "options"],
      [{ version: 1, overrides: {}, allowedHosts: ["evil.test"] }, "allowedHosts"],
      [{ version: 1, overrides: { "demo:local:x": { account: {} } } }, "must set email or identifier"],
      [{ version: 1, overrides: { "demo:local:x": { account: { email: "a b@c.test" } } } }, "whitespace"],
      [{ version: 1, overrides: { "demo:local:x": { account: { email: `${"a".repeat(250)}@b.test` } } } }, "254"],
      [{ version: 2, overrides: {} }, "version"],
      [{ version: 1, overrides: { "Bad Name": { account: { email: "a@b.test" } } } }, "profile name must match"],
    ];
    const { root, file } = await setup(undefined);
    for (const [json, fragment] of cases) {
      await fs.writeFile(file, JSON.stringify(json));
      const err = await catchPolicyAsync(loadProfiles({ cwd: root }));
      expect(err.code, fragment).toBe("invalid-profile");
      expect(err.message, fragment).toContain(`Invalid account overrides file ${file}`);
      expect(err.message, fragment).toContain(fragment);
    }
    await fs.writeFile(file, "{ not json");
    const bad = await catchPolicyAsync(loadProfiles({ cwd: root }));
    expect(bad.message).toContain(`invalid JSON in ${file}`);
  });

  it("writeAccountOverrides writes atomically (no temp file left), sorted, 0600 on POSIX, and round-trips", async () => {
    const file = accountOverridesPath();
    await writeAccountOverrides({ "b:x": { email: "b@x.test" }, "a:x": { email: "a@x.test", identifier: "member-1" } });
    expect(await readAccountOverrides()).toEqual({ "a:x": { email: "a@x.test", identifier: "member-1" }, "b:x": { email: "b@x.test" } });
    expect(Object.keys((JSON.parse(await fs.readFile(file, "utf8")) as { overrides: object }).overrides)).toEqual(["a:x", "b:x"]);
    expect((await fs.readdir(home)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    // Invalid content is never written.
    await expect(writeAccountOverrides({ "a:x": { email: "has space@x.test" } })).rejects.toBeInstanceOf(PolicyError);
    expect(await readAccountOverrides()).toEqual({ "a:x": { email: "a@x.test", identifier: "member-1" }, "b:x": { email: "b@x.test" } });
  });
});
