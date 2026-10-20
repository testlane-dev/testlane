/** New runtime directories only; no secret input and no inherited Windows DACL. */
import {chmod,lstat,mkdir,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {runOwnedCommand} from './process.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const READY='SUPABASE_PRIVATE_DIRECTORY_READY';
// Fixed code only. The path and fixed operation are JSON on stdin, never script
// interpolation. Windows PowerShell 5.1 supplies the .NET Framework overload
// that creates a directory with its initial security descriptor in one call.
const WINDOWS_PRIVATE_DIRECTORY=String.raw`
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
  [Console]::Out.Write('SUPABASE_PRIVATE_DIRECTORY_READY')
  exit 0
} catch {
  [Console]::Error.Write('SUPABASE_PRIVATE_DIRECTORY_REFUSED')
  exit 1
}`;

async function canonicalDirectory(requested,{newRoot=false}={}) {
  if(typeof requested!=='string'||!path.isAbsolute(requested)||/[\r\n\0]/.test(requested))throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');
  const root=path.resolve(requested),parent=path.dirname(root);
  if(root===parent||process.platform==='win32'&&(!/^[A-Za-z]:\\/.test(root)||root.slice(3).split('\\').some(part=>/[. ]$/.test(part)||/[<>:"|?*]/.test(part))))throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');
  if(!same(await realpath(parent),parent)||(await lstat(parent)).isSymbolicLink())throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');
  if(process.platform!=='win32'){
    const parentInfo=await lstat(parent),uid=process.getuid();
    if(!parentInfo.isDirectory()||parentInfo.mode&0o022&&(!(parentInfo.mode&0o1000)||![0,uid].includes(parentInfo.uid)))throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');
  }
  const info=await lstat(root).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(newRoot){if(info)throw fail('SUPABASE_PRIVATE_DIRECTORY_EXISTS');}
  else if(!info?.isDirectory()||info.isSymbolicLink()||!same(await realpath(root),root))throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');
  return root;
}

async function windowsDirectory(root,operation,signal) {
  const windows=process.env.SystemRoot;
  if(typeof windows!=='string'||!path.isAbsolute(windows))throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');
  const executable=path.join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const env={...process.env,DEBUG:'',NODE_DEBUG:''};delete env.NODE_OPTIONS;
  let result;
  try{result=await runOwnedCommand(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',WINDOWS_PRIVATE_DIRECTORY],
    {cwd:path.dirname(root),env,input:JSON.stringify({operation,path:root}),timeoutMs:15000,signal});}
  catch{throw fail(signal?.aborted?'SUPABASE_CANCELLED':'SUPABASE_PRIVATE_DIRECTORY_REFUSED');}
  if(result.code!==0||result.stdout!==READY||result.stderr!=='')throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');
}

export async function assertPrivateRuntimeDirectory(requested,{signal}={}) {
  if(signal?.aborted)throw fail('SUPABASE_CANCELLED');
  let root;
  try{
    root=await canonicalDirectory(requested);
    if(process.platform==='win32')await windowsDirectory(root,'verify',signal);
    else {const info=await lstat(root);if((info.mode&0o7777)!==0o700||info.uid!==process.getuid())throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');}
  }catch(error){if(error.code==='SUPABASE_CANCELLED')throw error;throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');}
  return root;
}

export async function createPrivateRuntimeDirectory(requested,{signal}={}) {
  if(signal?.aborted)throw fail('SUPABASE_CANCELLED');
  let root;
  try{
    root=await canonicalDirectory(requested,{newRoot:true});
    if(signal?.aborted)throw fail('SUPABASE_CANCELLED');
    if(process.platform==='win32')await windowsDirectory(root,'create',signal);
    else {await mkdir(root,{mode:0o700});await chmod(root,0o700);}
    await assertPrivateRuntimeDirectory(root,{signal});
    if((await readdir(root)).length!==0)throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');
  }catch(error){if(['SUPABASE_CANCELLED','SUPABASE_PRIVATE_DIRECTORY_EXISTS'].includes(error.code))throw error;throw fail('SUPABASE_PRIVATE_DIRECTORY_REFUSED');}
  return root;
}
