'use strict';

const fs = require('fs');
const path = require('path');

function skillsRootFromHere() {
  return path.resolve(__dirname, '..', '..', '..');
}

function callflowTestScript() {
  const p = path.join(skillsRootFromHere(), 'gc-callflow-test', 'scripts', 'gc-callflow-test.js');
  if (!fs.existsSync(p)) {
    throw new Error(`gc-callflow-test not found at ${p}. Install the gc-callflow-test skill alongside gc-wrapup-codes.`);
  }
  return p;
}

function wrapupScript() {
  return path.resolve(__dirname, '..', 'gc-wrapup-codes.js');
}

module.exports = { skillsRootFromHere, callflowTestScript, wrapupScript };
