/* eslint-disable no-useless-return */
'use strict'

const fastJsonStringify = require('fast-json-stringify')
const validation = require('./validation')
const validateSchema = validation.validate

const schemas = require('./schemas.json')
const inputSchemaError = fastJsonStringify(schemas.inputSchemaError)

function handleRequest (context) {
  var method = context.req.method

  if (method === 'GET' || method === 'HEAD') {
    return handler(context)
  }

  var contentType = context.headers['content-type']

  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    // application/json content type
    if (contentType && contentType.indexOf('application/json') > -1) {
      return jsonBody(context)
    }

    // custom parser for a given content type
    if (context._contentTypeParser.fastHasHeader(contentType)) {
      return context._contentTypeParser.run(contentType, context, handler)
    }

    context.code(415).send(new Error('Unsupported Media Type: ' + contentType))
    return
  }

  if (method === 'OPTIONS' || method === 'DELETE') {
    if (!contentType) {
      return handler(context)
    }

    // application/json content type
    if (contentType.indexOf('application/json') > -1) {
      return jsonBody(context)
    }
    // custom parser for a given content type
    if (context._contentTypeParser.fastHasHeader(contentType)) {
      return context._contentTypeParser.run(contentType, context, handler)
    }

    context.code(415).send(new Error('Unsupported Media Type: ' + contentType))
    return
  }

  context.code(405).send(new Error('Method Not Allowed: ' + method))
  return
}

function jsonBody (context) {
  var limit = context._jsonParserOptions.limit
  var contentLength = context.headers['content-length'] === undefined
    ? NaN
    : Number.parseInt(context.headers['content-length'], 10)

  if (contentLength > limit) {
    context.code(413).send(new Error('Request body is too large'))
    return
  }

  var receivedLength = 0
  var body = ''
  var req = context.req

  req.on('data', onData)
  req.on('end', onEnd)
  req.on('error', onEnd)

  function onData (chunk) {
    receivedLength += chunk.length

    if (receivedLength > limit) {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onEnd)
      context.code(413).send(new Error('Request body is too large'))
      return
    }

    body += chunk.toString()
  }

  function onEnd (err) {
    req.removeListener('data', onData)
    req.removeListener('end', onEnd)
    req.removeListener('error', onEnd)

    if (err !== undefined) {
      context.code(400).send(err)
      return
    }

    if (!Number.isNaN(contentLength) && receivedLength !== contentLength) {
      context.code(400).send(new Error('Request body size did not match Content-Length'))
      return
    }

    if (receivedLength === 0) { // Body is invalid JSON
      context.code(422).send(new Error('Unexpected end of JSON input'))
      return
    }

    try {
      context.body = JSON.parse(body)
    } catch (err) {
      context.code(422).send(err)
      return
    }
    handler(context)
  }
}

function handler (context) {
  var valid = validateSchema(context)
  if (valid !== true) {
    context.code(400).send(wrapValidationError(valid))
    return
  }

  // preHandler hook
  if (context._preHandler !== null) {
    context._preHandler(
      hookIterator,
      context,
      preHandlerCallback
    )
  } else {
    preHandlerCallback(null, context)
  }
}

function hookIterator (fn, context, next) {
  return fn(context, next)
}

function preHandlerCallback (err, context) {
  if (err) {
    context.send(err)
    return
  }

  var result = context._handler(context)
  if (result && typeof result.then === 'function') {
    result.then((payload) => {
      // this is for async functions that
      // are using reply.send directly
      if (payload !== undefined || (context.res.statusCode === 204 && !context.sent)) {
        context.send(payload)
      }
    }).catch((err) => {
      context._isError = true
      context.send(err)
    })
  }
}

function wrapValidationError (valid) {
  if (valid instanceof Error) {
    return valid
  }
  var error = new Error(inputSchemaError(valid))
  error.validation = valid
  return error
}

module.exports = handleRequest
module.exports[Symbol.for('internals')] = { jsonBody, handler }
