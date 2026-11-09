'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFERRED_SERVER_KEYS = Object.freeze(['ava-harness', 'user-ava-harness']);

const PLACEHOLDER_PATTERNS = [
  /^\$\{[^}]+\}$/,
  /^\{\{[^}]+\}\}$/,
  /^<[^>]+>$/,
  /^YOUR_/i,
  /^REPLACE_/i,
  /^CHANGEME/i,
  /^TODO/i,
  /^INSERT_/i,
  /^PUT_/i,
];

function defaultMcpConfigPath() {
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

function isPlaceholder(value) {
  const trimmed = String(value).trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function readEnvValue(env, keys) {
  for (const key of keys) {
    const value = env[key];
    if (value != null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

function isAvaMcpServer(serverConfig) {
  if (!serverConfig || typeof serverConfig !== 'object') return false;
  const command = String(serverConfig.command || '').toLowerCase();
  const args = Array.isArray(serverConfig.args)
    ? serverConfig.args.map(String).join(' ').toLowerCase()
    : '';
  const combined = `${command} ${args}`;
  return combined.includes('ava-mcp') || combined.includes('ava_mcp');
}

function selectAvaHarnessServer(mcpServers, configPath) {
  if (!mcpServers || typeof mcpServers !== 'object') {
    throw new Error(`Cursor MCP config at ${configPath} is missing mcpServers.`);
  }

  const preferredFound = PREFERRED_SERVER_KEYS.filter((key) => mcpServers[key]);
  if (preferredFound.length > 1) {
    throw new Error(
      `Ambiguous AVA harness MCP server in ${configPath}: multiple preferred keys found (${preferredFound.join(', ')}).`,
    );
  }
  if (preferredFound.length === 1) {
    return { key: preferredFound[0], config: mcpServers[preferredFound[0]] };
  }

  const candidates = Object.entries(mcpServers).filter(([, cfg]) => isAvaMcpServer(cfg));
  if (candidates.length === 0) {
    throw new Error(
      `No AVA harness MCP server found in ${configPath}. Configure ava-harness or user-ava-harness.`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous AVA harness MCP server in ${configPath}: multiple ava-mcp servers found (${candidates.map(([key]) => key).join(', ')}).`,
    );
  }
  return { key: candidates[0][0], config: candidates[0][1] };
}

function loadMcpConfig(configPath = defaultMcpConfigPath()) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`Cursor MCP config not found at ${configPath}.`);
    }
    throw new Error(`Unable to read Cursor MCP config at ${configPath}.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Cursor MCP config at ${configPath} contains malformed JSON.`);
  }

  const { key, config } = selectAvaHarnessServer(parsed.mcpServers, configPath);
  const env = config?.env;
  if (!env || typeof env !== 'object') {
    throw new Error(`AVA harness MCP server "${key}" in ${configPath} is missing env configuration.`);
  }

  return { configPath, serverKey: key, env, launch: launchCommandOf(config) };
}

function launchCommandOf(config) {
  const args = Array.isArray(config?.args) ? config.args.join(' ') : '';
  return `${config?.command || ''} ${args}`.trim();
}

function parseShellEnvFile(filePath) {
  const values = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return values;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim().replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * Some AVA harness entries do not carry credentials in their `env` map. Instead their launch
 * command sources a file and re-exports the values, for example:
 *   set -a; source '/path/.env.local'; export GENESYS_CLIENT_ID="$GENESYSCLOUD_OAUTHCLIENT_ID"
 * Follow only the indirection that entry declares: read the files it names, and resolve the
 * variables it maps onto the credential names. Nothing outside the harness entry is consulted.
 */
function credentialsFromLaunchCommand(launch, configPath, names) {
  if (!launch) return {};

  const sourced = {};
  const sourceRe = /(?:^|[;&\s])(?:source|\.)\s+(?:'([^']+)'|"([^"]+)"|(\S+))/g;
  let match;
  while ((match = sourceRe.exec(launch)) !== null) {
    const candidate = match[1] || match[2] || match[3];
    if (!candidate || candidate.includes('$')) continue;
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(path.dirname(configPath), candidate);
    Object.assign(sourced, parseShellEnvFile(resolved));
  }
  if (Object.keys(sourced).length === 0) return {};

  // A single `export` can carry several assignments, e.g.
  //   export GENESYS_CLIENT_ID="$A" GENESYS_CLIENT_SECRET="$B"
  const exported = {};
  const exportRe = /export\s+((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;]+)\s*)+)/g;
  const assignmentRe = /([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;]+))/g;
  while ((match = exportRe.exec(launch)) !== null) {
    let assignment;
    assignmentRe.lastIndex = 0;
    while ((assignment = assignmentRe.exec(match[1])) !== null) {
      const literal = assignment[2] !== undefined ? assignment[2]
        : assignment[3] !== undefined ? assignment[3] : assignment[4];
      const indirect = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(literal);
      exported[assignment[1]] = indirect ? sourced[indirect[1]] : literal;
    }
  }

  const resolved = {};
  for (const name of names) {
    const value = exported[name] !== undefined ? exported[name] : sourced[name];
    if (value !== undefined) resolved[name] = value;
  }
  return resolved;
}

function resolveMcpCredentials(options = {}) {
  const configPath = options.configPath || defaultMcpConfigPath();
  const { env, serverKey, launch } = loadMcpConfig(configPath);

  const ID_KEYS = ['GENESYS_CLIENT_ID', 'AVA_CLIENT_ID'];
  const SECRET_KEYS = ['GENESYS_CLIENT_SECRET', 'AVA_CLIENT_SECRET'];
  const HABITAT_KEYS = ['AVA_HABITAT'];

  let clientId = readEnvValue(env, ID_KEYS);
  let clientSecret = readEnvValue(env, SECRET_KEYS);
  let habitat = readEnvValue(env, HABITAT_KEYS);

  if (!clientId || !clientSecret) {
    const fromLaunch = credentialsFromLaunchCommand(
      launch, configPath, [...ID_KEYS, ...SECRET_KEYS, ...HABITAT_KEYS],
    );
    clientId = clientId || readEnvValue(fromLaunch, ID_KEYS);
    clientSecret = clientSecret || readEnvValue(fromLaunch, SECRET_KEYS);
    habitat = habitat || readEnvValue(fromLaunch, HABITAT_KEYS);
  }

  const missing = [];
  if (!clientId || isPlaceholder(clientId)) {
    missing.push('GENESYS_CLIENT_ID or AVA_CLIENT_ID');
  }
  if (!clientSecret || isPlaceholder(clientSecret)) {
    missing.push('GENESYS_CLIENT_SECRET or AVA_CLIENT_SECRET');
  }
  if (!habitat || isPlaceholder(habitat)) {
    missing.push('AVA_HABITAT');
  }

  if (missing.length) {
    throw new Error(
      `Genesys Cloud credentials incomplete in AVA harness MCP env (${serverKey}) at ${configPath}. Missing or placeholder: ${missing.join(', ')}.`,
    );
  }

  return {
    clientId,
    clientSecret,
    habitat,
    configPath,
    serverKey,
  };
}

function credentialRedactionValues(options = {}) {
  try {
    const { clientId, clientSecret } = resolveMcpCredentials(options);
    return [clientId, clientSecret];
  } catch {
    return [];
  }
}

module.exports = {
  PREFERRED_SERVER_KEYS,
  credentialRedactionValues,
  defaultMcpConfigPath,
  isAvaMcpServer,
  isPlaceholder,
  loadMcpConfig,
  resolveMcpCredentials,
  selectAvaHarnessServer,
};
