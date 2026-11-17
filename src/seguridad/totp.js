// =====================================================================
//  MFA con códigos TOTP (RFC 6238), compatible con
//  Google Authenticator, Microsoft Authenticator, Authy, etc.
//  Implementado con el módulo crypto de Node (sin librerías externas).
// =====================================================================
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIODO = 30;   // segundos que dura cada código
const DIGITOS = 6;
const VENTANA = 1;    // acepta el código anterior y el siguiente (desfase de reloj)

function base32Codificar(buffer) {
  let bits = 0, valor = 0, salida = '';
  for (const byte of buffer) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO[(valor << (5 - bits)) & 31];
  return salida;
}

function base32Decodificar(texto) {
  const limpio = String(texto).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, valor = 0;
  const bytes = [];
  for (const c of limpio) {
    const i = ALFABETO.indexOf(c);
    if (i === -1) throw new Error('Secreto base32 inválido');
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Secreto nuevo de 160 bits, en base32 (32 caracteres). */
function generarSecreto() {
  return base32Codificar(crypto.randomBytes(20));
}

function codigoParaPaso(secretoBuffer, paso) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(paso));
  const hmac = crypto.createHmac('sha1', secretoBuffer).update(contador).digest();
  const desplazamiento = hmac[hmac.length - 1] & 0x0f;
  const binario = ((hmac[desplazamiento] & 0x7f) << 24) |
                  (hmac[desplazamiento + 1] << 16) |
                  (hmac[desplazamiento + 2] << 8) |
                  hmac[desplazamiento + 3];
  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

const pasoActual = (ahoraMs = Date.now()) => Math.floor(ahoraMs / 1000 / PERIODO);

/**
 * Verifica un código. Devuelve el número de paso usado (para impedir que
 * el mismo código se use dos veces) o null si no es válido.
 * @param {number|null} ultimoPasoUsado
 */
function verificarCodigo(secretoBase32, codigo, ultimoPasoUsado = null, ahoraMs = Date.now()) {
  if (!/^\d{6}$/.test(String(codigo))) return null;
  const secreto = base32Decodificar(secretoBase32);
  const actual = pasoActual(ahoraMs);
  const recibido = Buffer.from(String(codigo));

  for (let w = -VENTANA; w <= VENTANA; w++) {
    const paso = actual + w;
    if (ultimoPasoUsado !== null && paso <= Number(ultimoPasoUsado)) continue;
    const esperado = Buffer.from(codigoParaPaso(secreto, paso));
    if (crypto.timingSafeEqual(esperado, recibido)) return paso;
  }
  return null;
}

/** Texto que va dentro del código QR. */
function uriOtpauth(secretoBase32, cuenta, emisor) {
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`);
  const params = new URLSearchParams({
    secret: secretoBase32, issuer: emisor, algorithm: 'SHA1', digits: String(DIGITOS), period: String(PERIODO)
  });
  return `otpauth://totp/${etiqueta}?${params.toString()}`;
}

module.exports = {
  generarSecreto, verificarCodigo, uriOtpauth,
  // expuestos solo para pruebas
  _codigoParaPaso: codigoParaPaso, _base32Codificar: base32Codificar, _base32Decodificar: base32Decodificar
};
