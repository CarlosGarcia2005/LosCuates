// =====================================================================
//  Bitácora administrativa
//  Registra quién hizo qué, cuándo, desde dónde y qué datos cambiaron.
// =====================================================================
const { consulta } = require('../config/db');

// Campos que nunca deben quedar escritos en la bitácora
const CAMPOS_PROHIBIDOS = /contrase|password|secreto|token|hash|codigo/i;

function limpiar(obj) {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(limpiar);
  if (typeof obj !== 'object') return obj;
  const salida = {};
  for (const [k, v] of Object.entries(obj)) {
    if (CAMPOS_PROHIBIDOS.test(k)) continue;
    salida[k] = v instanceof Date ? v.toISOString() : (typeof v === 'object' ? limpiar(v) : v);
  }
  return salida;
}

const normalizar = (v) => (v === undefined || v === '' ? null : v instanceof Date ? v.toISOString() : v);

/** Devuelve solo los campos que cambiaron: { antes: {...}, despues: {...}, campos: [...] } */
function diferencias(antes, despues) {
  const a = {}, d = {}, campos = [];
  for (const campo of Object.keys(despues)) {
    const va = normalizar(antes[campo]);
    const vd = normalizar(despues[campo]);
    if (String(va) !== String(vd)) {
      a[campo] = va; d[campo] = vd; campos.push(campo);
    }
  }
  return { antes: a, despues: d, campos };
}

function ipDe(req) {
  const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || null;
  return ip ? String(ip).replace(/^::ffff:/, '').slice(0, 45) : null;
}

/**
 * Inserta un registro. Nunca lanza error: si la bitácora falla,
 * se avisa en consola pero no se rompe la operación principal.
 */
async function registrar(req, {
  accion, modulo, descripcion, resultado = 'Éxito',
  tabla = null, idRegistro = null, antes = null, despues = null, actor = null
}) {
  try {
    const u = actor || (req && req.usuario) || null;
    await consulta(`
      INSERT INTO Bitacora
        (idUsuario, Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
         Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
      VALUES
        (@idUsuario, @correo, @rol, @accion, @modulo, @tabla, @idRegistro,
         @descripcion, @antes, @despues, @ip, @navegador, @resultado, 'Aplicación')`, {
      idUsuario: u && u.id ? Number(u.id) : null,
      correo: u && u.correo ? String(u.correo).slice(0, 100) : null,
      rol: u && u.rol ? String(u.rol).slice(0, 40) : null,
      accion: String(accion).slice(0, 40),
      modulo: String(modulo || 'Sistema').slice(0, 40),
      tabla: tabla || null,
      idRegistro: idRegistro === null || idRegistro === undefined ? null : String(idRegistro),
      descripcion: String(descripcion || '').slice(0, 500),
      antes: antes ? JSON.stringify(limpiar(antes)) : null,
      despues: despues ? JSON.stringify(limpiar(despues)) : null,
      ip: ipDe(req),
      navegador: req && req.headers ? String(req.headers['user-agent'] || '').slice(0, 300) : null,
      resultado: resultado === 'Fallo' ? 'Fallo' : 'Éxito'
    });
    if (req && req.res) req.res.locals.bitacoraRegistrada = true;
  } catch (err) {
    console.error('[BITÁCORA] No se pudo registrar el movimiento:', accion, err.message);
  }
}

module.exports = { registrar, diferencias, limpiar };
