// =====================================================================
//  [OWASP A09] Monitoreo y alertas
//  Revisa cada registro de la bitácora en el momento en que se guarda.
//  Si ve un patrón de ataque, crea una ALERTA_SEGURIDAD: aparece en la
//  consola del servidor y en el panel del administrador hasta que alguien
//  la marca como atendida.
// =====================================================================
// Se cargan al usarse (y las pruebas pueden cambiarlas por versiones falsas)
const deps = {
  registrar: (...a) => require('../bitacora').registrar(...a),
  consulta: (...a) => require('../../config/db').consulta(...a)
};

const VENTANA_MS = 10 * 60 * 1000;
const UMBRAL_IP = 5;
const SILENCIO_MS = 30 * 60 * 1000;

// Eventos que cuentan como "actividad sospechosa" de una IP
const SOSPECHOSOS = new Set([
  'SESION_EXPULSADA', 'TOKEN_MANIPULADO', 'TOKEN_REVOCADO', 'SOLICITUD_MANIPULADA', 'ACCESO_DENEGADO',
  'INTENTO_INYECCION', 'VALIDACION_EVADIDA', 'LIMITE_EXCEDIDO', 'METODO_NO_PERMITIDO',
  'DATOS_MANIPULADOS', 'INTENTO_SSRF', 'LOGIN_FALLIDO', 'MFA_FALLIDO'
]);

const porIp = new Map();         // ip → [marcas de tiempo]
const silenciadas = new Map();   // clave → hasta cuándo no repetir
const estado = { alertasEmitidas: 0, ultima: null };

function limpiarVentana(lista, ahora) {
  while (lista.length && ahora - lista[0] > VENTANA_MS) lista.shift();
  return lista;
}

/**
 * Crea la alerta (una vez por clave cada 30 min, y nunca si ya hay una igual sin atender).
 * @returns {Promise<boolean>} true si se creó
 */
async function alertar({ clave, descripcion, ip = null }) {
  const ahora = Date.now();
  if ((silenciadas.get(clave) || 0) > ahora) return false;
  silenciadas.set(clave, ahora + SILENCIO_MS);

  try {
    const activas = await alertasActivas({ dias: 1, clave: clave.slice(0, 40) });
    if (activas.length) return false;
  } catch { /* si no se puede revisar, se alerta igual */ }

  estado.alertasEmitidas += 1;
  estado.ultima = { clave, descripcion, fecha: new Date().toISOString() };
  console.warn(`\n🚨 ALERTA DE SEGURIDAD (OWASP A09): ${descripcion}\n   Revísala en Panel → Seguridad OWASP.\n`);
  await deps.registrar({ ip, headers: {} }, {
    accion: 'ALERTA_SEGURIDAD', modulo: 'Seguridad', resultado: 'Fallo', idRegistro: clave.slice(0, 40),
    descripcion: `[A09] ${descripcion}`
  });
  return true;
}

/** Se llama por cada registro guardado en la bitácora. */
function observar(entrada) {
  const accion = entrada.Accion;
  if (!accion || accion.startsWith('ALERTA_')) return;
  const ip = entrada.IP || 'desconocida';
  const ahora = Date.now();

  if (accion === 'FUERZA_BRUTA') {
    alertar({ clave: `fuerza_bruta:${ip}`, ip, descripcion: `Ataque de fuerza bruta desde la IP ${ip}: se bloqueó la IP.` });
  }
  if (accion === 'CUENTA_BLOQUEADA' && entrada.Rol_Usuario === 'Administrador') {
    alertar({ clave: `admin_bloqueado:${entrada.Correo_Usuario}`, ip,
      descripcion: `Se bloqueó la cuenta de administrador ${entrada.Correo_Usuario} por intentos fallidos (desde ${ip}).` });
  }
  if (accion === 'INTENTO_SSRF') {
    alertar({ clave: `ssrf:${entrada.Correo_Usuario || ip}`, ip,
      descripcion: `Intento de SSRF: ${entrada.Correo_Usuario || 'alguien'} pidió al servidor descargar una dirección interna (desde ${ip}).` });
  }
  if (SOSPECHOSOS.has(accion)) {
    const lista = limpiarVentana(porIp.get(ip) || [], ahora);
    lista.push(ahora);
    porIp.set(ip, lista);
    if (lista.length >= UMBRAL_IP) {
      alertar({ clave: `ataque_ip:${ip}`, ip,
        descripcion: `Posible ataque: ${lista.length} eventos de seguridad desde la IP ${ip} en 10 minutos (el último: ${accion}).` });
    }
  }
}

/**
 * Alertas que nadie ha marcado como atendidas.
 * Se cruzan en JavaScript (y no con "idRegistro = CAST(id AS CHAR)" en SQL) porque
 * (En MySQL 8 esa comparación fallaba cuando la conexión y la tabla usaban colaciones
 * distintas: "Illegal mix of collations"; así funciona igual en cualquier motor.)
 */
async function alertasActivas({ dias = 7, clave = null, limite = 20 } = {}) {
  const [alertas, atendidas] = await deps.consulta(`
    SELECT TOP (200) idBitacora AS id, Fecha AS fecha, Descripcion AS descripcion, IP AS ip
      FROM Bitacora
     WHERE Accion = 'ALERTA_SEGURIDAD' AND Fecha >= DATEADD(DAY, -@dias, GETDATE())
       AND (@clave IS NULL OR idRegistro = @clave)
     ORDER BY idBitacora DESC;
    SELECT DISTINCT idRegistro FROM Bitacora
     WHERE Accion = 'ALERTA_ATENDIDA' AND Fecha >= DATEADD(DAY, -@diasAtendidas, GETDATE());`,
  { dias, clave, diasAtendidas: dias + 1 });
  const hechas = new Set((atendidas || []).map((f) => String(f.idRegistro)));
  return (alertas || []).filter((a) => !hechas.has(String(a.id))).slice(0, limite);
}

const resumen = () => ({ ...estado, ventanaMin: VENTANA_MS / 60000, umbral: UMBRAL_IP });

/** Solo para pruebas */
const _reiniciar = () => { porIp.clear(); silenciadas.clear(); estado.alertasEmitidas = 0; estado.ultima = null; };
const _dependencias = (nuevas) => Object.assign(deps, nuevas);

module.exports = { observar, alertar, alertasActivas, resumen, SOSPECHOSOS, _reiniciar, _dependencias };
