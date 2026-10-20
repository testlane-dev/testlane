/** Shared filesystem-only fixture; never creates a keychain or provider. */
import assert from 'node:assert/strict';
import {lstat,mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runOwnedCommand} from '../supabase/tools/process.mjs';
const WINDOWS_FIXTURE = [
  "$ErrorActionPreference='Stop'",
  "try {",
  " $request=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  " $target=[string]$request.path",
  " if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { throw 'exists' }",
  " $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
  " $security=New-Object Security.AccessControl.DirectorySecurity",
  " $security.SetOwner($sid)",
  " $security.SetAccessRuleProtection($true,$false)",
  " $inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
  " $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))",
  " if ($request.unsafe -eq $true) {",
  "  $everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')",
  "  $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))",
  " }",
  " $null=[IO.Directory]::CreateDirectory($target,$security)",
  " [Console]::Out.Write('fixture-ready')",
  " exit 0",
  "} catch { [Console]::Error.Write('PRIVATE_PATH_FIXTURE_FAILED');exit 1 }",
].join('\n');
export async function fixture({ unsafe = false } = {}) {
  const temporary = await realpath(os.tmpdir()), root = await mkdtemp(path.join(temporary, 'tlp-proof-path-unit-'));
  const parent = path.join(root, 'new-parent');
  try {
  if (process.platform === 'win32') {
    const result = await runOwnedCommand(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-Command',WINDOWS_FIXTURE],
      { cwd: root, input: JSON.stringify({ path: parent, unsafe }), timeoutMs: 15000 });
    assert.equal(result.code, 0); assert.equal(result.stdout, 'fixture-ready'); assert.equal(result.stderr, '');
  } else {
    await mkdir(parent, { mode: unsafe ? 0o777 : 0o700 });
    const { chmod } = await import('node:fs/promises');
    await chmod(parent, unsafe ? 0o777 : 0o700);
  }
  } catch (error) {
    assert.equal(path.dirname(await realpath(root)), temporary); assert.match(path.basename(root), /^tlp-proof-path-unit-/);
    await rm(root, { recursive: true, force: false }); throw error;
  }
  return { root, parent, async close() {
    assert.equal(path.dirname(await realpath(root)), temporary); assert.equal((await lstat(root)).isSymbolicLink(), false);
    assert.match(path.basename(root), /^tlp-proof-path-unit-/);
    await rm(root, { recursive: true, force: false });
  } };
}
