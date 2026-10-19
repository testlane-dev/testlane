/**
 * Fictional device exchange service used only by dependent-token tests.
 * An approved service session authorizes a subject/credential exchange; a
 * random access token can then read that subject's identity. This is not an
 * adapter for an application. Secrets and token values are never recorded.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeDeviceUser {
  subject: string;
  credential: string;
  name: string;
  role?: string;
  email?: string;
}

export interface DeviceExchangeRequest {
  method: string;
  path: string;
  dependency: boolean;
  identifier?: "subject" | "none";
  hasToken?: boolean;
}

export interface DeviceExchangeOptions {
  users: FakeDeviceUser[];
  isDependency: (cookieHeader: string | undefined) => boolean;
  tokenTtlSeconds?: number;
}

export interface DeviceExchangeRoutes {
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean>;
  requests: DeviceExchangeRequest[];
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createDeviceExchangeRoutes(opts: DeviceExchangeOptions): DeviceExchangeRoutes {
  const ttl = opts.tokenTtlSeconds ?? 90 * 60;
  const tokens = new Map<string, { user: FakeDeviceUser; expiresMs: number }>();
  const requests: DeviceExchangeRequest[] = [];
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    if (req.method === "POST" && url.pathname === "/api/device/exchange") {
      const dependency = opts.isDependency(req.headers.cookie);
      const record: DeviceExchangeRequest = { method: "POST", path: url.pathname, dependency, identifier: "none" };
      requests.push(record);
      const raw = await readBody(req);
      if (!dependency) {
        json(res, 401, { error: "Service session required" });
        return true;
      }
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return true;
      }
      if (typeof body["credential"] !== "string" || body["credential"] === "") {
        json(res, 400, { error: "Credential required" });
        return true;
      }
      if (typeof body["subject"] === "string") record.identifier = "subject";
      const user = opts.users.find((entry) => entry.subject === body["subject"]);
      if (user === undefined || user.credential !== body["credential"]) {
        json(res, 401, { error: "Invalid subject or credential" });
        return true;
      }
      const accessToken = randomBytes(24).toString("hex");
      const expiresMs = Date.now() + ttl * 1000;
      tokens.set(accessToken, { user, expiresMs });
      json(res, 200, { accessToken, expiresAt: new Date(expiresMs).toISOString() });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/device/identity") {
      const header = req.headers["x-device-access"];
      const token = typeof header === "string" ? header : undefined;
      requests.push({
        method: "GET",
        path: url.pathname,
        dependency: opts.isDependency(req.headers.cookie),
        hasToken: token !== undefined,
      });
      const entry = token !== undefined ? tokens.get(token) : undefined;
      if (entry === undefined || entry.expiresMs <= Date.now()) {
        json(res, 401, { error: "Access token required" });
        return true;
      }
      const { user } = entry;
      const identity: Record<string, unknown> = { name: user.name, sessionToken: token };
      if (user.role !== undefined) identity["role"] = user.role;
      if (user.email !== undefined) identity["email"] = user.email;
      json(res, 200, { name: user.name, subject: identity });
      return true;
    }
    return false;
  };
  return { handle, requests };
}

export interface FakeDeviceExchange {
  baseUrl: string;
  requests: DeviceExchangeRequest[];
  close(): Promise<void>;
}

export interface FakeDeviceExchangeOptions extends Omit<DeviceExchangeOptions, "isDependency"> {
  dependencyCookie: { name: string; value: string };
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export async function startFakeDeviceExchange(opts: FakeDeviceExchangeOptions): Promise<FakeDeviceExchange> {
  const routes = createDeviceExchangeRoutes({
    ...opts,
    isDependency: (header) => cookieValue(header, opts.dependencyCookie.name) === opts.dependencyCookie.value,
  });
  let baseUrl = "";
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", baseUrl);
      if (!(await routes.handle(req, res, url))) json(res, 404, { error: "not found" });
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
    requests: routes.requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
