'use strict';
// ─── CABECERAS DE SEGURIDAD (FASE 2) ─────────────────────────────────────────
// helmet con una Content-Security-Policy estricta compatible con la PWA:
//   · script-src 'self'  → sin scripts inline (el único que había en index.html
//     se movió a /install-prompt.js) ni eval.
//   · style-src 'self' 'unsafe-inline' + Google Fonts → la UI usa atributos
//     style de React (los temas se aplican con variables CSS).
//   · img-src https: → portadas de YouTube/Spotify/Last.fm en búsquedas y playlists.
//   · media-src 'self' blob: → streaming propio + audio silencioso keep-alive.
//   · worker-src 'self' → Service Worker; connect-src 'self' → API.
//   · frame-ancestors 'none' + X-Frame-Options: DENY → sin clickjacking.
//   · Sin upgrade-insecure-requests: rompería el acceso por http en la LAN.
// Si helmet no está instalado se envían cabeceras equivalentes a mano, para
// que el servidor nunca arranque sin ellas.

const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  mediaSrc: ["'self'", 'blob:'],
  connectSrc: ["'self'"],
  workerSrc: ["'self'"],
  manifestSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameSrc: ["'none'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
};

const PERMISSIONS_POLICY = [
  'camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()',
  'magnetometer=()', 'gyroscope=()', 'accelerometer=()', 'browsing-topics=()',
].join(', ');

const HSTS_MAX_AGE = 180 * 24 * 60 * 60;

function kebab(name) {
  return name.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
}

function buildCsp(directives = CSP_DIRECTIVES) {
  return Object.entries(directives).map(([k, v]) => `${kebab(k)} ${v.join(' ')}`).join('; ');
}

function helmetOptions({ reportOnly = false } = {}) {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: CSP_DIRECTIVES,
      reportOnly,
    },
    // COEP bloquearía las portadas externas (no envían CORP).
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'same-origin' },
    // Sin includeSubDomains: otros servicios del mismo dominio pueden ir por http.
    strictTransportSecurity: { maxAge: HSTS_MAX_AGE, includeSubDomains: false },
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    xDnsPrefetchControl: { allow: false },
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xXssProtection: true,
  };
}

// Mismas cabeceras sin helmet.
function manualHeaders({ reportOnly = false } = {}) {
  const csp = buildCsp();
  return function securityHeaders(req, res, next) {
    res.setHeader(reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', csp);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('X-XSS-Protection', '0');
    next();
  };
}

function createSecurityHeaders({ reportOnly = false, log = () => {}, helmetModule } = {}) {
  let helmet = helmetModule;
  if (helmet === undefined) {
    try { helmet = require('helmet'); } catch { helmet = null; }
  }
  const fn = helmet && (typeof helmet === 'function' ? helmet : helmet.default);
  const base = typeof fn === 'function' ? fn(helmetOptions({ reportOnly })) : manualHeaders({ reportOnly });
  if (typeof fn !== 'function') log('[Seguridad] Aviso: "helmet" no está instalado; se envían cabeceras equivalentes sin él (npm install).');
  return function securityHeaders(req, res, next) {
    // helmet no gestiona Permissions-Policy.
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    base(req, res, next);
  };
}

module.exports = { createSecurityHeaders, buildCsp, helmetOptions, CSP_DIRECTIVES, PERMISSIONS_POLICY };
