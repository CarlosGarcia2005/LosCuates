// =====================================================================
//  [OWASP A01] Diagnóstico de un JWT rechazado
//  Distingue un token que simplemente venció (normal) de uno que alguien
//  modificó: firma cambiada, algoritmo "none", formato roto, etc.
//  No usa librerías para poder probarse con `npm test`.
// =====================================================================
const crypto = require('crypto');

const EMISOR = 'rancho-seco';

function base64url(texto) {
  return Buffer.from(texto.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function leerJson(parte) {
  try { return JSON.parse(base64url(parte).toString('utf8')); } catch { return null; }
}

/**
 * @returns {{motivo: 'valido'|'vacio'|'formato'|'algoritmo'|'firma'|'expirado'|'emisor'|'tipo', datos: object|null}}
 *   datos = lo que dice el token (NO es confiable si el motivo no es 'valido')
 */
function diagnosticar(token, secreto, tipoEsperado, ahoraSeg = Math.floor(Date.now() / 1000)) {
  if (!token) return { motivo: 'vacio', datos: null };
  const partes = String(token).split('.');
  if (partes.length !== 3) return { motivo: 'formato', datos: null };

  const cabecera = leerJson(partes[0]);
  const datos = leerJson(partes[1]);
  if (!cabecera || !datos) return { motivo: 'formato', datos: null };
  if (cabecera.alg !== 'HS256') return { motivo: 'algoritmo', datos };

  const esperada = crypto.createHmac('sha256', secreto).update(`${partes[0]}.${partes[1]}`).digest();
  const recibida = base64url(partes[2]);
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) {
    return { motivo: 'firma', datos };
  }
  if (typeof datos.exp === 'number' && datos.exp <= ahoraSeg) return { motivo: 'expirado', datos };
  if (datos.iss !== EMISOR) return { motivo: 'emisor', datos };
  if (tipoEsperado && datos.tipo !== tipoEsperado) return { motivo: 'tipo', datos };
  return { motivo: 'valido', datos };
}

const DESCRIPCION = {
  formato: 'el token no tiene un formato válido',
  algoritmo: 'el token pide un algoritmo distinto de HS256 (por ejemplo "none")',
  firma: 'la firma no coincide: el contenido del token fue modificado o lo firmó alguien más',
  emisor: 'el token no lo emitió este sistema',
  tipo: 'se intentó usar un token temporal como token de sesión'
};

module.exports = { diagnosticar, DESCRIPCION };
