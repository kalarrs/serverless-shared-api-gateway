'use strict'

const AWS = require('aws-sdk')
const chalk = require('chalk')

class ServerlessSharedApiGateway {
  constructor (serverless, options) {
    this.serverless = serverless
    this.options = options

    // Indicate if variables are initialized to avoid run multiples init
    this.initialized = false
    this.restApiId = null
    this.restApiName = null
    this.restApiResourceId = null
    this.resources = null

    this.commands = {
      shared_api_gateway: {
        validate: {
          usage: 'Checks to see if the AWS API gateway exists and if you have permission',
          lifecycleEvents: [
            'validate'
          ]
        },
        create: {
          usage: 'Creates an AWS API gateway',
          lifecycleEvents: [
            'initialize',
            'create'
          ]
        },
        delete: {
          usage: 'Deletes an AWS API gateway',
          lifecycleEvents: [
            'initialize',
            'delete'
          ]
        }
      }
    }

    this.hooks = {
      'shared_api_gateway:delete:delete': this.deleteRestApi.bind(this),
      'shared_api_gateway:create:create': this.createRestApi.bind(this),
      'after:package:compileEvents': this.compileEvents.bind(this),
      'after:info:info': this.summary.bind(this),
      // https://gist.github.com/HyperBrain/50d38027a8f57778d5b0f135d80ea406
      // https://serverless.com/framework/docs/providers/aws/guide/plugins/
      // 'after:aws:info:gatherData': this.summary.bind(this)
    }
  }

  _initializeVariables () {
    if (!this.initialized) {
      const awsCreds = this.serverless.providers.aws.getCredentials()
      AWS.config.update(awsCreds)
      this.apiGateway = new AWS.APIGateway()
      this.initialized = true
    }
  }

  createRestApi () {
    this._initializeVariables()

    return this.apiGateway.createRestApi({
      name: this.restApiName,
      // binaryMediaTypes: [],
      description: 'Generated by the shared Serverless - AWS Api Gateway plugin',
      endpointConfiguration: {
        types: [
          'EDGE'
        ]
      }
    }).promise()
  }

  deleteRestApi () {
    this._initializeVariables()
    return null
  }

  _sourceArnReplaceRestApi (arr) {
    return arr.map(item => {
      if (Array.isArray(item)) return this._sourceArnReplaceRestApi(item)
      if (item && item.Ref && item.Ref === this.apiGatewayRestApiLogicalId) return this.restApiId
      else if (item && item['Fn::GetAtt']) return this.restApiResourceId
      return item
    })
  }

  _updateReferencesInCloudFormation () {
    const plugin = this.serverless.pluginManager.plugins.find(plugin => plugin.apiGatewayRestApiLogicalId)
    this.apiGatewayRestApiLogicalId = plugin && plugin.apiGatewayRestApiLogicalId

    // Set restApiId on provider
    this.serverless.service.provider.apiGatewayRestApiId = this.restApiId

    // Set restApiResourceId on provider
    this.serverless.service.provider.restApiResourceId = this.restApiResourceId

    let ccfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate
    let Resources = ccfTemplate.Resources

    // Remove ApiGatewayRestApi
    if (Resources.ApiGatewayRestApi) delete Resources.ApiGatewayRestApi

    // Set restApiId on custom domain names
    if (Resources.pathmapping) Resources.pathmapping.Properties.RestApiId = this.restApiId

    if (this.apiGatewayRestApiLogicalId) {
      Object.keys(Resources).forEach(key => {
        if (/^ApiGateway(Resource|Method|Deployment)/.test(key)) {
          let Properties = Resources[key].Properties
          // Set restApiId on each Resource, Method, & Deployment
          if (Properties && Properties.RestApiId && Properties.RestApiId.Ref && Properties.RestApiId.Ref === this.apiGatewayRestApiLogicalId) Properties.RestApiId = this.restApiId
          // Set restApiResourceId as ParentId
          if (Properties && Properties.ParentId && Properties.ParentId['Fn::GetAtt']) Properties.ParentId = this.restApiResourceId
        } else if (/.+?LambdaPermissionApiGateway$/.test(key)) {
          Resources[key].Properties.SourceArn['Fn::Join'] = this._sourceArnReplaceRestApi(Resources[key].Properties.SourceArn['Fn::Join'])
        }
      })
    }

    // Set restApiId on Outputs
    if (ccfTemplate.Outputs && ccfTemplate.Outputs.ServiceEndpoint && ccfTemplate.Outputs.ServiceEndpoint.Value) {
      ccfTemplate.Outputs.ServiceEndpoint.Value['Fn::Join'] = this._sourceArnReplaceRestApi(ccfTemplate.Outputs.ServiceEndpoint.Value['Fn::Join'])
    }
  }

  async compileEvents () {
    this.restApiId = this.serverless.service.provider.apiGatewayRestApiId
    this.restApiName = this.serverless.service.provider.apiGatewayRestApiName
    this.restApiResourceId = this.serverless.service.provider.apiGatewayRestApiResourceId

    if (!this.restApiId && !this.restApiName) throw new Error(`Unable to continue please provide an apiId or apiName`)

    await this.findRestApi()
    await this.loadResourcesForApi()
    this.findResourceId()
    this._updateReferencesInCloudFormation()
    this._findAndRemoveExistingResources()
  }

  async loadResourcesForApi () {
    let hasMoreResults = true
    let currentPosition = null
    this.resources = []
    do {
      const {position, items} = await this.apiGateway.getResources({position: currentPosition, restApiId: this.restApiId, limit: 500}).promise()
      this.resources = this.resources.concat(items)
      currentPosition = position
      hasMoreResults = position && items.length === 500
    } while (hasMoreResults)
  }

  _findMatchingRestApi (api) {
    if (this.restApiId) return api.id === this.restApiId
    else if (this.restApiName) return api.name === this.restApiName
    return false
  }

  async findRestApi () {
    this._initializeVariables()

    const {items} = await this.apiGateway.getRestApis({}).promise()
    if (!Array.isArray(items)) return

    if (this.restApiName) {
      let matchingRestApis = items.filter(api => this._findMatchingRestApi(api))
      if (matchingRestApis && matchingRestApis.length > 1) throw new Error(`Found multiple APIs with the name: ${this.restApiName}. Please rename your api or specify an apiGatewayRestApiId`)
      let provider = this.serverless.getProvider('aws')
      if (provider) provider.naming.getApiGatewayName = () => this.restApiName
    }

    let matchingRestApi = items.find(api => this._findMatchingRestApi(api))
    if (this.restApiName && !matchingRestApi) {
      this.serverless.cli.log(`No API Gateway matching '${this.restApiName}' attempting to create it.`)
      matchingRestApi = await this.createRestApi()
    }

    this.restApiId = matchingRestApi.id
    this.restApiName = matchingRestApi.name
  }

  findExistingResources () {
    if (!this.resources) throw new Error(`You must have a list of the current resources. Did you forget to run loadResourcesForApi?`)

    const Resources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources
    return Object.keys(Resources).reduce((arr, key) => {
      const item = Resources[key]
      if (item.Type === 'AWS::ApiGateway::Resource') {
        const match = this.resources.find(r => r.pathPart === item.Properties.PathPart && r.parentId === item.Properties.ParentId) || null
        if (match) arr.push({key, id: match.id, parentId: match.parentId})
      }
      return arr
    }, [])
  }

  _findAndRemoveExistingResources () {
    const existingResources = this.findExistingResources()
    const Resources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources

    // Remove existing resources from the cloud formation
    existingResources.forEach(er => {
      delete Resources[er.key]
    })

    // Update the remaining resources to point to the existing resource
    Object.keys(Resources).forEach(key => {
      let item = Resources[key]
      if (item.Type === 'AWS::ApiGateway::Resource') {
        let ref = item.Properties.ParentId && item.Properties.ParentId.Ref
        let match = existingResources.find(er => er.key === ref)
        if (match) item.Properties.ParentId = match.id
      }
    })
  }

  findResourceId () {
    this._initializeVariables()

    if (!this.restApiId) throw new Error(`You must have a restApiId. Did you forget to run findRestApi?`)
    if (!this.resources) throw new Error(`You must have a list of the current resources. Did you forget to run loadResourcesForApi?`)

    let matchingResource = this.resources.find(resource => this.restApiResourceId ? resource.id === this.restApiResourceId : resource.path === '/')
    if (!matchingResource) throw new Error('Unable to find a matching API Gateway resource. Please check the id and try again.')

    this.restApiResourceId = matchingResource.id
  }

  summary () {
    this.serverless.cli.consoleLog(chalk.yellow.underline('Serverless Shared API Gateway Summary'))

    this.serverless.cli.consoleLog(chalk.yellow('Name'))
    this.serverless.cli.consoleLog(`  ${this.restApiName}`)

    if (this.restApiId) {
      this.serverless.cli.consoleLog(chalk.yellow('ID'))
      this.serverless.cli.consoleLog(`  ${this.restApiId}`)
    }
  }
}

module.exports = ServerlessSharedApiGateway
