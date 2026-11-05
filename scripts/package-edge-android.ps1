param(
  [string]$BrowserPath = "",
  [string]$SigningKeyPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $repoRoot ".output\edge-mv3"
$packedCrx = Join-Path $repoRoot ".output\edge-mv3.crx"
$generatedKey = Join-Path $repoRoot ".output\edge-mv3.pem"

if ([string]::IsNullOrWhiteSpace($SigningKeyPath)) {
  $keyDirectory = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".koharu-manga-companion"
  $SigningKeyPath = Join-Path $keyDirectory "edge-android-signing-key.pem"
} else {
  $SigningKeyPath = [System.IO.Path]::GetFullPath($SigningKeyPath)
  $keyDirectory = Split-Path -Parent $SigningKeyPath
}

if ([string]::IsNullOrWhiteSpace($BrowserPath)) {
  $browserCandidates = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
  )
  $BrowserPath = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($BrowserPath) -or -not (Test-Path -LiteralPath $BrowserPath)) {
  throw "Microsoft Edge or Google Chrome was not found. Pass -BrowserPath explicitly."
}

Push-Location $repoRoot
try {
  $version = node -p "require('./package.json').version"
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
    throw "Unable to read package version."
  }

  npm run build:edge
  if ($LASTEXITCODE -ne 0) { throw "Edge extension build failed." }

  if (-not (Test-Path -LiteralPath $buildDir)) { throw "Edge build directory was not created." }
  New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null
  if (Test-Path -LiteralPath $packedCrx) { Remove-Item -LiteralPath $packedCrx -Force }

  $packArguments = @("--no-first-run", "--pack-extension=$buildDir")
  if (Test-Path -LiteralPath $SigningKeyPath) {
    $packArguments += "--pack-extension-key=$SigningKeyPath"
  } else {
    if (Test-Path -LiteralPath $generatedKey) { Remove-Item -LiteralPath $generatedKey -Force }
  }

  $process = Start-Process -FilePath $BrowserPath -ArgumentList $packArguments -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "Browser CRX packing failed with exit code $($process.ExitCode)." }
  if (-not (Test-Path -LiteralPath $packedCrx)) { throw "Browser did not produce a CRX package." }

  if (-not (Test-Path -LiteralPath $SigningKeyPath)) {
    if (-not (Test-Path -LiteralPath $generatedKey)) { throw "Browser did not produce a signing key." }
    Move-Item -LiteralPath $generatedKey -Destination $SigningKeyPath
  }

  $bytes = [System.IO.File]::ReadAllBytes($packedCrx)
  $isCrx3 = $bytes.Length -ge 12 -and
    [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq "Cr24" -and
    [BitConverter]::ToUInt32($bytes, 4) -eq 3
  if (-not $isCrx3) {
    throw "Packed file is not a valid CRX3 container."
  }

  $artifactBase = Join-Path $repoRoot ".output\koharu-manga-companion-$version-edge-android"
  $crxArtifact = "$artifactBase.crx"
  $binArtifact = "$artifactBase.bin"
  Copy-Item -LiteralPath $packedCrx -Destination $crxArtifact -Force
  Copy-Item -LiteralPath $packedCrx -Destination $binArtifact -Force
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($crxArtifact)
  try {
    $hashBytes = $sha256.ComputeHash($stream)
    $hash = ([BitConverter]::ToString($hashBytes) -replace "-", "").ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }

  Write-Output "Android Edge CRX3: $crxArtifact"
  Write-Output "Download-safe copy: $binArtifact"
  Write-Output "Signing key (keep private and reuse): $SigningKeyPath"
  Write-Output "SHA-256: $hash"
} finally {
  Pop-Location
}
