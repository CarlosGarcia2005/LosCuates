// =====================================================================
//  Conexión a SQL Server (pool de conexiones con el paquete mssql)
// ---------------------------------------------------------------------
//  * Los parámetros se escriben con @nombre (estilo T-SQL).
//  * La aplicación se identifica con el nombre NOMBRE_APP; los triggers
//    de auditoría lo leen con APP_NAME() para saber que el cambio viene
//    de la aplicación (que ya lo registra en la bitácora con más detalle)
//    y no de SSMS o de otra herramienta.
// =====================================================================
const sql = require('mssql');

const NOMBRE_APP = 'RanchoSecoApp';

// El host puede venir como "SERVIDOR" o como "SERVIDOR\INSTANCIA"
const [servidor, instanciaEnHost] = String(process.env.DB_HOST || 'localhost').split('\\');
const instancia = process.env.DB_INSTANCIA || instanciaEnHost || '';

const configuracion = {
  server: servidor,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  connectionTimeout: 15000,
  requestTimeout: 30000,
  options: {
    appName: NOMBRE_APP,
    encrypt: process.env.DB_CIFRADO === '1',                     // 1 en AWS (con certificado)
    trustServerCertificate: process.env.DB_CIFRADO !== '1',
    useUTC: false,                 // las fechas se guardan y se leen con la hora local
    enableArithAbort: true
  }
};

// Con instancia con nombre manda el SQL Browser; con puerto fijo, el puerto.
if (instancia) configuracion.options.instanceName = instancia;
else configuracion.port = Number(process.env.DB_PORT) || 1433;

const pool = new sql.ConnectionPool(configuracion);
let promesaConexion = null;

/** Abre el pool la primera vez y reutiliza la misma promesa después. */
function conectar() {
  if (!promesaConexion) {
    promesaConexion = pool.connect().catch((err) => { promesaConexion = null; throw err; });
  }
  return promesaConexion;
}

/** Tipo de SQL Server que corresponde a cada valor de JavaScript. */
function tipoDe(valor) {
  if (valor === null || valor === undefined) return sql.NVarChar(4000);
  if (typeof valor === 'boolean') return sql.Bit;
  if (typeof valor === 'number') {
    if (!Number.isInteger(valor)) return sql.Decimal(18, 4);
    return Math.abs(valor) <= 2147483647 ? sql.Int : sql.BigInt;
  }
  if (typeof valor === 'bigint') return sql.BigInt;
  if (valor instanceof Date) return sql.DateTime2;
  if (Buffer.isBuffer(valor)) return sql.VarBinary(sql.MAX);
  return String(valor).length > 4000 ? sql.NVarChar(sql.MAX) : sql.NVarChar(4000);
}

/** Agrega solo los parámetros que la consulta realmente usa. */
function agregarParametros(solicitud, textoSql, parametros) {
  const usados = new Set();
  const buscador = /@([A-Za-z_][A-Za-z0-9_]*)/g;
  let coincidencia;
  while ((coincidencia = buscador.exec(textoSql)) !== null) usados.add(coincidencia[1]);

  for (const [nombre, valor] of Object.entries(parametros || {})) {
    if (!usados.has(nombre)) continue;
    const limpio = valor === undefined ? null : valor;
    solicitud.input(nombre, tipoDe(limpio), limpio);
  }
}

/**
 * Ejecuta una consulta.
 *   - Un solo SELECT            → arreglo de filas
 *   - Varios SELECT en un lote  → arreglo con los resultados de cada uno
 *   - INSERT/UPDATE/DELETE      → { filasAfectadas }
 */
async function consulta(textoSql, parametros = {}, transaccionActiva = null) {
  await conectar();
  const solicitud = transaccionActiva ? new sql.Request(transaccionActiva) : pool.request();
  agregarParametros(solicitud, textoSql, parametros);

  const resultado = await solicitud.query(textoSql);
  const conjuntos = resultado.recordsets || [];
  if (conjuntos.length > 1) return conjuntos;
  if (conjuntos.length === 1) return conjuntos[0];
  return { filasAfectadas: (resultado.rowsAffected || []).reduce((a, b) => a + b, 0) };
}

/**
 * INSERT que además devuelve el identificador recién creado.
 * SCOPE_IDENTITY() es el id de ESTA inserción; no el de los triggers
 * de auditoría que escriben en Bitacora.
 */
async function insertar(textoSql, parametros = {}, transaccionActiva = null) {
  const filas = await consulta(
    `${textoSql};\nSELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS insertId;`, parametros, transaccionActiva);
  const id = filas && filas[0] ? filas[0].insertId : null;
  return { insertId: id === null || id === undefined ? null : Number(id) };
}

/** Ejecuta fn(transaccion) dentro de una transacción; si algo falla, la revierte. */
async function transaccion(fn) {
  await conectar();
  const tx = new sql.Transaction(pool);
  let revertida = false;
  tx.on('rollback', () => { revertida = true; });

  await tx.begin();
  try {
    const resultado = await fn(tx);
    await tx.commit();
    return resultado;
  } catch (err) {
    if (!revertida) { try { await tx.rollback(); } catch { /* ya revertida */ } }
    throw err;
  }
}

module.exports = { sql, pool, conectar, consulta, insertar, transaccion, NOMBRE_APP };
