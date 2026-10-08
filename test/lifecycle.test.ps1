#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$global:motivationTestCalls = [Collections.Generic.List[object]]::new()
$global:motivationTestValues = @{
    AZURE_ENV_NAME = 'unit-test'
    AZURE_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000001'
    AZURE_RESOURCE_GROUP = 'rg-motivation-coach-unit-test'
    AZURE_CONTAINER_APP_NAME = 'ca-motivation-coach-test'
    AZURE_CONTAINER_REGISTRY_NAME = 'acrmotivationtest'
    AZURE_CONTAINER_REGISTRY_ENDPOINT = 'acrmotivationtest.azurecr.io'
    AZURE_CONTAINER_REGISTRY_ID = '/subscriptions/test/resourceGroups/test/providers/Microsoft.ContainerRegistry/registries/acrmotivationtest'
    AZURE_CONTAINER_APP_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000002'
    AZURE_AI_PROJECT_ENDPOINT = 'https://ai-motivation-coach-test.services.ai.azure.com/api/projects/motivation-coach-project'
    FOUNDRY_VOICE_AGENT_NAME = 'motivation-coach-agent'
    FOUNDRY_VOICE_AGENT_VERSION = '2'
    WEB_URL = 'https://ca-motivation-coach-test.example'
}

function Assert-True([bool] $Value, [string] $Message) {
    if (-not $Value) { throw $Message }
}
function global:azd {
    $global:LASTEXITCODE = 0
    $global:motivationTestCalls.Add(@{ command = 'azd'; arguments = @($args) })
    if ($args[0] -eq 'env' -and $args[1] -eq 'get-values') {
        return ($global:motivationTestValues | ConvertTo-Json -Compress)
    }
    if ($args[0] -eq 'env' -and $args[1] -eq 'set') {
        $global:motivationTestValues[$args[2]] = $args[3]
        return
    }
    throw "Unexpected azd call: $args"
}
function global:az {
    $global:LASTEXITCODE = 0
    $global:motivationTestCalls.Add(@{ command = 'az'; arguments = @($args) })
    $operation = ($args | Select-Object -First 3) -join ' '
    if ($operation.StartsWith('account show')) {
        return '{"tenantId":"00000000-0000-0000-0000-000000000003"}'
    }
    if ($operation.StartsWith('account get-access-token')) {
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
            '{"oid":"00000000-0000-0000-0000-000000000004"}')).TrimEnd('=')
        return (@{ accessToken = "header.$payload.signature" } | ConvertTo-Json -Compress)
    }
    if ($operation.StartsWith('provider show')) { return 'Registered' }
    if ($operation -eq 'role assignment list') {
        return (@(@{
            principalId = $global:motivationTestValues.AZURE_CONTAINER_APP_PRINCIPAL_ID
            roleDefinitionId = '/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d'
        }) | ConvertTo-Json -Compress -AsArray)
    }
    if ($operation.StartsWith('containerapp show')) {
        if ($args -contains 'properties.template.containers[0].image') {
            return 'acrmotivationtest.azurecr.io/web:unit-test'
        }
        return 'ca-motivation-coach-test.example'
    }
    if ($operation -eq 'containerapp registry set' -or $operation.StartsWith('containerapp update')) {
        return
    }
    throw "Unexpected az call: $args"
}
function global:node {
    $global:LASTEXITCODE = 0
    $global:motivationTestCalls.Add(@{ command = 'node'; arguments = @($args) })
    if ($args[0] -eq '--version') { return 'v22.0.0' }
    if ($args[0].EndsWith('agent-version.mjs')) { return '2' }
    if ($args[0].EndsWith('remote-smoke.js')) { return 'Mock readiness succeeded.' }
    throw "Unexpected node call: $args"
}
function global:npm { throw 'Dependencies must be restored before running this test.' }
function global:Invoke-RestMethod {
    $global:motivationTestCalls.Add(@{ command = 'health'; arguments = @($args) })
    return @{ status = 'ok' }
}

foreach ($stage in @('Preprovision', 'Postprovision', 'Predeploy', 'Postdeploy')) {
    & (Join-Path $root 'scripts\lifecycle.ps1') -Stage $stage
}
Assert-True ($global:motivationTestValues.AZURE_PRINCIPAL_ID -eq '00000000-0000-0000-0000-000000000004') 'CLI principal resolution failed.'
Assert-True ($global:motivationTestValues.FOUNDRY_VOICE_AGENT_VERSION -eq '2') 'Pinned agent version was not persisted.'
Assert-True ($global:motivationTestValues.WEB_URL -eq 'https://ca-motivation-coach-test.example') 'Origin was not resolved from ingress.'
Assert-True ($global:motivationTestValues.MOTIVATION_COACH_IMAGE -eq 'acrmotivationtest.azurecr.io/web:unit-test') 'Deployed image was not saved for repeat provisioning.'
$registryCalls = @($global:motivationTestCalls | Where-Object {
    $_.command -eq 'az' -and ($_.arguments[0..2] -join ' ') -eq 'containerapp registry set'
})
Assert-True ($registryCalls.Count -eq 2) 'Registry must be configured in both setup and deploy hooks.'
foreach ($call in $registryCalls) {
    $index = [Array]::IndexOf($call.arguments, '--identity')
    Assert-True ($index -ge 0 -and $call.arguments[$index + 1] -eq 'system') 'Image pull must use system identity.'
}
$updates = @($global:motivationTestCalls | Where-Object {
    $_.command -eq 'az' -and $_.arguments[0] -eq 'containerapp' -and $_.arguments[1] -eq 'update'
})
Assert-True ($updates.Count -eq 2) 'Runtime configuration was not set in both hooks.'
foreach ($call in $updates) {
    Assert-True ($call.arguments -contains 'PUBLIC_ORIGIN=https://ca-motivation-coach-test.example') 'Public origin mismatch.'
    Assert-True ($call.arguments -contains 'FOUNDRY_VOICE_AGENT_VERSION=2') 'Agent version mismatch.'
}
$smokes = @($global:motivationTestCalls | Where-Object { $_.command -eq 'node' -and $_.arguments[0].EndsWith('remote-smoke.js') })
Assert-True ($smokes.Count -eq 1) 'Postdeploy must perform one readiness probe only.'
Assert-True ($smokes[0].arguments[1] -eq $global:motivationTestValues.WEB_URL) 'Smoke URL mismatch.'
Write-Host 'Lifecycle hooks passed with mocked CLIs; no cloud operations executed.'
