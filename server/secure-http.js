/* ============================================================
   HTTPS JSON client with TLS 1.3 enforcement.
   Used for biometric vendor and permissioned-ledger adapters.
   ============================================================ */

const fs = require('fs');
const http = require('http');
const https = require('https');

function readOptionalFile(filePath) {
  return filePath ? fs.readFileSync(filePath) : undefined;
}

function requestJson(urlValue, options = {}) {
  const url = new URL(urlValue);
  const isHttps = url.protocol === 'https:';
  const allowHttp = options.allowHttp === true;

  if (!isHttps && !allowHttp) {
    throw new Error('External integration URL must use HTTPS.');
  }

  const body = options.body == null
    ? null
    : Buffer.from(JSON.stringify(options.body), 'utf8');

  const headers = {
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
    ...(options.headers || {}),
  };

  const transport = isHttps ? https : http;
  const agent = isHttps
    ? new https.Agent({
        minVersion: 'TLSv1.3',
        cert: readOptionalFile(options.clientCertPath),
        key: readOptionalFile(options.clientKeyPath),
        ca: readOptionalFile(options.caPath),
        rejectUnauthorized: options.rejectUnauthorized !== false,
      })
    : undefined;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: options.method || 'GET',
        headers,
        agent,
        timeout: options.timeoutMs || 15000,
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            return reject(new Error(`Integration returned malformed JSON (HTTP ${res.statusCode}).`));
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Integration returned HTTP ${res.statusCode}: ${data.error || data.message || 'Request failed'}`));
          }

          resolve({ statusCode: res.statusCode, headers: res.headers, data });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Integration request timed out.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { requestJson };
