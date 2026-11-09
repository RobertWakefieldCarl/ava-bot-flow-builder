'use strict';

class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = details.status || 0;
    this.code = details.code || null;
    this.contextId = details.contextId || null;
    this.details = details.details || null;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      contextId: this.contextId,
      details: this.details,
    };
  }
}

const SECRET_KEY = /token|secret|authorization|credential|password/i;

function sanitizedText(value, secrets = []) {
  let output = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join('[REDACTED]');
  return output
    .replace(/(authorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, '$1[REDACTED]')
    .replace(/("(?:access_token|client_secret|password)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .slice(0, 2000);
}

function sanitizedValue(value, secrets = [], depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizedText(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizedValue(item, secrets, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : sanitizedValue(child, secrets, depth + 1);
    }
    return output;
  }
  return sanitizedText(value, secrets);
}

async function responseBody(response, secrets) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return sanitizedText(text, secrets);
  }
}

function errorFromResponse(response, body, operation, secrets) {
  const object = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return new ApiError(sanitizedText(object.message || `${operation} failed`, secrets), {
    status: response.status,
    code: object.code || null,
    contextId: object.contextId
      || response.headers.get('inin-correlation-id')
      || response.headers.get('x-correlation-id')
      || null,
    details: sanitizedValue({
      details: object.details,
      errors: object.errors,
      response: typeof body === 'string' ? body : undefined,
    }, secrets),
  });
}

class GenesysClient {
  constructor({ region, clientId, clientSecret, fetchImpl = globalThis.fetch, sleep, timeoutMs = 30000 }) {
    if (!region?.apiBase || !region?.loginBase) throw new Error('A normalized Genesys region is required.');
    if (typeof fetchImpl !== 'function') throw new Error('Node.js 22 native fetch is required.');
    this.region = region;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = timeoutMs;
    this.accessToken = null;
    this.expiresAt = 0;
    this.extraSecrets = [];
  }

  /** Register a caller-supplied secret so it is scrubbed from any output. */
  addSecret(value) {
    if (typeof value === 'string' && value !== '') this.extraSecrets.push(value);
  }

  get secrets() {
    return [this.clientId, this.clientSecret, this.accessToken, ...this.extraSecrets].filter(Boolean);
  }

  async authenticate(force = false) {
    if (!force && this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken;
    const response = await this.fetch(`${this.region.loginBase}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await responseBody(response, this.secrets);
    if (!response.ok) throw errorFromResponse(response, body, 'OAuth authentication', this.secrets);
    if (!body?.access_token) throw new ApiError('OAuth response did not contain an access token.');
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return this.accessToken;
  }

  async request(method, apiPath, options = {}) {
    const upperMethod = method.toUpperCase();
    if (!apiPath.startsWith('/api/v2/')) throw new Error(`Refusing non-Platform-API path: ${apiPath}`);
    const url = new URL(apiPath, `${this.region.apiBase}/`);
    for (const [key, raw] of Object.entries(options.query || {})) {
      if (raw === undefined || raw === null || raw === '') continue;
      // Routing filters such as id and divisionId are collectionFormat "multi",
      // so each value must be repeated rather than comma-joined. The operation
      // builder pre-joins any csv-format parameter into a string.
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item === undefined || item === null || item === '') continue;
          url.searchParams.append(key, String(item));
        }
      } else url.searchParams.set(key, String(raw));
    }
    const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(upperMethod);
    const maxRetries = options.retries ?? (idempotent ? 3 : 0);
    let refreshed = false;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const token = await this.authenticate();
      let response;
      try {
        response = await this.fetch(url, {
          method: upperMethod,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (idempotent && attempt < maxRetries) {
          await this.sleep(Math.min(1000 * (2 ** attempt), 5000));
          continue;
        }
        throw new ApiError(`${upperMethod} ${apiPath} failed before receiving a response.`, {
          details: sanitizedText(error.message, this.secrets),
        });
      }
      const body = await responseBody(response, this.secrets);
      if (response.ok) {
        return {
          status: response.status,
          body,
          contextId: response.headers.get('inin-correlation-id') || response.headers.get('x-correlation-id'),
        };
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.accessToken = null;
        this.expiresAt = 0;
        await this.authenticate(true);
        attempt -= 1;
        continue;
      }
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(1000 * (2 ** attempt), 5000));
        continue;
      }
      if (idempotent && response.status >= 500 && attempt < maxRetries) {
        await this.sleep(Math.min(1000 * (2 ** attempt), 5000));
        continue;
      }
      throw errorFromResponse(response, body, `${upperMethod} ${apiPath}`, this.secrets);
    }
    throw new ApiError(`${upperMethod} ${apiPath} exhausted retries.`);
  }
}

module.exports = {
  ApiError,
  GenesysClient,
  sanitizedText,
  sanitizedValue,
};
