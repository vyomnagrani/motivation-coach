#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Up', 'Provision', 'Deploy')]
    [string] $Stage = 'Up'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
& azd $Stage.ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw "azd $Stage failed (exit $LASTEXITCODE)." }
