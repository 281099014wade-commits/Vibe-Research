$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $root "orchestrator\src\doctor.ts") @args
exit $LASTEXITCODE
