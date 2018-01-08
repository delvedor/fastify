'use strict'

const FindMyWay = require('find-my-way')
const avvio = require('avvio')
const Ajv = require('ajv')
const http = require('http')
const https = require('https')
const Middie = require('middie')
const fastIterator = require('fast-iterator')
const lightMyRequest = require('light-my-request')
const abstractLogging = require('abstract-logging')
const urlUtil = require('url')

const supportedMethods = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS']
const buildSchema = require('./lib/validation').build
const handleRequest = require('./lib/handleRequest')
const isValidLogger = require('./lib/validation').isValidLogger
const schemaCompiler = require('./lib/validation').schemaCompiler
const decorator = require('./lib/decorate')
const ContentTypeParser = require('./lib/ContentTypeParser')
const Hooks = require('./lib/hooks')
const loggerUtils = require('./lib/logger')
const pluginUtils = require('./lib/pluginUtils')
const Context = require('./lib/ctx')

const DEFAULT_JSON_BODY_LIMIT = 1024 * 1024 // 1 MiB

function validateBodyLimitOption (jsonBodyLimit) {
  if (jsonBodyLimit === undefined) return
  if (!Number.isInteger(jsonBodyLimit) || jsonBodyLimit <= 0) {
    throw new TypeError(`'jsonBodyLimit' option must be an integer > 0. Got '${jsonBodyLimit}'`)
  }
}

function build (options) {
  options = options || {}
  if (typeof options !== 'object') {
    throw new TypeError('Options must be an object')
  }

  var log
  if (isValidLogger(options.logger)) {
    log = loggerUtils.createLogger({ logger: options.logger, serializers: loggerUtils.serializers })
  } else if (!options.logger) {
    log = Object.create(abstractLogging)
    log.child = () => log
  } else {
    options.logger = typeof options.logger === 'object' ? options.logger : {}
    options.logger.level = options.logger.level || 'info'
    options.logger.serializers = options.logger.serializers || loggerUtils.serializers
    log = loggerUtils.createLogger(options.logger)
  }

  const ajv = new Ajv(Object.assign({ coerceTypes: true }, options.ajv))

  const router = FindMyWay({ defaultRoute: defaultRoute })
  const map = new Map()

  // logger utils
  const customGenReqId = options.logger ? options.logger.genReqId : null
  const genReqId = customGenReqId || loggerUtils.reqIdGenFactory()
  const now = loggerUtils.now
  const onResponseIterator = loggerUtils.onResponseIterator
  const onResponseCallback = loggerUtils.onResponseCallback

  const app = avvio(fastify, {
    autostart: false
  })
  // Override to allow the plugin incapsulation
  app.override = override

  var listening = false
  // true when Fastify is ready to go
  var started = false
  app.on('start', () => {
    started = true
  })

  var server
  if (options.https) {
    if (options.http2) {
      server = http2().createSecureServer(options.https, fastify)
    } else {
      server = https.createServer(options.https, fastify)
    }
  } else if (options.http2) {
    server = http2().createServer(fastify)
  } else {
    server = http.createServer(fastify)
  }

  fastify.onClose((instance, done) => {
    if (listening) {
      instance.server.close(done)
    } else {
      done(null)
    }
  })

  if (Number(process.versions.node[0]) >= 6) {
    server.on('clientError', handleClientError)
  }

  // JSON body limit option
  validateBodyLimitOption(options.jsonBodyLimit)
  fastify._jsonBodyLimit = options.jsonBodyLimit || DEFAULT_JSON_BODY_LIMIT

  // shorthand methods
  fastify.delete = _delete
  fastify.get = _get
  fastify.head = _head
  fastify.patch = _patch
  fastify.post = _post
  fastify.put = _put
  fastify.options = _options
  fastify.all = _all
  // extended route
  fastify.route = route
  fastify._routePrefix = ''

  // expose logger instance
  fastify.log = log

  // hooks
  fastify.addHook = addHook
  fastify._hooks = new Hooks()

  // custom parsers
  fastify.addContentTypeParser = addContentTypeParser
  fastify.hasContentTypeParser = hasContentTypeParser
  fastify._contentTypeParser = new ContentTypeParser()

  fastify.setSchemaCompiler = setSchemaCompiler
  fastify._schemaCompiler = schemaCompiler.bind({ ajv: ajv })

  // plugin
  fastify.register = fastify.use
  fastify.listen = listen
  fastify.server = server
  fastify[pluginUtils.registeredPlugins] = []

  // extend server methods
  fastify.decorate = decorator.add
  fastify.hasDecorator = decorator.exist
  fastify.decorateContext = decorator.decorateContext

  // Context
  fastify._Context = Context

  // middleware support
  fastify.use = use
  fastify._middie = Middie(onRunMiddlewares)
  fastify._middlewares = []

  // exposes the routes map
  fastify[Symbol.iterator] = iterator

  // fake http injection (for testing purposes)
  fastify.inject = inject

  var fourOhFour = FindMyWay({ defaultRoute: fourOhFourFallBack })
  fastify.setNotFoundHandler = setNotFoundHandler
  setNotFoundHandler.call(fastify)

  fastify.setErrorHandler = setErrorHandler

  return fastify

  function fastify (req, res) {
    req.id = genReqId(req)
    req.log = res.log = log.child({ reqId: req.id })
    req.originalUrl = req.url

    req.log.info({ req }, 'incoming request')

    res._startTime = now()
    res._context = null
    res.on('finish', onResFinished)
    res.on('error', onResFinished)

    router.lookup(req, res)
  }

  function onResFinished (err) {
    this.removeListener('finish', onResFinished)
    this.removeListener('error', onResFinished)

    var ctx = this._context

    if (ctx && ctx._onResponse !== null) {
      // deferring this with setImmediate will
      // slow us by 10%
      ctx._onResponse(
        onResponseIterator,
        this,
        onResponseCallback
      )
    } else {
      onResponseCallback(err, this)
    }
  }

  function listen (port, address, cb) {
    /* Deal with listen (port, cb) */
    if (typeof address === 'function') {
      cb = address
      address = undefined
    }

    if (cb === undefined) {
      return new Promise((resolve, reject) => {
        fastify.listen(port, address, err => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    }

    const hasAddress = address !== undefined

    fastify.ready(function (err) {
      if (err) return cb(err)
      if (listening) {
        return cb(new Error('Fastify is already listening'))
      }

      server.on('error', wrap)
      if (hasAddress) {
        server.listen(port, address, wrap)
      } else {
        server.listen(port, wrap)
      }
      listening = true
    })

    function wrap (err) {
      if (!err) {
        let address = server.address()
        if (typeof address === 'object') {
          address = address.address + ':' + address.port
        }
        address = 'http' + (options.https ? 's' : '') + '://' + address
        fastify.log.info('Server listening at ' + address)
      }

      server.removeListener('error', wrap)
      cb(err)
    }
  }

  function startHooks (req, res, params, store) {
    var context = new store.Context(store)
    res._context = context
    context.req = req
    context.res = res
    context.log = req.log
    context.params = params
    context.headers = req.headers
    context.query = urlUtil.parse(req.url, true).query

    if (context._onRequest !== null) {
      context._onRequest(
        hookIterator,
        context,
        middlewareCallback
      )
    } else {
      middlewareCallback(null, context)
    }
  }

  function hookIterator (fn, context, next) {
    return fn(context.req, context.res, next)
  }

  function middlewareCallback (err, context) {
    if (err) {
      context.send(err)
      return
    }

    context._middie.run(context.req, context.res, context)
  }

  function onRunMiddlewares (err, req, res, context) {
    if (err) {
      context.send(err)
      return
    }

    handleRequest(context)
  }

  function override (old, fn, opts) {
    const shouldSkipOverride = pluginUtils.registerPlugin.call(old, fn)
    if (shouldSkipOverride) {
      return old
    }

    const middlewares = Object.assign([], old._middlewares)
    const instance = Object.create(old)
    instance._Context = Context.buildContext(
      new Store(instance, { limit: instance._jsonBodyLimit }, { config: {}, handler: () => {} }),
      instance._Context
    )
    instance._contentTypeParser = ContentTypeParser.buildContentTypeParser(instance._contentTypeParser)
    instance._hooks = Hooks.buildHooks(instance._hooks)
    instance._routePrefix = buildRoutePrefix(instance._routePrefix, opts.prefix)
    instance._middlewares = []
    instance._middie = Middie(onRunMiddlewares)
    instance[pluginUtils.registeredPlugins] = Object.create(instance[pluginUtils.registeredPlugins])

    if (opts.prefix) {
      instance._404Context = null
    }

    for (var i = 0; i < middlewares.length; i++) {
      instance.use.apply(instance, middlewares[i])
    }

    return instance
  }

  function buildRoutePrefix (instancePrefix, pluginPrefix) {
    if (!pluginPrefix) {
      return instancePrefix
    }

    if (pluginPrefix[0] !== '/') {
      pluginPrefix = '/' + pluginPrefix
    }
    return instancePrefix + pluginPrefix
  }

  // Shorthand methods
  function _delete (url, opts, handler) {
    return _route(this, 'DELETE', url, opts, handler)
  }

  function _get (url, opts, handler) {
    return _route(this, 'GET', url, opts, handler)
  }

  function _head (url, opts, handler) {
    return _route(this, 'HEAD', url, opts, handler)
  }

  function _patch (url, opts, handler) {
    return _route(this, 'PATCH', url, opts, handler)
  }

  function _post (url, opts, handler) {
    return _route(this, 'POST', url, opts, handler)
  }

  function _put (url, opts, handler) {
    return _route(this, 'PUT', url, opts, handler)
  }

  function _options (url, opts, handler) {
    return _route(this, 'OPTIONS', url, opts, handler)
  }

  function _all (url, opts, handler) {
    return _route(this, supportedMethods, url, opts, handler)
  }

  function _route (_fastify, method, url, options, handler) {
    if (!handler && typeof options === 'function') {
      handler = options
      options = {}
    }
    return _fastify.route({
      method,
      url,
      handler,
      schema: options.schema,
      beforeHandler: options.beforeHandler,
      config: options.config,
      schemaCompiler: options.schemaCompiler,
      jsonBodyLimit: options.jsonBodyLimit
    })
  }

  // Route management
  function route (opts) {
    const _fastify = this

    if (Array.isArray(opts.method)) {
      for (var i = 0; i < opts.method.length; i++) {
        if (supportedMethods.indexOf(opts.method[i]) === -1) {
          throw new Error(`${opts.method[i]} method is not supported!`)
        }
      }
    } else {
      if (supportedMethods.indexOf(opts.method) === -1) {
        throw new Error(`${opts.method} method is not supported!`)
      }
    }

    if (!opts.handler) {
      throw new Error(`Missing handler function for ${opts.method}:${opts.url} route.`)
    }

    validateBodyLimitOption(opts.jsonBodyLimit)
    var jsonBodyLimit = opts.jsonBodyLimit || _fastify._jsonBodyLimit

    _fastify.after((notHandledErr, done) => {
      const path = opts.url || opts.path
      const prefix = _fastify._routePrefix
      const url = prefix + (path === '/' && prefix.length > 0 ? '' : path)

      opts.config = opts.config || {}
      opts.config.url = url

      const store = new Store(_fastify, { limit: jsonBodyLimit }, opts)

      try {
        buildSchema(store, opts.schemaCompiler || _fastify._schemaCompiler)
      } catch (error) {
        done(error)
        return
      }

      const onRequest = _fastify._hooks.onRequest
      const onResponse = _fastify._hooks.onResponse
      const onSend = _fastify._hooks.onSend
      const preHandler = _fastify._hooks.preHandler.concat(opts.beforeHandler || [])

      store.onRequest = onRequest.length ? fastIterator(onRequest, _fastify) : null
      store.onResponse = onResponse.length ? fastIterator(onResponse, _fastify) : null
      store.onSend = onSend.length ? fastIterator(onSend, _fastify) : null
      store.preHandler = preHandler.length ? fastIterator(preHandler, _fastify) : null

      if (map.has(url)) {
        if (map.get(url)[opts.method]) {
          return done(new Error(`${opts.method} already set for ${url}`))
        }

        if (Array.isArray(opts.method)) {
          for (i = 0; i < opts.method.length; i++) {
            map.get(url)[opts.method[i]] = store
          }
        } else {
          map.get(url)[opts.method] = store
        }
        router.on(opts.method, url, startHooks, store)
      } else {
        const node = {}
        if (Array.isArray(opts.method)) {
          for (i = 0; i < opts.method.length; i++) {
            node[opts.method[i]] = store
          }
        } else {
          node[opts.method] = store
        }
        map.set(url, node)
        router.on(opts.method, url, startHooks, store)
      }
      done(notHandledErr)
    })

    // chainable api
    return _fastify
  }

  function Store (fastifyContext, jsonParserOptions, opts) {
    this.fastifyContext = fastifyContext
    this.Context = fastifyContext._Context
    this.config = opts.config
    this.handler = opts.handler.bind(fastifyContext)
    this.schema = opts.schema
    this.jsonParserOptions = jsonParserOptions
    this.errorHandler = fastifyContext._errorHandler
    this.middie = fastifyContext._middie
    this.contentTypeParser = fastifyContext._contentTypeParser
    this.onRequest = null
    this.onResponse = null
    this.onSend = null
    this.preHandler = null
    this._paramsSchema = null
    this._bodySchema = null
    this._querystringSchema = null
    this._responseSchema = null
    this._headersSchema = null
  }

  function iterator () {
    var entries = map.entries()
    var it = {}
    it.next = function () {
      var next = entries.next()

      if (next.done) {
        return {
          value: null,
          done: true
        }
      }

      var value = {}
      var methods = {}

      value[next.value[0]] = methods

      // out methods are saved Uppercase,
      // so we lowercase them for a better usability
      for (var method in next.value[1]) {
        methods[method.toLowerCase()] = next.value[1][method]
      }

      return {
        value: value,
        done: false
      }
    }
    return it
  }

  function inject (opts, cb) {
    if (started) {
      return lightMyRequest(this, opts, cb)
    }

    if (cb) {
      this.ready(err => {
        if (err) throw err
        return lightMyRequest(this, opts, cb)
      })
    } else {
      return new Promise((resolve, reject) => {
        this.ready(err => {
          if (err) return reject(err)
          resolve()
        })
      }).then(() => lightMyRequest(this, opts))
    }
  }

  function use (url, fn) {
    if (typeof url === 'string') {
      const prefix = this._routePrefix
      url = prefix + (url === '/' && prefix.length > 0 ? '' : url)
    }
    this._middlewares.push([url, fn])
    this._middie.use(url, fn)
    return this
  }

  function addHook (name, fn) {
    if (name === 'onClose') {
      this.onClose(fn)
    } else {
      this._hooks.add(name, fn)
    }
    return this
  }

  function addContentTypeParser (contentType, fn) {
    this._contentTypeParser.add(contentType, fn)
    return this
  }

  function hasContentTypeParser (contentType, fn) {
    return this._contentTypeParser.hasParser(contentType)
  }

  function handleClientError (e, socket) {
    const body = JSON.stringify({
      error: http.STATUS_CODES['400'],
      message: 'Client Error',
      statusCode: 400
    })
    log.error(e, 'client error')
    socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Length: ${body.length}\r\nContent-Type: 'application/json'\r\n\r\n${body}`)
  }

  function defaultRoute (req, res) {
    fourOhFour.lookup(req, res)
  }

  function basic404 (ctx) {
    ctx.code(404).send(new Error('Not found'))
  }

  function fourOhFourFallBack (req, res) {
    // if this happen, we have a very bad bug
    // we might want to do some hard debugging
    // here, let's print out as much info as
    // we can
    req.log.warn('the default handler for 404 did not catch this, this is likely a fastify bug, please report it')
    req.log.warn(fourOhFour.prettyPrint())
    res.statusCode = 404
    res.send('Not found')
  }

  function setNotFoundHandler (opts, handler) {
    this.after((notHandledErr, done) => {
      _setNotFoundHandler.call(this, opts, handler)
      done(notHandledErr)
    })
  }

  function _setNotFoundHandler (opts, handler) {
    if (typeof opts === 'function') {
      handler = opts
      opts = undefined
    }
    opts = opts || {}
    handler = handler ? handler.bind(this) : basic404
    opts.handler = handler

    if (!this._404Context) {
      const store = new Store(
        this,
        { limit: this._jsonBodyLimit },
        opts
      )

      const onRequest = this._hooks.onRequest
      const preHandler = this._hooks.preHandler
      const onSend = this._hooks.onSend
      const onResponse = this._hooks.onResponse

      store.onRequest = onRequest.length ? fastIterator(onRequest, this) : null
      store.preHandler = preHandler.length ? fastIterator(preHandler, this) : null
      store.onSend = onSend.length ? fastIterator(onSend, this) : null
      store.onResponse = onResponse.length ? fastIterator(onResponse, this) : null

      this._404Context = store

      const prefix = this._routePrefix

      fourOhFour.all(prefix + '/*', startHooks, store)
      fourOhFour.all(prefix || '/', startHooks, store)
    } else {
      this._404Context._handler = handler
      this._404Context._contentTypeParser = this._contentTypeParser
      this._404Context.config = opts.config || {}
    }
  }

  function setSchemaCompiler (schemaCompiler) {
    this._schemaCompiler = schemaCompiler
    return this
  }

  function setErrorHandler (func) {
    this._errorHandler = func
    return this
  }
}

function http2 () {
  try {
    return require('http2')
  } catch (err) {
    console.error('http2 is available only from node >= 8.8.1')
  }
}

module.exports = build
