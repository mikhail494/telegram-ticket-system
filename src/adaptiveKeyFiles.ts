import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AdaptiveKeyError } from "./adaptiveKeyErrors.js";
import { randomBytes } from "node:crypto";

function windowsAccess(file: string, privateTarget: boolean, create = false): void {
  // Node does not expose NTFS DACLs. Inspect effective path ACL entries without
  // changing them; inherited-only entries do not grant access to this object.
  const script = `$ErrorActionPreference='Stop';
    $installer=([System.Security.Principal.NTAccount]'NT SERVICE\\TrustedInstaller').Translate([System.Security.Principal.SecurityIdentifier]).Value;
    $trusted=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544',$installer);
    $p=$env:ADAPTIVE_ACCESS_PATH; $first=$true;
    if($env:ADAPTIVE_ACCESS_CREATE -eq '1') {
      $secure=New-Object System.Security.AccessControl.DirectorySecurity;
      $secure.SetAccessRuleProtection($true,$false);
      $secure.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User);
      foreach($sid in $trusted[0..2]) {
        $rule=New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.SecurityIdentifier]$sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
        $secure.AddAccessRule($rule);
      };
      [void][System.IO.Directory]::CreateDirectory($p,$secure);
    };
    while($p) {
      $acl=if([System.IO.Directory]::Exists($p)){[System.IO.Directory]::GetAccessControl($p)}else{[System.IO.File]::GetAccessControl($p)};
      $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
      if($owner -notin $trusted) { throw 'owner' };
      foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
        if($r.AccessControlType -ne 'Allow' -or ($r.PropagationFlags -band 2)) { continue };
        if($r.IdentityReference.Value -in $trusted) { continue };
        # CreateDirectories alone cannot replace an existing validated component.
        # Newly created private directories still require an entirely private DACL.
        $mask=852306;
        if($first -and $env:ADAPTIVE_ACCESS_PRIVATE -eq '1') { $mask=2032127 };
        if(([int]$r.FileSystemRights -band $mask) -ne 0) { throw 'permissions' };
      };
      $first=$false; $parent=[System.IO.Directory]::GetParent($p);
      if($null -eq $parent) { break }; $p=$parent.FullName;
    }`;
  try {
    execFileSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          ADAPTIVE_ACCESS_PATH: file,
          ADAPTIVE_ACCESS_PRIVATE: privateTarget ? "1" : "0",
          ADAPTIVE_ACCESS_CREATE: create ? "1" : "0",
        },
        stdio: "ignore",
        timeout: 15000,
      }
    );
  } catch {
    throw new AdaptiveKeyError("PERMISSIONS");
  }
}

function checkAncestors(directory: string): void {
  if (process.platform === "win32") {
    windowsAccess(directory, false);
    return;
  }
  for (let current = directory; ; current = path.dirname(current)) {
    const info = fs.lstatSync(current);
    const trustedOwner = info.uid === 0 || info.uid === process.getuid?.();
    const sticky = (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || info.isSymbolicLink() || !trustedOwner || ((info.mode & 0o022) !== 0 && !sticky))
      throw new AdaptiveKeyError("DIRECTORY");
    if (path.dirname(current) === current) break;
  }
}

function canonicalTrustedDirectory(directory: string, links = new Set<string>()): string {
  const absolute = path.isAbsolute(directory) ? directory : path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    if (component === ".") continue;
    if (component === "..") {
      checkAncestors(current);
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, component);
    const info = fs.lstatSync(next);
    if (info.isSymbolicLink()) {
      // realpath alone hides intermediate target namespaces. Validate every hop
      // before following it, including nested targets outside the original path.
      checkAncestors(current);
      if (process.platform === "win32") windowsAccess(next, false);
      else if (info.uid !== 0 && info.uid !== process.getuid?.()) throw new AdaptiveKeyError("DIRECTORY");
      const identity = process.platform === "win32" ? next.toLowerCase() : next;
      if (links.has(identity) || links.size >= 40) throw new AdaptiveKeyError("DIRECTORY");
      links.add(identity);
      const target = fs.readlinkSync(next);
      current = canonicalTrustedDirectory(path.isAbsolute(target) ? target : `${current}${path.sep}${target}`, links);
      links.delete(identity);
    } else {
      if (!info.isDirectory()) throw new AdaptiveKeyError("DIRECTORY");
      current = next;
    }
  }
  checkAncestors(current);
  return fs.realpathSync(current);
}

export function secureAdaptiveKeyPath(configuredFile: string): { file: string; verify(): void; sync(): void } {
  const originalDirectory = path.dirname(path.resolve(configuredFile));
  let existing = originalDirectory;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const info = (() => {
      try {
        return fs.lstatSync(existing);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      }
    })();
    if (info?.isSymbolicLink()) throw new AdaptiveKeyError("DIRECTORY");
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const canonicalParent = canonicalTrustedDirectory(existing);
  const directory = path.join(canonicalParent, ...missing);
  if (process.platform === "win32") windowsAccess(directory, true, true);
  else fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkAncestors(directory);
  const identity = fs.lstatSync(directory);
  if (process.platform === "win32") windowsAccess(directory, true);
  else if ((identity.mode & 0o077) !== 0 || identity.uid !== process.getuid?.())
    throw new AdaptiveKeyError("PERMISSIONS");
  const verify = () => {
    const current = fs.lstatSync(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.ino !== identity.ino ||
      current.dev !== identity.dev ||
      current.uid !== identity.uid ||
      (originalDirectory === directory
        ? fs.realpathSync(originalDirectory)
        : canonicalTrustedDirectory(originalDirectory)) !== directory
    )
      throw new AdaptiveKeyError("DIRECTORY");
    if (process.platform === "win32") windowsAccess(directory, true);
    else {
      checkAncestors(directory);
      if ((current.mode & 0o077) !== 0) throw new AdaptiveKeyError("PERMISSIONS");
    }
  };
  verify();
  return {
    file: path.join(directory, path.basename(configuredFile)),
    verify,
    sync() {
      verify();
      if (process.platform === "win32") return;
      const descriptor = fs.openSync(
        directory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    },
  };
}

export function readOrRecoverPrivateAdaptiveFile(file: string): Buffer {
  finishPrivatePublication(file);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new AdaptiveKeyError("FILE");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (before.ino !== opened.ino || before.dev !== opened.dev || opened.nlink !== 1 || opened.size > 8192)
      throw new AdaptiveKeyError("FILE");
    if (process.platform !== "win32" && ((opened.mode & 0o077) !== 0 || opened.uid !== process.getuid?.()))
      throw new AdaptiveKeyError("PERMISSIONS");
    if (process.platform === "win32") windowsAccess(file, true);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(file);
    if (
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.uid !== opened.uid ||
      after.nlink !== 1 ||
      after.mode !== opened.mode ||
      after.isSymbolicLink()
    )
      throw new AdaptiveKeyError("FILE");
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function publishPrivateAdaptiveFile(file: string, bytes: Buffer): void {
  const temporary = path.join(path.dirname(file), `.key-${randomBytes(16).toString("hex")}.tmp`);
  try {
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.linkSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function finishPrivatePublication(file: string): void {
  const published = fs.lstatSync(file);
  if (!published.isFile() || published.isSymbolicLink() || published.nlink === 1) return;
  // Only complete our own interrupted publication; unrelated hard links remain invalid.
  for (const name of fs.readdirSync(path.dirname(file))) {
    if (!/^\.key-[a-f0-9]{32}\.tmp$/.test(name)) continue;
    const temporary = path.join(path.dirname(file), name);
    try {
      const info = fs.lstatSync(temporary);
      if (info.isFile() && !info.isSymbolicLink() && info.dev === published.dev && info.ino === published.ino)
        fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
