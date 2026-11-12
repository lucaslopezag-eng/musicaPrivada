'use strict';
// ─── VALIDACIÓN DE ENTRADA CENTRALIZADA (FASE 2) ─────────────────────────────
// Todos los endpoints de mutación declaran el esquema de su cuerpo, parámetros
// y query aquí. El middleware `validate()` responde 400 con un mensaje claro y
// deja en req.body el objeto ya validado (sin claves desconocidas) y en
// req.valid los parámetros/query convertidos (ids → número).
// Las comprobaciones de propiedad (AUTH-04) y de negocio siguen en las rutas.

const { s } = require('./schema');

// Id positivo: número entero o cadena de dígitos ("12" llega de un <select>).
const id = s.union([
  s.number().int().positive(),
  s.string().regex(/^\d{1,15}$/).transform(Number),
], 'Identificador no válido').refine(n => Number.isSafeInteger(n) && n > 0, 'Identificador no válido');

// Id opcional: '' / null / ausente → null.
const optionalId = s.union([id, s.literal('')], 'Identificador no válido')
  .nullish()
  .transform(v => (v === '' || v === null || v === undefined ? null : v));

const schemas = {
  // ─── Autenticación ──────────────────────────────────────────────────────────
  login: s.object({
    username: s.string().max(64).required('Falta el usuario'),
    password: s.string().max(1024).required('Falta la contraseña'),
  }),
  changePassword: s.object({
    currentPassword: s.string().min(1, 'Falta la contraseña actual').max(1024).required('Falta la contraseña actual'),
    newPassword: s.string().max(1024).required('Falta la nueva contraseña'),
    revokeOtherSessions: s.boolean().optional(),
  }),
  sessionIdParams: s.object({
    id: s.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Sesión no válida').required('Sesión no válida'),
  }),

  // ─── Parámetros genéricos ──────────────────────────────────────────────────
  idParams: s.object({ id: id.required('Identificador no válido') }),
  playlistSongParams: s.object({ playlistId: id, songId: id }),

  // ─── Canciones ─────────────────────────────────────────────────────────────
  reorder: s.object({
    orderedIds: s.array(id, 'orderedIds no válido').max(20000, 'orderedIds no válido').required('orderedIds no válido'),
  }),
  trim: s.object({
    startTime: s.coerceNumber('startTime no válido').min(0, 'startTime no puede ser negativo').required('Falta startTime'),
    endTime: s.coerceNumber('endTime no válido').required('Falta endTime'),
    rev: s.number().int().min(0).nullish(),
  }).refine(b => b.endTime - b.startTime >= 0.5, 'startTime/endTime no válidos (startTime < endTime, mínimo 0,5 s).'),

  // ─── Playlists ─────────────────────────────────────────────────────────────
  playlistCreate: s.object({
    name: s.string().max(500).nullish(),
    cover_url: s.string().max(2000).nullish(),
  }),
  playlistAddSong: s.object({ songId: id.required('Falta songId') }),

  // ─── Estadísticas ──────────────────────────────────────────────────────────
  listen: s.object({
    song_id: s.union([id, s.string().regex(/^ai-\d{1,15}$/)], 'song_id no válido').required('Falta song_id'),
    listen_duration_ms: s.coerceNumber().min(0).nullish(),
    completed: s.union([s.boolean(), s.number()]).nullish().transform(v => Boolean(v)),
    skip_at_ms: s.coerceNumber().nullish(),
    playlist_id: optionalId,
  }),

  // ─── Importación y descargas ───────────────────────────────────────────────
  import: s.object({
    // El límite fino (2 MB → 413) lo aplica la ruta; aquí solo tipo y contenido.
    tracksText: s.string('No se han indicado canciones').nonEmpty('No se han indicado canciones').required('No se han indicado canciones'),
    playlistId: optionalId,
  }),
  downloadSingle: s.object({
    url: s.string('Solo se admiten URLs https de YouTube').max(2048, 'URL demasiado larga').required('Falta la URL'),
    title: s.string('Título no válido').max(300, 'Título no válido').nonEmpty('Título no válido').required('Título no válido'),
    artist: s.string().max(300).nullish().transform(v => v || ''),
    coverUrl: s.string().max(2048).nullish(),
    replaceId: optionalId,
    playlistId: optionalId,
  }),
  searchQuery: s.object({
    q: s.string('Falta la consulta').trim().refine(q => q.length > 0, 'Falta la consulta')
      .transform(q => q.slice(0, 200)).required('Falta la consulta'),
  }),
  taskIdParams: s.object({ id: s.string().regex(/^[a-f0-9]{8,32}$/, 'Tarea no válida').required('Tarea no válida') }),

  // ─── Recomendaciones IA ────────────────────────────────────────────────────
  aiGenerate: s.object({
    count: s.coerceNumber().int().min(1).max(50).nullish(),
  }),

  // ─── Worker de subtítulos ──────────────────────────────────────────────────
  workerJobQuery: s.object({
    job: s.string().max(64).optional(),
    file: s.string().max(2048).optional(),
    audioPath: s.string().max(2048).optional(),
  }),
  // ─── Fondo de pantalla ─────────────────────────────────────────────────────
  backgroundOpacity: s.object({
    opacity: s.number('Opacidad no válida').refine(n => Number.isInteger(n) && n >= 0 && n <= 100, 'Opacidad no válida (0-100)').required('Falta la opacidad'),
  }),
  wrappedQuery: s.object({
    year: s.string().regex(/^(all|\d{4})$/, 'Año no válido').optional(),
  }),
};

function describeIssues(issues = []) {
  const details = issues.slice(0, 10).map(i => ({ path: i.path.join('.'), message: i.message }));
  return { message: details[0] ? details[0].message : 'Datos no válidos', details };
}

// validate({ body, params, query }) → middleware Express.
function validate(spec) {
  return function validationMiddleware(req, res, next) {
    req.valid = req.valid || {};
    for (const part of ['params', 'query', 'body']) {
      const schema = spec[part];
      if (!schema) continue;
      let input = req[part];
      if (part === 'body' && (input === undefined || input === null || input === '')) input = {};
      if (part === 'body' && (typeof input !== 'object' || Array.isArray(input) || Buffer.isBuffer(input))) {
        return res.status(400).json({ error: 'El cuerpo de la petición debe ser un objeto JSON' });
      }
      const result = schema.safeParse(input || {});
      if (!result.success) {
        const { message, details } = describeIssues(result.error.issues);
        return res.status(400).json({ error: message, details });
      }
      req.valid[part] = result.data;
      // req.query es de solo lectura en Express 5; el cuerpo sí se sustituye.
      if (part === 'body') req.body = result.data;
    }
    return next();
  };
}

module.exports = { schemas, validate, describeIssues };
