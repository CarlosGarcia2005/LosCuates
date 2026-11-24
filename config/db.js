// =====================================================================
//  Conexión a SQL Server / Azure SQL (pool de conexiones con el paquete mssql)
// ---------------------------------------------------------------------
//  * Los parámetros se escriben con @nombre (estilo T-SQL).
//    Si el valor es un arreglo, "IN (@lista)" se expande solo a
//    "IN (@lista_0, @lista_1, ...)".
//  * consulta() devuelve lo mismo en cualquier parte del proyecto:
//      - Un solo SELECT            → arreglo de filas
//      - Varios SELECT en un lote  → arreglo con los resultados de cada uno
//      - INSERT                    → { insertId, affectedRows }
//      - UPDATE / DELETE           → { affectedRows }
//  * Las columnas TIME se devuelven como texto "HH:MM:SS", DECIMAL como
//    texto con sus decimales ("150.00") y BIGINT como número.
//  * La aplicación se identifica con el nombre NOMBRE_APP; los triggers
//    de auditoría lo leen con APP_NAME() para saber que el cambio viene
//    de la aplicación (que ya lo registra en la bitácora con más detalle).
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
  // Azure SQL gratuito se "duerme" cuando no se usa; despertarlo puede tardar ~1 minuto
  connectionTimeout: Number(process.env.DB_TIMEOUT_MS) || 60000,
  requestTimeout: 30000,
  options: {
    appName: NOMBRE_APP,
    // [OWASP A02] DB_CIFRADO=1 en Azure (conexión cifrada y certificado verificado)
    encrypt: process.env.DB_CIFRADO === '1',
    trustServerCertificate: process.env.DB_CIFRADO !== '1',
    useUTC: false,                 // las fechas se guardan y se leen con la hora local
    dateFormat: 'ymd',             // '2026-11-20' siempre es año-mes-día, sin importar el idioma del servidor
    enableArithAbort: true
  }
};

// Con instancia con nombre manda el SQL Browser; con puerto fijo, el puerto.
if (instancia) configuracion.options.instanceName = instancia;
else configuracion.port = Number(process.env.DB_PORT) || 1433;

const pool = new sql.ConnectionPool(configuracion);
pool.on('error', (err) => console.error('[BD] Error en el pool de conexiones:', err.message));
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

const limpio = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

/**
 * Prepara la consulta: agrega solo los parámetros que realmente usa y
 * expande los arreglos de "IN (@lista)".
 */
function prepararSolicitud(solicitud, textoSql, parametros) {
  const usados = new Set();
  const buscador = /@([A-Za-z_][A-Za-z0-9_]*)/g;
  let coincidencia;
  while ((coincidencia = buscador.exec(textoSql)) !== null) usados.add(coincidencia[1]);

  let texto = textoSql;
  for (const [nombre, valor] of Object.entries(parametros || {})) {
    if (!usados.has(nombre)) continue;
    if (Array.isArray(valor)) {
      const lista = valor.length ? valor : [null];       // IN (NULL) nunca coincide, igual que una lista vacía
      const nombres = lista.map((v, i) => {
        const n = `${nombre}_${i}`;
        solicitud.input(n, tipoDe(limpio(v)), limpio(v));
        return `@${n}`;
      });
      texto = texto.replace(new RegExp(`@${nombre}(?![A-Za-z0-9_])`, 'g'), nombres.join(', '));
    } else {
      solicitud.input(nombre, tipoDe(limpio(valor)), limpio(valor));
    }
  }
  return texto;
}

const dos = (n) => String(n).padStart(2, '0');

/** Convierte cada fila para que se lea igual que con MySQL (TIME y DECIMAL como texto, BIGINT como número). */
function normalizarFilas(filas) {
  const columnas = filas && filas.columns ? Object.values(filas.columns) : [];
  const ajustes = [];
  for (const c of columnas) {
    if (c.type === sql.Time) ajustes.push([c.name, (v) => (v instanceof Date ? `${dos(v.getHours())}:${dos(v.getMinutes())}:${dos(v.getSeconds())}` : v)]);
    else if (c.type === sql.Decimal || c.type === sql.Numeric || c.type === sql.Money || c.type === sql.SmallMoney) {
      const escala = Number.isInteger(c.scale) ? c.scale : 2;
      ajustes.push([c.name, (v) => (v === null || v === undefined ? v : Number(v).toFixed(escala))]);
    } else if (c.type === sql.BigInt) ajustes.push([c.name, (v) => (v === null || v === undefined ? v : Number(v))]);
  }
  if (!ajustes.length) return filas;
  for (const fila of filas) {
    for (const [nombre, fn] of ajustes) if (nombre in fila) fila[nombre] = fn(fila[nombre]);
  }
  return filas;
}

/** Agrega a los errores de SQL Server el número de error equivalente de MySQL (errno) que usa el resto del código. */
function traducirError(err) {
  if (!err || err.errno) return err;
  // Cuando un trigger lanza un error, SQL Server manda dos: el del trigger (50001) y luego
  // "The batch has been aborted" (3616). mssql deja los primeros en precedingErrors.
  const todos = [err, ...(Array.isArray(err.precedingErrors) ? err.precedingErrors : [])];
  const numeroDe = (e) => e && (e.number || (e.originalError && e.originalError.info && e.originalError.info.number));
  const principal = todos.find((e) => [50001, 2627, 2601, 547, 2628, 8152, 515].includes(numeroDe(e))) || err;
  const numero = numeroDe(principal);
  const mensaje = String(principal.message || '');
  err.mensajes = todos.map((e) => String(e && e.message || ''));
  if (principal !== err) err.message = `${mensaje} (${err.message})`;
  if (numero === 2627 || numero === 2601) err.errno = 1062;                         // valor duplicado
  else if (numero === 547 && /REFERENCE/i.test(mensaje) && /DELETE/i.test(mensaje)) err.errno = 1451;   // está en uso
  else if (numero === 547 && /FOREIGN KEY/i.test(mensaje)) err.errno = 1452;        // el registro relacionado no existe
  else if (numero === 547 && /CHECK/i.test(mensaje)) err.errno = 3819;              // no cumple una regla
  else if (numero === 50001) err.errno = 1644;                                       // THROW de un trigger
  if (numero) err.numeroSql = numero;
  return err;
}

const ES_INSERT = /^\s*(?:--[^\n]*\n\s*)*INSERT\s/i;

/**
 * Ejecuta una consulta. El tercer parámetro es la transacción (cuando se
 * llama dentro de transaccion(fn)).
 */
async function consulta(textoSql, parametros = {}, transaccionActiva = null) {
  await conectar();
  const solicitud = transaccionActiva ? new sql.Request(transaccionActiva) : pool.request();
  let texto = prepararSolicitud(solicitud, textoSql, parametros);

  // Un INSERT devuelve el id recién creado (SCOPE_IDENTITY no incluye los de los triggers)
  const esInsert = ES_INSERT.test(texto) && !/;\s*\S/.test(texto.replace(/;\s*$/, ''));
  if (esInsert) texto = `${texto.replace(/;\s*$/, '')};\nSELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS insertId;`;

  let resultado;
  try {
    resultado = await solicitud.query(texto);
  } catch (err) {
    throw traducirError(err);
  }
  const conjuntos = (resultado.recordsets || []).map(normalizarFilas);
  const afectadas = (resultado.rowsAffected || []).reduce((a, b) => a + b, 0);

  if (esInsert) {
    const ultimo = conjuntos[conjuntos.length - 1];
    const id = ultimo && ultimo[0] ? ultimo[0].insertId : null;
    return { insertId: id === null || id === undefined ? null : Number(id), affectedRows: (resultado.rowsAffected || [0])[0] };
  }
  if (conjuntos.length > 1) return conjuntos;
  if (conjuntos.length === 1) return conjuntos[0];
  return { affectedRows: afectadas };
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
    throw traducirError(err);
  }
}

module.exports = { sql, pool, conectar, consulta, transaccion, NOMBRE_APP };
