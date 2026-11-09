'use strict';

const { resolveCredentials, resolveRegion } = require('./genesys_config');

/** Values that must never reach stdout/stderr. */
const redactions = new Set();

function redact(text) {
  let out = String(text);
  for (const value of redactions) {
    if (value) out = out.split(value).join('***');
  }
  return out;
}

class GenesysClient {
  constructor({ region, configPath } = {}) {
    this.region = resolveRegion(region, { configPath });
    const { clientId, clientSecret } = resolveCredentials({ configPath });
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    redactions.add(clientSecret);
    this.token = null;
    this.tokenExpiry = 0;
  }

  async authenticate() {
    if (this.token && Date.now() < this.tokenExpiry - 60_000) return this.token;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(`${this.region.loginBase}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`OAuth token request failed (${res.status}). Check the client id, secret and AVA_HABITAT in the ava-harness MCP entry. ${redact(body)}`);
    }
    const parsed = JSON.parse(body);
    this.token = parsed.access_token;
    this.tokenExpiry = Date.now() + (parsed.expires_in || 3600) * 1000;
    redactions.add(this.token);
    return this.token;
  }

  async request(method, path, body) {
    await this.authenticate();
    const url = path.startsWith('http') ? path : `${this.region.apiBase}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const err = new Error(`${method} ${path} failed (${res.status}): ${redact(typeof parsed === 'string' ? parsed : JSON.stringify(parsed))}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }

  /** Walk `entities` across every page. */
  async getAll(path) {
    const entities = [];
    let pageNumber = 1;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const page = await this.get(`${path}${sep}pageSize=100&pageNumber=${pageNumber}`);
      entities.push(...(page.entities || []));
      const total = page.pageCount != null ? page.pageCount : 1;
      if (pageNumber >= total || !(page.entities || []).length) break;
      pageNumber += 1;
    }
    return entities;
  }

  /** Report the connected org so the caller can prove which one it is about to write to. */
  async whoami() {
    const org = await this.get('/api/v2/organizations/me');
    return { name: org.name, id: org.id, region: this.region.key, apiBase: this.region.apiBase };
  }
}

module.exports = { GenesysClient, redact };
