'use strict';

const fs = require('fs');
const path = require('path');

function sessionArtifactModule() {
  const p = path.resolve(__dirname, '..', '..', '..', 'gc-wrapup-codes', 'scripts', 'lib', 'session-artifact-html.js');
  if (!fs.existsSync(p)) {
    throw new Error(`gc-wrapup-codes session-artifact-html not found at ${p}.`);
  }
  return require(p);
}

function writeSummaryHandoff(args, extra = {}) {
  try {
    const { writeSummarySessionHtml } = sessionArtifactModule();
    return writeSummarySessionHtml({ ...args, ...extra });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { writeSummaryHandoff };
