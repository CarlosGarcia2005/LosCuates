// =====================================================================
//  Middlewares de sesión (JWT) y permisos por rol
// =====================================================================
const jwt = require('./seguridad/jwt');
const { consulta } = require('../config/db');
const usuarios = require('./usuarios');
const bitacora = require('./bitacora');
const { expulsar } = require('./seguridad/expulsion');
const { diagnosticar, DESCRIPCION } = require('./seguridad/diagnostico-token');
const { funcionesDe } = require('./funciones');

const esApi = (req) => req.originalUrl.startsWith('/api/');

function rechazarSesion(req, res, motivo = null) {
  jwt.borrarCookies(res);
  if (esApi(req)) return res.status(401).json({ mensaje: 'Tu sesión expiró. Inicia sesión de nuevo.', motivo });
  return res.redirect(motivo ? `/?motivo=${motivo}` : '/');
}

/**
 * Verifica el JWT y además consulta la base en cada petición:
 * si el usuario fue desactivado, cambió su contraseña o cerró sesión,
 * el token viejo deja de servir de inmediato.
 */
async function requiereSesion(req, res, next) {
  try {
    const cookies = jwt.leerCookies(req);
    const token = cookies[jwt.COOKIE_ACCESO];
    const datos = jwt.verificar(token, 'acceso');

    if (!datos) {
      // [A01] ¿Venció normalmente o alguien modificó el token?
      const { motivo, datos: diceSer } = diagnosticar(token, jwt.secreto(), 'acceso');
      if (DESCRIPCION[motivo]) {
        return expulsar(req, res, {
          accion: 'TOKEN_MANIPULADO',
          motivo: `Token de sesión alterado: ${DESCRIPCION[motivo]}` +
            (diceSer && diceSer.sub ? ` (decía ser el usuario ${String(diceSer.sub).slice(0, 12)})` : ''),
          datos: { motivo }
        });
      }
      // [A07] Token auténtico que venció: 15 min sin actividad
      if (motivo === 'expirado' && diceSer && diceSer.sub) {
        const quien = await usuarios.porId(Number(diceSer.sub));
        if (quien && Number(quien.Token_Version) === diceSer.ver) {
          await bitacora.registrar(req, {
            accion: 'SESION_INACTIVA', modulo: 'Autenticación', tabla: 'Usuario', idRegistro: quien.idUsuario,
            actor: usuarios.actor(quien), resultado: 'Fallo',
            descripcion: `[A07] La sesión venció por ${jwt.INACTIVIDAD_SEG / 60} minutos sin actividad. Debe iniciar sesión otra vez.`
          });
        }
      }
      return rechazarSesion(req, res, motivo === 'expirado' ? 'inactividad' : null);
    }

    const u = await usuarios.porId(Number(datos.sub));
    if (u && Number(u.Token_Version) !== datos.ver) {
      // Token auténtico pero ya revocado (cerró sesión, cambió contraseña, fue expulsado...)
      await bitacora.registrar(req, {
        accion: 'TOKEN_REVOCADO', modulo: 'Seguridad', tabla: 'Usuario', idRegistro: u.idUsuario,
        actor: usuarios.actor(u),
        descripcion: `[A01] Se intentó usar un token de sesión que ya había sido cerrado: ${req.method} ${req.originalUrl}`,
        resultado: 'Fallo'
      });
      return rechazarSesion(req, res);
    }
    if (!u || u.Estado !== 'Activo' || !u.MFA_Activo) {
      return rechazarSesion(req, res);
    }
    req.usuario = usuarios.actor(u);
    req.usuarioCompleto = u;

    // [A07] Máximo 8 horas por sesión, aunque se esté usando
    if (jwt.sesionAgotada(datos)) {
      await consulta('UPDATE Usuario SET Token_Version = Token_Version + 1 WHERE idUsuario = @id', { id: u.idUsuario });
      await bitacora.registrar(req, {
        accion: 'SESION_INACTIVA', modulo: 'Autenticación', tabla: 'Usuario', idRegistro: u.idUsuario, resultado: 'Fallo',
        descripcion: `[A07] La sesión llegó al máximo de ${jwt.SESION_MAXIMA_SEG / 3600} horas. Debe iniciar sesión otra vez.`
      });
      return rechazarSesion(req, res, 'maximo');
    }
    req.sesionInicio = Number.isFinite(datos.ini) ? datos.ini : datos.iat;
    // Las consultas automáticas del panel (alertas cada minuto) no cuentan como actividad
    if (req.headers['x-sin-renovar'] !== '1') jwt.renovarSiHaceFalta(res, req.usuario, datos);
    next();
  } catch (err) {
    next(err);
  }
}

/** Solo usuarios cuyo rol tiene nivel "Administrador". */
async function requiereAdmin(req, res, next) {
  if (req.usuario && req.usuario.nivel === 'Administrador') return next();

  // [A01] La pantalla nunca pide datos de administrador a un usuario normal:
  // si llega esta petición es porque alguien la armó a mano → se le saca.
  if (esApi(req)) {
    return expulsar(req, res, {
      motivo: `Un usuario con rol "${req.usuario ? req.usuario.rol : '?'}" intentó usar una función de administrador`
    });
  }
  await bitacora.registrar(req, {
    accion: 'ACCESO_DENEGADO',
    modulo: 'Seguridad',
    descripcion: `[A01] Intentó abrir una pantalla de administrador: ${req.method} ${req.originalUrl}`,
    resultado: 'Fallo'
  });
  return res.redirect('/perfil');
}

/**
 * Solo usuarios cuyo rol tiene la función indicada ("arbitro" o "limpieza").
 * Con tambienAdmin = true, los administradores también pasan.
 * [A01] La pantalla nunca llama estas rutas para otros roles: si llega, se expulsa.
 */
const NOMBRE_FUNCION = { arbitro: 'árbitro', limpieza: 'personal de limpieza' };
const requiereFuncion = (funcion, { tambienAdmin = false } = {}) => async (req, res, next) => {
  try {
    if (tambienAdmin && req.usuario && req.usuario.nivel === 'Administrador') return next();
    if (req.usuario && funcionesDe(req.usuario.rol).includes(funcion)) return next();
    return await expulsar(req, res, {
      motivo: `Un usuario con rol "${req.usuario ? req.usuario.rol : '?'}" intentó usar una función de ${NOMBRE_FUNCION[funcion] || funcion}`
    });
  } catch (err) {
    return next(err);
  }
};

/** Guarda el contexto de la operación para que, si falla, la bitácora sepa qué se intentaba. */
const contexto = (accion, modulo, tabla) => (req, res, next) => {
  res.locals.accion = { accion, modulo, tabla, idRegistro: req.params.id || null };
  next();
};

module.exports = { requiereSesion, requiereAdmin, requiereFuncion, contexto };
