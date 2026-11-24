// =====================================================================
//  [OWASP A06] Componentes vulnerables y desactualizados
//  - Versión de Node.js y de SQL Server contra sus fechas de fin de soporte
//  - Paquetes de npm instalados (versión exacta)
//  - Auditoría con "npm audit" (base de datos pública de vulnerabilidades)
// =====================================================================
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const { CARPETA_ALMACEN } = require('../almacen');
const ARCHIVO_AUDITORIA = path.join(CARPETA_ALMACEN, 'auditoria-npm.json');
const DIAS_VIGENCIA_AUDITORIA = 7;

// Fin de soporte oficial (calendario de nodejs.org y ciclo de vida de Microsoft SQL Server)
const FIN_NODE = {
  18: '2025-04-30', 19: '2023-06-01', 20: '2026-04-30', 21: '2024-06-01',
  22: '2027-04-30', 23: '2025-06-01', 24: '2028-04-30', 25: '2026-06-01', 26: '2029-04-30'
};
// Fin del soporte extendido de cada versión de SQL Server (número de versión mayor → año comercial)
const FIN_SQLSERVER = { 11: '2022-07-12', 12: '2024-07-09', 13: '2026-07-14', 14: '2027-10-12', 15: '2030-01-08', 16: '2033-01-11' };
const NOMBRE_SQLSERVER = { 11: '2012', 12: '2014', 13: '2016', 14: '2017', 15: '2019', 16: '2022', 17: '2025' };

const hoyTexto = (hoy) => hoy.toISOString().slice(0, 10);

/** { version, linea, fin, soportado } para una versión de Node como "v24.20.0". */
function soporteNode(version = process.version, hoy = new Date()) {
  const linea = Number(String(version).replace(/^v/, '').split('.')[0]);
  const fin = FIN_NODE[linea] || (linea > 26 ? null : '1970-01-01');
  return {
    version: String(version).replace(/^v/, ''), linea,
    fin, lts: linea % 2 === 0,
    soportado: fin === null ? true : hoyTexto(hoy) <= fin
  };
}

/**
 * { version, nombre, fin, soportado, motor } para SQL Server.
 * @param {string} version  SERVERPROPERTY('ProductVersion'), por ejemplo "16.0.4135.4"
 * @param {string} edicion  SERVERPROPERTY('Edition')
 * @param {number} motor    SERVERPROPERTY('EngineEdition'): 5 = Azure SQL Database, 8 = Azure SQL Managed Instance
 */
function soporteSqlServer(version, edicion = '', motor = null, hoy = new Date()) {
  const texto = String(version || '');
  if (Number(motor) === 5 || Number(motor) === 8 || /azure/i.test(edicion)) {
    return { version: texto, nombre: Number(motor) === 8 ? 'Azure SQL Managed Instance' : 'Azure SQL Database',
      fin: null, soportado: true, administrado: true, motor: 'Azure SQL' };
  }
  const mayor = Number(texto.split('.')[0]);
  const fin = FIN_SQLSERVER[mayor] || null;
  const soportado = fin ? hoyTexto(hoy) <= fin : mayor > 16;
  return { version: texto, nombre: `SQL Server ${NOMBRE_SQLSERVER[mayor] || texto}`, fin, soportado, administrado: false, motor: 'SQL Server' };
}

/** Paquetes declarados en package.json con la versión que realmente está instalada. */
function dependenciasInstaladas() {
  const paquete = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  return Object.entries(paquete.dependencies || {}).map(([nombre, pedido]) => {
    let instalada = null;
    try {
      instalada = JSON.parse(fs.readFileSync(path.join(RAIZ, 'node_modules', nombre, 'package.json'), 'utf8')).version;
    } catch { /* no instalado */ }
    return { nombre, pedido, instalada };
  });
}

const hayLockfile = () => fs.existsSync(path.join(RAIZ, 'package-lock.json'));

async function leerAuditoria() {
  try { return JSON.parse(await fsp.readFile(ARCHIVO_AUDITORIA, 'utf8')); } catch { return null; }
}

/** Ejecuta un comando de npm fijo (sin datos del usuario) y devuelve su salida JSON. */
function npmJson(argumentos) {
  return new Promise((resolve) => {
    exec(`npm ${argumentos}`, { cwd: RAIZ, timeout: 90 * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        // npm audit / npm outdated terminan con código 1 cuando encuentran algo: no es un fallo
        try { resolve(JSON.parse(stdout || '{}')); } catch { resolve({ error: { summary: err ? err.message : 'Salida no válida' } }); }
      });
  });
}

/** Resume la salida de "npm audit --json" (formato de npm 7 o más nuevo). */
function resumirAudit(salida) {
  if (!salida || salida.error) {
    const e = salida && salida.error;
    const texto = e && (e.summary || e.code) ? String(e.summary || e.code).slice(0, 140).replace(/\.+$/, '') : '';
    const pista = /lockfile|package-lock/i.test(texto) ? 'Ejecuta "npm install" primero.' : '¿Hay internet?';
    throw new Error(`No se pudo consultar npm audit${texto ? `: ${texto}` : ''}. ${pista}`);
  }
  const v = (salida.metadata && salida.metadata.vulnerabilities) || {};
  const conteo = {
    critical: Number(v.critical) || 0, high: Number(v.high) || 0, moderate: Number(v.moderate) || 0,
    low: Number(v.low) || 0, info: Number(v.info) || 0
  };
  conteo.total = Number(v.total) || conteo.critical + conteo.high + conteo.moderate + conteo.low + conteo.info;
  const detalle = Object.values(salida.vulnerabilities || {}).slice(0, 20).map((x) => ({
    paquete: x.name, severidad: x.severity, arreglo: x.fixAvailable ? 'npm audit fix' : 'sin arreglo aún',
    titulo: (Array.isArray(x.via) ? x.via.find((y) => typeof y === 'object') : null)?.title || null
  }));
  return { conteo, detalle };
}

function resumirOutdated(salida) {
  if (!salida || salida.error) return [];
  return Object.entries(salida).map(([nombre, x]) => ({
    nombre, instalada: x.current || null, compatible: x.wanted || null, ultima: x.latest || null
  }));
}

let enCurso = null;

/** Corre npm audit + npm outdated y guarda el resultado en almacen/auditoria-npm.json. */
function ejecutarAuditoria() {
  if (enCurso) return enCurso;
  enCurso = (async () => {
    const audit = resumirAudit(await npmJson('audit --omit=dev --json'));   // si falla, ya no se corre outdated
    const resultado = {
      fecha: new Date().toISOString(),
      ...audit,
      desactualizados: resumirOutdated(await npmJson('outdated --json'))
    };
    await fsp.mkdir(path.dirname(ARCHIVO_AUDITORIA), { recursive: true });
    await fsp.writeFile(ARCHIVO_AUDITORIA, JSON.stringify(resultado, null, 2));
    return resultado;
  })().finally(() => { enCurso = null; });
  return enCurso;
}

const revision = (estado, nombre, detalle, arreglo) => ({ estado, nombre, detalle, ...(arreglo ? { arreglo } : {}) });

/** Revisiones para el panel. `bd` = { version, comentario, motor } de configuracion.js */
async function revisarComponentes(bd = {}, hoy = new Date()) {
  const r = [];
  const node = soporteNode(process.version, hoy);
  r.push(node.soportado
    ? revision('activo', `Node.js ${node.version}`, `Línea ${node.linea}${node.lts ? ' LTS' : ''} con parches de seguridad hasta ${node.fin || 'fecha por anunciar'}.`)
    : revision('atencion', `Node.js ${node.version} sin soporte`, `La línea ${node.linea} dejó de recibir parches el ${node.fin}.`,
      'Instala la versión LTS más reciente desde nodejs.org.'));

  if (bd.version) {
    const m = soporteSqlServer(bd.version, bd.comentario, bd.motor, hoy);
    if (m.administrado) {
      r.push(revision('activo', `${m.nombre} (${m.version})`, 'Servicio administrado: Microsoft le aplica los parches de seguridad automáticamente.'));
    } else if (m.soportado) {
      r.push(revision('activo', `${m.nombre} (${m.version})`, `Con parches de seguridad${m.fin ? ` hasta ${m.fin}` : ''}.`));
    } else {
      r.push(revision('atencion', `${m.nombre} sin soporte`,
        `Esta versión dejó de recibir parches de seguridad${m.fin ? ` el ${m.fin}` : ''}.`,
        'Actualiza a SQL Server 2022 o usa Azure SQL Database.'));
    }
  }

  const deps = dependenciasInstaladas();
  const faltan = deps.filter((d) => !d.instalada);
  r.push(faltan.length
    ? revision('atencion', 'Paquetes sin instalar', faltan.map((d) => d.nombre).join(', '), 'Ejecuta "npm install".')
    : revision('activo', `${deps.length} paquetes de npm`, deps.map((d) => `${d.nombre} ${d.instalada}`).join(' · ')));

  r.push(hayLockfile()
    ? revision('activo', 'Versiones fijadas (package-lock.json)', 'Todos instalan exactamente las mismas versiones revisadas.')
    : revision('atencion', 'Falta package-lock.json', 'Sin él, cada "npm install" puede bajar versiones distintas.', 'Ejecuta "npm install" para generarlo.'));

  r.push(revision('activo', 'Sin librerías externas en el navegador',
    'La página no carga JavaScript de otros sitios (CDN); todo el código está en public/js.'));

  const a = await leerAuditoria();
  if (!a) {
    r.push(revision('atencion', 'Auditoría de dependencias pendiente', 'Nunca se ha corrido "npm audit" desde el panel.',
      'Da clic en "Revisar dependencias" (necesita internet).'));
  } else {
    const dias = Math.floor((hoy - new Date(a.fecha)) / 86400000);
    const graves = a.conteo.critical + a.conteo.high;
    if (a.conteo.total === 0) {
      r.push(revision(dias > DIAS_VIGENCIA_AUDITORIA ? 'atencion' : 'activo', 'npm audit: 0 vulnerabilidades',
        `Última revisión hace ${dias} día(s).${dias > DIAS_VIGENCIA_AUDITORIA ? ' Vuelve a revisar (cada semana salen avisos nuevos).' : ''}`));
    } else {
      r.push(revision('atencion', `npm audit: ${a.conteo.total} vulnerabilidad(es)`,
        `${graves} grave(s) (critical/high), ${a.conteo.moderate} moderada(s), ${a.conteo.low} baja(s). Revisado hace ${dias} día(s).`,
        'Ejecuta "npm audit fix" en la carpeta del proyecto y vuelve a revisar.'));
    }
    if (a.desactualizados && a.desactualizados.length) {
      r.push(revision('info', `${a.desactualizados.length} paquete(s) con versión más nueva`,
        a.desactualizados.map((d) => `${d.nombre} ${d.instalada || '?'} → ${d.ultima}`).join(' · ')));
    }
  }
  return { revisiones: r, auditoria: a, node, dependencias: deps };
}

module.exports = {
  soporteNode, soporteSqlServer, dependenciasInstaladas, resumirAudit, resumirOutdated,
  ejecutarAuditoria, leerAuditoria, revisarComponentes
};
