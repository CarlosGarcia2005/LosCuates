// =====================================================================
//  Middlewares de sesión (JWT) y permisos por rol
// =====================================================================
const jwt = require('./seguridad/jwt');
const usuarios = require('./usuarios');
const bitacora = require('./bitacora');

const esApi = (req) => req.originalUrl.startsWith('/api/');

function rechazarSesion(req, res) {
  jwt.borrarCookies(res);
  if (esApi(req)) return res.status(401).json({ mensaje: 'Tu sesión expiró. Inicia sesión de nuevo.' });
  return res.redirect('/');
}

/**
 * Verifica el JWT y además consulta la base en cada petición:
 * si el usuario fue desactivado, cambió su contraseña o cerró sesión,
 * el token viejo deja de servir de inmediato.
 */
async function requiereSesion(req, res, next) {
  try {
    const cookies = jwt.leerCookies(req);
    const datos = jwt.verificar(cookies[jwt.COOKIE_ACCESO], 'acceso');
    if (!datos) return rechazarSesion(req, res);

    const u = await usuarios.porId(Number(datos.sub));
    if (!u || u.Estado !== 'Activo' || Number(u.Token_Version) !== datos.ver || !u.MFA_Activo) {
      return rechazarSesion(req, res);
    }
    req.usuario = usuarios.actor(u);
    req.usuarioCompleto = u;
    next();
  } catch (err) {
    next(err);
  }
}

/** Solo usuarios cuyo rol tiene nivel "Administrador". */
async function requiereAdmin(req, res, next) {
  if (req.usuario && req.usuario.nivel === 'Administrador') return next();

  await bitacora.registrar(req, {
    accion: 'ACCESO_DENEGADO',
    modulo: 'Seguridad',
    descripcion: `Intentó entrar a una función de administrador: ${req.method} ${req.originalUrl}`,
    resultado: 'Fallo'
  });
  if (esApi(req)) return res.status(403).json({ mensaje: 'No tienes permisos para realizar esta acción.' });
  return res.redirect('/perfil');
}

/** Guarda el contexto de la operación para que, si falla, la bitácora sepa qué se intentaba. */
const contexto = (accion, modulo, tabla) => (req, res, next) => {
  res.locals.accion = { accion, modulo, tabla, idRegistro: req.params.id || null };
  next();
};

module.exports = { requiereSesion, requiereAdmin, contexto };
