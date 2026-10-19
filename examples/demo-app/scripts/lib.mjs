/**
 * Shared plumbing for demo.mjs and smoke.mjs. Node built-ins only (this runs
 * before the demo app's own dependencies are installed).
 *
 * Secrets handled here (the two demo passwords, NEXTAUTH_SECRET and
 * AGENT_HANDOFF_SECRET) are generated per run, passed to the app once over
 * stdin, and passed to the broker only over stdin. They are never written to
 * a file, environment variable, or command argument. Nothing in this file
 * prints them.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(DEMO_DIR, "..", "..");
/** .demo/ by default; the smoke test uses its own folder so it can run next to a live demo. */
export const STATE_DIR = process.env.DEMO_STATE_DIR ? path.resolve(DEMO_DIR, process.env.DEMO_STATE_DIR) : path.join(DEMO_DIR, ".demo");
export const HOME_DIR = path.join(STATE_DIR, "home");
export const PROFILES_FILE = path.join(STATE_DIR, "testlane.profiles.json");

export const IS_WINDOWS = process.platform === "win32";

export const PROFILE_ADMIN = "demo:admin";
export const PROFILE_HANDOFF = "demo:handoff:qa";
export const PROFILE_PRODUCTION = "demo:production";

export function log(msg) {
  process.stdout.write(`[demo] ${msg}\n`);
}

export function demoPort() {
  const raw = process.env.DEMO_PORT;
  if (raw === undefined || raw.trim() === "") return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DEMO_PORT must be an integer between 1 and 65535`);
  }
  return port;
}

export function baseUrlFor(port) {
  return `http://localhost:${port}`;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

// npm's own `--prefix <dir>` flag (used by the root "demo" script, `npm
// --prefix examples/demo-app run demo`) exports npm_config_prefix,
// npm_config_local_prefix, and npm_config_global_prefix into the script's
// environment, all three set to <dir> (verified for npm 10.9.7; reported for
// npm 11.4.2 on Windows). Every nested `npm install` we spawn from here
// inherits that trio unchanged, even the one at REPO_ROOT -- a different cwd
// than <dir>. A nested npm that trusts an inherited local_prefix instead of
// deriving one from its own cwd can end up installing into (and rewriting
// the package.json of) the wrong project; on Windows this is exactly
// npm/cli#6960, where a mismatched --prefix/local_prefix makes npm add the
// project as a self-referential "file:" dependency of itself. Strip all
// three, case-insensitively (env var names are case-insensitive on
// Windows), so each nested npm computes its own prefix from the cwd we
// actually pass it. Other inherited npm_config_* keys (registry, cache,
// proxy, user agent, ...) don't encode a directory that can mismatch the
// nested cwd, so they are left alone.
const NPM_PREFIX_ENV_KEYS = new Set(["npm_config_prefix", "npm_config_local_prefix", "npm_config_global_prefix"]);

/** A copy of `env` with npm's --prefix-derived keys removed (case-insensitively). Does not mutate `env`. */
export function npmChildEnv(env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (NPM_PREFIX_ENV_KEYS.has(key.toLowerCase())) delete copy[key];
  }
  return copy;
}

function runNpm(args, cwd) {
  // npm is a .cmd shim on Windows, which Node only spawns through a shell. The
  // arguments are fixed constants, never user input.
  const res = spawnSync("npm", args, { cwd, env: npmChildEnv(process.env), stdio: "inherit", shell: IS_WINDOWS });
  if (res.status !== 0) throw new Error(`npm ${args.join(" ")} failed in ${cwd} (exit ${res.status ?? res.signal})`);
}

/** `npm install` the demo app when its node_modules is missing. */
export function ensureDemoDeps() {
  if (existsSync(path.join(DEMO_DIR, "node_modules", "next", "package.json"))) return;
  log("installing the demo app's dependencies (first run only)...");
  runNpm(["install", "--no-audit", "--no-fund"], DEMO_DIR);
}

/**
 * How to run the broker CLI: `node <repo>/dist/cli.js` when built, else tsx on
 * src/cli.ts. Installs the broker's dependencies when they are missing.
 * Returns { argv: [node, ...prefix], shellPrefix } where shellPrefix is the
 * human-typable command (paths quoted) used in the "try this" block.
 */
export function resolveBroker() {
  if (!existsSync(path.join(REPO_ROOT, "node_modules", "commander", "package.json"))) {
    log("installing the broker's dependencies at the repo root (first run only)...");
    runNpm(["install", "--no-audit", "--no-fund"], REPO_ROOT);
  }
  const distCli = path.join(REPO_ROOT, "dist", "cli.js");
  if (existsSync(distCli)) return { prefix: [distCli], kind: "dist" };
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const srcCli = path.join(REPO_ROOT, "src", "cli.ts");
  if (existsSync(tsxCli) && existsSync(srcCli)) return { prefix: [tsxCli, srcCli], kind: "tsx" };
  throw new Error(`cannot find the broker CLI: run "npm install && npm run build" in ${REPO_ROOT}`);
}

/**
 * Environment for every broker invocation: the demo's own home folder (audit log; the whole
 * vault on Windows only, see vaultLocation) and the demo registry.
 */
export function brokerEnv(extra = {}) {
  return {
    ...process.env,
    TESTLANE_HOME: HOME_DIR,
    TESTLANE_PROFILES: PROFILES_FILE,
    // Blank legacy names (blank = unset), so a pre-rename AGENT_AUTH_* in the caller's shell cannot matter.
    AGENT_AUTH_HOME: "",
    AGENT_AUTH_PROFILES: "",
    ...extra,
  };
}

/**
 * Run the broker. `input` (optional) goes to stdin, which is how secrets are
 * passed; stdout/stderr are captured and returned, never echoed here.
 */
export function runBroker(broker, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...broker.prefix, ...args], {
      cwd: DEMO_DIR,
      env: env ?? brokerEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(`${input}\n`);
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Throwaway state
// ---------------------------------------------------------------------------

function secret(bytes) {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Fresh secrets for this run. Returns values for stdin transport; never prints
 * or persists them.
 */
export function generateSecrets() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const secrets = {
    NEXTAUTH_SECRET: secret(32), // 43 chars
    AGENT_HANDOFF_SECRET: secret(32), // 43 chars, >= 32 as the contract requires
    DEMO_ADMIN_PASSWORD: secret(18), // 24 chars
    DEMO_QA_PASSWORD: secret(18),
  };
  return secrets;
}

/** The demo's profile registry (no secrets). */
export function writeProfiles(port) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const baseUrl = baseUrlFor(port);
  const registry = {
    version: 1,
    profiles: {
      [PROFILE_ADMIN]: {
        app: "demo-app",
        environment: "sandbox",
        baseUrl,
        strategy: "nextauth-credentials",
        account: { email: "admin@demo.test", role: "Admin" },
        session: { ttlMinutes: 60 },
        notes: "Demo admin; the broker signs in with the password from the vault.",
      },
      [PROFILE_HANDOFF]: {
        app: "demo-app",
        environment: "sandbox",
        baseUrl,
        strategy: "app-handoff",
        account: { email: "qa@demo.test", role: "QA" },
        session: { ttlMinutes: 30 },
        notes: "Demo QA user for browser panes; the vault holds the app's AGENT_HANDOFF_SECRET, not a password.",
      },
      [PROFILE_PRODUCTION]: {
        app: "demo-app",
        environment: "production",
        baseUrl: "https://demo.example",
        strategy: "nextauth-credentials",
        account: { email: "", role: "" },
        session: { ttlMinutes: 0 },
        notes: "Listed only so the broker can refuse it by name.",
      },
    },
  };
  writeFileSync(PROFILES_FILE, `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}

/** Store the admin password and the handoff secret in the vault (see vaultLocation), over stdin. */
export async function seedVault(broker, secrets) {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  for (const [profile, value] of [
    [PROFILE_ADMIN, secrets.DEMO_ADMIN_PASSWORD],
    [PROFILE_HANDOFF, secrets.AGENT_HANDOFF_SECRET],
  ]) {
    const res = await runBroker(broker, ["store", "set", profile], {
      input: value,
      env: brokerEnv({ TESTLANE_REQUESTER: "demo-setup" }),
    });
    if (res.code !== 0) {
      throw new Error(
        `testlane store set ${profile} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}` +
          (process.platform === "linux"
            ? "\n(on Linux the vault needs a keychain: install secret-tool with an unlocked Secret Service keyring)"
            : ""),
      );
    }
  }
}

/** The profiles `seedVault` stores a secret for (the production profile never holds one). */
export const VAULT_PROFILES = [PROFILE_ADMIN, PROFILE_HANDOFF];

/**
 * Where the demo's stored secrets really live, for the lines the scripts print.
 * Only on Windows is the vault inside the state folder (DPAPI files under
 * TESTLANE_HOME). On macOS and Linux the secrets are items in the user's own
 * login Keychain / Secret Service; TESTLANE_HOME does not isolate them.
 */
export function vaultLocation() {
  if (IS_WINDOWS) return "DPAPI files under .demo/home";
  const where = process.platform === "darwin" ? "login Keychain" : "login keyring (Secret Service)";
  return `your ${where}, service agent-auth, keys ${VAULT_PROFILES.map((p) => `agent-auth/${p}`).join(" and ")}`;
}

/**
 * Delete the demo's stored secrets with the broker's `store delete`. Removing
 * the state folder is not enough on macOS and Linux (see vaultLocation), so
 * clean.mjs, smoke.mjs and workflow-proof.mjs call this. `store delete` needs
 * the profile registry, so it is rewritten when missing. Reports the broker's
 * one-line answer (never a secret) through `say` and returns the profiles that
 * could not be deleted. "No keychain available" is not a failure: nothing
 * could have been stored.
 */
export async function deleteVaultEntries(broker, say = log) {
  if (!existsSync(PROFILES_FILE)) writeProfiles(3000);
  const failed = [];
  for (const profile of VAULT_PROFILES) {
    const res = await runBroker(broker, ["store", "delete", profile]);
    const detail = (res.stdout.trim() || res.stderr.trim()).split("\n")[0];
    if (res.code === 0) say(detail);
    else if (/no keychain available/.test(res.stderr)) say(`${profile}: no keychain on this machine, nothing to delete`);
    else {
      say(`store delete ${profile} failed (exit ${res.code}): ${detail}`);
      failed.push(profile);
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// The app process
// ---------------------------------------------------------------------------

function canConnect(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(500, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port }, () => srv.close(() => resolve(true)));
  });
}

/** Throws a clear error when anything already answers on `port`. */
export async function assertPortFree(port) {
  const busy =
    (await canConnect("127.0.0.1", port)) || (await canConnect("::1", port)) || !(await canListen(port));
  if (busy) {
    throw new Error(
      `port ${port} is already in use. Stop whatever is listening there, or pick another port:\n` +
        `  bash:       DEMO_PORT=3020 npm run demo\n` +
        `  PowerShell: $env:DEMO_PORT='3020'; npm run demo`,
    );
  }
}

/**
 * Start the custom Next bootstrap on `port`. `onLine(stream, line)` gets
 * every output line of the app. Returns the child process.
 */
export function startApp(port, secrets, onLine) {
  const appScript = path.join(DEMO_DIR, "scripts", "app.mjs");
  const env = {
    ...process.env,
    NEXTAUTH_URL: baseUrlFor(port),
    // The route is fail-closed: enabled only with the flag AND a non-production marker (lib/handoff-gate.js).
    AGENT_HANDOFF_ENABLED: "true",
    AGENT_HANDOFF_ENV: "local",
    DEMO_PROFILES_FILE: PROFILES_FILE,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  delete env.NODE_ENV; // next dev sets it
  // The app never needs the broker's settings.
  delete env.TESTLANE_HOME;
  delete env.TESTLANE_PROFILES;
  delete env.AGENT_AUTH_HOME;
  delete env.AGENT_AUTH_PROFILES;
  // Secret values travel only through the one-shot stdin bootstrap.
  delete env.NEXTAUTH_SECRET;
  delete env.AGENT_HANDOFF_SECRET;
  delete env.DEMO_ADMIN_PASSWORD;
  delete env.DEMO_QA_PASSWORD;

  const child = spawn(process.execPath, [appScript, String(port)], {
    cwd: DEMO_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: !IS_WINDOWS, // own process group on POSIX, so stopApp can kill the whole tree
  });
  for (const [name, stream] of [
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ]) {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        onLine(name, buf.slice(0, nl).replace(/\r$/, ""));
        buf = buf.slice(nl + 1);
      }
    });
    stream.on("end", () => {
      if (buf !== "") onLine(name, buf);
    });
  }
  child.stdin.end(
    `${JSON.stringify({
      nextAuthSecret: secrets.NEXTAUTH_SECRET,
      handoffSecret: secrets.AGENT_HANDOFF_SECRET,
      adminPassword: secrets.DEMO_ADMIN_PASSWORD,
      qaPassword: secrets.DEMO_QA_PASSWORD,
    })}\n`,
  );
  return child;
}

/** Kill the app and everything it spawned. */
export function stopApp(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, 3000).unref();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the app answers /api/auth/csrf (first compile can take a while). */
export async function waitForApp(port, child, timeoutMs = 180_000) {
  const url = `${baseUrlFor(port)}/api/auth/csrf`;
  const deadline = Date.now() + timeoutMs;
  let serverErrors = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited early (exit ${child.exitCode}); see the [app] lines above`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      await res.body?.cancel();
      if (res.ok) return;
      if (res.status >= 500 && ++serverErrors >= 5) {
        throw new Error(`the app answers ${url} with ${res.status}; see the app's error output`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("the app answers")) throw err;
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`the app did not come up on port ${port} within ${Math.round(timeoutMs / 1000)} s`);
}

/** Compile the routes the walkthrough uses, so the first real command is fast. */
export async function warmUp(port) {
  const base = baseUrlFor(port);
  const hits = [
    ["GET", "/login"],
    ["GET", "/"],
    ["GET", "/api/me"],
    ["GET", "/api/auth/session"],
    ["HEAD", "/api/auth/agent-handoff"], // HEAD: compiles the route, always 404, logs nothing
  ];
  for (const [method, p] of hits) {
    try {
      const res = await fetch(`${base}${p}`, { method, redirect: "manual", signal: AbortSignal.timeout(120_000) });
      await res.body?.cancel();
    } catch {
      // warm-up is best effort
    }
  }
}

/** Shell-quote for the printed commands. */
function psq(s) {
  return `'${s.replace(/'/g, "''")}'`;
}
function shq(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function posixish(p) {
  return IS_WINDOWS ? p.replace(/\\/g, "/") : p;
}

/** The "try this" block. Contains paths and commands only, never a secret. */
export function tryThisBlock(port, broker) {
  const base = baseUrlFor(port);
  const psFn = `function testlane { & node ${broker.prefix.map(psq).join(" ")} @args }`;
  const shAlias = `alias testlane="node ${broker.prefix.map((p) => shq(posixish(p))).join(" ")}"`;
  const dbusAddress = process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
  const lines = [
    "",
    "=".repeat(78),
    ` Demo app running at ${base}  (Ctrl+C stops it)`,
    "=".repeat(78),
    "",
    " In a second terminal, point the broker at the demo's home folder and registry:",
    "",
    "   PowerShell:",
    `     cd ${psq(DEMO_DIR)}; $env:TESTLANE_HOME=${psq(HOME_DIR)}; $env:TESTLANE_PROFILES=${psq(PROFILES_FILE)}; ${psFn}`,
    "",
    "   bash / zsh:",
    ...(dbusAddress === ""
      ? []
      : [
          "     # to use the same keyring session from another terminal, run (a socket path, not a secret):",
          `     export DBUS_SESSION_BUS_ADDRESS=${shq(dbusAddress)}`,
        ]),
    `     cd ${shq(posixish(DEMO_DIR))} && export TESTLANE_HOME=${shq(posixish(HOME_DIR))} TESTLANE_PROFILES=${shq(posixish(PROFILES_FILE))} && ${shAlias}`,
    "",
    " Then try:",
    "",
    `   testlane check ${PROFILE_ADMIN}`,
    "       signs in with the vaulted password; prints only email and role",
    "",
    `   testlane session ${PROFILE_ADMIN} --format curl --out .demo/jar.txt`,
    `   curl -b .demo/jar.txt ${base}/api/me          (PowerShell: curl.exe ...)`,
    "       a real session for your tools; the password never left the vault",
    "",
    `   testlane handoff ${PROFILE_HANDOFF}`,
    "       open the printed url in any browser within 60 s: signed in as qa@demo.test (QA);",
    "       open it again: 404 (single use)",
    "",
    `   testlane session ${PROFILE_PRODUCTION}`,
    "       refused, exit code 2: production profiles never get a session",
    "",
    "   testlane status",
    "   testlane audit",
    "",
    ` Humans can also visit ${base}/login; automated sign-in uses the in-memory`,
    " throwaway credentials and never writes their values to disk.",
    "",
    ...(IS_WINDOWS
      ? []
      : [
          ` The demo's two throwaway secrets are stored in ${vaultLocation()}.`,
          " TESTLANE_HOME does not isolate them from your real vault. When you are done, delete them:",
          "   npm --prefix examples/demo-app run clean        (from the repo root)",
          "",
        ]),
  ];
  return lines.join("\n");
}
