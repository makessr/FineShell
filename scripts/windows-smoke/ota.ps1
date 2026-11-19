[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$VerifiedInstaller,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Baseline,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Target,
    [string]$Node = 'node.exe'
)

$ErrorActionPreference = 'Stop'
if ([version]$Baseline -ge [version]$Target) { throw 'The target must be newer than the baseline.' }

$uninstallRoots = @(
    'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall'
    'HKLM:/Software/Microsoft/Windows/CurrentVersion/Uninstall'
    'HKLM:/Software/WOW6432Node/Microsoft/Windows/CurrentVersion/Uninstall'
)
if ((Get-Process -Name fineshell -ErrorAction SilentlyContinue) -or
    (Get-ChildItem -Path $uninstallRoots -ErrorAction SilentlyContinue |
        Get-ItemProperty | Where-Object DisplayName -Match '^FineShell(\s|$)')) {
    throw 'Use a Windows test user or VM with no existing FineShell installation or process.'
}

$installer = (Resolve-Path -LiteralPath $VerifiedInstaller).Path
$workspace = Join-Path ([IO.Path]::GetTempPath()) ('fineshell-ota-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $workspace 'App'
$binary = Join-Path $install 'fineshell.exe'
New-Item -ItemType Directory -Path $workspace | Out-Null

function Get-TestProcess {
    Get-Process -Name fineshell -ErrorAction SilentlyContinue | Where-Object Path -EQ $binary
}
function Get-TestVersion {
    if (Test-Path -LiteralPath $binary) { (Get-Item -LiteralPath $binary).VersionInfo.ProductVersion }
}
function Close-TestProcess {
    foreach ($app in @(Get-TestProcess)) {
        if (!$app.CloseMainWindow() -or !$app.WaitForExit(3500)) {
            Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
        }
    }
}
function Start-TestApp {
    Start-Process -FilePath $binary -WorkingDirectory $install -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $workspace 'app-stderr.log')
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$oldProfile = $env:WEBVIEW2_USER_DATA_FOLDER
$oldFlags = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $workspace 'WebView2'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
$marker = [guid]::NewGuid().ToString('N')

try {
    $setup = Start-Process -FilePath $installer -ArgumentList '/S', "/D=$install" -WindowStyle Hidden -Wait -PassThru
    if ($setup.ExitCode -ne 0 -or (Get-TestVersion) -ne $Baseline) { throw 'The baseline installation failed.' }
    $app = Start-TestApp
    Write-Host "FineShell PID: $($app.Id), runner session: $((Get-Process -Id $PID).SessionId), interactive: $([Environment]::UserInteractive)"
    & $Node (Join-Path $PSScriptRoot 'ota.mjs') update $port $Baseline $Target $marker
    if ($LASTEXITCODE) {
        $app.Refresh()
        if ($app.HasExited) {
            Write-Host ('FineShell exited with 0x{0:X8}.' -f $app.ExitCode)
        } else {
            Write-Host 'FineShell is still running.'
        }
        Get-Content -LiteralPath (Join-Path $workspace 'app-stderr.log') -Tail 30 | Write-Host
        Write-Host "FineShell window: $($app.MainWindowHandle), isolated WebView2 profile: $(Test-Path -LiteralPath $env:WEBVIEW2_USER_DATA_FOLDER)"
        Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
            Select-Object ProcessId,ParentProcessId,@{Name='UsesTestProfile';Expression={$_.CommandLine.Contains($workspace)}},@{Name='HasDebugPort';Expression={$_.CommandLine.Contains("--remote-debugging-port=$port")}} |
            Format-Table | Out-Host
        throw 'Could not activate the built-in updater.'
    }

    $deadline = [DateTime]::UtcNow.AddMinutes(4)
    do {
        $installed = Get-TestVersion
        if ($installed -eq $Target) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($installed -ne $Target) { throw "The test binary still reports version $installed." }

    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        try { $endpoint = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 1 } catch { }
        if ($endpoint) { break }
        Start-Sleep -Milliseconds 350
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$endpoint) {
        Close-TestProcess
        Start-TestApp | Out-Null
    }
    & $Node (Join-Path $PSScriptRoot 'ota.mjs') verify $port $Baseline $Target $marker
    if ($LASTEXITCODE) { throw 'The upgraded application failed runtime verification.' }
} finally {
    Close-TestProcess
    $uninstaller = Join-Path $install 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $clean = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
        if ($clean.ExitCode -ne 0) { Write-Warning "The test uninstaller returned $($clean.ExitCode)." }
    }
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldProfile
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldFlags
    Write-Output "Test workspace: $workspace"
}
