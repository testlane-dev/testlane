/** Internal subprocess entry; it never prints native values or exceptions. */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeDelete, storeSet, type CommandDeps } from "../commands.js";
import { resolveCommandDeps } from "../deps.js";
import { getProfile } from "../profiles.js";
import { secretKeyFor } from "../store/index.js";
import { assertBrowserPrivateDirectory } from "./private-directory.js";
import { absoluteLocalPath, canonicalLoopbackOrigin } from "./worker-contracts.js";

const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const PROFILE = new RegExp(`^tl-disposable:(${UUID}):(${UUID}):(editor|reviewer)$`);
type Operation = "present" | "seed" | "delete";
type Status = "present" | "absent" | "seeded" | "deleted";
const refused = () => new Error("BROWSER_NATIVE_ENTRY_REFUSED");

/** Exact generated entry only. No listing, rotation or access to other keys. */
export async function managedNativeOperation(deps: CommandDeps, operation: Operation, name: string, input?: string): Promise<Readonly<{ schemaVersion: 1; status: Status }>> {
  try {
    if (typeof name !== "string" || !["present", "seed", "delete"].includes(operation)) throw refused();
    const match = PROFILE.exec(name), profile = getProfile(deps.registry, name);
    if (!match || profile.name !== name || profile.app !== "testlane-disposable-browser" || profile.environment === "production" ||
        profile.account.email !== `tlp-${match[2]}-${match[3]}@example.test` ||
        !["form-post", "nextauth-credentials"].includes(profile.strategy) || canonicalLoopbackOrigin(profile.baseUrl) !== profile.baseUrl) throw refused();
    if (operation !== "seed" && input !== undefined) throw refused();
    const key = secretKeyFor(profile);
    if (operation === "present") return Object.freeze({ schemaVersion: 1, status: (await deps.store.get(key)) === null ? "absent" : "present" });
    if (operation === "seed") {
      if (typeof input !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(input) || (await deps.store.get(key)) !== null) throw refused();
      await storeSet(deps, name, input);
      if ((await deps.store.get(key)) === null) throw refused();
      return Object.freeze({ schemaVersion: 1, status: "seeded" });
    }
    await storeDelete(deps, name);
    if ((await deps.store.get(key)) !== null) throw refused();
    return Object.freeze({ schemaVersion: 1, status: "deleted" });
  } catch { throw refused(); }
}

async function readGeneratedSecret(): Promise<string> {
  const chunks: Buffer[] = []; let count = 0;
  try {
    for await (const chunk of process.stdin) {
      const value = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk as string, "utf8");
      count += value.length;
      if (count > 257) { value.fill(0); throw refused(); }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!/^[A-Za-z0-9_-]{32,256}\n$/.test(text)) throw refused();
      return text.slice(0, -1);
    } finally { bytes.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

async function main(): Promise<number> {
  let secret: string | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || !["present", "seed", "delete"].includes(args[0]!) || !PROFILE.test(args[1]!)) throw refused();
    const operation = args[0] as Operation, name = args[1]!, match = PROFILE.exec(name)!;
    const profilesFile = absoluteLocalPath(process.env["TESTLANE_PROFILES"]), runDirectory = path.dirname(profilesFile);
    const home = absoluteLocalPath(process.env["TESTLANE_HOME"]);
    const expectedStore = { win32: "dpapi", linux: "secret-service", darwin: "keychain-macos" }[process.platform as "win32" | "linux" | "darwin"];
    if (!expectedStore || process.env["TESTLANE_STORE"] !== expectedStore || path.basename(profilesFile) !== "profiles.json" ||
        path.basename(runDirectory) !== match[2] || home !== path.join(runDirectory, "broker-home")) throw refused();
    await assertBrowserPrivateDirectory(runDirectory); await assertBrowserPrivateDirectory(home);
    const info = await lstat(profilesFile, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 1n || info.size > 16384n || await realpath(profilesFile) !== profilesFile ||
        (process.platform !== "win32" && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o600n))) throw refused();
    const deps = await resolveCommandDeps({ profilesFile, cwd: runDirectory, requester: "testlane-disposable-browser" });
    if (operation === "seed") secret = await readGeneratedSecret();
    const result = await managedNativeOperation(deps, operation, name, secret);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch {
    process.stdout.write('{"schemaVersion":1,"status":"refused"}\n');
    return 2;
  } finally { secret = undefined; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
