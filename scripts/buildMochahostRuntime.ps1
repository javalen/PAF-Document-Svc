$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$target = Join-Path $repositoryRoot "mochahost-runtime"

if (Test-Path -LiteralPath $target) {
  $resolvedTarget = (Resolve-Path -LiteralPath $target).Path
  if ((Split-Path -Parent $resolvedTarget) -ne $repositoryRoot) {
    throw "Refusing to replace a runtime directory outside the repository."
  }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}

New-Item -ItemType Directory -Path $target | Out-Null
Copy-Item -LiteralPath (Join-Path $repositoryRoot "package.json") -Destination $target
Copy-Item -LiteralPath (Join-Path $repositoryRoot "package-lock.json") -Destination $target
Copy-Item -LiteralPath (Join-Path $repositoryRoot "server.js") -Destination $target
Copy-Item -LiteralPath (Join-Path $repositoryRoot "lib") -Destination $target -Recurse

Write-Host "PAF-Document-Svc MochaHost runtime created at $target"
