$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'msi'
  silentArgs     = "/quiet /norestart"
  validExitCodes = @(0, 3010, 1641)
}

# Check system architecture and set the correct URL and checksum
$procArch = Get-ProcessorBits

if ($procArch -eq 64) {
  $packageArgs.url64bit = '{{X64_URL}}'
  $packageArgs.checksum64 = '{{X64_HASH}}'
} elseif ($procArch -eq 'arm64') {
  $packageArgs.url64bit = '{{ARM64_URL}}'
  $packageArgs.checksum64 = '{{ARM64_HASH}}'
} else {
  throw "This package does not support the $($procArch) architecture."
}

$packageArgs.checksumType64 = 'sha256'

Install-ChocolateyPackage @packageArgs
