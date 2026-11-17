// =====================================================================
//  Cifrado AES-256-GCM para guardar el secreto MFA en la base de datos.
//  Si alguien roba la base, no puede generar códigos sin MFA_CLAVE (.env).
// =====================================================================
const crypto = require('crypto');

let clave = null;

function obtenerClave() {
  if (!clave) {
    const hex = process.env.MFA_CLAVE || '';
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('MFA_CLAVE debe tener 64 caracteres hexadecimales (32 bytes). Revisa tu .env');
    }
    clave = Buffer.from(hex, 'hex');
  }
  return clave;
}

function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv('aes-256-gcm', obtenerClave(), iv);
  const datos = Buffer.concat([cifrador.update(String(texto), 'utf8'), cifrador.final()]);
  const etiqueta = cifrador.getAuthTag();
  return ['v1', iv.toString('base64'), etiqueta.toString('base64'), datos.toString('base64')].join(':');
}

function descifrar(guardado) {
  const [version, iv, etiqueta, datos] = String(guardado).split(':');
  if (version !== 'v1' || !iv || !etiqueta || !datos) throw new Error('Formato de dato cifrado inválido');
  const descifrador = crypto.createDecipheriv('aes-256-gcm', obtenerClave(), Buffer.from(iv, 'base64'));
  descifrador.setAuthTag(Buffer.from(etiqueta, 'base64'));
  return Buffer.concat([descifrador.update(Buffer.from(datos, 'base64')), descifrador.final()]).toString('utf8');
}

module.exports = { cifrar, descifrar, obtenerClave };
