'use strict'

const fastJsonStringify = require('fast-json-stringify')

/* const bodySchema = Symbol('body-schema')
const querystringSchema = Symbol('querystring-schema')
const paramsSchema = Symbol('params-schema')
const responseSchema = Symbol('response-schema')
const headersSchema = Symbol('headers-schema') */

function getValidatorForStatusCodeSchema (statusCodeDefinition) {
  return fastJsonStringify(statusCodeDefinition)
}

function getResponseSchema (responseSchemaDefinition) {
  var statusCodes = Object.keys(responseSchemaDefinition)
  return statusCodes.reduce(function (r, statusCode) {
    r[statusCode] = getValidatorForStatusCodeSchema(responseSchemaDefinition[statusCode])
    return r
  }, {})
}

function getSchemaAnyway (schema) {
  if (!schema.type || !schema.properties) {
    return {
      type: 'object',
      properties: schema
    }
  }
  return schema
}

function build (context, compile) {
  if (!context.schema) {
    return
  }

  if (context.schema.headers) {
    // headers will always be an object, allow schema def to skip this
    context._headersSchema = compile(getSchemaAnyway(context.schema.headers))
  }

  if (context.schema.response) {
    context._responseSchema = getResponseSchema(context.schema.response)
  }

  if (context.schema.body) {
    context._bodySchema = compile(context.schema.body)
  }

  if (context.schema.querystring) {
    // querystring will always be an object, allow schema def to skip this
    context._querystringSchema = compile(getSchemaAnyway(context.schema.querystring))
  }

  if (context.schema.params) {
    context._paramsSchema = compile(context.schema.params)
  }
}

function validateParam (validatorFunction, context, paramName) {
  var ret = validatorFunction && validatorFunction(context[paramName])
  if (ret === false) return validatorFunction.errors
  if (ret && ret.error) return ret.error
  if (ret && ret.value) context[paramName] = ret.value
  return false
}

function validate (context) {
  return validateParam(context._paramsSchema, context, 'params') ||
    validateParam(context._bodySchema, context, 'body') ||
    validateParam(context._querystringSchema, context, 'query') ||
    validateParam(context._headersSchema, context, 'headers') ||
    true
}

function serialize (context, data, statusCode) {
  var responseSchemaDef = context._responseSchema
  if (!responseSchemaDef) {
    return JSON.stringify(data)
  }
  if (responseSchemaDef[statusCode]) {
    return responseSchemaDef[statusCode](data)
  }
  var fallbackStatusCode = (statusCode + '')[0] + 'xx'
  if (responseSchemaDef[fallbackStatusCode]) {
    return responseSchemaDef[fallbackStatusCode](data)
  }
  return JSON.stringify(data)
}

function isValidLogger (logger) {
  if (!logger) {
    return false
  }

  var result = true
  const methods = ['info', 'error', 'debug', 'fatal', 'warn', 'trace', 'child']
  for (var i = 0; i < methods.length; i += 1) {
    if (!logger[methods[i]] || typeof logger[methods[i]] !== 'function') {
      result = false
      break
    }
  }
  return result
}

function schemaCompiler (schema) {
  return this.ajv.compile(schema)
}

module.exports = { build, validate, serialize, isValidLogger, schemaCompiler }
// module.exports.symbols = { bodySchema, querystringSchema, responseSchema, paramsSchema, headersSchema }
