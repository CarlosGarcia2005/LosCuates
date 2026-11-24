// =====================================================================
//  [OWASP A01] Expulsión por manipulación
//  Cuando alguien con sesión intenta saltarse sus permisos (pedir datos
//  de administrador, mandar campos que no le corresponden, alterar su
//  token), se le cierra la sesión en TODOS sus equipos y se registra.
// =====================================================================
const { consulta } = require('../../config/db');
const jwt = require('./jwt');
const bitacora = require('../bitacora');

const MENSAJE = 'Detectamos una modificación no permitida. Por seguridad cerramos tu sesión.';

/**
 * @param {object} opciones
 * @param {string} opciones.motivo      texto para la bitácora
 * @param {string} [opciones.accion]    código de la bitácora
 * @param {object} [opciones.datos]     detalle técnico (sin secretos)
 */
async function expulsar(req, res, { motivo, accion = 'SESION_EXPULSADA', datos = null }) {
  if (req.usuario && req.usuario.id) {
    // Subir la versión del token invalida esta y cualquier otra sesión abierta
    await consulta('UPDATE Usuario SET Token_Version = Token_Version + 1 WHERE idUsuario = @id', { id: req.usuario.id });
  }
  await bitacora.registrar(req, {
    accion, modulo: 'Seguridad', tabla: req.usuario ? 'Usuario' : null,
    idRegistro: req.usuario ? req.usuario.id : null,
    descripcion: `[A01] ${motivo}. Se cerró la sesión. Petición: ${req.method} ${req.originalUrl}`.slice(0, 500),
    despues: datos, resultado: 'Fallo'
  });
  jwt.borrarCookies(res);
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ mensaje: MENSAJE, expulsado: true });
  }
  return res.redirect('/?motivo=seguridad');
}

module.exports = { expulsar, MENSAJE };
