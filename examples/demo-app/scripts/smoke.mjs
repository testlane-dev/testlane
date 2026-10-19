#!/usr/bin/env node
/**
 * `npm run smoke`: the whole demo flow, headless. Exit 0 only when every step passes.
 *
 *   start app, seed vault
 *   check demo:admin                          -> exit 0, admin@demo.test
 *   session demo:admin --format cookie        -> GET /api/me with it -> admin@demo.test / Admin
 *   handoff demo:handoff:qa                   -> GET url (redirect: manual) -> 302 + Set-Cookie
 *                                                that cookie on /api/me -> qa@demo.test / QA
 *   same url again                            -> 404 (replay)
 *   HEAD / tampered / no code on the route    -> 404
 *   session demo:production                   -> exit 2
 *   status                                    -> exit 0
 *   no generated secret appears in any CLI output or app log line
 *
 * State goes to .demo/smoke/ and the Next build to .next-smoke/. On Windows the vault is
 * inside that state folder too, so this can run while `npm run demo` is up (on another
 * DEMO_PORT) without touching it. On macOS and Linux the secrets go into your login
 * keychain under the same two profile names `npm run demo` uses, so a live demo's entries
 * are overwritten, then deleted again when the smoke test ends: rerun `npm run demo` after.
 */
process.env.DEMO_STATE_DIR ||= ".demo/smoke";
process.env.DEMO_NEXT_DIST_DIR ||= ".next-smoke";

const {
  PROFILE_ADMIN,
  PROFILE_HANDOFF,
  PROFILE_PRODUCTION,
  assertPortFree,
  baseUrlFor,
  deleteVaultEntries,
  demoPort,
  ensureDemoDeps,
  generateSecrets,
  log,
  resolveBroker,
  runBroker,
  seedVault,
  startApp,
  stopApp,
  waitForApp,
  writeProfiles,
} = await import("./lib.mjs");

const results = [];
const outputs = []; // everything the CLI and the app printed, for the leak check
let app = null;

function record(name, ok, detail = "") {
  results.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`);
}

async function cli(args) {
  const res = await runBroker(broker, args);
  outputs.push(res.stdout, res.stderr);
  return res;
}

async function getMe(cookieHeader) {
  const res = await fetch(`${base}/api/me`, { headers: { Cookie: cookieHeader }, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json };
}

/** name=value of the first Set-Cookie (attributes stripped). */
function cookiePair(setCookie) {
  return setCookie ? setCookie.split(";", 1)[0] : "";
}

const port = demoPort();
const base = baseUrlFor(port);
let broker;
let secrets;

async function main() {
  await assertPortFree(port);
  ensureDemoDeps();
  broker = resolveBroker();
  secrets = generateSecrets();
  writeProfiles(port);
  await seedVault(broker, secrets);
  record("seed vault (store set over stdin)", true);

  app = startApp(port, secrets, (stream, line) => {
    outputs.push(line);
    if (process.env.SMOKE_VERBOSE === "1") process.stdout.write(`[app:${stream}] ${line}\n`);
  });
  await waitForApp(port, app);
  record("app up", true, base);

  // check
  {
    const r = await cli(["--json", "check", PROFILE_ADMIN]);
    let j = null;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      // leave null
    }
    record(
      "check demo:admin -> ok",
      r.code === 0 && j?.ok === true && j?.email === "admin@demo.test" && j?.role === "Admin",
      `exit ${r.code}, email ${j?.email}, role ${j?.role}`,
    );
  }

  // session --format cookie -> /api/me
  {
    const r = await cli(["session", PROFILE_ADMIN, "--format", "cookie"]);
    const cookie = r.stdout.trim();
    const me = r.code === 0 ? await getMe(cookie) : { status: 0, json: null };
    record(
      "session demo:admin --format cookie -> /api/me",
      r.code === 0 && me.status === 200 && me.json?.email === "admin@demo.test" && me.json?.role === "Admin",
      `exit ${r.code}, /api/me ${me.status} ${JSON.stringify(me.json)}`,
    );
    const anon = await getMe("");
    record("/api/me without a session -> 401", anon.status === 401, `status ${anon.status}`);
  }

  // handoff -> 302 + cookie, replay -> 404
  {
    const r = await cli(["handoff", PROFILE_HANDOFF]);
    let url = null;
    try {
      url = JSON.parse(r.stdout).url;
    } catch {
      // leave null
    }
    const okUrl = r.code === 0 && typeof url === "string" && url.startsWith(`${base}/api/auth/agent-handoff?code=`);
    record("handoff demo:handoff:qa -> url", okUrl, `exit ${r.code}`);
    if (okUrl) {
      const head = await fetch(url, { method: "HEAD", redirect: "manual" });
      record("HEAD on the handoff url -> 404 (does not burn the code)", head.status === 404, `status ${head.status}`);

      const first = await fetch(url, { redirect: "manual" });
      await first.body?.cancel();
      const setCookie = first.headers.get("set-cookie");
      const pair = cookiePair(setCookie);
      record(
        "GET handoff url -> 302 + Set-Cookie",
        first.status === 302 &&
          first.headers.get("location") === "/" &&
          pair.startsWith("next-auth.session-token=") &&
          /HttpOnly/i.test(setCookie ?? "") &&
          /SameSite=Lax/i.test(setCookie ?? ""),
        `status ${first.status}, location ${first.headers.get("location")}, cookie ${pair.split("=", 1)[0] || "none"}`,
      );
      const me = await getMe(pair);
      record(
        "handoff cookie -> /api/me is qa@demo.test (QA)",
        me.status === 200 && me.json?.email === "qa@demo.test" && me.json?.role === "QA",
        `/api/me ${me.status} ${JSON.stringify(me.json)}`,
      );
      const page = await fetch(`${base}/`, { headers: { Cookie: pair }, redirect: "manual" });
      const html = await page.text();
      record(
        "handoff cookie -> / shows Signed in as qa@demo.test (QA)",
        page.status === 200 && /Signed in as .*qa@demo\.test.*\(.*QA.*\)/s.test(html),
        `status ${page.status}`,
      );

      const replay = await fetch(url, { redirect: "manual" });
      const replayBody = await replay.text();
      record(
        "replay the same url -> bare 404",
        replay.status === 404 && replayBody === "" && replay.headers.get("set-cookie") === null,
        `status ${replay.status}, body ${replayBody.length} bytes`,
      );

      // Tamper with the signature's first character (keeps the shape valid).
      const u = new URL(url);
      const code = u.searchParams.get("code") ?? "";
      const [p, s] = code.split(".");
      const tampered = `${p}.${s[0] === "A" ? "B" : "A"}${s.slice(1)}`;
      const bad = await fetch(`${base}/api/auth/agent-handoff?code=${encodeURIComponent(tampered)}`, { redirect: "manual" });
      await bad.body?.cancel();
      record("tampered code -> 404", bad.status === 404, `status ${bad.status}`);
    }
    const none = await fetch(`${base}/api/auth/agent-handoff`, { redirect: "manual" });
    await none.body?.cancel();
    record("no code -> 404", none.status === 404, `status ${none.status}`);
  }

  // anonymous / redirects to /login
  {
    const res = await fetch(`${base}/`, { redirect: "manual" });
    await res.body?.cancel();
    const loc = res.headers.get("location") ?? "";
    record("/ without a session -> redirect to /login", res.status >= 300 && res.status < 400 && loc.endsWith("/login"), `status ${res.status}, location ${loc}`);
  }

  // production refused
  {
    const r = await cli(["session", PROFILE_PRODUCTION]);
    record("session demo:production -> refused (exit 2)", r.code === 2, `exit ${r.code}`);
  }

  // status
  {
    const r = await cli(["status"]);
    record("status -> exit 0", r.code === 0, `exit ${r.code}`);
  }

  // Leak check: no generated secret in anything the CLI or the app printed.
  {
    const all = outputs.join("\n");
    const leaked = Object.entries(secrets)
      .filter(([, v]) => all.includes(v))
      .map(([k]) => k);
    record("no secret in CLI output or app logs", leaked.length === 0, leaked.length ? `leaked: ${leaked.join(", ")}` : "");
  }
}

let exitCode = 1;
try {
  await main();
  exitCode = results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  record("smoke run", false, err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  stopApp(app);
  // On macOS and Linux the seeded secrets are in your own keychain, not under .demo/smoke: take them out again.
  if (broker) await deleteVaultEntries(broker).catch(() => {});
}
const failed = results.filter((r) => !r.ok).length;
log(`${results.length - failed}/${results.length} passed`);
setTimeout(() => process.exit(exitCode), 500);
