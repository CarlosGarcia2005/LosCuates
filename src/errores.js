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

/** Envuelve rutas async para que sus errores lleguen al manejador central. */
const asincrono = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Número de error que devuelve SQL Server (mssql lo deja en varios lugares). */
function numeroSql(err) {
  if (!err) return null;
  if (Number.isInteger(err.number)) return err.number;
  if (err.originalError && err.originalError.info && Number.isInteger(err.originalError.info.number)) {
    return err.originalError.info.number;
  }
  return null;
}

/** Traduce errores conocidos de SQL Server a mensajes entendibles. */
function traducirErrorSql(err) {
  switch (numeroSql(err)) {
    case 2601:
    case 2627: return new ErrorApp(409, 'Ya existe un registro con ese valor (por ejemplo, el correo o el nombre ya está en uso).');
    case 547:  return new ErrorApp(409, 'La operación no se puede realizar porque el registro está relacionado con otros datos o no cumple una regla de la base de datos.');
    case 2628:
    case 8152: return new ErrorApp(400, 'Uno de los valores es demasiado largo.');
    case 245:
    case 8114: return new ErrorApp(400, 'Uno de los valores no tiene el formato que espera la base de datos.');
    case 515:  return new ErrorApp(400, 'Falta un dato obligatorio.');
    case 229:
    case 230:
    case 262:
    case 50001: return new ErrorApp(403, 'La base de datos no permite esta operación.');
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
  if (err && err.type === 'entity.too.large') err = new ErrorApp(413, 'Los datos enviados son demasiado grandes.');

  let error = err instanceof ErrorApp ? err : traducirErrorSql(err);
  let referencia = null;

  if (!error) {
    referencia = crypto.randomBytes(4).toString('hex').toUpperCase();
    console.error(`[ERROR ${referencia}] ${req.method} ${req.originalUrl}`, err);
    error = new ErrorApp(500, `Ocurrió un error inesperado. Código de referencia: ${referencia}`);
  }

  // Registrar en bitácora las operaciones que fallaron (si la ruta no lo hizo ya)
  if (!res.locals.bitacoraRegistrada && (error.estado >= 500 || req.method !== 'GET')) {
    const contexto = res.locals.accion || {};
    await bitacora.registrar(req, {
      accion: error.estado >= 500 ? 'ERROR_SERVIDOR' : (contexto.accion || 'SOLICITUD_RECHAZADA'),
      modulo: contexto.modulo || 'Sistema',
      tabla: contexto.tabla,
      idRegistro: contexto.idRegistro,
      descripcion: `${req.method} ${req.originalUrl} → ${error.estado}: ${error.message}` +
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

module.exports = { ErrorApp, errorValidacion, asincrono, noEncontrado, manejadorErrores };
