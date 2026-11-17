// =====================================================================
//  Tokens JWT en cookies httpOnly
//
//  rs_mfa   → token temporal (5 min) entre la contraseña y el código MFA
//  rs_token → token de acceso (2 h) que se emite solo después del MFA
// =====================================================================
const jwt = require('jsonwebtoken');

const COOKIE_ACCESO = 'rs_token';
const COOKIE_MFA = 'rs_mfa';
const DURACION_ACCESO_SEG = 2 * 60 * 60;
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

function emitirAcceso(res, usuario) {
  const token = firmar({ sub: String(usuario.id), ver: usuario.tokenVersion }, 'acceso', DURACION_ACCESO_SEG);
  res.cookie(COOKIE_ACCESO, token, opcionesCookie(DURACION_ACCESO_SEG));
}

function emitirMfa(res, usuario, modo) {
  const token = firmar({ sub: String(usuario.id), ver: usuario.tokenVersion, modo }, 'mfa', DURACION_MFA_SEG);
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
  COOKIE_ACCESO, COOKIE_MFA, secreto,
  verificar, emitirAcceso, emitirMfa, borrarCookies, borrarCookieMfa, leerCookies
};
