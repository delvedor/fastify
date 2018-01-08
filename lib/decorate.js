'use strict'

function decorate (name, fn, dependencies) {
  if (checkExistence(this, name)) {
    throw new Error(`The decorator '${name}' has been already added!`)
  }

  if (dependencies) {
    checkDependencies(this, dependencies)
  }

  this[name] = fn
  return this
}

function checkExistence (instance, name) {
  if (!name) {
    name = instance
    instance = this
  }
  return name in instance
}

function checkExistenceInPrototype (klass, name) {
  return name in klass.prototype
}

function checkDependencies (instance, deps) {
  for (var i = 0; i < deps.length; i++) {
    if (!checkExistence(instance, deps[i])) {
      throw new Error(`Fastify decorator: missing dependency: '${deps[i]}'.`)
    }
  }
}

function decorateContext (name, fn) {
  if (checkExistenceInPrototype(this._Context, name)) {
    throw new Error(`The decorator '${name}' has been already added to Context!`)
  }

  this._Context.prototype[name] = fn
  return this
}

module.exports = {
  add: decorate,
  exist: checkExistence,
  dependencies: checkDependencies,
  decorateContext: decorateContext
}
