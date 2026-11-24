// =====================================================================
//  Límite de peticiones por IP
//  [OWASP A04] frena el abuso automatizado (bots, scripts)
//  [OWASP A07] frena la fuerza bruta contra el login y el MFA
// =====================================================================

/**
 * @param {object}   o
 * @param {number}   o.ventanaMs   duración de la ventana
 * @param {number}   o.maximo      peticiones permitidas por IP en la ventana
 * @param {string}   [o.mensaje]   texto para el usuario
 * @param {Function} [o.alExceder] se llama UNA vez por IP y ventana cuando se pasa del límite
 *                                 (para registrarlo en la bitácora sin llenarla de renglones)
 */
function crearLimitador({ ventanaMs, maximo, mensaje, alExceder }) {
  const registros = new Map();

  const limpieza = setInterval(() => {
    const ahora = Date.now();
    for (const [clave, r] of registros) if (r.reinicio <= ahora) registros.delete(clave);
  }, ventanaMs);
  limpieza.unref();

  return function limitador(req, res, next) {
    const clave = req.ip || 'desconocida';
    const ahora = Date.now();
    let r = registros.get(clave);
    if (!r || r.reinicio <= ahora) {
      r = { cuenta: 0, reinicio: ahora + ventanaMs };
      registros.set(clave, r);
    }
    r.cuenta += 1;

    res.setHeader('RateLimit-Limit', String(maximo));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, maximo - r.cuenta)));

    if (r.cuenta > maximo) {
      const segundos = Math.ceil((r.reinicio - ahora) / 1000);
      res.setHeader('Retry-After', String(segundos));
      if (r.cuenta === maximo + 1 && typeof alExceder === 'function') {
        Promise.resolve()
          .then(() => alExceder(req, { maximo, minutos: Math.round(ventanaMs / 60000) }))
          .catch(() => { /* registrar nunca debe romper la respuesta */ });
      }
      return res.status(429).json({ mensaje: mensaje || 'Demasiadas solicitudes. Intenta más tarde.' });
    }
    next();
  };
}

module.exports = { crearLimitador };
