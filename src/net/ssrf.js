'use strict';
// ─── PROTECCIÓN SSRF PARA DESCARGAS SALIENTES ────────────────────────────────
// AUTH-05: las URLs de portadas llegan del cliente (import / download-single).
// Se bloquean destinos privados (RFC 1918, loopback, link-local, CGNAT/Tailscale
// 100.64.0.0/10, ULA IPv6...) tanto en la URL literal como tras resolver DNS
// en el propio momento de conexión (evita DNS rebinding), con timeout y límite
// de tamaño.

const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');

const IPV4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

const IPV4_RANGES = IPV4_BLOCKS.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network: (ipv4ToInt(base) & mask) >>> 0, mask };
});

function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  return IPV4_RANGES.some(({ network, mask }) => ((n & mask) >>> 0) === network);
}

// Expande una IPv6 a 8 grupos de 16 bits. Devuelve null si no es válida.
function expandIPv6(ip) {
  let addr = ip.toLowerCase().split('%')[0];
  let tailV4 = null;
  const v4Match = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4Match) {
    tailV4 = v4Match[1];
    if (!net.isIPv4(tailV4)) return null;
    const n = ipv4ToInt(tailV4);
    addr = addr.slice(0, -tailV4.length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
  }
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map(g => Number.parseInt(g || '0', 16));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (!net.isIPv6(ip)) return true; // desconocido → bloquear
  const g = expandIPv6(ip);
  if (!g) return true;
  if (g.every(x => x === 0)) return true;                                   // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;         // ::1
  // IPv4 mapeada (::ffff:a.b.c.d) o compatible (::a.b.c.d)
  const embedded = () => `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateIPv4(embedded());
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateIPv4(embedded());   // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true;                              // fc00::/7 (incl. Tailscale)
  if ((g[0] & 0xffc0) === 0xfe80) return true;                              // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true;                              // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                      // documentación
  return false;
}

const BLOCKED_HOST_SUFFIXES = ['localhost', '.localhost', '.local', '.internal', '.lan', '.home.arpa', '.ts.net'];

function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return BLOCKED_HOST_SUFFIXES.some(s => (s.startsWith('.') ? h.endsWith(s) : h === s));
}

// lookup() que se ejecuta al abrir el socket: valida TODAS las IPs resueltas.
function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0) return callback(new Error(`Sin direcciones para ${hostname}`));
    if (list.some(a => isPrivateAddress(a.address))) {
      const blocked = new Error(`Destino bloqueado por la política SSRF: ${hostname}`);
      blocked.code = 'ESSRFBLOCKED';
      return callback(blocked);
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const httpAgent = new http.Agent({ lookup: guardedLookup, keepAlive: false });
const httpsAgent = new https.Agent({ lookup: guardedLookup, keepAlive: false });

function assertPublicUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('URL no válida'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Protocolo no permitido');
  if (url.username || url.password) throw new Error('URL con credenciales no permitida');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('Destino privado no permitido');
  if (!net.isIP(host) && isBlockedHostname(host)) throw new Error('Host interno no permitido');
  return url;
}

/**
 * Descarga un recurso público con salvaguardas SSRF.
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function safeFetch(rawUrl, { fetchImpl, timeoutMs = 10000, maxBytes = 5 * 1024 * 1024, accept = null, maxRedirects = 3 } = {}) {
  const fetch = fetchImpl || require('node-fetch');
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.href, {
        redirect: 'manual',
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
        signal: controller.signal,
        size: maxBytes,
        headers: { 'User-Agent': 'MusicaPrivada/2.0' },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`Redirección ${res.status} sin Location`);
        current = new URL(location, url).href;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (accept && !accept.test(contentType)) throw new Error(`Tipo de contenido no permitido: ${contentType || 'desconocido'}`);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Respuesta demasiado grande');
      const buffer = await res.buffer();
      if (buffer.length > maxBytes) throw new Error('Respuesta demasiado grande');
      return { buffer, contentType };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Demasiadas redirecciones');
}

module.exports = { isPrivateAddress, isBlockedHostname, assertPublicUrl, safeFetch, guardedLookup, expandIPv6 };
