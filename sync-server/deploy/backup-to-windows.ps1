param(
    [Parameter(Mandatory)][string]$SshTarget,
    [Parameter(Mandatory)][string]$KnownHosts,
    [Parameter(Mandatory)][string]$Destination,
    [string]$NodePath,
    [ValidateRange(2, 365)][int]$RetentionDays = 30,
    [switch]$RestoreDrill
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser

$script = @'
set -eu
umask 077
tmp=$(mktemp -d)
trap 'rm -f "$tmp/vault.sqlite" "$tmp/vault.sqlite-wal" "$tmp/vault.sqlite-shm"; rmdir "$tmp"' EXIT
/opt/fineshell-sync/node/bin/node --input-type=module -e '
import { backup, DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/var/lib/fineshell-sync/vault.sqlite", {readOnly:true});
await backup(db, process.argv[1]);
db.close();
const snapshot = new DatabaseSync(process.argv[1]);
snapshot.exec("PRAGMA journal_mode=DELETE");
snapshot.close();
' "$tmp/vault.sqlite"
cat "$tmp/vault.sqlite"
'@
$ssh = [Diagnostics.ProcessStartInfo]::new((Get-Command ssh.exe).Source)
$ssh.UseShellExecute = $false
$ssh.RedirectStandardOutput = $true
$ssh.CreateNoWindow = $true
@('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$KnownHosts",
    '-o','ConnectTimeout=10','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3',
    $SshTarget,($script -replace "\r",'')) | ForEach-Object { $ssh.ArgumentList.Add($_) }

$guard = [Threading.Mutex]::new($false, 'Local\FineShellSyncDatabaseBackup')
$acquired = $false
$payload = $null
try {
    $acquired = $guard.WaitOne(0)
    if (!$acquired) { exit 0 }
    $stream = [IO.MemoryStream]::new()
    $proc = [Diagnostics.Process]::Start($ssh)
    try {
        $proc.StandardOutput.BaseStream.CopyTo($stream)
        $proc.WaitForExit()
        if ($proc.ExitCode -ne 0) { throw "SSH backup failed (exit $($proc.ExitCode))" }
        $payload = $stream.ToArray()
    } finally {
        $proc.Dispose()
        [Array]::Clear($stream.GetBuffer(), 0, [int]$stream.Length)
        $stream.Dispose()
    }
    $header = [Text.Encoding]::ASCII.GetString($payload, 0, [Math]::Min(16,$payload.Length))
    if (!$header.StartsWith('SQLite format 3')) { throw 'Invalid SQLite snapshot header' }
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    $file = Join-Path $Destination ("vault-" + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ') + '.sqlite.dpapi')
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($payload, $null, $scope)
    [IO.File]::WriteAllBytes("$file.partial", $encrypted)
    [IO.File]::Move("$file.partial", $file)
    if ($RestoreDrill) {
        $node = if ($NodePath) { $NodePath } else { (Get-Command node.exe).Source }
        $restored = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file), $null, $scope)
        try {
            $check = @'
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const restored = new DatabaseSync(":memory:");
restored.deserialize(fs.readFileSync(0));
const result = restored.prepare("PRAGMA integrity_check").all();
if (result.length !== 1 || result[0].integrity_check !== "ok") process.exit(1);
restored.prepare("SELECT id, revision, vault FROM accounts LIMIT 1").get();
restored.prepare("SELECT account_id FROM sessions LIMIT 1").get();
console.log("SQLite restore drill passed in memory");
'@
            $checkInfo = [Diagnostics.ProcessStartInfo]::new($node)
            $checkInfo.UseShellExecute = $false
            $checkInfo.RedirectStandardInput = $true
            $checkInfo.CreateNoWindow = $true
            $checkInfo.ArgumentList.Add('-e')
            $checkInfo.ArgumentList.Add($check)
            $checkProc = [Diagnostics.Process]::Start($checkInfo)
            try {
                $checkProc.StandardInput.BaseStream.Write($restored, 0, $restored.Length)
                $checkProc.StandardInput.Close()
                $checkProc.WaitForExit()
                if ($checkProc.ExitCode -ne 0) { throw 'SQLite restore drill failed' }
            } finally { $checkProc.Dispose() }
        } finally { [Array]::Clear($restored, 0, $restored.Length) }
    }
    $cutoff = [DateTime]::UtcNow.AddDays(-$RetentionDays)
    Get-ChildItem -LiteralPath $Destination -Filter 'vault-*.sqlite.dpapi' -File |
        Where-Object LastWriteTimeUtc -lt $cutoff |
        Remove-Item -ErrorAction Continue
    Write-Output $file
} finally {
    if ($payload) { [Array]::Clear($payload, 0, $payload.Length) }
    if ($acquired) { $guard.ReleaseMutex() }
    $guard.Dispose()
}
