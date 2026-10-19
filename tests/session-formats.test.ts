import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CookieJar, hasDomainAttribute, parseSetCookie } from "../src/http/cookie-jar.js";
import { toCookieHeader } from "../src/session/cookie.js";
import { toCurlJar } from "../src/session/curl-jar.js";
import { formatSession, SESSION_FORMATS } from "../src/session/format.js";
import { extraHeaderNames, toHeaderLines } from "../src/session/headers.js";
import { toSessionJson } from "../src/session/json.js";
import { toStorageState } from "../src/session/storage-state.js";
import { getStrategy } from "../src/strategies/index.js";
import type { SessionArtifact } from "../src/types.js";
import { startFakeNextAuth, type FakeNextAuth } from "./helpers/fake-nextauth.js";

const EMAIL = "agent-test@example.invalid";
const password = randomBytes(18).toString("base64url");

let server: FakeNextAuth;
let artifact: SessionArtifact;

beforeAll(async () => {
  server = await startFakeNextAuth({ users: [{ email: EMAIL, password }] });
  artifact = await getStrategy("nextauth-credentials").signIn({
    profile: {
      name: "acme:local:admin",
      app: "acme",
      environment: "sandbox",
      baseUrl: server.baseUrl,
      strategy: "nextauth-credentials",
      account: { email: EMAIL, role: "Admin" },
      session: { ttlMinutes: 30 },
    },
    secret: password,
    ttlMinutes: 30,
  });
});

afterAll(async () => {
  await server.close();
});

describe("session formats", () => {
  it("never contains the secret in any format", () => {
    expect(JSON.stringify(artifact)).not.toContain(password);
    for (const format of SESSION_FORMATS) {
      expect(formatSession(artifact, format)).not.toContain(password);
    }
  });

  it("cookie header is name=value", () => {
    const value = artifact.cookies[0]?.value ?? "";
    expect(value).not.toBe("");
    expect(toCookieHeader(artifact)).toBe(`next-auth.session-token=${value}`);
    expect(formatSession(artifact, "cookie")).toBe(`next-auth.session-token=${value}`);
  });

  it("storage-state parses as Playwright storageState JSON", () => {
    const text = formatSession(artifact, "storage-state");
    expect(text).toContain("\n  "); // pretty-printed
    const parsed = JSON.parse(text) as ReturnType<typeof toStorageState>;
    expect(parsed.origins).toEqual([]);
    expect(parsed.cookies).toHaveLength(1);
    const [c] = parsed.cookies;
    expect(Object.keys(c ?? {}).sort()).toEqual(
      ["domain", "expires", "httpOnly", "name", "path", "sameSite", "secure", "value"].sort(),
    );
    expect(c).toMatchObject({ name: "next-auth.session-token", domain: "127.0.0.1", path: "/", httpOnly: true });
    expect(typeof c?.expires).toBe("number");
  });

  it("curl jar has the Netscape header and a #HttpOnly_ line with 7 fields", () => {
    const text = toCurlJar(artifact);
    expect(formatSession(artifact, "curl")).toBe(text);
    const lines = text.split("\n");
    expect(lines[0]).toBe("# Netscape HTTP Cookie File");
    const cookieLine = lines.find((l) => l.startsWith("#HttpOnly_"));
    expect(cookieLine).toBeDefined();
    const fields = (cookieLine ?? "").split("\t");
    expect(fields).toHaveLength(7);
    const cookie = artifact.cookies[0];
    expect(fields).toEqual([
      "#HttpOnly_127.0.0.1",
      "FALSE",
      "/",
      "FALSE",
      String(cookie?.expires),
      "next-auth.session-token",
      cookie?.value,
    ]);
  });

  it("curl jar writes 0 for session cookies and TRUE for domain/secure cookies", () => {
    const text = toCurlJar({
      ...artifact,
      cookies: [
        { name: "a", value: "1", domain: ".example.test", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
      ],
    });
    expect(text.split("\n")).toContain([".example.test", "TRUE", "/", "TRUE", "0", "a", "1"].join("\t"));
  });
});

describe("cookie jar", () => {
  const url = new URL("http://app.example.test/api/auth/csrf");

  it("parses attributes, preferring Max-Age over Expires", () => {
    const before = Math.floor(Date.now() / 1000);
    const c = parseSetCookie("sid=abc; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Max-Age=120; HttpOnly; SameSite=Strict", url);
    expect(c).toMatchObject({ name: "sid", value: "abc", domain: "app.example.test", path: "/", httpOnly: true, secure: false, sameSite: "Strict" });
    expect(c.expires).toBeGreaterThanOrEqual(before + 120);
    expect(c.expires).toBeLessThanOrEqual(before + 122);
    expect(parseSetCookie("x=1", url)).toMatchObject({ expires: -1, sameSite: "Lax", path: "/" });
    expect(parseSetCookie("x=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT", url).expires).toBe(Date.UTC(2031, 0, 1) / 1000);
  });

  it("matches host-only cookies exactly and domain cookies by suffix", () => {
    const jar = new CookieJar();
    jar.add(parseSetCookie("host=1", url));
    jar.add(parseSetCookie("dom=2; Domain=.example.test", url));
    jar.add(parseSetCookie("sec=3; Secure", url));
    jar.add(parseSetCookie("scoped=4; Path=/admin", url));
    expect(jar.headerFor(new URL("http://app.example.test/"))).toBe("host=1; dom=2");
    expect(jar.headerFor(new URL("http://other.example.test/"))).toBe("dom=2");
    expect(jar.headerFor(new URL("https://app.example.test/admin/x"))).toContain("scoped=4");
    expect(jar.headerFor(new URL("https://app.example.test/"))).toContain("sec=3");
    expect(jar.headerFor(new URL("http://app.example.test/administrator"))).not.toContain("scoped=4");
    expect(jar.headerFor(new URL("http://unrelated.test/"))).toBeUndefined();
    jar.add(parseSetCookie("host=; Max-Age=0", url));
    expect(jar.all().map((c) => c.name)).not.toContain("host");
  });

  it("never suffix-matches a Domain cookie against an IP-address host", () => {
    const jar = new CookieJar();
    const loopback = new URL("http://127.0.0.1/");
    jar.add(parseSetCookie("suffix=1; Domain=0.0.1", loopback));
    jar.add(parseSetCookie("exact=2; Domain=127.0.0.1", loopback));
    jar.add(parseSetCookie("ipv6=3; Domain=[::1]", new URL("http://[::1]/")));
    expect(jar.headerFor(loopback)).toBe("exact=2");
    expect(jar.headerFor(new URL("http://[::1]/"))).toBe("ipv6=3");
    expect(jar.headerFor(new URL("http://other.example.test/"))).toBeUndefined();
  });

  it("refuses names or values containing tabs or control characters, without echoing them", () => {
    for (const header of ["sid=ab\tcd", "s\tid=abcd", "sid=ab\u0001cd", "sid=abcd\u007f; Path=/", "sid=a\u001bb"]) {
      let message = "";
      try {
        parseSetCookie(header, url);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(header)).toBe(
        "invalid Set-Cookie header: cookie name or value contains control characters",
      );
    }
  });

  it("addFromResponse skips a control-character cookie and keeps the others", () => {
    const jar = new CookieJar();
    const res = new Response(null, {
      headers: [
        ["set-cookie", "bad=ab\tcd; Path=/"],
        ["set-cookie", "good=1; Path=/"],
      ],
    });
    const parsed = jar.addFromResponse(res, url);
    expect(parsed.map((c) => c.name)).toEqual(["good"]);
    expect(jar.headerFor(url)).toBe("good=1");
  });

  describe("cookie name prefixes (every strategy)", () => {
    const https = new URL("https://app.example.test/login");
    const refused = (header: string): string => {
      try {
        parseSetCookie(header, https);
      } catch (e) {
        return (e as Error).message;
      }
      return "accepted";
    };

    it("__Secure- needs Secure (prefix matched case-insensitively)", () => {
      expect(refused("__Secure-sid=1; Path=/")).toBe("invalid Set-Cookie header: a __Secure- cookie must be Secure");
      expect(refused("__secure-sid=1")).toBe("invalid Set-Cookie header: a __Secure- cookie must be Secure");
      expect(refused("__SECURE-sid=1; HttpOnly")).toBe("invalid Set-Cookie header: a __Secure- cookie must be Secure");
      expect(refused("__Secure-sid=1; Secure")).toBe("accepted");
      expect(refused("__Secure-sid=1; Secure; Domain=example.test; Path=/app")).toBe("accepted");
    });

    it("__Host- needs Secure, no Domain attribute at all, and Path=/", () => {
      const message = "invalid Set-Cookie header: a __Host- cookie must be Secure, without Domain, with Path=/";
      expect(refused("__Host-sid=1; Path=/")).toBe(message);
      expect(refused("__Host-sid=1; Secure")).toBe(message);
      expect(refused("__Host-sid=1; Secure; Path=/app")).toBe(message);
      expect(refused("__Host-sid=1; Secure; Path=/; Domain=app.example.test")).toBe(message);
      expect(refused("__Host-sid=1; Secure; Path=/; Domain=")).toBe(message);
      expect(refused("__host-sid=1; Path=/")).toBe(message);
      expect(refused("__Host-sid=1; Secure; Path=/")).toBe("accepted");
      expect(refused("__Host-sid=1; Path=/; HttpOnly; Secure; SameSite=Lax")).toBe("accepted");
    });

    it("addFromResponse ignores a cookie that breaks a prefix rule and never echoes its value", () => {
      const jar = new CookieJar();
      const value = "prefix-rule-value-4b1d";
      const res = new Response(null, {
        headers: [
          ["set-cookie", `__Secure-a=${value}; Path=/`],
          ["set-cookie", `__Host-b=${value}; Secure; Path=/; Domain=example.test`],
          ["set-cookie", "__Host-ok=1; Secure; Path=/"],
        ],
      });
      expect(jar.addFromResponse(res, https).map((c) => c.name)).toEqual(["__Host-ok"]);
      expect(refused(`__Secure-a=${value}`)).not.toContain(value);
    });

    it("the existing next-auth cookie shapes still pass", () => {
      for (const header of [
        "__Host-next-auth.csrf-token=t%7Ch; Path=/; HttpOnly; SameSite=Lax; Secure",
        "__Secure-next-auth.callback-url=https%3A%2F%2Fapp.example.test; Path=/; SameSite=Lax; Secure",
        "__Secure-next-auth.session-token=jwt; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure",
      ]) {
        expect(refused(header), header).toBe("accepted");
      }
    });
  });

  describe("host-only capture", () => {
    it("drops every cookie that carries a Domain attribute: parent, dotted, equal to the host, or empty", () => {
      expect(hasDomainAttribute("a=1; Path=/; Domain=example.test")).toBe(true);
      expect(hasDomainAttribute("a=1; domain=")).toBe(true);
      expect(hasDomainAttribute("a=1; DOMAIN")).toBe(true);
      expect(hasDomainAttribute("a=1; Path=/; Secure")).toBe(false);
      // The name/value pair is never read as an attribute.
      expect(hasDomainAttribute("domain=1; Path=/")).toBe(false);

      const res = (): Response =>
        new Response(null, {
          headers: [
            ["set-cookie", "parent=1; Path=/; Domain=example.test"],
            ["set-cookie", "dotted=1; Path=/; Domain=.example.test"],
            ["set-cookie", "same=1; Path=/; Domain=app.example.test"],
            ["set-cookie", "empty=1; Path=/; Domain="],
            ["set-cookie", "host=1; Path=/"],
          ],
        });
      const hostOnly = new CookieJar();
      expect(hostOnly.addFromResponse(res(), url, { hostOnly: true }).map((c) => c.name)).toEqual(["host"]);
      // Without hostOnly the other strategies keep their documented behaviour (no public-suffix check).
      const lenient = new CookieJar();
      expect(lenient.addFromResponse(res(), url).map((c) => c.name)).toEqual(["parent", "dotted", "same", "empty", "host"]);
    });
  });
});

describe("headers format", () => {
  const base = (): SessionArtifact => ({ ...artifact, cookies: [...artifact.cookies] });

  it("is a Cookie: line for a cookie-only artifact", () => {
    expect(toHeaderLines(artifact)).toEqual([`Cookie: ${toCookieHeader(artifact)}`]);
    expect(formatSession(artifact, "headers")).toBe(`Cookie: ${toCookieHeader(artifact)}`);
  });

  it("adds one Name: value line per extra header, and no Cookie line without cookies", () => {
    const withHeaders: SessionArtifact = { ...base(), headers: { "x-device-access": "abc123", "X-Other": "v 1" } };
    expect(formatSession(withHeaders, "headers").split("\n")).toEqual([
      `Cookie: ${toCookieHeader(artifact)}`,
      "x-device-access: abc123",
      "X-Other: v 1",
    ]);
    expect(extraHeaderNames(withHeaders)).toEqual(["x-device-access", "X-Other"]);
    expect(toHeaderLines({ ...withHeaders, cookies: [] })).toEqual(["x-device-access: abc123", "X-Other: v 1"]);
  });

  it("refuses a header value or name that could start a new line, without echoing the value", () => {
    const value = `tok${randomBytes(4).toString("hex")}\r\nInjected: 1`;
    const call = (): string[] => toHeaderLines({ ...base(), headers: { "x-device-access": value } });
    expect(call).toThrow(/x-device-access is not representable/);
    try {
      call();
    } catch (e) {
      expect(String(e)).not.toContain(value.slice(0, 10));
    }
    expect(() => toHeaderLines({ ...base(), headers: { "bad name": "v" } })).toThrow(/not a valid HTTP field name/);
  });
});

describe("json format", () => {
  const base = (): SessionArtifact => ({ ...artifact, cookies: [...artifact.cookies] });

  it("carries exactly the same header set (names and values) as --format headers, for the same artifact", () => {
    const withHeaders: SessionArtifact = { ...base(), headers: { "x-device-access": "abc123", "X-Other": "v 1" } };
    const lines = toHeaderLines(withHeaders);
    const fromLines = Object.fromEntries(
      lines.map((line) => {
        const i = line.indexOf(": ");
        return [line.slice(0, i), line.slice(i + 2)];
      }),
    );
    const json = toSessionJson(withHeaders);
    expect(json.headers).toEqual(fromLines);
    expect(Object.keys(json.headers)).toEqual(extraHeaderNames(withHeaders).length > 0 ? ["Cookie", ...extraHeaderNames(withHeaders)] : ["Cookie"]);
  });

  it("has profile, format, expiresAt and an always-empty droppedHeaders", () => {
    const json = toSessionJson(artifact);
    expect(json).toMatchObject({ profile: artifact.profile, format: "json", expiresAt: artifact.expiresAt, droppedHeaders: [] });
    expect(Object.keys(json.headers)).toEqual(["Cookie"]);
  });

  it("formatSession(artifact, \"json\") is pretty-printed JSON parsing to the same object", () => {
    const text = formatSession(artifact, "json");
    expect(text).toContain("\n  "); // pretty-printed, like storage-state
    expect(JSON.parse(text)).toEqual(toSessionJson(artifact));
  });

  it("never contains cookies without one, and drops nothing a cookie-only artifact can't carry", () => {
    const noCookies: SessionArtifact = { ...base(), cookies: [], headers: { "x-device-access": "abc123" } };
    const json = toSessionJson(noCookies);
    expect(Object.keys(json.headers)).toEqual(["x-device-access"]);
    expect(json.droppedHeaders).toEqual([]);
  });

  it("refuses the same unrepresentable header as --format headers, without echoing the value", () => {
    const value = `tok${randomBytes(4).toString("hex")}\r\nInjected: 1`;
    expect(() => toSessionJson({ ...base(), headers: { "x-device-access": value } })).toThrow(
      /x-device-access is not representable/,
    );
    try {
      toSessionJson({ ...base(), headers: { "x-device-access": value } });
    } catch (e) {
      expect(String(e)).not.toContain(value.slice(0, 10));
    }
  });
});
