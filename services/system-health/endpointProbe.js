'use strict';

const path = require('path');
const { ProbeFailure } = require('./probeResult');

function loadModule(modulePath, label = 'service module') {
  try {
    const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
    const loaded = require(resolved);
    if (!loaded) throw new Error('Module returned an empty export.');
    return loaded;
  } catch (error) {
    throw new ProbeFailure('SERVICE_MODULE_UNAVAILABLE', `${label} could not be loaded.`, { cause: error });
  }
}

function requireFunction(value, label) {
  if (typeof value !== 'function') {
    throw new ProbeFailure('SERVICE_METHOD_UNAVAILABLE', `${label} is unavailable.`);
  }
  return value;
}

module.exports = { loadModule, requireFunction };
