'use strict';
// ─── MINI-LIBRERÍA DE ESQUEMAS (FASE 2) ──────────────────────────────────────
// Validación declarativa sin dependencias, con una API inspirada en zod:
//
//   const schema = s.object({ name: s.string().max(100).optional() });
//   const r = schema.safeParse(input); // { success, data } | { success:false, error:{ issues } }
//
// Cada esquema es inmutable: los métodos encadenados devuelven uno nuevo.
// Objetos: las claves desconocidas se descartan (como z.object por defecto).

class Schema {
  constructor(check, opts = {}) {
    this._check = check;          // (value, path) => { ok, value } | { ok:false, issues }
    this._optional = Boolean(opts.optional);
    this._nullable = Boolean(opts.nullable);
    this._default = opts.default;
    this._steps = opts.steps || []; // refinamientos/transformaciones tras _check
  }

  _clone(patch) {
    const next = new Schema(this._check, {
      optional: this._optional, nullable: this._nullable, default: this._default, steps: this._steps, ...patch,
    });
    next._requiredMessage = this._requiredMessage;
    return next;
  }

  optional() { return this._clone({ optional: true }); }
  nullable() { return this._clone({ nullable: true }); }
  nullish() { return this._clone({ optional: true, nullable: true }); }
  default(value) { return this._clone({ optional: true, default: value }); }

  refine(predicate, message = 'Valor no válido', path = []) {
    return this._clone({ steps: [...this._steps, { kind: 'refine', predicate, message, path }] });
  }

  transform(fn) {
    return this._clone({ steps: [...this._steps, { kind: 'transform', fn }] });
  }

  _run(value, path) {
    if (value === undefined) {
      if (this._default !== undefined) value = typeof this._default === 'function' ? this._default() : this._default;
      else if (this._optional) return this._applySteps(undefined, path, true);
      else return fail(path, this._requiredMessage || 'Campo obligatorio');
    }
    if (value === null && this._nullable) return this._applySteps(null, path, true);
    const res = this._check(value, path);
    if (!res.ok) return res;
    return this._applySteps(res.value, path, false);
  }

  _applySteps(value, path, isEmpty) {
    let current = value;
    for (const step of this._steps) {
      if (step.kind === 'transform') {
        current = step.fn(current);
      } else if (!isEmpty || step.runOnEmpty) {
        let ok;
        try { ok = step.predicate(current); } catch { ok = false; }
        if (!ok) return fail([...path, ...step.path], typeof step.message === 'function' ? step.message(current) : step.message);
      }
    }
    return { ok: true, value: current };
  }

  safeParse(value) {
    const res = this._run(value, []);
    return res.ok ? { success: true, data: res.value } : { success: false, error: { issues: res.issues } };
  }

  parse(value) {
    const res = this.safeParse(value);
    if (!res.success) {
      const err = new Error(res.error.issues[0] ? res.error.issues[0].message : 'Datos no válidos');
      err.issues = res.error.issues;
      throw err;
    }
    return res.data;
  }

  required(message) {
    const next = this._clone({});
    next._requiredMessage = message;
    return next;
  }
}

function fail(path, message) {
  return { ok: false, issues: [{ path: [...path], message }] };
}

// Añade a un esquema base métodos específicos que encadenan refinamientos.
function withMethods(schema, methods) {
  const wrapAll = (sch) => {
    for (const [name, fn] of Object.entries(methods)) {
      sch[name] = (...args) => wrapAll(fn(sch, ...args));
    }
    for (const name of ['optional', 'nullable', 'nullish', 'default', 'refine', 'transform', 'required']) {
      const original = Schema.prototype[name];
      sch[name] = (...args) => wrapAll(original.apply(sch, args));
    }
    return sch;
  };
  return wrapAll(schema);
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const s = {
  string(message = 'Debe ser un texto') {
    const base = new Schema((v, path) => (typeof v === 'string' ? { ok: true, value: v } : fail(path, message)));
    return withMethods(base, {
      min: (sch, n, msg) => sch.refine(v => v.length >= n, msg || `Debe tener al menos ${n} caracteres`),
      max: (sch, n, msg) => sch.refine(v => v.length <= n, msg || `No puede superar ${n} caracteres`),
      regex: (sch, re, msg) => sch.refine(v => re.test(v), msg || 'Formato no válido'),
      nonEmpty: (sch, msg) => sch.refine(v => v.trim().length > 0, msg || 'No puede estar vacío'),
      trim: (sch) => sch.transform(v => (typeof v === 'string' ? v.trim() : v)),
    });
  },

  number(message = 'Debe ser un número') {
    const base = new Schema((v, path) => (typeof v === 'number' && Number.isFinite(v) ? { ok: true, value: v } : fail(path, message)));
    return withMethods(base, numberMethods);
  },

  // Acepta números o cadenas numéricas ("12.5"); rechaza '', null, booleanos.
  coerceNumber(message = 'Debe ser un número') {
    const base = new Schema((v, path) => {
      if (typeof v === 'number' && Number.isFinite(v)) return { ok: true, value: v };
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return { ok: true, value: Number(v) };
      return fail(path, message);
    });
    return withMethods(base, numberMethods);
  },

  boolean(message = 'Debe ser verdadero o falso') {
    return withMethods(new Schema((v, path) => (typeof v === 'boolean' ? { ok: true, value: v } : fail(path, message))), {});
  },

  literal(expected, message) {
    return withMethods(new Schema((v, path) => (v === expected ? { ok: true, value: v } : fail(path, message || `Debe ser ${JSON.stringify(expected)}`))), {});
  },

  array(item, message = 'Debe ser una lista') {
    const base = new Schema((v, path) => {
      if (!Array.isArray(v)) return fail(path, message);
      const out = [];
      for (let i = 0; i < v.length; i++) {
        const r = item._run(v[i], [...path, i]);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    });
    return withMethods(base, {
      max: (sch, n, msg) => sch.refine(v => v.length <= n, msg || `La lista no puede tener más de ${n} elementos`),
      min: (sch, n, msg) => sch.refine(v => v.length >= n, msg || `La lista debe tener al menos ${n} elementos`),
    });
  },

  // Objeto: valida cada clave declarada y DESCARTA las desconocidas.
  object(shape, message = 'Debe ser un objeto') {
    const base = new Schema((v, path) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(path, message);
      const out = {};
      for (const [key, sch] of Object.entries(shape)) {
        const r = sch._run(Object.prototype.hasOwnProperty.call(v, key) ? v[key] : undefined, [...path, key]);
        if (!r.ok) return r;
        if (r.value !== undefined) out[key] = r.value;
      }
      return { ok: true, value: out };
    });
    return withMethods(base, {});
  },

  // Primer esquema que valide gana. Si ninguno, se informa `message` o el
  // error del primero.
  union(options, message) {
    const base = new Schema((v, path) => {
      let firstFail = null;
      for (const opt of options) {
        const r = opt._run(v, path);
        if (r.ok) return r;
        if (!firstFail) firstFail = r;
      }
      return message ? fail(path, message) : firstFail || fail(path, `Tipo no válido (${typeName(v)})`);
    }, { optional: options.some(o => o._optional), nullable: options.some(o => o._nullable) });
    return withMethods(base, {});
  },
};

const numberMethods = {
  int: (sch, msg) => sch.refine(v => Number.isInteger(v), msg || 'Debe ser un número entero'),
  min: (sch, n, msg) => sch.refine(v => v >= n, msg || `Debe ser mayor o igual que ${n}`),
  max: (sch, n, msg) => sch.refine(v => v <= n, msg || `Debe ser menor o igual que ${n}`),
  positive: (sch, msg) => sch.refine(v => v > 0, msg || 'Debe ser positivo'),
};

module.exports = { s, Schema };
