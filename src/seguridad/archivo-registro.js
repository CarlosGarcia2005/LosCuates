// =====================================================================
//  [OWASP A09] Respaldo de la bitácora en archivo
//  Cada registro también se escribe (una línea JSON) en
//  almacen/registros/bitacora-AAAA-MM-DD.log. Si la base de datos falla
//  o alguien borra registros en SQL Server, la evidencia sigue aquí.
//  Se guardan 90 días.
// =====================================================================
const fs = require('fs');
const path = require('path');

const { CARPETA_ALMACEN } = require('../almacen');
const CARPETA = path.join(CARPETA_ALMACEN, 'registros');
const DIAS_RETENCION = 90;

const estado = { escritos: 0, fallosArchivo: 0, fallosBase: 0, ultimoError: null };

const fechaArchivo = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const rutaDelDia = (d = new Date()) => path.join(CARPETA, `bitacora-${fechaArchivo(d)}.log`);

let cola = Promise.resolve();

/** Agrega una línea al archivo del día (en orden, sin bloquear la respuesta). */
function escribir(entrada) {
  const linea = `${JSON.stringify(entrada)}\n`;    // JSON escapa los saltos de línea: no se pueden inyectar renglones falsos
  cola = cola.then(async () => {
    try {
      await fs.promises.mkdir(CARPETA, { recursive: true });
      await fs.promises.appendFile(rutaDelDia(), linea, 'utf8');
      estado.escritos += 1;
    } catch (err) {
      estado.fallosArchivo += 1;
      estado.ultimoError = err.message;
    }
  });
  return cola;
}

const fallaBase = (mensaje) => { estado.fallosBase += 1; estado.ultimoError = mensaje; };

/** Borra archivos de más de 90 días. */
async function limpiarViejos(ahora = new Date()) {
  let borrados = 0;
  try {
    const limite = new Date(ahora.getTime() - DIAS_RETENCION * 86400000);
    for (const nombre of await fs.promises.readdir(CARPETA)) {
      const m = /^bitacora-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(nombre);
      if (m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) < limite) {
        await fs.promises.unlink(path.join(CARPETA, nombre));
        borrados += 1;
      }
    }
  } catch { /* la carpeta aún no existe */ }
  return borrados;
}

/** Resumen para el panel. */
function resumen() {
  let lineasHoy = 0;
  let archivos = 0;
  try {
    archivos = fs.readdirSync(CARPETA).filter((n) => n.startsWith('bitacora-')).length;
    lineasHoy = fs.readFileSync(rutaDelDia(), 'utf8').split('\n').filter(Boolean).length;
  } catch { /* sin archivo hoy */ }
  return { ...estado, lineasHoy, archivos, carpeta: 'almacen/registros', retencionDias: DIAS_RETENCION };
}

module.exports = { escribir, fallaBase, limpiarViejos, resumen, rutaDelDia, CARPETA };
