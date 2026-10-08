#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Preprovision', 'Postprovision', 'Predeploy', 'Postdeploy')]
    [string] $Stage
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Invoke-Checked {
    param([string] $Command, [string[]] $Arguments)
    $result = & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)." }
    return $result
}
function Read-Environment {
    $values = (Invoke-Checked azd @('env', 'get-values', '-o', 'json')) | ConvertFrom-Json
    foreach ($property in $values.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
    }
}
function Require-Value([string] $Name) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if (-not $value) { throw "Missing $Name; run azd provision first." }
    return $value
}
function Ensure-Dependencies {
    $modules = Join-Path $root 'src\web\node_modules\@azure\ai-projects\package.json'
    if (-not (Test-Path $modules)) {
        Invoke-Checked npm @('ci', '--prefix', (Join-Path $root 'src\web'), '--ignore-scripts', '--no-audit') | Out-Host
    }
}

Set-Location $root
if ($Stage -eq 'Preprovision') {
    $nodeVersion = Invoke-Checked node @('--version')
    if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22 or newer is required.' }
    Read-Environment
    $environmentName = Require-Value 'AZURE_ENV_NAME'
    if ($environmentName -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') {
        throw 'Use an azd environment name with 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.'
    }
    $subscription = Require-Value 'AZURE_SUBSCRIPTION_ID'
    $account = (Invoke-Checked az @('account', 'show', '--subscription', $subscription, '-o', 'json')) | ConvertFrom-Json
    $tokenInfo = (Invoke-Checked az @('account', 'get-access-token', '--subscription', $subscription,
        '--resource', 'https://management.azure.com/', '-o', 'json')) | ConvertFrom-Json
    $claims = $tokenInfo.accessToken.Split('.')[1].Replace('-', '+').Replace('_', '/')
    $claims = $claims.PadRight($claims.Length + ((4 - $claims.Length % 4) % 4), '=')
    $principal = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($claims)) | ConvertFrom-Json).oid
    if (-not $principal) { throw 'Cannot resolve the Azure CLI principal. Sign in with az login.' }
    Invoke-Checked azd @('env', 'set', 'AZURE_PRINCIPAL_ID', $principal) | Out-Host
    Invoke-Checked azd @('env', 'set', 'AZURE_TENANT_ID', $account.tenantId) | Out-Host
    foreach ($entry in @{ FOUNDRY_LOCATION = 'eastus' }.GetEnumerator()) {
        if (-not [Environment]::GetEnvironmentVariable($entry.Key)) {
            Invoke-Checked azd @('env', 'set', $entry.Key, $entry.Value) | Out-Host
        }
    }
    foreach ($provider in @('Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.CognitiveServices',
        'Microsoft.ManagedIdentity', 'Microsoft.OperationalInsights')) {
        $registration = Invoke-Checked az @('provider', 'show', '--namespace', $provider,
            '--subscription', $subscription, '--query', 'registrationState', '-o', 'tsv')
        if ($registration -ne 'Registered') {
            Write-Host "Registering $provider."
            Invoke-Checked az @('provider', 'register', '--namespace', $provider,
                '--subscription', $subscription, '--wait', '--only-show-errors') | Out-Host
        }
    }
    return
}

Read-Environment
$subscription = Require-Value 'AZURE_SUBSCRIPTION_ID'
$resourceGroup = Require-Value 'AZURE_RESOURCE_GROUP'
$app = Require-Value 'AZURE_CONTAINER_APP_NAME'
if ($Stage -eq 'Postprovision') {
    Ensure-Dependencies
    $version = (Invoke-Checked node @((Join-Path $PSScriptRoot 'agent-version.mjs')) | Select-Object -Last 1).Trim()
    if ($version -notmatch '^[1-9]\d*$') { throw 'Agent version setup returned an invalid version.' }
    Invoke-Checked azd @('env', 'set', 'FOUNDRY_VOICE_AGENT_VERSION', $version) | Out-Host
    $env:FOUNDRY_VOICE_AGENT_VERSION = $version
}
if ($Stage -in @('Postprovision', 'Predeploy')) {
    $version = Require-Value 'FOUNDRY_VOICE_AGENT_VERSION'
    if ($version -notmatch '^[1-9]\d*$') { throw 'FOUNDRY_VOICE_AGENT_VERSION must be a positive integer.' }
    $registry = Require-Value 'AZURE_CONTAINER_REGISTRY_NAME'
    $registryEndpoint = Require-Value 'AZURE_CONTAINER_REGISTRY_ENDPOINT'
    $registryId = Require-Value 'AZURE_CONTAINER_REGISTRY_ID'
    $registryPrincipal = Require-Value 'AZURE_CONTAINER_APP_PRINCIPAL_ID'
    $visible = $false
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $roles = (Invoke-Checked az @('role', 'assignment', 'list', '--scope', $registryId,
            '--subscription', $subscription, '-o', 'json')) | ConvertFrom-Json
        $visible = [bool]($roles | Where-Object {
            $_.principalId -eq $registryPrincipal -and
            $_.roleDefinitionId.EndsWith('/7f951dda-4ed3-4680-a7ca-43fe172d538d')
        })
        if ($visible) { break }
        Write-Host 'Waiting for the app registry-pull role to be visible...'
        Start-Sleep -Seconds 30
    }
    if (-not $visible) { throw 'App AcrPull role is not visible. Retry azd deploy after RBAC propagation.' }
    Invoke-Checked az @('containerapp', 'registry', 'set', '--name', $app,
        '--resource-group', $resourceGroup, '--subscription', $subscription,
        '--server', $registryEndpoint, '--identity', 'system', '--only-show-errors', '-o', 'none') | Out-Host
    $fqdn = Invoke-Checked az @('containerapp', 'show', '--name', $app,
        '--resource-group', $resourceGroup, '--subscription', $subscription,
        '--query', 'properties.configuration.ingress.fqdn', '-o', 'tsv')
    if (-not $fqdn) { throw 'App has no ingress FQDN.' }
    $url = "https://$fqdn"
    Invoke-Checked az @('containerapp', 'update', '--name', $app, '--resource-group', $resourceGroup,
        '--subscription', $subscription, '--set-env-vars', "PUBLIC_ORIGIN=$url",
        "FOUNDRY_VOICE_AGENT_VERSION=$version", '--only-show-errors', '-o', 'none') | Out-Host
    Invoke-Checked azd @('env', 'set', 'WEB_URL', $url) | Out-Host
    Write-Host "Prepared $app with pinned agent version $version using registry $registry."
}
if ($Stage -eq 'Postdeploy') {
    Ensure-Dependencies
    $image = Invoke-Checked az @('containerapp', 'show', '--name', $app,
        '--resource-group', $resourceGroup, '--subscription', $subscription,
        '--query', 'properties.template.containers[0].image', '-o', 'tsv')
    $registryEndpoint = Require-Value 'AZURE_CONTAINER_REGISTRY_ENDPOINT'
    if (-not $image.StartsWith("$registryEndpoint/")) { throw 'Deployed image is not from the provisioned registry.' }
    Invoke-Checked azd @('env', 'set', 'MOTIVATION_COACH_IMAGE', $image) | Out-Host
    $url = Require-Value 'WEB_URL'
    $healthy = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        try {
            $response = Invoke-RestMethod "$url/healthz" -TimeoutSec 10
            if ($response.status -eq 'ok') { $healthy = $true; break }
        } catch [Microsoft.PowerShell.Commands.HttpResponseException] {
            if ([int]$_.Exception.Response.StatusCode -notin @(404, 502, 503, 504)) { throw }
            Write-Host 'Waiting for HTTPS app startup...'
        } catch [System.Net.Http.HttpRequestException] {
            Write-Host 'Waiting for HTTPS app startup...'
        } catch [System.Threading.Tasks.TaskCanceledException] {
            Write-Host 'App health request timed out; waiting for startup...'
        }
        Start-Sleep -Seconds 10
    }
    if (-not $healthy) { throw 'App did not become healthy; inspect Container Apps logs.' }
    Invoke-Checked node @((Join-Path $root 'src\web\scripts\remote-smoke.js'), $url) | Out-Host
    Write-Host "Motivation Coach: $url"
}
