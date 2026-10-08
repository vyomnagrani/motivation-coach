targetScope = 'subscription'

@description('Short azd environment name. Use lowercase letters, digits and hyphens.')
@minLength(1)
@maxLength(32)
param environmentName string

@description('Container Apps and registry location.')
param location string

@description('Region with native Foundry voice-agent feature access.')
param foundryLocation string = 'eastus'

@description('Azure CLI deployment caller object ID; populated by the preprovision hook.')
param principalId string

@description('Optional public raw.githubusercontent.com UI-copy JSON URL.')
param contentSourceUrl string = ''

@description('Preserve the previously deployed image on repeated provisioning.')
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Pinned agent version from a prior provisioning run; hook updates after registration.')
param agentVersion string = '1'

@description('Existing HTTPS app origin, populated by the postprovision hook.')
param publicOrigin string = ''

var suffix = take(uniqueString(subscription().id, environmentName, location), 6)
var tags = {
  'azd-env-name': environmentName
  application: 'motivation-coach'
}

resource rg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: 'rg-motivation-coach-${environmentName}'
  location: location
  tags: tags
}

module resources './modules/resources.bicep' = {
  name: 'motivation-coach-${suffix}'
  scope: rg
  params: {
    name: 'motivation-coach-${suffix}'
    location: location
    foundryLocation: foundryLocation
    tags: tags
    suffix: suffix
    principalId: principalId
    contentSourceUrl: contentSourceUrl
    containerImage: containerImage
    agentVersion: agentVersion
    publicOrigin: publicOrigin
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.registryName
output AZURE_CONTAINER_REGISTRY_ID string = resources.outputs.registryId
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryEndpoint
output AZURE_CONTAINER_APP_NAME string = resources.outputs.appName
output AZURE_CONTAINER_APP_PRINCIPAL_ID string = resources.outputs.appPrincipalId
output AZURE_AI_PROJECT_ENDPOINT string = resources.outputs.projectEndpoint
output FOUNDRY_VOICE_AGENT_NAME string = 'motivation-coach-agent'
output WEB_URL string = resources.outputs.appUrl
