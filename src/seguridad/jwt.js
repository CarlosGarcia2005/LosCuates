// =====================================================================
//  Tokens JWT en cookies httpOnly
//
//  rs_mfa   → token temporal (5 min) entre la contraseña y el código MFA
//  rs_token → token de acceso que se emite solo después del MFA
//
//  [OWASP A07] Sesión con dos límites:
//    - 15 min de INACTIVIDAD: el token vence a los 15 min y se renueva
//      solo mientras el usuario sigue usando el sistema.
//    - 8 h MÁXIMO: aunque se use todo el día, a las 8 h se pide login otra vez.
// =====================================================================
const jwt = require('jsonwebtoken');

const COOKIE_ACCESO = 'rs_token';
const COOKIE_MFA = 'rs_mfa';
const INACTIVIDAD_SEG = 15 * 60;
const SESION_MAXIMA_SEG = 8 * 60 * 60;
const RENOVAR_DESPUES_SEG = 60;          // no renovar en cada clic, como mucho una vez por minuto
const DURACION_MFA_SEG = 5 * 60;
const EMISOR = 'rancho-seco';

function secreto() {
  const s = process.env.JWT_SECRET || '';
  if (s.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres. Revisa tu .env');
  return s;
}

const enProduccion = () => process.env.NODE_ENV === 'production';

function opcionesCookie(maxAgeSeg, path = '/') {
  return {
    httpOnly: true,                 // JavaScript del navegador no puede leerla (protege contra XSS)
    secure: enProduccion(),         // solo por HTTPS en producción
    sameSite: 'strict',             // no se envía desde otros sitios (protege contra CSRF)
    path,
    maxAge: maxAgeSeg * 1000
  };
}

function firmar(payload, tipo, duracionSeg) {
  return jwt.sign({ ...payload, tipo }, secreto(), {
    algorithm: 'HS256', expiresIn: duracionSeg, issuer: EMISOR
  });
}

/** Devuelve el payload o null si el token no es válido, expiró o es de otro tipo. */
function verificar(token, tipoEsperado) {
  if (!token) return null;
  try {
    const datos = jwt.verify(token, secreto(), { algorithms: ['HS256'], issuer: EMISOR });
    return datos.tipo === tipoEsperado ? datos : null;
  } catch {
    return null;
  }
}

const ahoraSeg = () => Math.floor(Date.now() / 1000);

/**
 * Emite (o renueva) el token de acceso.
 * @param {number} [inicio] segundo en que empezó la sesión (se conserva al renovar)
 */
function emitirAcceso(res, usuario, inicio = ahoraSeg()) {
  const restante = inicio + SESION_MAXIMA_SEG - ahoraSeg();
  const vida = Math.max(1, Math.min(INACTIVIDAD_SEG, restante));
  const token = firmar({ sub: String(usuario.id), ver: usuario.tokenVersion, ini: inicio }, 'acceso', vida);
  res.cookie(COOKIE_ACCESO, token, opcionesCookie(Math.max(1, restante)));
}

/** ¿La sesión ya pasó del máximo de 8 horas? */
const sesionAgotada = (datos) => Number.isFinite(datos.ini) && ahoraSeg() - datos.ini >= SESION_MAXIMA_SEG;

/** Renueva el token si ya tiene más de un minuto (ventana deslizante de inactividad). */
function renovarSiHaceFalta(res, usuario, datos) {
  if (ahoraSeg() - datos.iat >= RENOVAR_DESPUES_SEG) emitirAcceso(res, usuario, Number.isFinite(datos.ini) ? datos.ini : datos.iat);
}

function emitirMfa(res, usuario, modo, extra = {}) {
  const token = firmar({ sub: String(usuario.id), ver: usuario.tokenVersion, modo, ...extra }, 'mfa', DURACION_MFA_SEG);
  res.cookie(COOKIE_MFA, token, opcionesCookie(DURACION_MFA_SEG, '/api/auth'));
}

function borrarCookies(res) {
  res.clearCookie(COOKIE_ACCESO, { ...opcionesCookie(0), maxAge: undefined });
  res.clearCookie(COOKIE_MFA, { ...opcionesCookie(0, '/api/auth'), maxAge: undefined });
}

function borrarCookieMfa(res) {
  res.clearCookie(COOKIE_MFA, { ...opcionesCookie(0, '/api/auth'), maxAge: undefined });
}

/** Lee las cookies del encabezado sin depender de librerías. */
function leerCookies(req) {
  const salida = {};
  const encabezado = req.headers.cookie;
  if (!encabezado) return salida;
  for (const parte of encabezado.split(';')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    const nombre = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    try { salida[nombre] = decodeURIComponent(valor); } catch { salida[nombre] = valor; }
  }
  return salida;
}

module.exports = {
  COOKIE_ACCESO, COOKIE_MFA, INACTIVIDAD_SEG, SESION_MAXIMA_SEG, secreto,
  verificar, emitirAcceso, renovarSiHaceFalta, sesionAgotada, emitirMfa, borrarCookies, borrarCookieMfa, leerCookies
};
