import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { probeProvider, runRoleRequest } from './core.mjs';

const host = '127.0.0.1';
const port = Number(process.env.NAVA_MODEL_BRIDGE_PORT || 4174);
const token = String(process.env.NAVA_MODEL_BRIDGE_TOKEN || randomBytes(32).toString('base64url'));
const allowedExtensionId = String(process.env.NAVA_EXTENSION_ID || '').trim();
const maxConcurrent = Math.max(1, Math.min(6, Number(process.env.NAVA_MODEL_BRIDGE_CONCURRENCY || 3)));
let activeRequests = 0;

function tokenMatches(candidate) {
  const expected = createHash('sha256').update(token).digest();
  const actual = createHash('sha256').update(String(candidate || '')).digest();
  return timingSafeEqual(expected, actual);
}

function originAllowed(origin) {
  if (!origin) return true;
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
  return !allowedExtensionId || origin === `chrome-extension://${allowedExtensionId}`;
}

function corsHeaders(request) {
  const origin = String(request.headers.origin || '');
  return originAllowed(origin) && origin
    ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Private-Network': 'true',
      Vary: 'Origin',
    }
    : {};
}

function reply(request, response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(request),
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new Error('The request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('The request body must be valid JSON.');
  }
}

const server = createServer(async (request, response) => {
  if (!originAllowed(request.headers.origin)) {
    reply(request, response, 403, { ok: false, error: 'This browser origin is not allowed.' });
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }
  const authorization = String(request.headers.authorization || '');
  if (!tokenMatches(authorization.replace(/^Bearer\s+/i, ''))) {
    reply(request, response, 401, { ok: false, error: 'The model-companion pairing token is invalid.' });
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    const [codex, claude] = await Promise.all([probeProvider('codex'), probeProvider('claude')]);
    reply(request, response, 200, { ok: true, providers: { codex, claude }, activeRequests, maxConcurrent });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/role') {
    reply(request, response, 404, { ok: false, error: 'Not found.' });
    return;
  }
  if (activeRequests >= maxConcurrent) {
    reply(request, response, 429, { ok: false, error: 'The model companion is busy. Try this page again shortly.' });
    return;
  }
  activeRequests += 1;
  try {
    const result = await runRoleRequest(await readJson(request));
    reply(request, response, 200, { ok: true, ...result });
  } catch (error) {
    reply(request, response, 400, { ok: false, error: String(error?.message || 'The local model call failed.').slice(0, 800) });
  } finally {
    activeRequests -= 1;
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Nava subscription model companion\n`);
  process.stdout.write(`Listening: http://${host}:${port}\n`);
  process.stdout.write(`Pairing token: ${token}\n`);
  process.stdout.write('The token is kept only in Chrome session storage. Stop with Ctrl-C.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

