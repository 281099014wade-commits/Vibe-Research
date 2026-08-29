$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $root "orchestrator\src\init.ts") @args
exit $LASTEXITCODE
