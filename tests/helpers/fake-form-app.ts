/**
 * A minimal HTML-form login app on 127.0.0.1 for form-post strategy tests.
 *
 * Routes:
 *   GET  /login        200 HTML; sets a "csrf" cookie (the priming cookie)
 *   POST /login        form: user, pass, remember. Optional csrf-cookie check.
 *                      success: sets the session cookie and 302s along `chain`
 *                      failure: 302 /login?error=1, no session cookie
 *   GET  <chain[i]>    302 to chain[i+1]; the last entry answers 200
 *   GET  /me           JSON identity for the session cookie, 401 otherwise
 *   GET  /loop         302 /loop forever
 *   POST /api/auth/sign-in/email   (JSON mode) application/json {email, password};
 *                      anything else 415. success: sets the session cookie and
 *                      answers `jsonSuccessStatus` (200) JSON with a sessionToken
 *                      field (omitted with jsonOmitToken); failure: 401 JSON, no cookie
 *   GET  /api/auth/workspaces      Workspace-listing identity {userId, email, workspaces:[{id, role}]}
 * Credentials are supplied by the test (generated at test time). Request
 * records hold cookie and field NAMES only, never values.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeFormUser {
  email: string;
  password: string;
  name?: string;
  role?: string;
}

export interface FakeFormAppOptions {
  users: FakeFormUser[];
  /** Session cookie name; default "sid". */
  sessionCookieName?: string;
  /** POST /login answers 403 unless the "csrf" cookie from GET /login is present. */
  requireCsrfCookie?: boolean;
  /** Redirect chain after a successful POST; default ["/step-1", "/dashboard"]. */
  chain?: string[];
  /** Set the session cookie on the last chain hop instead of on the POST. */
  setCookieOnFinalHop?: boolean;
  /** Successful POST redirects to this absolute URL instead of the chain. */
  redirectTo?: string;
  /** POST answers 200 with no redirect (success sets the cookie, failure does not). */
  noRedirect?: boolean;
  /** Also set the session cookie (anonymous) on GET /login. */
  sessionCookieOnPrime?: boolean;
  /** Status of a successful JSON sign-in; default 200. */
  jsonSuccessStatus?: number;
  /** Successful JSON sign-in sets the cookie but leaves sessionToken out of the body. */
  jsonOmitToken?: boolean;
}

export interface FakeFormRequest {
  method: string;
  path: string;
  cookieNames: string[];
  fieldNames: string[];
  contentType?: string;
  origin?: string;
}

export interface FakeFormApp {
  baseUrl: string;
  requests: FakeFormRequest[];
  close(): Promise<void>;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeFormApp(opts: FakeFormAppOptions): Promise<FakeFormApp> {
  const sessionName = opts.sessionCookieName ?? "sid";
  const chain = opts.chain ?? ["/step-1", "/dashboard"];
  const sessions = new Map<string, FakeFormUser>();
  /** Session tokens minted on POST but only handed out on the final hop. */
  const pending = new Map<string, string>();
  const requests: FakeFormRequest[] = [];
  let baseUrl = "";

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", baseUrl);
      const cookies = parseCookies(req.headers.cookie);
      const record: FakeFormRequest = {
        method: req.method ?? "",
        path: url.pathname,
        cookieNames: [...cookies.keys()],
        fieldNames: [],
      };
      if (req.headers["content-type"] !== undefined) record.contentType = req.headers["content-type"];
      if (req.headers.origin !== undefined) record.origin = req.headers.origin;
      requests.push(record);
      const redirect = (location: string, setCookies: string[] = []): void => {
        if (setCookies.length > 0) res.setHeader("Set-Cookie", setCookies);
        res.writeHead(302, { Location: location });
        res.end();
      };

      if (req.method === "GET" && url.pathname === "/login") {
        const set = [`csrf=${randomBytes(16).toString("hex")}; Path=/; HttpOnly; SameSite=Lax`];
        if (opts.sessionCookieOnPrime) set.push(`${sessionName}=anon-${randomBytes(8).toString("hex")}; Path=/`);
        res.setHeader("Set-Cookie", set);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<form method=post></form>");
        return;
      }

      if (req.method === "POST" && url.pathname === "/login") {
        const form = new URLSearchParams(await readBody(req));
        record.fieldNames = [...new Set(form.keys())];
        if (opts.requireCsrfCookie && !cookies.has("csrf")) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("csrf cookie missing");
          return;
        }
        const user = opts.users.find((u) => u.email === form.get("user") && u.password === form.get("pass"));
        if (!user) {
          if (opts.noRedirect) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("invalid credentials");
            return;
          }
          return redirect("/login?error=1");
        }
        const token = randomBytes(32).toString("hex");
        sessions.set(token, user);
        const cookie = `${sessionName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`;
        if (opts.noRedirect) {
          res.setHeader("Set-Cookie", [cookie]);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("welcome");
          return;
        }
        if (opts.redirectTo !== undefined) return redirect(opts.redirectTo, [cookie]);
        const first = chain[0] ?? "/";
        if (opts.setCookieOnFinalHop) {
          const hop = randomBytes(8).toString("hex");
          pending.set(hop, token);
          return redirect(`${first}?hop=${hop}`);
        }
        return redirect(first, [cookie]);
      }

      if (req.method === "POST" && url.pathname === "/api/auth/sign-in/email") {
        const raw = await readBody(req);
        const json = (body: unknown, status: number, setCookies: string[] = []): void => {
          if (setCookies.length > 0) res.setHeader("Set-Cookie", setCookies);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return json({ code: "UNSUPPORTED_MEDIA_TYPE" }, 415);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return json({ code: "INVALID_JSON" }, 400);
        }
        const fields = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        record.fieldNames = Object.keys(fields);
        const user = opts.users.find((u) => u.email === fields["email"] && u.password === fields["password"]);
        if (!user) return json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, 401);
        const token = randomBytes(32).toString("hex");
        sessions.set(token, user);
        const cookie = `${sessionName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`;
        const out: Record<string, unknown> = { redirect: false, user: { email: user.email, name: user.name ?? "Form User" } };
        if (!opts.jsonOmitToken) out["sessionToken"] = randomBytes(24).toString("hex");
        return json(out, opts.jsonSuccessStatus ?? 200, [cookie]);
      }

      if (req.method === "GET" && url.pathname === "/api/auth/workspaces") {
        const user = sessions.get(cookies.get(sessionName) ?? "");
        res.writeHead(user ? 200 : 401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            user
              ? {
                  userId: "user_test_1",
                  email: user.email,
                  workspaces: [
                    { id: "ws_primary", name: "Primary", role: user.role ?? "member" },
                    { id: "ws_other", name: "Other", role: "viewer" },
                  ],
                }
              : { error: "unauthenticated" },
          ),
        );
        return;
      }

      const idx = chain.indexOf(url.pathname);
      if (req.method === "GET" && idx !== -1) {
        const hop = url.searchParams.get("hop");
        const next = chain[idx + 1];
        if (next !== undefined) return redirect(hop !== null ? `${next}?hop=${hop}` : next);
        if (hop !== null) {
          const token = pending.get(hop);
          if (token !== undefined) {
            res.setHeader("Set-Cookie", [`${sessionName}=${token}; Path=/; HttpOnly; SameSite=Lax`]);
          }
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("dashboard");
        return;
      }

      if (req.method === "GET" && url.pathname === "/loop") return redirect("/loop");

      if (req.method === "GET" && url.pathname === "/me") {
        const user = sessions.get(cookies.get(sessionName) ?? "");
        if (!user) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthenticated" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            user: { email: user.email, name: user.name ?? "Form User", role: user.role ?? "Member" },
            csrfToken: "not-an-identity-field",
          }),
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
