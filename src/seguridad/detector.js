// =====================================================================
//  [OWASP A03] Detector de intentos de inyección (SQL y XSS)
//
//  OJO: esto NO es lo que protege. Lo que protege es:
//    - Consultas parametrizadas: el texto del usuario nunca se vuelve SQL.
//    - Validación con listas blancas (correo, nombres, números...).
//    - Mostrar datos con textContent + Content-Security-Policy.
//  El detector solo DEJA CONSTANCIA en la bitácora de que alguien lo
//  intentó, para que el administrador lo vea en la sección Seguridad.
// =====================================================================
// Se carga al usarse (así las pruebas no necesitan conectarse a SQL Server)
const bitacora = { registrar: (...a) => require('../bitacora').registrar(...a) };

const PATRONES = [
  { tipo: 'SQL', nombre: 'comparación siempre verdadera', re: /['"`]\s*(or|and|\|\||&&)\s*['"`\d(]/i },
  { tipo: 'SQL', nombre: 'comentario SQL', re: /(--|#)\s*$|\/\*|\*\//m },
  { tipo: 'SQL', nombre: 'UNION SELECT', re: /\bunion\b[\s\S]{0,20}\bselect\b/i },
  { tipo: 'SQL', nombre: 'comando encadenado', re: /;\s*(drop|delete|insert|update|alter|truncate|create|exec|shutdown)\b/i },
  { tipo: 'SQL', nombre: 'función de tiempo', re: /\b(sleep|benchmark|pg_sleep|waitfor\s+delay)\s*\(/i },
  { tipo: 'XSS', nombre: 'etiqueta peligrosa', re: /<\s*\/?\s*(script|iframe|object|embed|svg|img|body|style|link|meta|base)\b/i },
  { tipo: 'XSS', nombre: 'evento JavaScript', re: /\bon[a-z]{3,20}\s*=/i },
  { tipo: 'XSS', nombre: 'URL javascript:', re: /(javascript|vbscript)\s*:/i },
  { tipo: 'XSS', nombre: 'datos HTML codificados', re: /&#x?0*(3c|60|62|3e);?|%3c\s*script/i }
];

const SENSIBLE = /contrase|password|secreto|token|codigo|actual|nueva|confirmar/i;

/** Analiza un texto. Devuelve [{tipo, nombre}] (vacío si se ve normal). */
function analizar(texto) {
  if (typeof texto !== 'string' || texto.length < 2) return [];
  return PATRONES.filter((p) => p.re.test(texto)).map(({ tipo, nombre }) => ({ tipo, nombre }));
}

/** Recorre query y body (hasta 2 niveles) y junta los hallazgos. */
function revisarSolicitud(req) {
  const hallazgos = [];
  const revisar = (origen, objeto, prefijo = '', nivel = 0) => {
    if (!objeto || typeof objeto !== 'object' || Buffer.isBuffer(objeto) || nivel > 2) return;
    for (const [clave, valor] of Object.entries(objeto).slice(0, 50)) {
      const ruta = prefijo ? `${prefijo}.${clave}` : clave;
      if (typeof valor === 'string') {
        const encontrados = analizar(valor).concat(analizar(clave));
        if (encontrados.length) {
          hallazgos.push({
            campo: `${origen}.${ruta}`,
            patrones: [...new Set(encontrados.map((e) => `${e.tipo}: ${e.nombre}`))],
            // Nunca se guarda lo que la persona escribió en un campo de contraseña o código
            valor: SENSIBLE.test(clave) ? '(oculto: campo sensible)' : valor.slice(0, 120)
          });
        }
      } else if (typeof valor === 'object') {
        revisar(origen, valor, ruta, nivel + 1);
      }
    }
  };
  revisar('query', req.query);
  revisar('body', req.body);
  return hallazgos;
}

/** Middleware: registra el intento y deja seguir (la validación decide). */
async function detectorInyeccion(req, res, next) {
  try {
    const hallazgos = revisarSolicitud(req);
    if (hallazgos.length) {
      req.intentoInyeccion = hallazgos;
      const tipos = [...new Set(hallazgos.flatMap((h) => h.patrones.map((p) => p.split(':')[0])))].join(' y ');
      await bitacora.registrar(req, {
        accion: 'INTENTO_INYECCION', modulo: 'Seguridad',
        descripcion: `[A03] Posible inyección ${tipos} en ${hallazgos.map((h) => h.campo).join(', ')} de ` +
          `${req.method} ${req.originalUrl.split('?')[0]}. La solicitud se procesó como texto normal.`,
        despues: { hallazgos: hallazgos.slice(0, 5) },
        resultado: 'Fallo'
      });
      // registrar() marca la petición como ya registrada; aquí no queremos ocultar errores posteriores
      res.locals.bitacoraRegistrada = false;
    }
  } catch (err) {
    console.error('[DETECTOR] ', err.message);
  }
  next();
}

module.exports = { detectorInyeccion, analizar, revisarSolicitud };
