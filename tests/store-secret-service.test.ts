import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnLike } from "../src/store/dpapi.js";
import { secretKeyFor } from "../src/store/index.js";
import { PLATFORMS_DOC_POINTER, SecretServiceStore } from "../src/store/secret-service.js";

/** Throwaway value generated at test time; never a real secret. */
function throwaway(): string {
  return `throwaway-${randomBytes(12).toString("hex")}`;
}

let home = "";
const savedHome = process.env["TESTLANE_HOME"];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-secret-service-"));
  process.env["TESTLANE_HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["TESTLANE_HOME"];
  else process.env["TESTLANE_HOME"] = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// In-process fake ChildProcess built from PassThrough streams; every spawn is
// recorded exactly as the adapter passed it.
// ---------------------------------------------------------------------------

interface Reply {
  code: number;
  stdout?: string;
  stderr?: string;
}
type Handler = (args: string[], stdin: Buffer) => Reply | "hang";

interface Call {
  command: string;
  args: string[];
  rawEnv: NodeJS.ProcessEnv | undefined;
  effectiveEnv: Record<string, string | undefined>;
  stdin: string;
  killed: boolean;
}

function fakeSpawn(handler: Handler, calls: Call[]): SpawnLike {
  return (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const call: Call = {
      command,
      args: [...args],
      rawEnv: options.env === undefined ? undefined : { ...options.env },
      effectiveEnv: { ...(options.env ?? process.env) },
      stdin: "",
      killed: false,
    };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child["stdin"] = stdin;
    child["stdout"] = stdout;
    child["stderr"] = stderr;
    child["kill"] = (): boolean => {
      call.killed = true;
      setImmediate(() => child.emit("close", null, "SIGTERM"));
      return true;
    };
    const chunks: Buffer[] = [];
    stdin.on("data", (c: Buffer) => chunks.push(c));
    stdin.on("end", () => {
      const input = Buffer.concat(chunks);
      call.stdin = input.toString("utf8");
      const reply = handler([...args], input);
      if (reply === "hang") return;
      setImmediate(() => {
        void Promise.all([once(stdout, "end"), once(stderr, "end")]).then(() => child.emit("close", reply.code, null));
        stdout.end(reply.stdout ?? "");
        stderr.end(reply.stderr ?? "");
      });
    });
    return child as unknown as ChildProcess;
  };
}

interface Item {
  label: string;
  attrs: Record<string, string>;
  secret: string;
}

/** Emulates the parts of libsecret's secret-tool the adapter uses, backed by `items`. */
function secretToolEmulator(items: Item[]): Handler {
  const parseAttrs = (rest: string[]): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (let i = 0; i + 1 < rest.length; i += 2) attrs[rest[i] ?? ""] = rest[i + 1] ?? "";
    return attrs;
  };
  const matches = (item: Item, attrs: Record<string, string>): boolean =>
    Object.entries(attrs).every(([k, v]) => item.attrs[k] === v);
  return (args, stdin) => {
    const [cmd, ...rest] = args;
    switch (cmd) {
      case "store": {
        const labelArg = rest[0] ?? "";
        if (!labelArg.startsWith("--label=")) return { code: 2, stderr: "usage: secret-tool store --label='label' attribute value ...\n" };
        const attrs = parseAttrs(rest.slice(1));
        const existing = items.findIndex((it) => matches(it, attrs) && Object.keys(it.attrs).length === Object.keys(attrs).length);
        if (existing >= 0) items.splice(existing, 1);
        // secret-tool reads stdin to EOF when it is not a terminal and stores it as-is.
        items.push({ label: labelArg.slice("--label=".length), attrs, secret: stdin.toString("utf8") });
        return { code: 0 };
      }
      case "lookup": {
        const found = items.find((it) => matches(it, parseAttrs(rest)));
        return found ? { code: 0, stdout: found.secret } : { code: 1 };
      }
      case "clear": {
        const attrs = parseAttrs(rest);
        for (let i = items.length - 1; i >= 0; i--) if (matches(items[i] as Item, attrs)) items.splice(i, 1);
        return { code: 0 };
      }
      case "search": {
        const all = rest[0] === "--all";
        const found = items.filter((it) => matches(it, parseAttrs(all ? rest.slice(1) : rest)));
        let stdout = "";
        let stderr = "";
        for (const [i, it] of (all ? found : found.slice(0, 1)).entries()) {
          stdout += `[/org/freedesktop/secrets/collection/login/${i + 1}]\nlabel = ${it.label}\nsecret = ${it.secret}\ncreated = 2026-09-23 10:00:00\nmodified = 2026-09-23 10:00:00\n`;
          stderr += "schema = org.freedesktop.Secret.Generic\n";
          for (const [k, v] of Object.entries(it.attrs)) stderr += `attribute.${k} = ${v}\n`;
        }
        return { code: 0, stdout, stderr };
      }
      default:
        return { code: 2, stderr: "usage: secret-tool ...\n" };
    }
  };
}

/** Throwaway made of short random words: invisible to the base64-run scrubber, so only exact redaction can hide it. */
function wordy(): string {
  const word = (): string => Array.from(randomBytes(5), (b) => String.fromCharCode(97 + (b % 26))).join("");
  return `${word()} ${word()} ${word()}`;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function assertNothingSecretSpawned(calls: Call[], value: string): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    for (const form of [value, b64(value)]) {
      for (const a of [call.command, ...call.args]) expect(a).not.toContain(form);
      expect(JSON.stringify(call.effectiveEnv)).not.toContain(form);
      if (call.rawEnv !== undefined) expect(JSON.stringify(call.rawEnv)).not.toContain(form);
    }
  }
}

function newStore(items: Item[], calls: Call[]): SecretServiceStore {
  return new SecretServiceStore({ spawn: fakeSpawn(secretToolEmulator(items), calls), allowAnyPlatform: true });
}

describe("SecretServiceStore platform guard", () => {
  it.skipIf(process.platform === "linux")("refuses to construct off Linux", () => {
    expect(() => new SecretServiceStore()).toThrow(/requires Linux/);
  });

  it("constructs anywhere with allowAnyPlatform and honours an explicit command path", () => {
    const store = new SecretServiceStore({ allowAnyPlatform: true, command: "/usr/bin/secret-tool" });
    expect(store.kind).toBe("secret-service");
    expect(store.command).toBe("/usr/bin/secret-tool");
    expect(new SecretServiceStore({ allowAnyPlatform: true }).command).toBe("secret-tool");
  });
});

describe("SecretServiceStore (fake secret-tool)", () => {
  it("round-trips values exactly and sends them only over stdin", async () => {
    const items: Item[] = [];
    const calls: Call[] = [];
    const store = newStore(items, calls);
    const cases = [
      throwaway(),
      `pässwörd ✓ 🔑 ${randomBytes(4).toString("hex")}`,
      `  leading and trailing ${randomBytes(4).toString("hex")}  `,
      `quotes " ' and \\ backslash ${randomBytes(4).toString("hex")}`,
      `two\nlines ${randomBytes(4).toString("hex")}\n`,
    ];
    for (const [i, value] of cases.entries()) {
      const key = secretKeyFor(`test:local:case${i}`);
      calls.length = 0;
      await store.set(key, value);
      expect(await store.get(key)).toBe(value);
      assertNothingSecretSpawned(calls, value);
      expect(calls[0]?.args).toEqual(["store", `--label=agent-auth ${key}`, "service", "agent-auth", "key", key]);
      expect(calls[0]?.stdin).toBe(value); // exactly the value, no added newline
      expect(calls[1]?.args).toEqual(["lookup", "service", "agent-auth", "key", key]);
      expect(calls[1]?.stdin).toBe("");
    }
  });

  it("returns null for a missing key, deletes true/false, overwrites, lists keys only", async () => {
    const items: Item[] = [];
    const calls: Call[] = [];
    const store = newStore(items, calls);
    const a = secretKeyFor("acme:local:admin");
    const b = secretKeyFor("acme:local:sales");
    expect(await store.get(a)).toBeNull();
    expect(await store.list()).toEqual([]);

    const va = throwaway();
    const vb = throwaway();
    await store.set(b, vb);
    await store.set(a, va);
    // An unrelated item with the same service but a non-namespaced key is ignored.
    items.push({ label: "x", attrs: { service: "agent-auth", key: "not-a-store-key" }, secret: throwaway() });

    calls.length = 0;
    const listed = await store.list();
    expect(listed).toEqual([a, b]);
    expect(calls[0]?.args).toEqual(["search", "--all", "service", "agent-auth"]);
    expect(JSON.stringify(listed)).not.toContain(va);

    const va2 = throwaway();
    await store.set(a, va2);
    expect(await store.get(a)).toBe(va2);
    expect(items.filter((it) => it.attrs["key"] === a)).toHaveLength(1);

    calls.length = 0;
    expect(await store.delete(a)).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(["lookup", "clear"]);
    calls.length = 0;
    expect(await store.delete(a)).toBe(false);
    expect(calls.map((c) => c.args[0])).toEqual(["lookup"]);
    expect(await store.get(a)).toBeNull();
    expect(await store.list()).toEqual([b]);
  });

  it("reports false when the item vanishes between lookup and clear (concurrent delete)", async () => {
    const calls: Call[] = [];
    // lookup finds it; clear then finds nothing (exit 1, no output), as real secret-tool does.
    const handler: Handler = (args) =>
      args[0] === "lookup" ? { code: 0, stdout: `throwaway-${"x".repeat(8)}` } : { code: 1 };
    const store = new SecretServiceStore({ spawn: fakeSpawn(handler, calls), allowAnyPlatform: true });
    expect(await store.delete("agent-auth/acme:local:admin")).toBe(false);
    expect(calls.map((c) => c.args[0])).toEqual(["lookup", "clear"]);
  });

  it("still throws when clear fails with output", async () => {
    const handler: Handler = (args) =>
      args[0] === "lookup"
        ? { code: 0, stdout: "v" }
        : { code: 1, stderr: "secret-tool: the keyring daemon went away" };
    const store = new SecretServiceStore({ spawn: fakeSpawn(handler, []), allowAnyPlatform: true });
    await expect(store.delete("agent-auth/acme:local:admin")).rejects.toThrow(
      /secret-service delete failed \(exit 1\): secret-tool: the keyring daemon went away/,
    );
  });

  it("treats search exit 1 with no output as an empty list", async () => {
    const store = new SecretServiceStore({ spawn: fakeSpawn(() => ({ code: 1 }), []), allowAnyPlatform: true });
    expect(await store.list()).toEqual([]);
  });

  it("refuses invalid keys before spawning", async () => {
    const calls: Call[] = [];
    const store = newStore([], calls);
    for (const key of ["", "agent-auth/", "other/acme:local:admin", "agent-auth/a b", "agent-auth/Acme"]) {
      await expect(store.set(key, throwaway()), key).rejects.toThrow(/invalid secret store key/);
      await expect(store.get(key), key).rejects.toThrow(/invalid secret store key/);
      await expect(store.delete(key), key).rejects.toThrow(/invalid secret store key/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("SecretServiceStore error handling", () => {
  it("sanitizes a failing secret-tool: no stdin echo, no base64 blob, capped length", async () => {
    const blob = randomBytes(48).toString("base64");
    const calls: Call[] = [];
    const echoing: Handler = (_args, stdin) => ({
      code: 1,
      stderr: `secret-tool: failed on <${stdin.toString("utf8")}> <${b64(stdin.toString("utf8"))}> ${blob} ${"noise ".repeat(200)}`,
    });
    const store = new SecretServiceStore({ spawn: fakeSpawn(echoing, calls), allowAnyPlatform: true });
    const value = `  ${wordy()} ✓ `;
    const err = await store.set(secretKeyFor("acme:local:admin"), value).then(
      () => null,
      (e: unknown) => e as Error,
    );
    const message = err?.message ?? "";
    expect(message).toMatch(/^secret-service set failed \(exit 1\)/);
    expect(message).not.toContain(value.trim());
    expect(message).not.toContain(b64(value));
    expect(message).not.toContain(blob);
    expect(message.length).toBeLessThan(700);
    assertNothingSecretSpawned(calls, value);
  });

  it("reports a D-Bus failure on get instead of pretending the key is absent", async () => {
    const store = new SecretServiceStore({
      spawn: fakeSpawn(() => ({ code: 1, stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n" }), []),
      allowAnyPlatform: true,
    });
    await expect(store.get(secretKeyFor("acme:local:admin"))).rejects.toThrow(
      /secret-service get failed \(exit 1\): No D-Bus session bus is reachable/,
    );
    await expect(store.delete(secretKeyFor("acme:local:admin"))).rejects.toThrow(/secret-service delete failed/);
    await expect(store.list()).rejects.toThrow(/secret-service list failed/);
  });

  it("does not leak search output secrets in a list error", async () => {
    const secret = wordy();
    const store = new SecretServiceStore({
      spawn: fakeSpawn(() => ({ code: 3, stdout: `secret = ${secret}\n`, stderr: `boom ${secret}\n` }), []),
      allowAnyPlatform: true,
    });
    const err = await store.list().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/secret-service list failed \(exit 3\)/);
    expect(err?.message).not.toContain(secret);
  });

  it("kills a hung secret-tool and reports a timeout", async () => {
    const calls: Call[] = [];
    const store = new SecretServiceStore({ spawn: fakeSpawn(() => "hang", calls), allowAnyPlatform: true, timeoutMs: 50 });
    await expect(store.set(secretKeyFor("acme:local:admin"), throwaway())).rejects.toThrow(
      /secret-service set failed: secret-tool timed out after 50 ms/,
    );
    expect(calls[0]?.killed).toBe(true);
  });

  it("replaces a locked-collection set failure with the fixed, actionable message", async () => {
    const handler: Handler = () => ({
      code: 1,
      stderr: "secret-tool: Cannot create an item in a locked collection\n",
    });
    const store = new SecretServiceStore({ spawn: fakeSpawn(handler, []), allowAnyPlatform: true });
    const err = await store.set(secretKeyFor("acme:local:admin"), throwaway()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe(
      "secret-service set failed (exit 1): The Linux Secret Service keyring is locked (or has no default collection). " +
        "Unlock it by logging into your desktop session, or on a headless machine, WSL or a devcontainer unlock " +
        "gnome-keyring in your `dbus-run-session -- bash` shell with a password piped on stdin (never on argv) and " +
        "start the agent from that same shell; " +
        "see docs/platforms.md (https://github.com/testlane-dev/testlane/blob/main/docs/platforms.md)",
    );
    // The hint points at the page the npm package documents, never at a repo-only file.
    expect(err?.message).not.toContain("examples/demo-app");
    expect(err?.message).not.toContain("secret-tool");
    expect(err?.message).not.toContain("locked collection");
  });

  it("replaces a missing-default-collection lookup/clear failure with the same fixed message", async () => {
    const handler: Handler = () => ({
      code: 1,
      stderr: 'secret-tool: Object does not exist at path "/org/freedesktop/secrets/collection/login"\n',
    });
    const store = new SecretServiceStore({ spawn: fakeSpawn(handler, []), allowAnyPlatform: true });
    await expect(store.get(secretKeyFor("acme:local:admin"))).rejects.toThrow(
      /secret-service get failed \(exit 1\): The Linux Secret Service keyring is locked/,
    );
    await expect(store.delete(secretKeyFor("acme:local:admin"))).rejects.toThrow(
      /secret-service delete failed \(exit 1\): The Linux Secret Service keyring is locked/,
    );
    await expect(store.list()).rejects.toThrow(
      /secret-service list failed \(exit 1\): The Linux Secret Service keyring is locked/,
    );
  });

  it("replaces a locked-object clear failure (item found, then locked on clear) with the fixed message", async () => {
    const handler: Handler = (args) =>
      args[0] === "lookup"
        ? { code: 0, stdout: "v" }
        : { code: 1, stderr: "secret-tool: Cannot get secret of a locked object\n" };
    const store = new SecretServiceStore({ spawn: fakeSpawn(handler, []), allowAnyPlatform: true });
    await expect(store.delete("agent-auth/acme:local:admin")).rejects.toThrow(
      /secret-service delete failed \(exit 1\): The Linux Secret Service keyring is locked/,
    );
  });

  it("keeps the sanitized raw stderr for an unrelated failure (not a known setup failure)", async () => {
    const store = new SecretServiceStore({
      spawn: fakeSpawn(() => ({ code: 1, stderr: "secret-tool: something unexpected in the keyring daemon\n" }), []),
      allowAnyPlatform: true,
    });
    const err = await store.get(secretKeyFor("acme:local:admin")).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe("secret-service get failed (exit 1): secret-tool: something unexpected in the keyring daemon");
    expect(err?.message).not.toContain("docs/platforms.md");
  });

  /** Real secret-tool / GLib / gnome-keyring wordings (verified against the real tools where marked). */
  const NO_BUS_STDERR = [
    "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n", // real: no bus, no DISPLAY
    "secret-tool: Could not connect: No such file or directory\n", // real: stale DBUS_SESSION_BUS_ADDRESS
    "secret-tool: Could not connect: Connection refused\n",
    "secret-tool: Unable to autolaunch a dbus-daemon without a $DISPLAY for X11\n",
    "secret-tool: Error spawning command line “dbus-launch --autolaunch=0123 --binary-syntax --close-stderr”: Child process exited with code 1\n",
  ];
  const NO_PROVIDER_STDERR = [
    "secret-tool: The name org.freedesktop.secrets was not provided by any .service files\n", // real: bus, no keyring
    "secret-tool: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files\n",
    "secret-tool: org.freedesktop.DBus.Error.ServiceUnknown\n",
  ];
  const LOCKED_STDERR = [
    "secret-tool: Cannot create an item in a locked collection\n", // real: set on a locked keyring
    "secret-tool: Cannot get secret of a locked object\n", // real: search on a locked keyring
    'secret-tool: Object does not exist at path "/org/freedesktop/secrets/collection/login"\n',
    "secret-tool: Object does not exist at path ?/org/freedesktop/secrets/collection/login?\n", // real, C locale
    "secret-tool: Object does not exist at path “/org/freedesktop/secrets/collection/login”\n", // UTF-8 locale
    "secret-tool: The collection does not exist\n",
  ];

  it("maps every known setup failure to one fixed message per cause, on every operation, ending with the pointer", async () => {
    expect(PLATFORMS_DOC_POINTER).toBe(
      "see docs/platforms.md (https://github.com/testlane-dev/testlane/blob/main/docs/platforms.md)",
    );
    const causes: { name: string; samples: string[]; opening: RegExp; mustContain: string[] }[] = [
      {
        name: "no bus",
        samples: NO_BUS_STDERR,
        opening: /^No D-Bus session bus is reachable\. /,
        mustContain: ["headless machine, WSL or a devcontainer", "`dbus-run-session -- bash`", "unlock a keyring", "start the agent from that same shell"],
      },
      {
        name: "no Secret Service",
        samples: NO_PROVIDER_STDERR,
        opening: /^A D-Bus session bus is reachable, but no Secret Service keyring is running on it/,
        mustContain: ["sudo apt install gnome-keyring", "sudo dnf install gnome-keyring"],
      },
      {
        name: "locked",
        samples: LOCKED_STDERR,
        opening: /^The Linux Secret Service keyring is locked \(or has no default collection\)\. /,
        mustContain: ["`dbus-run-session -- bash`", "password piped on stdin (never on argv)"],
      },
    ];
    const key = secretKeyFor("acme:local:admin");
    const seen = new Set<string>();
    for (const cause of causes) {
      for (const stderr of cause.samples) {
        // delete's lookup must also fail loudly (not read as "absent"), as must the clear after a found item.
        const ops: [string, (store: SecretServiceStore) => Promise<unknown>, Handler][] = [
          ["get", (st) => st.get(key), () => ({ code: 1, stderr })],
          ["set", (st) => st.set(key, throwaway()), () => ({ code: 1, stderr })],
          ["delete", (st) => st.delete(key), () => ({ code: 1, stderr })],
          [
            "delete",
            (st) => st.delete(key),
            (args) => (args[0] === "lookup" ? { code: 0, stdout: "v" } : { code: 1, stderr }),
          ],
          ["list", (st) => st.list(), () => ({ code: 1, stderr })],
        ];
        for (const [op, run, handler] of ops) {
          const store = new SecretServiceStore({ spawn: fakeSpawn(handler, []), allowAnyPlatform: true });
          const err = await run(store).then(
            () => null,
            (e: unknown) => e as Error,
          );
          const label = `${cause.name} / ${op} / ${stderr.trim()}`;
          const message = err?.message ?? "";
          expect(message, label).toMatch(new RegExp(`^secret-service ${op} failed \\(exit 1\\): `));
          const fixed = message.replace(/^secret-service \w+ failed \(exit 1\): /, "");
          expect(fixed, label).toMatch(cause.opening);
          for (const part of cause.mustContain) expect(fixed, label).toContain(part);
          expect(fixed.endsWith(PLATFORMS_DOC_POINTER), label).toBe(true);
          // secret-tool's own text is discarded, and the message is the same for every wording of one cause.
          expect(message, label).not.toMatch(/secret-tool|D-Bus without|org\.freedesktop\.secrets was/i);
          seen.add(`${cause.name}:${fixed}`);
        }
      }
    }
    expect(seen.size).toBe(3); // exactly one fixed message per cause
  });

  it("never echoes stdin, the value or secret-tool's text when it recognises a setup failure", async () => {
    const value = wordy();
    const calls: Call[] = [];
    for (const stderr of [...NO_BUS_STDERR, ...NO_PROVIDER_STDERR, ...LOCKED_STDERR]) {
      const handler: Handler = (_args, stdin) => ({
        code: 1,
        stderr: `${stderr.trim()} <${stdin.toString("utf8")}> <${b64(stdin.toString("utf8"))}> ${randomBytes(48).toString("base64")}\n`,
      });
      const store = new SecretServiceStore({ spawn: fakeSpawn(handler, calls), allowAnyPlatform: true });
      const err = await store.set(secretKeyFor("acme:local:admin"), value).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toBeDefined();
      expect(err?.message).not.toContain(value);
      expect(err?.message).not.toContain(b64(value));
      expect(err?.message).not.toContain("<");
      expect(err?.message.length).toBeLessThan(700);
    }
    assertNothingSecretSpawned(calls, value);
  });

  it("a locked keyring that lists nothing is reported, not mistaken for an empty store", async () => {
    // Real behaviour: `search` on a locked keyring exits 0, matches items only by hashed attributes and
    // complains on stderr, so no attribute.key line reaches us.
    const lockedSearch: Handler = () => ({
      code: 0,
      stdout: "[/1]\nlabel = \ncreated = \nmodified = \n",
      stderr:
        "secret-tool: Cannot get secret of a locked object\nschema = org.freedesktop.Secret.Generic\nattribute.gkr:compat:hashed:key = 0123456789abcdef0123456789abcdef\n",
    });
    const store = new SecretServiceStore({ spawn: fakeSpawn(lockedSearch, []), allowAnyPlatform: true });
    await expect(store.list()).rejects.toThrow(
      /^secret-service list failed: The Linux Secret Service keyring is locked .*docs\/platforms\.md/,
    );

    // Keys that did come through (another, unlocked collection) are still returned.
    const mixed: Handler = () => ({
      code: 0,
      stderr:
        "secret-tool: Cannot get secret of a locked object\nattribute.key = agent-auth/acme:local:admin\nattribute.service = agent-auth\n",
    });
    expect(await new SecretServiceStore({ spawn: fakeSpawn(mixed, []), allowAnyPlatform: true }).list()).toEqual([
      "agent-auth/acme:local:admin",
    ]);

    // An unrelated stderr note with nothing found is still just an empty list.
    const quiet: Handler = () => ({ code: 0, stderr: "secret-tool: some harmless note\n" });
    expect(await new SecretServiceStore({ spawn: fakeSpawn(quiet, []), allowAnyPlatform: true }).list()).toEqual([]);
  });

  it("reports a spawn failure by errno code only", async () => {
    const throwing: SpawnLike = () => {
      throw Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
    };
    const store = new SecretServiceStore({ spawn: throwing, allowAnyPlatform: true });
    await expect(store.get(secretKeyFor("acme:local:admin"))).rejects.toThrow(
      /^secret-service get failed: could not start secret-tool \(ENOENT\)$/,
    );
  });
});
