// =====================================================================
//  [OWASP A08 / A09] Vigilancia periódica
//  Al arrancar y cada 10 minutos revisa:
//   - que el código no haya cambiado (integridad.json)
//   - que la cadena de firmas de la bitácora siga completa
//  Si encuentra algo, lo registra y crea una alerta (una sola vez por problema).
// =====================================================================
const crypto = require('crypto');
const { verificarManifiesto } = require('./integridad-codigo');
const monitor = require('./monitor');

const bitacora = { get m() { return require('../bitacora'); } };
const INTERVALO_MS = 10 * 60 * 1000;
const yaAvisado = new Set();

const ultimo = { codigo: null, bitacora: null, fecha: null };

function huella(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

async function revisarCodigo({ silencioso = false } = {}) {
  const r = verificarManifiesto();
  ultimo.codigo = r;
  if (r.estado === 'ok' || r.estado === 'sin_manifiesto') return r;
  const clave = `codigo:${huella([r.estado, r.modificados, r.nuevos, r.faltantes])}`;
  if (yaAvisado.has(clave)) return r;
  yaAvisado.add(clave);
  const lista = [...r.modificados.map((x) => `modificado ${x}`), ...r.nuevos.map((x) => `nuevo ${x}`), ...r.faltantes.map((x) => `falta ${x}`)];
  const texto = r.estado === 'firma_invalida'
    ? 'La firma de integridad.json no es válida (el manifiesto fue alterado o se firmó con otra clave).'
    : `El código del sistema cambió desde que se firmó: ${lista.slice(0, 5).join(', ')}${lista.length > 5 ? ` y ${lista.length - 5} más` : ''}.`;
  if (!silencioso) {
    await bitacora.m.registrar({ ip: null, headers: {} }, {
      accion: 'INTEGRIDAD_CODIGO', modulo: 'Seguridad', resultado: 'Fallo', descripcion: `[A08] ${texto}`,
      despues: { estado: r.estado, modificados: r.modificados, nuevos: r.nuevos, faltantes: r.faltantes }
    });
    await monitor.alertar({ clave: clave.slice(0, 40), descripcion: `Integridad del código: ${texto}` });
  }
  return r;
}

async function revisarBitacora() {
  const r = await bitacora.m.verificarIntegridad();
  ultimo.bitacora = r;
  for (const p of r.problemas.filter((x) => !x.revisado)) {
    if (yaAvisado.has(p.clave)) continue;
    yaAvisado.add(p.clave);
    await bitacora.m.registrar({ ip: null, headers: {} }, {
      accion: 'INTEGRIDAD_BITACORA', modulo: 'Seguridad', resultado: 'Fallo', idRegistro: p.clave,
      descripcion: `[A09] Bitácora alterada: ${p.detalle}`
    });
    await monitor.alertar({ clave: `bitacora:${p.clave}`.slice(0, 40), descripcion: `Bitácora alterada: ${p.detalle}` });
  }
  return r;
}

async function revisarTodo() {
  ultimo.fecha = new Date().toISOString();
  const resultado = { codigo: null, bitacora: null };
  try { resultado.codigo = await revisarCodigo(); } catch (err) { resultado.codigo = { estado: 'error', error: err.message }; }
  try { resultado.bitacora = await revisarBitacora(); } catch (err) { resultado.bitacora = { ok: false, error: err.message }; }
  return resultado;
}

function iniciar() {
  const t = setInterval(() => { revisarTodo().catch(() => {}); }, INTERVALO_MS);
  t.unref();
  return revisarTodo();
}

module.exports = { iniciar, revisarTodo, revisarCodigo, revisarBitacora, ultimo };
