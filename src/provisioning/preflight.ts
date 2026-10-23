/** Read-only app plan preflight before account or native-store side effects. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { normalizeBrowserAccountBinding } from "./contracts.js";
import { absoluteLocalPath } from "./worker-contracts.js";

interface BoundFile { readonly file: string; readonly sha256: string; readonly dev: bigint; readonly ino: bigint }
export interface PreparedBrowserPlan {
  readonly plan: BoundFile;
  readonly projectDirectory: string;
  readonly packageFile: BoundFile;
  readonly playwrightManifest: BoundFile;
  readonly playwrightCLI: BoundFile;
  readonly specs: readonly BoundFile[];
  readonly origin: string;
  readonly environment: string;
}
function refused(): Error { return new Error("BROWSER_PLAN_PREFLIGHT_REFUSED"); }

async function stableFile(file: string, maximum: number): Promise<{ binding: BoundFile; bytes: Buffer }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    absoluteLocalPath(file);
    if (await realpath(file) !== file) throw refused();
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)) throw refused();
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw refused();
    const buffer = Buffer.alloc(Number(opened.size) + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (size !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
        named.dev !== opened.dev || named.ino !== opened.ino || named.nlink !== 1n || named.size !== before.size ||
        named.mtimeNs !== before.mtimeNs || named.ctimeNs !== before.ctimeNs || await realpath(file) !== file) throw refused();
    const bytes = buffer.subarray(0, size), sha256 = createHash("sha256").update(bytes).digest("hex");
    return { binding: Object.freeze({ file, sha256, dev: opened.dev, ino: opened.ino }), bytes };
  } catch { throw refused(); }
  finally { try { await handle?.close(); } catch { throw refused(); } }
}

/**
 * Loads only Testlane's own fixed packaged validator, never app test/adapter code.
 * Resolving the app-local Playwright CLI does not install or execute it. These
 * hashes bind entry files, not their imports or the quality of authored tests.
 */
export async function prepareManagedBrowserPlan(planFile: string, inputBinding: unknown): Promise<PreparedBrowserPlan> {
  try {
    const binding = normalizeBrowserAccountBinding(inputBinding), file = absoluteLocalPath(planFile);
    const source = await stableFile(file, 256 * 1024);
    const contractsURL = new URL("../../examples/agent-verification/contracts.mjs", import.meta.url).href;
    const contracts = await import(contractsURL) as { validatePlan: (value: unknown) => unknown };
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)) as unknown;
    const plan = contracts.validatePlan(decoded) as { status: string; projectDir: string; target: { baseUrl: string; environment: string };
      evidence: { screenshots: string }; cases: { spec: string }[] };
    if (plan.status !== "reviewed" || plan.target.baseUrl !== binding.target.origin || plan.target.environment !== binding.target.environment || plan.evidence.screenshots !== "off") throw refused();
    const projectDirectory = path.resolve(path.dirname(file), plan.projectDir), info = await lstat(projectDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(projectDirectory) !== projectDirectory) throw refused();
    const packageFile = await stableFile(path.join(projectDirectory, "package.json"), 256 * 1024);
    const playwrightManifest = await stableFile(path.join(projectDirectory, "node_modules", "@playwright", "test", "package.json"), 256 * 1024);
    const decode = (bytes: Buffer): Record<string, unknown> => {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw refused();
      return value as Record<string, unknown>;
    };
    // The fresh worker drops the parent's custom conditions/loader settings.
    // A single explicit CLI string has the same selector in both processes.
    if (decode(packageFile.bytes)["name"] === "@playwright/test") throw refused();
    const exports = decode(playwrightManifest.bytes)["exports"];
    if (exports === null || typeof exports !== "object" || Array.isArray(exports)) throw refused();
    const cliExport = (exports as Record<string, unknown>)["./cli"];
    if (typeof cliExport !== "string" || !cliExport.startsWith("./")) throw refused();
    const dependencyDirectory = path.dirname(playwrightManifest.binding.file), exportedCLI = path.resolve(dependencyDirectory, cliExport);
    const exportRelative = path.relative(dependencyDirectory, exportedCLI);
    if (!exportRelative || exportRelative === ".." || exportRelative.startsWith(".." + path.sep) || path.isAbsolute(exportRelative)) throw refused();
    // Resolve through the app's own installed dependency, without importing it.
    const cli = createRequire(packageFile.binding.file).resolve("@playwright/test/cli");
    if (cli !== exportedCLI) throw refused();
    const dependencyPath = path.relative(path.join(projectDirectory, "node_modules"), cli);
    if (!dependencyPath || dependencyPath === ".." || dependencyPath.startsWith(".." + path.sep) || path.isAbsolute(dependencyPath)) throw refused();
    const playwrightCLI = await stableFile(cli, 1024 * 1024), specs = new Map<string, BoundFile>();
    let total = 0;
    for (const item of plan.cases) {
      const spec = path.resolve(projectDirectory, item.spec), relative = path.relative(projectDirectory, spec);
      if (path.isAbsolute(item.spec) || !relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw refused();
      if (!specs.has(spec)) {
        const loaded = await stableFile(spec, 1024 * 1024);
        total += loaded.bytes.length;
        if (total > 10 * 1024 * 1024) throw refused();
        specs.set(spec, loaded.binding);
      }
    }
    const prepared = Object.freeze({ plan: source.binding, projectDirectory, packageFile: packageFile.binding, playwrightManifest: playwrightManifest.binding, playwrightCLI: playwrightCLI.binding,
      specs: Object.freeze([...specs.values()]), origin: binding.target.origin, environment: binding.target.environment });
    await assertManagedBrowserPlanUnchanged(prepared);
    return prepared;
  } catch { throw refused(); }
}

/** A changed/replaced entry cannot use an already reviewed preflight result. */
export async function assertManagedBrowserPlanUnchanged(prepared: PreparedBrowserPlan): Promise<void> {
  try {
    if (await realpath(prepared.projectDirectory) !== prepared.projectDirectory) throw refused();
    for (const item of [prepared.plan, prepared.packageFile, prepared.playwrightManifest, prepared.playwrightCLI, ...prepared.specs]) {
      const current = (await stableFile(item.file, [prepared.plan, prepared.packageFile, prepared.playwrightManifest].includes(item) ? 256 * 1024 : 1024 * 1024)).binding;
      if (current.dev !== item.dev || current.ino !== item.ino || current.sha256 !== item.sha256) throw refused();
    }
  } catch { throw refused(); }
}
