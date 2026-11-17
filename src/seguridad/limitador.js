// =====================================================================
//  Límite de peticiones por IP (frena ataques de fuerza bruta)
// =====================================================================

function crearLimitador({ ventanaMs, maximo, mensaje }) {
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
      return res.status(429).json({ mensaje: mensaje || 'Demasiadas solicitudes. Intenta más tarde.' });
    }
    next();
  };
}

module.exports = { crearLimitador };
