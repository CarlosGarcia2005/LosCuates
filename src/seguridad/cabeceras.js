// =====================================================================
//  Cabeceras de seguridad HTTP (equivalente a lo que hace "helmet")
// =====================================================================

const CSP = [
  "default-src 'self'",
  "script-src 'self'",                                   // sin scripts en línea ni de otros sitios
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",                                // data: para el código QR
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"                               // nadie puede meter la página en un iframe
].join('; ');

function cabecerasSeguridad(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (process.env.NODE_ENV === 'production') {
    // Obliga a usar HTTPS durante 1 año (solo tiene sentido con HTTPS activo)
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/** Las respuestas con datos privados no se guardan en caché del navegador. */
function sinCache(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

/**
 * Protección CSRF: toda petición que modifica datos debe venir de nuestro
 * propio JavaScript (encabezado X-Requested-With) y del mismo origen.
 */
function protegerCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origen = req.headers.origin;
  const host = req.headers.host;
  const origenValido = !origen || origen === `http://${host}` || origen === `https://${host}`;
  if (req.headers['x-requested-with'] !== 'fetch' || !origenValido) {
    return res.status(403).json({ mensaje: 'Solicitud rechazada por seguridad.' });
  }
  next();
}

module.exports = { cabecerasSeguridad, sinCache, protegerCsrf };
