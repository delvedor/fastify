/* eslint-disable no-useless-return */

'use strict'

const pump = require('pump')
const validation = require('./validation')
const serialize = validation.serialize
const statusCodes = require('http').STATUS_CODES
const flatstr = require('flatstr')
const FJS = require('fast-json-stringify')

const serializeError = FJS({
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    error: { type: 'string' },
    message: { type: 'string' }
  }
})

function Context (store) {
  // The request context
  this.params = null
  this.req = null
  this.res = null
  this.query = null
  this.headers = null
  this.log = null
  this.body = null
  this.config = store.config
  // route handler
  this._handler = store.handler
  // Hooks
  this._onRequest = store.onRequest
  this._onSend = store.onSend
  this._preHandler = store.preHandler
  this._onResponse = store.onRequest
  // Custom error handler
  this._errorHandler = store.errorHandler
  // Middlewares runner
  this._middie = store.middie
  // Custom content type parser
  this._contentTypeParser = store.contentTypeParser
  // JSON parser options
  this._jsonParserOptions = store.jsonParserOptions
  // The fastify context
  this._fastifyContext = store.fastifyContext
  // Reply stuff
  this.sent = false
  this._serializer = null
  this._customError = false
  this._isError = false
  this._is404 = false
  // schemas
  this._paramsSchema = store._paramsSchema
  this._bodySchema = store._bodySchema
  this._querystringSchema = store._querystringSchema
  this._responseSchema = store._responseSchema
  this._headersSchema = store._headersSchema
}

Context.prototype.send = function (payload) {
  if (this.sent) {
    this.log.warn(new Error('Reply already sent'))
    return
  }

  this.sent = true

  if (payload instanceof Error || this._isError === true) {
    handleError(this, payload, onSendHook)
    return
  }

  onSendHook(this, payload)
  return
}

Context.prototype.setHeader = function (key, value) {
  this.res.setHeader(key, value)
  return this
}

Context.prototype.setHeaders = function (headers) {
  var keys = Object.keys(headers)
  for (var i = 0; i < keys.length; i++) {
    this.setHeader(keys[i], headers[keys[i]])
  }
  return this
}

Context.prototype.code = function (code) {
  this.res.statusCode = code
  return this
}

Context.prototype.serialize = function (payload) {
  return serialize(this.context, payload, this.res.statusCode)
}

Context.prototype.serializer = function (fn) {
  this._serializer = fn
  return this
}

Context.prototype.type = function (type) {
  this.res.setHeader('Content-Type', type)
  return this
}

Context.prototype.redirect = function (code, url) {
  if (typeof code === 'string') {
    url = code
    code = 302
  }

  this.setHeader('Location', url).code(code).send()
}

Context.prototype.notFound = function () {
  if (this._is404 === true) {
    this.log.warn('"ctx.notFound()" called inside a 404 handler. Sending basic 404 response.')
    this.code(404).send('404 Not Found')
    return
  }

  this._is404 = true
  this._fastifyContext._404Context.handler(this)
}

function onSendHook (ctx, payload) {
  if (ctx._onSend !== null) {
    ctx._onSend(
      hookIterator.bind(ctx),
      payload,
      wrapOnSendEnd.bind(ctx)
    )
  } else {
    onSendEnd(ctx, payload)
  }
}

function hookIterator (fn, payload, next) {
  return fn(this, payload, next)
}

function wrapOnSendEnd (err, payload) {
  if (err) {
    handleError(this, err)
  } else {
    onSendEnd(this, payload)
  }
}

function onSendEnd (ctx, payload) {
  var res = ctx.res
  if (payload === undefined) {
    ctx.sent = true
    res.end()
    return
  }

  var contentType = res.getHeader('Content-Type')
  if (payload !== null && payload._readableState) {
    if (!contentType) {
      res.setHeader('Content-Type', 'application/octet-stream')
    }
    pump(payload, res, pumpCallback(ctx))
    return
  }

  var isPayloadString = typeof payload === 'string'

  if (!contentType && isPayloadString) {
    res.setHeader('Content-Type', 'text/plain')
  } else if (Buffer.isBuffer(payload)) {
    if (!contentType) {
      res.setHeader('Content-Type', 'application/octet-stream')
    }
  } else if (ctx._serializer) {
    payload = ctx._serializer(payload)
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
      throw new TypeError(`Serializer for Content-Type '${contentType}' returned invalid payload of type '${typeof payload}'. Expected a string or Buffer.`)
    }
  } else if (!contentType || contentType === 'application/json') {
    res.setHeader('Content-Type', 'application/json')
    payload = serialize(ctx, payload, ctx.res.statusCode)
    flatstr(payload)
  } else if (!isPayloadString && !Buffer.isBuffer(payload)) {
    throw new TypeError(`Attempted to send payload of invalid type '${typeof payload}' without serialization. Expected a string or Buffer.`)
  }

  if (!res.getHeader('Content-Length')) {
    res.setHeader('Content-Length', '' + Buffer.byteLength(payload))
  }

  ctx.sent = true
  res.end(payload)
}

function pumpCallback (ctx) {
  return function _pumpCallback (err) {
    const headersSent = ctx.res.headersSent
    if (err) {
      if (!headersSent) {
        handleError(ctx, err)
      } else {
        ctx.res.log.info('response terminated with an error with headers already sent')
      }
    }
  }
}

function handleError (ctx, error, cb) {
  var res = ctx.res
  var statusCode = res.statusCode
  if (error == null) {
    statusCode = statusCode || 500
  } else if (error.status >= 400) {
    statusCode = error.status
  } else if (error.statusCode >= 400) {
    statusCode = error.statusCode
  } else {
    statusCode = statusCode || 500
  }
  if (statusCode < 400) statusCode = 500
  res.statusCode = statusCode

  if (statusCode >= 500) {
    ctx.log.error({ res: ctx.res, err: error }, error && error.message)
  } else if (statusCode >= 400) {
    ctx.log.info({ res: ctx.res, err: error }, error && error.message)
  }

  if (error && error.headers) {
    ctx.setHeaders(error.headers)
  }

  var customErrorHandler = ctx._errorHandler
  if (customErrorHandler && ctx._customError === false) {
    ctx.sent = false
    ctx._isError = false
    ctx._customError = true
    var result = customErrorHandler(error, ctx)
    if (result && typeof result.then === 'function') {
      result.then(payload => ctx.send(payload))
            .catch(err => ctx.send(err))
    }
    return
  }

  var payload = {
    error: statusCodes[statusCode + ''],
    message: error ? error.message : '',
    statusCode: statusCode
  }

  if (cb) {
    cb(ctx, payload)
    return
  }

  payload = serializeError(payload)
  flatstr(payload)

  res.setHeader('Content-Length', '' + Buffer.byteLength(payload))
  res.setHeader('Content-Type', 'application/json')
  ctx.sent = true
  res.end(payload)
}

function buildContext (store, Ctx) {
  function _Context (store) {
    // The request context
    this.params = null
    this.req = null
    this.res = null
    this.query = null
    this.headers = null
    this.log = null
    this.body = null
    this.config = store.config
    // route handler
    this._handler = store.handler
    // Hooks
    this._onRequest = store.onRequest
    this._onSend = store.onSend
    this._preHandler = store.preHandler
    this._onResponse = store.onRequest
    // Custom error handler
    this._errorHandler = store.errorHandler
    // Middlewares runner
    this._middie = store.middie
    // Custom content type parser
    this._contentTypeParser = store.contentTypeParser
    // JSON parser options
    this._jsonParserOptions = store.jsonParserOptions
    // The fastify context
    this._fastifyContext = store.fastifyContext
    // Reply stuff
    this.sent = false
    this._serializer = null
    this._customError = false
    this._isError = false
    this._404Context = store._404Context
    // schemas
    this._paramsSchema = store._paramsSchema
    this._bodySchema = store._bodySchema
    this._querystringSchema = store._querystringSchema
    this._responseSchema = store._responseSchema
    this._headersSchema = store._headersSchema
  }
  _Context.prototype = new Ctx(store, {}, {})
  return _Context
}

module.exports = Context
module.exports.buildContext = buildContext
