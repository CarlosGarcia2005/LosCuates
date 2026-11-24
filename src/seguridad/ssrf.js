// =====================================================================
//  [OWASP A10] Server-Side Request Forgery (SSRF)
//  Cuando el SERVIDOR descarga algo de una URL que escribió un usuario
//  (aquí: "comprobante desde enlace"), un atacante podría pedirle que
//  descargue cosas internas que solo el servidor ve:
//    http://localhost:3000/...            (la propia app)
//    http://192.168.1.1/                  (el router / la red local)
//    http://169.254.169.254/latest/...    (credenciales de AWS)
//  Esta descarga segura:
//   1. Solo acepta https en el puerto 443, sin usuario:contraseña.
//   2. Rechaza nombres internos (localhost, *.local, *.internal).
//   3. Resuelve el DNS y rechaza si CUALQUIER IP es privada/interna.
//   4. Se conecta a la IP ya revisada (evita "DNS rebinding").
//   5. No sigue redirecciones sin volver a revisar todo (máximo 3).
//   6. Corta a los 8 segundos o a los 5 MB.
// =====================================================================
const dns = require('dns').promises;
const net = require('net');
const https = require('https');

const TAMANO_MAXIMO = 5 * 1024 * 1024;
const TIEMPO_MAXIMO_MS = 8000;
const REDIRECCIONES_MAXIMAS = 3;

class ErrorSsrf extends Error {
  constructor(motivo, mensaje, detalle = {}) {
    super(mensaje);
    this.motivo = motivo;
    this.detalle = detalle;
  }
}
class ErrorDescarga extends Error {}

// ---------------------------------------------------------------------
// Direcciones que nunca se deben visitar desde el servidor
// ---------------------------------------------------------------------
const bloqueadas = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([red, bits]) => bloqueadas.addSubnet(red, bits, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 32]
].forEach(([red, bits]) => bloqueadas.addSubnet(red, bits, 'ipv6'));

/** Si la IPv6 lleva una IPv4 adentro (::ffff:a.b.c.d, 64:ff9b::/96, 2002::/16), la devuelve. */
function ipv4Dentro(ip6) {
  const texto = ip6.toLowerCase();
  const mapeada = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(texto) || /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(texto);
  if (mapeada) return mapeada[1];
  const grupos = expandirIpv6(texto);
  if (!grupos) return null;
  const aV4 = (a, b) => [a >> 8, a & 255, b >> 8, b & 255].join('.');
  if (grupos.slice(0, 5).every((g) => g === 0) && grupos[5] === 0xffff) return aV4(grupos[6], grupos[7]); // ::ffff:x:x
  if (grupos[0] === 0x64 && grupos[1] === 0xff9b) return aV4(grupos[6], grupos[7]);                     // NAT64
  if (grupos[0] === 0x2002) return aV4(grupos[1], grupos[2]);                                          // 6to4
  if (grupos.slice(0, 6).every((g) => g === 0) && (grupos[6] || grupos[7])) return aV4(grupos[6], grupos[7]); // ::a.b.c.d
  return null;
}

function expandirIpv6(ip) {
  let texto = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(texto);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    texto = texto.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [izq, der] = texto.split('::');
  const a = izq ? izq.split(':') : [];
  const b = der !== undefined && der ? der.split(':') : [];
  const faltan = 8 - a.length - b.length;
  if (texto.includes('::') ? faltan < 0 : a.length !== 8) return null;
  const grupos = [...a, ...Array(texto.includes('::') ? faltan : 0).fill('0'), ...b].map((g) => parseInt(g || '0', 16));
  return grupos.length === 8 && grupos.every((g) => g >= 0 && g <= 0xffff) ? grupos : null;
}

/** true si la IP es privada, local, reservada o de metadatos. */
function esIpBloqueada(ip) {
  const limpia = String(ip).replace(/^\[|\]$/g, '').split('%')[0];
  const tipo = net.isIP(limpia);
  if (tipo === 4) return bloqueadas.check(limpia, 'ipv4');
  if (tipo === 6) {
    const v4 = ipv4Dentro(limpia);
    if (v4) return bloqueadas.check(v4, 'ipv4');
    return bloqueadas.check(limpia, 'ipv6');
  }
  return true;   // si no es una IP válida, no se arriesga
}

const NOMBRES_INTERNOS = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/** Dominios permitidos opcionales (SSRF_DOMINIOS en .env, separados por coma). */
function dominiosPermitidos() {
  return String(process.env.SSRF_DOMINIOS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/**
 * Revisa la URL sin hacer ninguna conexión.
 * @returns {URL}
 * @throws {ErrorSsrf}
 */
function revisarUrl(texto) {
  let url;
  try { url = new URL(String(texto).trim()); } catch {
    throw new ErrorSsrf('formato', 'El enlace no es válido.');
  }
  if (url.protocol !== 'https:') {
    throw new ErrorSsrf('protocolo', 'Solo se permiten enlaces https://', { protocolo: url.protocol });
  }
  if (url.username || url.password) {
    throw new ErrorSsrf('credenciales', 'El enlace no puede llevar usuario ni contraseña.');
  }
  if (url.port && url.port !== '443') {
    throw new ErrorSsrf('puerto', 'Solo se permite el puerto estándar de https (443).', { puerto: url.port });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new ErrorSsrf('formato', 'El enlace no tiene dominio.');
  if (net.isIP(host)) {
    if (esIpBloqueada(host)) {
      throw new ErrorSsrf('ip_interna', 'Ese enlace apunta a una dirección interna del servidor o de la red.', { ip: host });
    }
  } else {
    if (NOMBRES_INTERNOS.test(host) || !host.includes('.')) {
      throw new ErrorSsrf('nombre_interno', 'Ese enlace apunta a un nombre interno de la red.', { host });
    }
  }
  const permitidos = dominiosPermitidos();
  if (permitidos.length && !permitidos.some((d) => host === d || host.endsWith(`.${d}`))) {
    throw new ErrorSsrf('dominio', `Ese dominio no está en la lista de permitidos (${permitidos.join(', ')}).`, { host });
  }
  return url;
}

/**
 * Resuelve el nombre y revisa TODAS las IPs (si una sola es interna, se rechaza).
 * @returns {Promise<{address:string, family:number}>} la IP con la que se va a conectar
 */
async function resolverSeguro(host, { buscar = dns.lookup, ipPermitida = (ip) => !esIpBloqueada(ip) } = {}) {
  const limpio = host.replace(/^\[|\]$/g, '');
  if (net.isIP(limpio)) {
    if (!ipPermitida(limpio)) throw new ErrorSsrf('ip_interna', 'Ese enlace apunta a una dirección interna del servidor o de la red.', { ip: limpio });
    return { address: limpio, family: net.isIP(limpio) };
  }
  let direcciones;
  try {
    direcciones = await buscar(limpio, { all: true, verbatim: true });
  } catch {
    throw new ErrorDescarga('No se encontró ese dominio.');
  }
  if (!direcciones.length) throw new ErrorDescarga('No se encontró ese dominio.');
  const internas = direcciones.filter((d) => !ipPermitida(d.address));
  if (internas.length) {
    throw new ErrorSsrf('dns_interno', 'Ese dominio apunta a una dirección interna del servidor o de la red.',
      { host: limpio, ips: direcciones.map((d) => d.address) });
  }
  return direcciones[0];
}

/** Una petición GET conectándose a la IP ya revisada. */
function pedir(url, destino, { maximo, tiempo, agente, ca }) {
  return new Promise((resolver, rechazar) => {
    const req = https.request({
      method: 'GET',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: 443,
      path: `${url.pathname}${url.search}`,
      servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      headers: { 'User-Agent': agente, Accept: 'image/png,image/jpeg,application/pdf;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity' },
      // Se conecta SOLO a la IP revisada: si el DNS cambia a una IP interna después, no importa
      lookup: (_host, opciones, cb) => (opciones && opciones.all
        ? cb(null, [{ address: destino.address, family: destino.family }])
        : cb(null, destino.address, destino.family)),
      timeout: tiempo,
      ca,
      agent: false
    }, (resp) => {
      const estado = resp.statusCode;
      if (estado >= 300 && estado < 400 && resp.headers.location) {
        resp.resume();
        return resolver({ redireccion: resp.headers.location, estado });
      }
      if (estado !== 200) {
        resp.resume();
        return rechazar(new ErrorDescarga(`El enlace respondió con error ${estado}.`));
      }
      const largo = Number(resp.headers['content-length'] || 0);
      if (largo > maximo) {
        resp.destroy();
        return rechazar(new ErrorDescarga('El archivo del enlace pesa más de 5 MB.'));
      }
      const partes = [];
      let total = 0;
      resp.on('data', (trozo) => {
        total += trozo.length;
        if (total > maximo) {
          resp.destroy();
          rechazar(new ErrorDescarga('El archivo del enlace pesa más de 5 MB.'));
        } else partes.push(trozo);
      });
      resp.on('end', () => resolver({ cuerpo: Buffer.concat(partes), tipo: String(resp.headers['content-type'] || '') }));
      resp.on('error', () => rechazar(new ErrorDescarga('Se cortó la descarga.')));
    });
    const lento = () => req.destroy(new ErrorDescarga('El enlace tardó demasiado en responder (más de 8 s).'));
    const reloj = setTimeout(lento, tiempo);       // límite total, aunque mande datos muy despacio
    req.on('close', () => clearTimeout(reloj));
    req.on('timeout', lento);
    req.on('error', (err) => rechazar(err instanceof ErrorDescarga ? err : new ErrorDescarga('No se pudo conectar con ese enlace.')));
    req.end();
  });
}

/**
 * Descarga segura (anti-SSRF).
 * @returns {Promise<{cuerpo:Buffer, tipo:string, urlFinal:string, ip:string, redirecciones:number}>}
 * @throws {ErrorSsrf | ErrorDescarga}
 */
async function descargarSeguro(texto, opciones = {}) {
  const {
    maximo = TAMANO_MAXIMO, tiempo = TIEMPO_MAXIMO_MS, agente = 'RanchoSeco/1.0 (descarga de comprobantes)',
    buscar, ipPermitida, ca, revisar = revisarUrl
  } = opciones;
  let url = revisar(texto);
  const limite = Date.now() + tiempo;

  for (let saltos = 0; saltos <= REDIRECCIONES_MAXIMAS; saltos += 1) {
    const destino = await resolverSeguro(url.hostname, { buscar, ipPermitida });
    const restante = Math.max(1000, limite - Date.now());
    const r = await pedir(url, destino, { maximo, tiempo: restante, agente, ca });
    if (!r.redireccion) return { ...r, urlFinal: url.href, ip: destino.address, redirecciones: saltos };
    let siguiente;
    try { siguiente = new URL(r.redireccion, url); } catch { throw new ErrorDescarga('El enlace redirige a una dirección inválida.'); }
    try {
      url = revisar(siguiente.href);    // cada redirección se revisa como si fuera un enlace nuevo
    } catch (err) {
      if (err instanceof ErrorSsrf) {
        err.detalle = { ...err.detalle, redireccionDesde: url.href };
        err.message = `El enlace redirige a una dirección no permitida. ${err.message}`;
      }
      throw err;
    }
  }
  throw new ErrorDescarga(`El enlace redirige más de ${REDIRECCIONES_MAXIMAS} veces.`);
}

/** URL sin datos sensibles para la bitácora (sin usuario/contraseña, máx. 200 caracteres). */
function urlParaBitacora(texto) {
  try {
    const u = new URL(String(texto));
    u.username = ''; u.password = '';
    return u.href.slice(0, 200);
  } catch {
    return String(texto).slice(0, 200);
  }
}

module.exports = {
  ErrorSsrf, ErrorDescarga, esIpBloqueada, revisarUrl, resolverSeguro, descargarSeguro, urlParaBitacora,
  dominiosPermitidos, TAMANO_MAXIMO, TIEMPO_MAXIMO_MS, REDIRECCIONES_MAXIMAS
};
