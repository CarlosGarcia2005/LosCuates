// =====================================================================
//  [OWASP A08] Deserialización segura de datos
//  El JSON que manda el navegador se convierte en objetos de JavaScript.
//  Claves como "__proto__", "constructor" o "prototype" sirven para
//  "contaminar el prototipo": cambiar el comportamiento de TODOS los
//  objetos del servidor (por ejemplo, que todos parezcan administradores).
//  Se rechazan antes de que lleguen a cualquier ruta.
// =====================================================================
const bitacora = { registrar: (...a) => require('../bitacora').registrar(...a) };

const CLAVES_PELIGROSAS = new Set(['__proto__', 'constructor', 'prototype']);
const PROFUNDIDAD_MAXIMA = 8;

/**
 * Busca claves peligrosas o anidación excesiva.
 * @returns {null | {motivo:'prototipo'|'profundidad', ruta:string}}
 */
function revisarEstructura(valor, ruta = 'body', nivel = 0) {
  if (valor === null || typeof valor !== 'object' || Buffer.isBuffer(valor)) return null;
  if (nivel > PROFUNDIDAD_MAXIMA) return { motivo: 'profundidad', ruta };
  for (const clave of Object.keys(valor)) {
    if (CLAVES_PELIGROSAS.has(clave)) return { motivo: 'prototipo', ruta: `${ruta}.${clave}` };
    const hallazgo = revisarEstructura(valor[clave], `${ruta}.${clave}`, nivel + 1);
    if (hallazgo) return hallazgo;
  }
  return null;
}

/** Middleware: va después de express.json(). */
async function datosSeguros(req, res, next) {
  const hallazgo = revisarEstructura(req.body);
  if (!hallazgo) return next();
  const texto = hallazgo.motivo === 'prototipo'
    ? `Intento de contaminación de prototipo: el JSON traía la clave ${hallazgo.ruta}`
    : `JSON con más de ${PROFUNDIDAD_MAXIMA} niveles de anidación en ${hallazgo.ruta}`;
  await bitacora.registrar(req, {
    accion: 'DATOS_MANIPULADOS', modulo: 'Seguridad', resultado: 'Fallo',
    descripcion: `[A08] ${texto}. Petición: ${req.method} ${String(req.originalUrl).slice(0, 120)}`
  });
  res.status(400).json({ mensaje: 'La solicitud contiene datos no permitidos.' });
}

module.exports = { datosSeguros, revisarEstructura, CLAVES_PELIGROSAS };
