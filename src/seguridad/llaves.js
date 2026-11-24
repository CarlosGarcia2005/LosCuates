// =====================================================================
//  Llaves derivadas para firmas de integridad (OWASP A08 / A09)
//  A partir de MFA_CLAVE (32 bytes del .env) se derivan, con HKDF-SHA256,
//  llaves DISTINTAS para cada uso. Así una firma de la bitácora no sirve
//  para firmar el código, y ninguna sirve para descifrar el MFA.
// =====================================================================
const crypto = require('crypto');

const cache = new Map();

function llave(proposito) {
  if (!cache.has(proposito)) {
    const hex = process.env.MFA_CLAVE || '';
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('MFA_CLAVE debe tener 64 caracteres hexadecimales (32 bytes). Revisa tu .env');
    }
    const derivada = crypto.hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.alloc(0),
      Buffer.from(`rancho-seco/${proposito}/v1`), 32);
    cache.set(proposito, Buffer.from(derivada));
  }
  return cache.get(proposito);
}

/** HMAC-SHA256 en hexadecimal. */
const firmar = (proposito, texto) => crypto.createHmac('sha256', llave(proposito)).update(texto, 'utf8').digest('hex');

/** Compara dos firmas hex en tiempo constante. */
function iguales(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Solo para pruebas: olvida las llaves en memoria. */
const _reiniciar = () => cache.clear();

module.exports = { llave, firmar, iguales, _reiniciar };
