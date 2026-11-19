$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY -ne 'makessr/FineShell') {
    throw 'Run only on the disposable FineShell Windows runner.'
}

function Get-ReleaseDraft([string]$tag, [string]$commit) {
    $id = gh release view $tag -R makessr/FineShell --json databaseId --jq .databaseId
    if ($LASTEXITCODE) { throw "Could not read draft $tag." }
    $draft = gh api "repos/makessr/FineShell/releases/$id" | ConvertFrom-Json
    if ($LASTEXITCODE -or !$draft.draft -or $draft.tag_name -cne $tag -or $draft.target_commitish -cne $commit) {
        throw "Unexpected release metadata for draft $tag."
    }
    return $draft
}

function Get-VerifiedAsset($release, [string]$name, [string]$folder) {
    $asset = @($release.assets | Where-Object name -CEQ $name)
    if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:[0-9a-f]{64}$') {
        throw "Missing digest for $name."
    }
    gh release download $release.tag_name -R makessr/FineShell --pattern $name --dir $folder | Out-Host
    if ($LASTEXITCODE) { throw "Download failed for $name." }
    $path = Join-Path $folder $name
    if ((Get-FileHash -LiteralPath $path).Hash -ne $asset[0].digest.Substring(7)) {
        throw "SHA-256 mismatch for $name."
    }
    return $path
}

$oldCommit = '268722fe7800fcfca84ce972111b1f139cfbb304'
$newCommit = 'e2e1b9051ce20159d807ea199764f61a8a9f8b1e'
$oldDraft = Get-ReleaseDraft 'v0.6.1' $oldCommit
$testDraft = Get-ReleaseDraft 'v0.6.2-ota-fixture-20261120' $oldCommit
$bridgeName = 'FineShell_0.6.1_windows_x64-setup.exe'
$targetName = 'FineShell_0.6.2_windows_x64-setup.exe'
$bridge = Get-VerifiedAsset $oldDraft $bridgeName $env:RUNNER_TEMP
$bridgeSig = Get-VerifiedAsset $oldDraft "$bridgeName.sig" $env:RUNNER_TEMP
$target = Get-VerifiedAsset $testDraft $targetName $env:RUNNER_TEMP
$targetSig = Get-VerifiedAsset $testDraft "$targetName.sig" $env:RUNNER_TEMP
$metadataPath = Get-VerifiedAsset $testDraft 'zhandu-draft-source.json' $env:RUNNER_TEMP
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ($metadata.repository -cne 'makessr/ZhanDu' -or $metadata.version -cne 'v0.6.2' -or
    $metadata.commit -cne $newCommit -or (Get-FileHash -LiteralPath $target).Hash -ne $metadata.installerSha256 -or
    (Get-FileHash -LiteralPath $targetSig).Hash -ne $metadata.signatureSha256) {
    throw 'Staged files differ from the original ZhanDu draft.'
}

$baseline = Join-Path $env:RUNNER_TEMP 'FineShell-v0.6.0.exe'
curl.exe --silent --show-error --fail --location --retry 3 --output $baseline 'https://github.com/makessr/FineShell/releases/download/v0.6.0/FineShell_0.6.0_windows_x64-setup.exe'
if ($LASTEXITCODE -or (Get-FileHash -LiteralPath $baseline).Hash -ne 'D777321CD568C07036E19492DD5AEC5B10EFA7F45B298BFE076D961DBC2424F1') {
    throw 'The baseline installer does not match the published asset.'
}
npm install --prefix "$env:RUNNER_TEMP/fixture" --ignore-scripts --no-audit --no-fund ssh2@1.17.0
if ($LASTEXITCODE) { throw 'Could not install the loopback SSH fixture.' }

$tls = Join-Path $env:RUNNER_TEMP 'ota-tls'
New-Item -ItemType Directory -Path $tls | Out-Null
$openssl = Join-Path $env:ProgramFiles 'Git/usr/bin/openssl.exe'
$rootKey = Join-Path $tls 'root.key'
$rootPem = Join-Path $tls 'root.pem'
$rootCer = Join-Path $tls 'root.cer'
$leafKey = Join-Path $tls 'localhost.key'
$leafCsr = Join-Path $tls 'localhost.csr'
$leafPem = Join-Path $tls 'localhost.pem'
$extensions = Join-Path $tls 'server.ext'
@'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1
'@ | Set-Content -LiteralPath $extensions -Encoding ascii
& $openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=ZhanDu OTA Test Root' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -keyout $rootKey -out $rootPem
if ($LASTEXITCODE) { throw 'Could not create the loopback test CA.' }
& $openssl x509 -in $rootPem -outform DER -out $rootCer
if ($LASTEXITCODE) { throw 'Could not encode the test CA.' }
& $openssl req -new -newkey rsa:2048 -nodes -subj '/CN=127.0.0.1' -keyout $leafKey -out $leafCsr
if ($LASTEXITCODE) { throw 'Could not create the loopback certificate request.' }
& $openssl x509 -req -in $leafCsr -CA $rootPem -CAkey $rootKey -CAcreateserial -days 1 -sha256 -extfile $extensions -out $leafPem
if ($LASTEXITCODE) { throw 'Could not sign the loopback certificate.' }
$root = Import-Certificate -FilePath $rootCer -CertStoreLocation Cert:/LocalMachine/Root
try {
    $env:FINESHELL_OTA_MIRROR_FIXTURE = Join-Path $tls 'fixture.json'
    @{
        certificate = $leafPem
        key = $leafKey
        stages = @(
            @{ repository = 'makessr/FineShell'; version = '0.6.1'; installer = $bridge; signature = $bridgeSig }
            @{ repository = 'makessr/ZhanDu'; version = '0.6.2'; installer = $target; signature = $targetSig }
        )
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:FINESHELL_OTA_MIRROR_FIXTURE -Encoding utf8
    $fixture = Join-Path $env:RUNNER_TEMP 'fixture/node_modules/ssh2/lib/index.js'
    & "$PSScriptRoot/ota.ps1" -VerifiedInstaller $baseline -Baseline 0.6.0 -Target 0.6.2 -Ssh2Module $fixture -UseHostedRunnerWebView2Policy
} finally {
    Remove-Item -LiteralPath "Cert:/LocalMachine/Root/$($root.Thumbprint)"
}
