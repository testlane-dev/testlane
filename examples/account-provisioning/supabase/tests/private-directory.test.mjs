/** Filesystem permission evidence only; this does not start provider services. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {chmod,lstat,mkdtemp,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPrivateRuntimeDirectory,assertPrivateRuntimeDirectory} from '../tools/private-directory.mjs';
import {runOwnedCommand} from '../tools/process.mjs';

async function fixture(){
  const parent=await realpath(os.tmpdir()),root=await mkdtemp(path.join(parent,'tld-supa-acl-unit-'));
  return {root,async close(){assert.equal(path.dirname(await realpath(root)),parent);assert.match(path.basename(root),/^tld-supa-acl-unit-/);await rm(root,{recursive:true,force:false});}};
}
const POWERSHELL_FIXTURE=String.raw`
$ErrorActionPreference='Stop'
try {
 $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $target=[string]$request.path
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 if ($request.operation -eq 'inspect') {
  $directory=New-Object IO.DirectoryInfo($target)
  $actual=$directory.GetAccessControl()
  $rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  $file=New-Object IO.FileInfo([IO.Path]::Combine($target,'canary.txt'))
  $fileRules=@($file.GetAccessControl().GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  $rootOnly=($rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and -not $rules[0].IsInherited)
  $fileOnly=($fileRules.Count -eq 1 -and $fileRules[0].IdentityReference.Value -eq $sid.Value -and $fileRules[0].IsInherited)
  [Console]::Out.Write(($actual.AreAccessRulesProtected -and $rootOnly -and $fileOnly).ToString().ToLowerInvariant())
 } else {
  if ($request.operation -notin @('read-parent','unsafe-parent','tamper','new-private-parent')) { throw 'refused' }
  $security=New-Object Security.AccessControl.DirectorySecurity
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true,$false)
  $inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))
  if ($request.operation -eq 'new-private-parent') {
   if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { throw 'refused' }
   $null=[IO.Directory]::CreateDirectory($target,$security)
  } else {
   $directory=New-Object IO.DirectoryInfo($target)
   $everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
   $rights=[Security.AccessControl.FileSystemRights]::ReadAndExecute
   if ($request.operation -eq 'unsafe-parent') { $rights=[Security.AccessControl.FileSystemRights]::FullControl }
   $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone,$rights,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))
   $directory.SetAccessControl($security)
  }
  [Console]::Out.Write('fixture-ready')
 }
 exit 0
} catch { [Console]::Error.Write('FIXTURE_SECURITY_FAILED');exit 1 }
`;
async function windowsFixture(root,target,operation){
  assert.ok(target.startsWith(root+path.sep));assert.equal(await realpath(operation==='new-private-parent'?path.dirname(target):target),operation==='new-private-parent'?path.dirname(target):target);
  const executable=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result=await runOwnedCommand(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',POWERSHELL_FIXTURE],
    {cwd:root,input:JSON.stringify({path:target,operation}),timeoutMs:15000});
  assert.equal(result.code,0);assert.equal(result.stderr,'');return result.stdout;
}

test('pre-abort and existing-directory refusal happen without allocating or changing existing content',async()=>{
  const f=await fixture();try{
    const absent=path.join(f.root,'absent'),controller=new AbortController();controller.abort();
    await assert.rejects(createPrivateRuntimeDirectory(absent,{signal:controller.signal}),{code:'SUPABASE_CANCELLED'});
    await assert.rejects(lstat(absent),{code:'ENOENT'});
    const existing=path.join(f.root,'existing');await mkdir(existing);await writeFile(path.join(existing,'keep'),'preserved');
    await assert.rejects(createPrivateRuntimeDirectory(existing),{code:'SUPABASE_PRIVATE_DIRECTORY_EXISTS'});
    assert.equal(await readFile(path.join(existing,'keep'),'utf8'),'preserved');
  }finally{await f.close();}
});

test('an explicit fresh private-parent fixture permits guarded children without relaxing unsafe-parent policy',async()=>{
  const f=await fixture();try{
    const parent=path.join(f.root,'new-private-parent');
    if(process.platform==='win32')assert.equal(await windowsFixture(f.root,parent,'new-private-parent'),'fixture-ready');
    else await mkdir(parent,{mode:0o700});
    const child=path.join(parent,'guarded-runtime');assert.equal(await createPrivateRuntimeDirectory(child),child);
    assert.equal(await assertPrivateRuntimeDirectory(child),child);
  }finally{await f.close();}
});

test('canonical new directory validation refuses redirected parents without touching their target',async()=>{
  const f=await fixture();try{
    const actual=path.join(f.root,'actual'),alias=path.join(f.root,'alias');await mkdir(actual);
    await symlink(actual,alias,process.platform==='win32'?'junction':'dir');
    await assert.rejects(createPrivateRuntimeDirectory(path.join(alias,'child')),{code:'SUPABASE_PRIVATE_DIRECTORY_REFUSED'});
    await assert.rejects(lstat(path.join(actual,'child')),{code:'ENOENT'});
  }finally{await f.close();}
});

test('actual platform permissions prevent inherited public reads and detect later permission widening',async()=>{
  const f=await fixture();try{
    const parent=path.join(f.root,'parent');await mkdir(parent);
    if(process.platform==='win32')assert.equal(await windowsFixture(f.root,parent,'read-parent'),'fixture-ready');
    else await chmod(parent,0o755);
    // Quotes, dollar signs and shell punctuation are only a literal stdin path.
    const child=path.join(parent,"owned '$() ; child");
    assert.equal(await createPrivateRuntimeDirectory(child),child);
    const canary=randomBytes(24).toString('hex');await writeFile(path.join(child,'canary.txt'),canary,{flag:'wx',mode:0o600});
    assert.equal(await assertPrivateRuntimeDirectory(child),child);
    if(process.platform==='win32'){
      assert.equal(await windowsFixture(f.root,child,'inspect'),'true');
      assert.equal(await windowsFixture(f.root,child,'tamper'),'fixture-ready');
    }else{
      assert.equal((await lstat(child)).mode&0o7777,0o700);assert.equal((await lstat(child)).uid,process.getuid());
      assert.equal((await lstat(path.join(child,'canary.txt'))).mode&0o777,0o600);await chmod(child,0o750);
    }
    await assert.rejects(assertPrivateRuntimeDirectory(child),{code:'SUPABASE_PRIVATE_DIRECTORY_REFUSED'});
    assert.equal(await readFile(path.join(child,'canary.txt'),'utf8'),canary);
  }finally{await f.close();}
});

test('unsafe immediate parent is refused before creation; POSIX sticky system/current-user parents retain owned-child safety',async()=>{
  const f=await fixture();try{
    const parent=path.join(f.root,'unsafe-parent');await mkdir(parent);
    if(process.platform==='win32')assert.equal(await windowsFixture(f.root,parent,'unsafe-parent'),'fixture-ready');else await chmod(parent,0o777);
    const child=path.join(parent,'child');
    await assert.rejects(createPrivateRuntimeDirectory(child),{code:'SUPABASE_PRIVATE_DIRECTORY_REFUSED'});
    await assert.rejects(lstat(child),{code:'ENOENT'});
    if(process.platform!=='win32'){
      await chmod(parent,0o1777);assert.equal(await createPrivateRuntimeDirectory(child),child);assert.equal((await lstat(child)).mode&0o7777,0o700);
    }
  }finally{await f.close();}
});
