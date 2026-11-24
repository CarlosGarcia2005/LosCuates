// =====================================================================
//  Manejo controlado de errores
//  - Nunca se muestra al usuario el detalle técnico (stack, SQL, rutas).
//  - Cada error inesperado recibe un código de referencia que también
//    queda en la consola del servidor y en la bitácora.
// =====================================================================
const crypto = require('crypto');
const path = require('path');
const bitacora = require('./bitacora');

class ErrorApp extends Error {
  /**
   * @param {number} estado   código HTTP
   * @param {string} mensaje  texto seguro para mostrar al usuario
   * @param {object} [extra]  { errores: {campo: msg} } para formularios
   */
  constructor(estado, mensaje, extra = {}) {
    super(mensaje);
    this.estado = estado;
    this.extra = extra;
  }
}

const errorValidacion = (errores) =>
  new ErrorApp(400, 'Revisa los campos marcados.', { errores });

/**
 * [OWASP A04] Regla del negocio que protege al sistema de abusos
 * (por ejemplo, apartar muchas canchas sin pagar). Queda en la bitácora como REGLA_NEGOCIO.
 */
const reglaNegocio = (mensaje, errores) => {
  const e = new ErrorApp(409, mensaje, errores ? { errores } : {});
  e.accion = 'REGLA_NEGOCIO';
  return e;
};

/**
 * [OWASP A04] La página valida con el MISMO archivo (public/js/validacion.js)
 * antes de enviar. Si el servidor encuentra un error de esas mismas reglas,
 * la petición no salió de la página normal: alguien se saltó la validación
 * del navegador (consola, Postman, script...). Se rechaza y se registra.
 */
const validacionEvadida = (errores) => {
  const e = errorValidacion(errores);
  e.evadida = true;
  return e;
};

/** Envuelve rutas async para que sus errores lleguen al manejador central. */
const asincrono = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Traduce errores conocidos de SQL Server a mensajes entendibles. */
function traducirErrorSql(err) {
  // config/db.js agrega a cada error de SQL Server su equivalente de MySQL en err.errno;
  // estos son los que no tienen equivalente directo
  switch (err && err.numeroSql) {
    case 2628:
    case 8152: return new ErrorApp(400, 'Uno de los valores es demasiado largo.');
    case 245:
    case 8114: return new ErrorApp(400, 'Uno de los valores no tiene el formato que espera la base de datos.');
    case 515:  return new ErrorApp(400, 'Falta un dato obligatorio.');
    case 229:
    case 230:
    case 262:  return new ErrorApp(403, 'La base de datos no permite esta operación.');
    default:   break;
  }
  switch (err && err.errno) {
    case 1062: return new ErrorApp(409, 'Ya existe un registro con ese valor (por ejemplo, el correo o el nombre ya está en uso).');
    case 1451:
    case 1452: return new ErrorApp(409, 'La operación no se puede realizar porque el registro está relacionado con otros datos.');
    case 1406: return new ErrorApp(400, 'Uno de los valores es demasiado largo.');
    case 3819: return new ErrorApp(400, 'Uno de los valores no cumple las reglas de la base de datos.');
    case 1142:
    case 1644: return new ErrorApp(403, 'La base de datos no permite esta operación.');
    default:   return null;
  }
}

function noEncontrado(req, res) {
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ mensaje: 'Recurso no encontrado.' });
  }
  res.status(404).sendFile(path.join(__dirname, '..', 'views', '404.html'));
}

// eslint-disable-next-line no-unused-vars
async function manejadorErrores(err, req, res, next) {
  // JSON mal formado o demasiado grande
  if (err && err.type === 'entity.parse.failed') err = new ErrorApp(400, 'El formato de los datos enviados no es válido.');
  if (err && err.type === 'entity.too.large') {
    err = new ErrorApp(413, 'Los datos enviados son demasiado grandes.');
    err.accion = 'LIMITE_EXCEDIDO';               // [A04] límite de tamaño por petición
  }

  let error = err instanceof ErrorApp ? err : traducirErrorSql(err);
  let referencia = null;

  if (!error) {
    referencia = crypto.randomBytes(4).toString('hex').toUpperCase();
    console.error(`[ERROR ${referencia}] ${req.method} ${req.originalUrl}`, err);
    error = new ErrorApp(500, `Ocurrió un error inesperado. Código de referencia: ${referencia}`);
  }

  // [A04] Datos que la página nunca habría enviado
  if (error.evadida) {
    const contexto = res.locals.accion || {};
    const campos = Object.keys((error.extra && error.extra.errores) || {});
    await bitacora.registrar(req, {
      accion: 'VALIDACION_EVADIDA', modulo: 'Seguridad', tabla: contexto.tabla, idRegistro: contexto.idRegistro,
      descripcion: `[A04] El servidor rechazó datos que la página valida antes de enviar (se saltó la validación del navegador): ` +
        `${req.method} ${req.originalUrl} · campos: ${campos.join(', ') || '—'}`,
      despues: { errores: error.extra.errores, operacion: contexto.accion || null },
      resultado: 'Fallo'
    });
  }

  // Registrar en bitácora las operaciones que fallaron (si la ruta no lo hizo ya)
  if (!res.locals.bitacoraRegistrada && (error.estado >= 500 || req.method !== 'GET')) {
    const contexto = res.locals.accion || {};
    await bitacora.registrar(req, {
      accion: error.estado >= 500 ? 'ERROR_SERVIDOR' : (error.accion || contexto.accion || 'SOLICITUD_RECHAZADA'),
      modulo: error.accion ? 'Seguridad' : (contexto.modulo || 'Sistema'),
      tabla: contexto.tabla,
      idRegistro: contexto.idRegistro,
      descripcion: (error.accion ? '[A04] ' : '') +
        `${req.method} ${req.originalUrl} → ${error.estado}: ${error.message}` +
        (referencia ? ` | ${String(err && err.message).slice(0, 200)}` : ''),
      despues: error.extra && error.extra.errores ? { errores: error.extra.errores } : null,
      resultado: 'Fallo'
    });
  }

  if (res.headersSent) return;

  if (!req.originalUrl.startsWith('/api/') && error.estado >= 500) {
    return res.status(500).sendFile(path.join(__dirname, '..', 'views', '500.html'));
  }
  res.status(error.estado).json({ mensaje: error.message, ...error.extra });
}

module.exports = { ErrorApp, errorValidacion, validacionEvadida, reglaNegocio, asincrono, noEncontrado, manejadorErrores };
