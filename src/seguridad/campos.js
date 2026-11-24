// =====================================================================
//  [OWASP A01] Lista blanca de campos ("mass assignment")
//  Cada ruta declara qué campos acepta. Si el JSON trae algo más
//  (por ejemplo alguien agrega "idRol": 1 desde la consola), se rechaza.
// =====================================================================
// Se carga al usarse (así las pruebas no necesitan conectarse a SQL Server)
const bitacora = { registrar: (...a) => require('../bitacora').registrar(...a) };

/** Devuelve los campos que sobran, o null si el cuerpo no es un objeto JSON. */
function camposSobrantes(cuerpo, permitidos) {
  if (cuerpo === undefined) return [];
  if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return null;
  return Object.keys(cuerpo).filter((k) => !permitidos.includes(k));
}

/**
 * Middleware. Si alAdvertir(req, res, sobrantes) devuelve true, ya respondió
 * (por ejemplo expulsando al usuario) y no se hace nada más.
 */
function soloCampos(permitidos, alAdvertir) {
  return async (req, res, next) => {
    try {
      const sobrantes = camposSobrantes(req.body, permitidos);
      if (sobrantes && sobrantes.length === 0) return next();

      if (alAdvertir && sobrantes && (await alAdvertir(req, res, sobrantes))) return undefined;

      await bitacora.registrar(req, {
        accion: 'SOLICITUD_MANIPULADA', modulo: 'Seguridad',
        descripcion: sobrantes
          ? `[A01] Se enviaron campos no permitidos (${sobrantes.slice(0, 10).join(', ')}) a ${req.method} ${req.originalUrl}`
          : `[A01] El cuerpo de ${req.method} ${req.originalUrl} no es un objeto JSON válido`,
        despues: sobrantes ? { camposNoPermitidos: sobrantes.slice(0, 20) } : null,
        resultado: 'Fallo'
      });
      return res.status(400).json({ mensaje: 'La solicitud contiene datos no permitidos.' });
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { soloCampos, camposSobrantes };
