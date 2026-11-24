// =====================================================================
//  Bitácora administrativa
//  Registra quién hizo qué, cuándo, desde dónde y qué datos cambiaron.
//
//  [OWASP A09] Además:
//   - Cada registro se firma y se encadena con el anterior (cadena-bitacora.js)
//   - Se limpia de saltos de línea y caracteres de control (anti "log injection")
//   - Se copia a un archivo diario (archivo-registro.js), aunque falle la base de datos
//   - Se revisa al momento para crear alertas (monitor.js)
// =====================================================================
const { consulta, transaccion } = require('../config/db');
const cadena = require('./seguridad/cadena-bitacora');
const archivo = require('./seguridad/archivo-registro');
const monitor = require('./seguridad/monitor');

// Campos que nunca deben quedar escritos en la bitácora
const CAMPOS_PROHIBIDOS = /contrase|password|secreto|token|hash|codigo/i;

function limpiar(obj) {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(limpiar);
  if (typeof obj !== 'object') return obj;
  const salida = {};
  for (const [k, v] of Object.entries(obj)) {
    if (CAMPOS_PROHIBIDOS.test(k)) continue;
    salida[k] = v instanceof Date ? v.toISOString() : (typeof v === 'object' ? limpiar(v) : v);
  }
  return salida;
}

const normalizar = (v) => (v === undefined || v === '' ? null : v instanceof Date ? v.toISOString() : v);

/** Devuelve solo los campos que cambiaron: { antes: {...}, despues: {...}, campos: [...] } */
function diferencias(antes, despues) {
  const a = {}, d = {}, campos = [];
  for (const campo of Object.keys(despues)) {
    const va = normalizar(antes[campo]);
    const vd = normalizar(despues[campo]);
    if (String(va) !== String(vd)) {
      a[campo] = va; d[campo] = vd; campos.push(campo);
    }
  }
  return { antes: a, despues: d, campos };
}

function ipDe(req) {
  const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || null;
  return ip ? String(ip).replace(/^::ffff:/, '').slice(0, 45) : null;
}

// Saltos de línea, tabuladores, caracteres de control y de dirección de texto (bidi)
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
let neutralizados = 0;

/** [A09] Texto seguro para la bitácora: sin caracteres de control y cortado sin partir emojis. */
function texto(valor, maximo) {
  if (valor === null || valor === undefined) return null;
  let t = String(valor);
  if (typeof t.toWellFormed === 'function') t = t.toWellFormed();
  const limpio = t.replace(CONTROL, ' ');
  if (limpio !== t) neutralizados += 1;
  if (limpio.length <= maximo) return limpio;
  // SQL Server mide NVARCHAR en unidades UTF-16 (un emoji ocupa 2): se corta sin partir emojis
  let salida = '';
  for (const letra of limpio) {
    if (salida.length + letra.length > maximo) break;
    salida += letra;
  }
  return salida;
}

/** Fecha local "AAAA-MM-DD HH:MM:SS" (la misma que devuelve SQL Server al leerla con CONVERT(..., 120)). */
function fechaLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Arma la fila exactamente como quedará guardada (es lo que se firma). */
function construirFila(req, { accion, modulo, descripcion, resultado, tabla, idRegistro, antes, despues, actor }) {
  const u = actor || (req && req.usuario) || null;
  return {
    Fecha: fechaLocal(),
    idUsuario: u && u.id ? Number(u.id) : null,
    Correo_Usuario: u && u.correo ? texto(u.correo, 100) : null,
    Rol_Usuario: u && u.rol ? texto(u.rol, 40) : null,
    Accion: texto(accion, 40),
    Modulo: texto(modulo || 'Sistema', 40),
    Tabla_Afectada: tabla ? texto(tabla, 40) : null,
    idRegistro: idRegistro === null || idRegistro === undefined ? null : texto(idRegistro, 40),
    Descripcion: texto(descripcion || '', 500),
    Datos_Anteriores: antes ? JSON.stringify(limpiar(antes)) : null,     // JSON escapa los saltos de línea
    Datos_Nuevos: despues ? JSON.stringify(limpiar(despues)) : null,
    IP: ipDe(req),
    Navegador: req && req.headers ? texto(req.headers['user-agent'] || '', 300) : null,
    Resultado: resultado === 'Fallo' ? 'Fallo' : 'Éxito',
    Origen: 'Aplicación'
  };
}

/** Guarda la fila firmada y encadenada (una a la vez, gracias al bloqueo de Bitacora_Cadena). */
async function guardarFirmada(fila) {
  return transaccion(async (cx) => {
    const [estado] = await consulta('SELECT Ultimo_Hash FROM Bitacora_Cadena WITH (UPDLOCK, HOLDLOCK) WHERE id = 1', {}, cx);
    if (!estado) throw new Error('Falta la tabla Bitacora_Cadena: ejecuta sql/04_integridad_y_monitoreo.sql');
    const hash = cadena.firmaDe(estado.Ultimo_Hash, fila);
    const r = await consulta(`
      INSERT INTO Bitacora
        (Fecha, idUsuario, Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
         Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen, Hash_Integridad)
      VALUES
        (CONVERT(DATETIME, @Fecha, 120), @idUsuario, @Correo_Usuario, @Rol_Usuario, @Accion, @Modulo, @Tabla_Afectada, @idRegistro,
         @Descripcion, @Datos_Anteriores, @Datos_Nuevos, @IP, @Navegador, @Resultado, @Origen, @hash)`, { ...fila, hash }, cx);
    await consulta(`UPDATE Bitacora_Cadena SET Ultimo_Hash = @hash, Total = Total + 1, Ultimo_id = @id, Actualizado = GETDATE()
                     WHERE id = 1`, { hash, id: r.insertId }, cx);
    return { id: r.insertId, hash };
  });
}

/**
 * Inserta un registro. Nunca lanza error: si la bitácora falla,
 * se avisa en consola y el registro queda en el archivo de respaldo.
 */
async function registrar(req, {
  accion, modulo, descripcion, resultado = 'Éxito',
  tabla = null, idRegistro = null, antes = null, despues = null, actor = null
}) {
  let fila;
  try {
    fila = construirFila(req, { accion, modulo, descripcion, resultado, tabla, idRegistro, antes, despues, actor });
  } catch (err) {
    console.error('[BITÁCORA] Datos inválidos para registrar:', accion, err.message);
    return;
  }
  let guardado = null;
  try {
    guardado = await guardarFirmada(fila);
    if (req && req.res) req.res.locals.bitacoraRegistrada = true;
  } catch (err) {
    archivo.fallaBase(err.message);
    console.error('[BITÁCORA] No se pudo registrar el movimiento:', accion, err.message);
  }
  archivo.escribir({ id: guardado && guardado.id, ...fila, Hash_Integridad: guardado && guardado.hash, enBase: Boolean(guardado) });
  try { monitor.observar(fila); } catch { /* el monitoreo nunca rompe la operación */ }
}

/** Lee la bitácora y revisa la cadena de firmas completa. */
async function verificarIntegridad() {
  const [estado] = await consulta('SELECT Ultimo_Hash, Total, Ultimo_id FROM Bitacora_Cadena WHERE id = 1');
  const revisadas = new Set((await consulta(
    "SELECT DISTINCT idRegistro FROM Bitacora WHERE Accion = 'INTEGRIDAD_REVISADA' AND idRegistro IS NOT NULL"
  )).map((f) => f.idRegistro));
  const limite = estado && estado.Ultimo_id ? Number(estado.Ultimo_id) : 0;

  const filas = [];
  const columnas = cadena.CAMPOS.filter((c) => c !== 'Fecha').join(', ');
  let desde = 0;
  for (;;) {
    const lote = await consulta(`
      SELECT TOP (5000) idBitacora, CONVERT(VARCHAR(19), Fecha, 120) AS Fecha, ${columnas}, Hash_Integridad
        FROM Bitacora WHERE idBitacora > @desde AND idBitacora <= @limite
       ORDER BY idBitacora`, { desde, limite });
    filas.push(...lote);
    if (lote.length < 5000) break;
    desde = Number(lote[lote.length - 1].idBitacora);
  }
  return { ...cadena.verificarCadena(filas, estado, revisadas), total: Number(estado ? estado.Total : 0) };
}

const resumenRegistro = () => ({ ...archivo.resumen(), neutralizados });

module.exports = { registrar, diferencias, limpiar, verificarIntegridad, resumenRegistro, construirFila, texto, fechaLocal };
