// =====================================================================
//  Hash de contraseñas con scrypt (incluido en Node, resistente a
//  ataques por fuerza bruta con GPU). Cada contraseña lleva su propia sal.
//
//  Formato guardado:  scrypt$N$r$p$<sal base64>$<hash base64>
//
//  Compatibilidad: si encuentra un hash viejo SHA-256 (64 caracteres hex,
//  como los que se insertaron con HASHBYTES), lo valida y avisa que hay
//  que migrarlo. El login lo convierte a scrypt automáticamente.
// =====================================================================
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const N = 16384, R = 8, P = 1, LARGO = 64;
const MAXMEM = 64 * 1024 * 1024;

async function hashear(contrasena) {
  const sal = crypto.randomBytes(16);
  const hash = await scrypt(contrasena.normalize('NFC'), sal, LARGO, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * @returns {Promise<{valida: boolean, requiereMigracion: boolean}>}
 */
async function verificar(contrasena, guardado) {
  if (typeof contrasena !== 'string' || typeof guardado !== 'string') {
    return { valida: false, requiereMigracion: false };
  }

  // Hash heredado: SHA-256 en hexadecimal
  if (/^[0-9a-f]{64}$/i.test(guardado)) {
    const calculado = crypto.createHash('sha256').update(contrasena, 'utf8').digest();
    const valida = crypto.timingSafeEqual(calculado, Buffer.from(guardado, 'hex'));
    return { valida, requiereMigracion: valida };
  }

  const partes = guardado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return { valida: false, requiereMigracion: false };

  const [, n, r, p, salB64, hashB64] = partes;
  const esperado = Buffer.from(hashB64, 'base64');
  const calculado = await scrypt(contrasena.normalize('NFC'), Buffer.from(salB64, 'base64'), esperado.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM
  });
  const valida = calculado.length === esperado.length && crypto.timingSafeEqual(calculado, esperado);
  return { valida, requiereMigracion: valida && Number(n) < N };
}

// Hash falso para que un correo inexistente tarde lo mismo que uno real
// (así no se puede adivinar qué correos están registrados midiendo tiempos).
let hashSenuelo = null;
async function verificarSenuelo(contrasena) {
  if (!hashSenuelo) hashSenuelo = await hashear('senuelo-' + crypto.randomBytes(8).toString('hex'));
  await verificar(String(contrasena || ''), hashSenuelo);
}

module.exports = { hashear, verificar, verificarSenuelo };
