/** Fresh private directories only. Existing caller directories are verified, never repaired. */
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";

export interface BrowserDirectoryOptions { readonly signal?: AbortSignal | undefined }
function fixed(code: string): Error {
  const error = new Error(code); error.name = "BrowserProvisioningError"; error.stack = code; return error;
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const aborted = (signal?: AbortSignal): boolean => signal !== undefined && abortedGetter.call(signal) === true;
function normalizedSignal(options: unknown): AbortSignal | undefined {
  try {
    if (options === null || typeof options !== "object" || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) throw fixed(REFUSED);
    let signal: unknown;
    for (const key of Reflect.ownKeys(options)) {
      if (key !== "signal") throw fixed(REFUSED);
      const descriptor = Object.getOwnPropertyDescriptor(options, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw fixed(REFUSED);
      signal = descriptor.value;
    }
    if (signal === undefined) return;
    if (signal === null || typeof signal !== "object" || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw fixed(REFUSED);
    for (const name of ["aborted", "reason", "addEventListener", "removeEventListener", "throwIfAborted", "onabort"]) if (Object.hasOwn(signal, name)) throw fixed(REFUSED);
    abortedGetter.call(signal);
    return signal as AbortSignal;
  } catch { throw fixed(REFUSED); }
}
const REFUSED = "BROWSER_PRIVATE_DIRECTORY_REFUSED", EXISTS = "BROWSER_PRIVATE_DIRECTORY_EXISTS";
const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const READY = "BROWSER_PRIVATE_DIRECTORY_READY";
const WINDOWS_PRIVATE_DIRECTORY = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.operation -ne 'create' -and $request.operation -ne 'verify') { throw 'refused' }
  $target=[string]$request.path
  if (-not [IO.Path]::IsPathRooted($target) -or $target -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($target) -cne $target) { throw 'refused' }
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $parent=New-Object IO.DirectoryInfo([IO.Path]::GetDirectoryName($target))
  if (-not $parent.Exists -or ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'refused' }
  $parentSecurity=$parent.GetAccessControl([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)
  $trusted=@($identity.Value,'S-1-5-18','S-1-5-32-544')
  if ($trusted -notcontains $parentSecurity.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'refused' }
  $dangerous=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($entry in $parentSecurity.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($entry.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($entry.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $trusted -notcontains $entry.IdentityReference.Value -and ($entry.FileSystemRights -band $dangerous) -ne 0) { throw 'refused' }
  }
  if ($request.operation -eq 'create') {
    if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { throw 'refused' }
    $security=New-Object Security.AccessControl.DirectorySecurity
    $security.SetOwner($identity)
    $security.SetAccessRuleProtection($true,$false)
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
    $null=[IO.Directory]::CreateDirectory($target,$security)
  }
  $directory=New-Object IO.DirectoryInfo($target)
  if (-not $directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'refused' }
  $actual=$directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $identity.Value) { throw 'refused' }
  $rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) { throw 'refused' }
  $only=$rules[0]
  if ($only.IdentityReference.Value -cne $identity.Value -or $only.IsInherited -or $only.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $only.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $only.InheritanceFlags -ne $inheritance -or $only.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'refused' }
  if ($request.operation -eq 'create' -and [IO.Directory]::GetFileSystemEntries($target).Length -ne 0) { throw 'refused' }
  [Console]::Out.Write('BROWSER_PRIVATE_DIRECTORY_READY')
  exit 0
} catch {
  [Console]::Error.Write('BROWSER_PRIVATE_DIRECTORY_REFUSED')
  exit 1
}`;

async function canonicalDirectory(requested: string, fresh = false): Promise<string> {
  if (typeof requested !== "string" || requested.length > 4096 || !path.isAbsolute(requested) || /[\r\n\0]/.test(requested) || path.resolve(requested) !== requested) throw fixed(REFUSED);
  const root = path.resolve(requested), parent = path.dirname(root);
  if (root === parent || (process.platform === "win32" && (!/^[A-Za-z]:\\/.test(root) || root.slice(3).split("\\").some(part => /[. ]$/.test(part) || /[<>:"|?*]/.test(part))))) throw fixed(REFUSED);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !same(await realpath(parent), parent)) throw fixed(REFUSED);
  if (process.platform !== "win32") {
    const uid = process.getuid!();
    if ((parentInfo.mode & 0o022) && (!(parentInfo.mode & 0o1000) || ![0, uid].includes(parentInfo.uid))) throw fixed(REFUSED);
  }
  let info;
  try { info = await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (fresh) { if (info) throw fixed(EXISTS); }
  else if (!info?.isDirectory() || info.isSymbolicLink() || !same(await realpath(root), root)) throw fixed(REFUSED);
  return root;
}

/** This fixed .NET-only child starts no descendants; unknown close remains a refusal. */
async function windowsDirectory(root: string, operation: "create" | "verify", signal?: AbortSignal): Promise<void> {
  if (aborted(signal)) throw fixed("BROWSER_CANCELLED");
  const system = process.env["SystemRoot"];
  if (typeof system !== "string" || !path.isAbsolute(system)) throw fixed(REFUSED);
  const executable = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink() || !same(await realpath(executable), executable)) throw fixed(REFUSED);
  const began = performance.now();
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined, timer: NodeJS.Timeout | undefined, stopTimer: NodeJS.Timeout | undefined;
    let done = false, stopping = false, failure: string | undefined, size = 0, stderrBytes = 0;
    const output: Buffer[] = [];
    const finish = (code?: number | null) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(stopTimer); if (signal) EventTarget.prototype.removeEventListener.call(signal, "abort", abort);
      if (failure) { reject(fixed(failure)); return; }
      if (aborted(signal)) { reject(fixed("BROWSER_CANCELLED")); return; }
      if (performance.now() - began >= 15000 || code !== 0 || stderrBytes || Buffer.concat(output).toString("utf8") !== READY) reject(fixed(REFUSED));
      else resolve();
    };
    const stop = (code: string) => {
      failure ??= code;
      if (stopping || done) return; stopping = true;
      if (!child) { finish(); return; }
      try { child.kill("SIGKILL"); } catch { /* Only close acknowledges the retained child. */ }
      stopTimer = setTimeout(() => {
        failure = "BROWSER_PRIVATE_DIRECTORY_STOP_UNCONFIRMED";
        child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); finish();
      }, 5000);
    };
    const abort = () => stop("BROWSER_CANCELLED");
    try {
      child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PRIVATE_DIRECTORY], {
        cwd: path.dirname(root), env: { SystemRoot: system, windir: system, PATH: path.join(system, "System32") },
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      child.once("close", finish);
      child.stdin!.on("error", () => {});
      child.stdout!.on("data", (bytes: Buffer) => { size += bytes.length; if (size > 4096) stop(REFUSED); else output.push(bytes); });
      child.stderr!.on("data", (bytes: Buffer) => { stderrBytes += bytes.length; size += bytes.length; if (size > 4096) stop(REFUSED); });
      child.once("error", () => { failure ??= REFUSED; });
      timer = setTimeout(() => stop(REFUSED), 15000);
      if (signal) EventTarget.prototype.addEventListener.call(signal, "abort", abort, { once: true });
      if (aborted(signal)) { abort(); child.stdin!.destroy(); }
      else child.stdin!.end(JSON.stringify({ operation, path: root }));
    } catch {
      if (child) { child.stdin?.destroy(); stop(aborted(signal) ? "BROWSER_CANCELLED" : REFUSED); }
      else { failure = REFUSED; finish(); }
    }
  });
}

export async function assertBrowserPrivateDirectory(requested: string, options: BrowserDirectoryOptions = {}): Promise<string> {
  const signal = normalizedSignal(options);
  if (aborted(signal)) throw fixed("BROWSER_CANCELLED");
  try {
    const root = await canonicalDirectory(requested), before = await lstat(root, { bigint: true });
    if (process.platform === "win32") await windowsDirectory(root, "verify", signal);
    else if ((before.mode & 0o7777n) !== 0o700n || before.uid !== BigInt(process.getuid!())) throw fixed(REFUSED);
    await canonicalDirectory(root);
    const after = await lstat(root, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || aborted(signal)) throw fixed(aborted(signal) ? "BROWSER_CANCELLED" : REFUSED);
    return root;
  } catch (error) {
    if (error instanceof Error && ["BROWSER_CANCELLED", "BROWSER_PRIVATE_DIRECTORY_STOP_UNCONFIRMED"].includes(error.message)) throw error;
    throw fixed(REFUSED);
  }
}

export async function createBrowserPrivateDirectory(requested: string, options: BrowserDirectoryOptions = {}): Promise<string> {
  const signal = normalizedSignal(options);
  if (aborted(signal)) throw fixed("BROWSER_CANCELLED");
  try {
    const root = await canonicalDirectory(requested, true);
    if (aborted(signal)) throw fixed("BROWSER_CANCELLED");
    if (process.platform === "win32") await windowsDirectory(root, "create", signal);
    else { await mkdir(root, { mode: 0o700 }); await chmod(root, 0o700); }
    await assertBrowserPrivateDirectory(root, { signal });
    if ((await readdir(root)).length || aborted(signal)) throw fixed(aborted(signal) ? "BROWSER_CANCELLED" : REFUSED);
    return root;
  } catch (error) {
    if (error instanceof Error && [EXISTS, "BROWSER_CANCELLED", "BROWSER_PRIVATE_DIRECTORY_STOP_UNCONFIRMED"].includes(error.message)) throw error;
    throw fixed(REFUSED);
  }
}
