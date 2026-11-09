'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFERRED_KEYS = Object.freeze(['ava-harness', 'user-ava-harness']);
const PLACEHOLDERS = [
  /^\$\{[^}]+\}$/,
  /^\{\{[^}]+\}\}$/,
  /^<[^>]+>$/,
  /^YOUR_/i,
  /^REPLACE_/i,
  /^CHANGEME/i,
  /^TODO/i,
];

function defaultConfigPath() {
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

function nonPlaceholder(value) {
  const text = String(value ?? '').trim();
  return text && !PLACEHOLDERS.some((pattern) => pattern.test(text)) ? text : null;
}

function firstValue(env, keys) {
  for (const key of keys) {
    const value = nonPlaceholder(env?.[key]);
    if (value) return value;
  }
  return null;
}

function looksLikeHarness(config) {
  const command = String(config?.command || '').toLowerCase();
  const args = Array.isArray(config?.args) ? config.args.join(' ').toLowerCase() : '';
  return `${command} ${args}`.includes('ava-mcp') || `${command} ${args}`.includes('ava_mcp');
}

function selectHarness(mcpServers, configPath) {
  if (!mcpServers || typeof mcpServers !== 'object') {
    throw new Error(`Cursor MCP config at ${configPath} is missing mcpServers.`);
  }
  const preferred = PREFERRED_KEYS.filter((key) => mcpServers[key]);
  if (preferred.length > 1) {
    throw new Error(`Ambiguous AVA harness configuration: ${preferred.join(', ')}.`);
  }
  if (preferred.length === 1) return { key: preferred[0], config: mcpServers[preferred[0]] };
  const candidates = Object.entries(mcpServers).filter(([, config]) => looksLikeHarness(config));
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length
        ? `Ambiguous AVA harness configuration: ${candidates.map(([key]) => key).join(', ')}.`
        : 'No AVA harness MCP server was found.',
    );
  }
  return { key: candidates[0][0], config: candidates[0][1] };
}

function resolveMcpCredentials(options = {}) {
  const configPath = path.resolve(options.configPath || defaultConfigPath());
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Cursor MCP config not found at ${configPath}.`);
    if (error instanceof SyntaxError) throw new Error(`Cursor MCP config at ${configPath} is malformed JSON.`);
    throw new Error(`Unable to read Cursor MCP config at ${configPath}.`);
  }
  const { key, config } = selectHarness(parsed.mcpServers, configPath);
  const env = config?.env;
  if (!env || typeof env !== 'object') {
    throw new Error(`AVA harness "${key}" has no env configuration.`);
  }
  const clientId = firstValue(env, ['GENESYS_CLIENT_ID', 'AVA_CLIENT_ID']);
  const clientSecret = firstValue(env, ['GENESYS_CLIENT_SECRET', 'AVA_CLIENT_SECRET']);
  const habitat = firstValue(env, ['AVA_HABITAT']);
  const missing = [];
  if (!clientId) missing.push('GENESYS_CLIENT_ID or AVA_CLIENT_ID');
  if (!clientSecret) missing.push('GENESYS_CLIENT_SECRET or AVA_CLIENT_SECRET');
  if (!habitat) missing.push('AVA_HABITAT');
  if (missing.length) {
    throw new Error(`AVA harness "${key}" is missing or has placeholder values for: ${missing.join(', ')}.`);
  }
  return { clientId, clientSecret, habitat, configPath, serverKey: key };
}

module.exports = {
  defaultConfigPath,
  firstValue,
  looksLikeHarness,
  nonPlaceholder,
  resolveMcpCredentials,
  selectHarness,
};
