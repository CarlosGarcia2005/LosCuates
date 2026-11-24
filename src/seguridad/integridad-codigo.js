// =====================================================================
//  [OWASP A08] Integridad del software
//  1. Manifiesto firmado (integridad.json): SHA-256 de cada archivo del
//     sistema + firma HMAC. Si alguien cambia un archivo (por ejemplo,
//     mete código para robar contraseñas en login.js), se detecta.
//  2. Dependencias: package-lock.json guarda el hash sha512 de cada
//     paquete y se revisa que lo instalado sea exactamente esa versión.
// =====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { firmar, iguales } = require('./llaves');

const RAIZ_PROYECTO = path.join(__dirname, '..', '..');
const ARCHIVO_MANIFIESTO = 'integridad.json';
// Lo que forma parte del sistema y se ejecuta o se sirve
const INCLUIR = ['server.js', 'package.json', 'package-lock.json', 'vercel.json', 'api', 'config', 'src', 'public', 'views', 'sql', 'scripts'];
const EXTENSIONES = /\.(js|json|html|css|sql|svg|png|ico|txt|md)$/i;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Lista de archivos (rutas relativas con "/") que se firman. */
function listarArchivos(raiz = RAIZ_PROYECTO) {
  const lista = [];
  const recorrer = (relativa) => {
    const absoluta = path.join(raiz, relativa);
    let info;
    try { info = fs.statSync(absoluta); } catch { return; }
    if (info.isDirectory()) {
      for (const nombre of fs.readdirSync(absoluta).sort()) {
        if (nombre.startsWith('.') || nombre === 'node_modules') continue;
        recorrer(path.join(relativa, nombre));
      }
    } else if (info.isFile() && (EXTENSIONES.test(relativa) || relativa === 'server.js')) {
      lista.push(relativa.split(path.sep).join('/'));
    }
  };
  for (const entrada of INCLUIR) recorrer(entrada);
  return lista.filter((r) => r !== ARCHIVO_MANIFIESTO).sort();
}

const textoFirmable = (archivos) => JSON.stringify(Object.keys(archivos).sort().map((r) => [r, archivos[r]]));

/** Calcula los hashes y escribe integridad.json firmado. */
function generarManifiesto(raiz = RAIZ_PROYECTO) {
  const archivos = {};
  for (const relativa of listarArchivos(raiz)) archivos[relativa] = sha256(fs.readFileSync(path.join(raiz, relativa)));
  const manifiesto = {
    descripcion: 'Huella SHA-256 de cada archivo del sistema. Si cambias el código a propósito, ejecuta: npm run firmar-codigo',
    fecha: new Date().toISOString(),
    total: Object.keys(archivos).length,
    archivos,
    firma: firmar('codigo', textoFirmable(archivos))
  };
  fs.writeFileSync(path.join(raiz, ARCHIVO_MANIFIESTO), JSON.stringify(manifiesto, null, 2) + '\n');
  return manifiesto;
}

/**
 * Compara los archivos actuales contra el manifiesto.
 * @returns {{estado:'ok'|'sin_manifiesto'|'firma_invalida'|'modificado', total, modificados, nuevos, faltantes, fecha}}
 */
function verificarManifiesto(raiz = RAIZ_PROYECTO) {
  let manifiesto;
  try {
    manifiesto = JSON.parse(fs.readFileSync(path.join(raiz, ARCHIVO_MANIFIESTO), 'utf8'));
  } catch {
    return { estado: 'sin_manifiesto', total: 0, modificados: [], nuevos: [], faltantes: [], fecha: null };
  }
  const guardados = manifiesto.archivos || {};
  let firmaValida = false;
  try { firmaValida = iguales(manifiesto.firma, firmar('codigo', textoFirmable(guardados))); } catch { firmaValida = false; }

  const actuales = listarArchivos(raiz);
  const modificados = [];
  const nuevos = [];
  for (const relativa of actuales) {
    if (!(relativa in guardados)) { nuevos.push(relativa); continue; }
    if (sha256(fs.readFileSync(path.join(raiz, relativa))) !== guardados[relativa]) modificados.push(relativa);
  }
  const faltantes = Object.keys(guardados).filter((r) => !actuales.includes(r));

  let estado = 'ok';
  if (!firmaValida) estado = 'firma_invalida';
  else if (modificados.length || nuevos.length || faltantes.length) estado = 'modificado';
  return { estado, total: Object.keys(guardados).length, modificados, nuevos, faltantes, fecha: manifiesto.fecha || null };
}

/** Revisa que cada paquete instalado sea la versión exacta (con hash sha512) del package-lock.json. */
function verificarDependencias(raiz = RAIZ_PROYECTO) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(raiz, 'package-lock.json'), 'utf8')); } catch {
    return { estado: 'sin_lock', total: 0, conHash: 0, distintos: [], faltantes: [] };
  }
  const paquetes = Object.entries(lock.packages || {}).filter(([ruta]) => ruta.startsWith('node_modules/'));
  const distintos = [];
  const faltantes = [];
  let conHash = 0;
  for (const [ruta, datos] of paquetes) {
    if (datos.integrity && /^sha(512|384|256)-/.test(datos.integrity)) conHash += 1;
    try {
      const instalado = JSON.parse(fs.readFileSync(path.join(raiz, ruta, 'package.json'), 'utf8'));
      if (datos.version && instalado.version !== datos.version) distintos.push(`${ruta.slice(13)} ${instalado.version} ≠ ${datos.version}`);
    } catch {
      if (!datos.optional && !datos.dev) faltantes.push(ruta.slice(13));
    }
  }
  return { estado: distintos.length || faltantes.length ? 'distinto' : 'ok', total: paquetes.length, conHash, distintos, faltantes };
}

module.exports = { listarArchivos, generarManifiesto, verificarManifiesto, verificarDependencias, ARCHIVO_MANIFIESTO };
