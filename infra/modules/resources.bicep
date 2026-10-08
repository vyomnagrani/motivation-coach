targetScope = 'resourceGroup'

param name string
param location string = resourceGroup().location
param tags object = {}
param suffix string
param foundryLocation string
param principalId string
param contentSourceUrl string = ''
param containerImage string
param agentVersion string
param publicOrigin string = ''

var projectName = 'motivation-coach-project'
var agentName = 'motivation-coach-agent'
var identityResourceId = resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'id-${name}')
var foundryUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var foundryName = 'ai-${name}'
var projectEndpoint = 'https://${foundryName}.services.ai.azure.com/api/projects/${projectName}'

module logs 'br/public:avm/res/operational-insights/workspace:0.11.0' = {
  name: 'logs-${suffix}'
  params: {
    name: 'log-${name}'
    location: location
    tags: tags
    skuName: 'PerGB2018'
    dataRetention: 30
  }
}

module registry 'br/public:avm/res/container-registry/registry:0.13.1' = {
  name: 'registry-${suffix}'
  params: {
    name: 'acrmotivation${suffix}'
    location: location
    tags: tags
    acrSku: 'Basic'
    acrAdminUserEnabled: false
    azureADAuthenticationAsArmPolicyStatus: 'enabled'
    roleAssignmentMode: 'LegacyRegistryPermissions'
    publicNetworkAccess: 'Enabled'
  }
}

module runtimeIdentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.4.0' = {
  name: 'identity-${suffix}'
  params: {
    name: 'id-${name}'
    location: location
    tags: tags
  }
}

module environment 'br/public:avm/res/app/managed-environment:0.16.0' = {
  name: 'cae-${name}'
  params: {
    name: 'cae-${name}'
    location: location
    tags: tags
    publicNetworkAccess: 'Enabled'
    zoneRedundant: false
    internal: false
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsWorkspaceResourceId: logs.outputs.resourceId
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

module foundry 'br/public:avm/res/cognitive-services/account:0.19.1' = {
  name: 'foundry-${suffix}'
  params: {
    name: foundryName
    location: foundryLocation
    tags: tags
    kind: 'AIServices'
    sku: 'S0'
    customSubDomainName: foundryName
    allowProjectManagement: true
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    restrictOutboundNetworkAccess: false
    managedIdentities: { systemAssigned: true }
  }
}

// No published AVM child-project module exists.
resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryName
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundryAccount
  name: projectName
  location: foundryLocation
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'Motivation Coach'
    description: 'Native voice listening and motivational encouragement demo.'
  }
  dependsOn: [foundry]
}

resource runtimeFoundryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(project.id, identityResourceId, foundryUserRoleId)
  scope: project
  properties: {
    principalId: runtimeIdentity.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: foundryUserRoleId
  }
}

resource deployerFoundryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(project.id, principalId, foundryUserRoleId)
  scope: project
  properties: {
    principalId: principalId
    roleDefinitionId: foundryUserRoleId
  }
}

// The bootstrap image is public. The hook configures image pull after AcrPull exists.
module app 'br/public:avm/res/app/container-app:0.23.0' = {
  name: 'ca-${name}'
  params: {
    name: 'ca-${name}'
    location: location
    tags: union(tags, { 'azd-service-name': 'web' })
    managedIdentities: {
      systemAssigned: true
      userAssignedResourceIds: [identityResourceId]
    }
    environmentResourceId: environment.outputs.resourceId
    workloadProfileName: 'Consumption'
    activeRevisionsMode: 'Single'
    registries: startsWith(containerImage, '${registry.outputs.loginServer}/') ? [
      {
        server: registry.outputs.loginServer
        identity: 'system'
      }
    ] : []
    ingressExternal: true
    ingressTargetPort: 8080
    ingressTransport: 'http'
    ingressAllowInsecure: false
    containers: [
        {
          name: 'web'
          image: containerImage
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'AZURE_AUTH_MODE', value: 'managed-identity' }
            { name: 'AZURE_CLIENT_ID', value: runtimeIdentity.outputs.clientId }
            { name: 'FOUNDRY_PROJECT_ENDPOINT', value: projectEndpoint }
            { name: 'FOUNDRY_VOICE_AGENT_NAME', value: agentName }
            { name: 'FOUNDRY_VOICE_AGENT_VERSION', value: agentVersion }
            { name: 'PUBLIC_ORIGIN', value: publicOrigin }
            { name: 'CONTENT_SOURCE_URL', value: contentSourceUrl }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    scaleSettings: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '10' } }
          }
        ]
    }
  }
  dependsOn: [runtimeFoundryRole]
}

resource acr 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: 'acrmotivation${suffix}'
}

resource appPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, resourceId('Microsoft.App/containerApps', 'ca-${name}'), acrPullRoleId)
  scope: acr
  properties: {
    principalId: app.outputs.systemAssignedMIPrincipalId!
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleId
  }
}

output registryName string = registry.outputs.name
output registryId string = registry.outputs.resourceId
output registryEndpoint string = registry.outputs.loginServer
output appName string = app.outputs.name
output appPrincipalId string = app.outputs.systemAssignedMIPrincipalId!
output projectEndpoint string = projectEndpoint
output appUrl string = 'https://${app.outputs.fqdn}'
