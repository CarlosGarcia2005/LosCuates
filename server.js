// =====================================================================
//  Servidor - Gestor Deportivo Rancho Seco
//  Node.js + Express + SQL Server | JWT + MFA (TOTP) + Bitácora
// =====================================================================
require('dotenv').config();

const path = require('path');
const express = require('express');

const { consulta } = require('./config/db');
const jwt = require('./src/seguridad/jwt');
const { obtenerClave } = require('./src/seguridad/cifrado');
const { cabecerasSeguridad, sinCache, protegerCsrf } = require('./src/seguridad/cabeceras');
const { crearLimitador } = require('./src/seguridad/limitador');
const { detectorInyeccion } = require('./src/seguridad/detector');
const { datosSeguros } = require('./src/seguridad/datos-seguros');
const vigilancia = require('./src/seguridad/vigilancia');
const archivoRegistro = require('./src/seguridad/archivo-registro');
const { requiereSesion, requiereAdmin, requiereFuncion } = require('./src/autenticacion');
const { noEncontrado, manejadorErrores, asincrono } = require('./src/errores');
const bitacora = require('./src/bitacora');
const { revisarConfiguracion } = require('./src/seguridad/configuracion');

// ---------- Revisar configuración antes de arrancar ----------
try {
  jwt.secreto();
  obtenerClave();
} catch (err) {
  console.error('✘ Configuración incompleta:', err.message);
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const VISTAS = path.join(__dirname, 'views');

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1); // detrás de un proxy (Vercel)

app.use(cabecerasSeguridad);

// [OWASP A05] Solo los métodos HTTP que usa la aplicación (TRACE, CONNECT, etc. se rechazan)
const METODOS_PERMITIDOS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
app.use((req, res, next) => {
  if (METODOS_PERMITIDOS.includes(req.method)) return next();
  bitacora.registrar(req, {
    accion: 'METODO_NO_PERMITIDO', modulo: 'Seguridad', resultado: 'Fallo',
    descripcion: `[A05] Se intentó usar el método HTTP ${String(req.method).slice(0, 12)} en ${String(req.originalUrl).slice(0, 120)}`
  });
  res.setHeader('Allow', METODOS_PERMITIDOS.join(', '));
  res.status(405).json({ mensaje: 'Método no permitido.' });
});

app.use(express.json({ limit: '20kb' }));

// ---------- API ----------
const limitadorApi = crearLimitador({
  ventanaMs: 60 * 1000, maximo: 300,
  alExceder: (req, { maximo }) => bitacora.registrar(req, {
    accion: 'LIMITE_EXCEDIDO', modulo: 'Seguridad', resultado: 'Fallo',
    descripcion: `[A04] Esta IP pasó de ${maximo} peticiones por minuto (posible bot o script). Se frenó 1 minuto.`
  })
});
app.use('/api', sinCache, protegerCsrf, limitadorApi, datosSeguros, detectorInyeccion);   // datosSeguros = OWASP A08
app.use('/api/auth', require('./src/rutas/auth'));
app.use('/api/admin/canchas', requiereSesion, requiereAdmin, require('./src/rutas/canchas'));
app.use('/api/admin/reservas', requiereSesion, requiereAdmin, require('./src/rutas/reservas'));
app.use('/api/admin/seguridad', requiereSesion, requiereAdmin, require('./src/rutas/seguridad'));
app.use('/api/admin/equipos', requiereSesion, requiereAdmin, require('./src/rutas/equipos'));
app.use('/api/admin/arbitros', requiereSesion, requiereAdmin, require('./src/rutas/arbitros'));
app.use('/api/admin/pagos', requiereSesion, requiereAdmin, require('./src/rutas/pagos'));
app.use('/api/admin/reportes', requiereSesion, requiereAdmin, require('./src/rutas/reportes'));
// Limpieza: administradores y personal de limpieza · Mis partidos: usuarios con rol Árbitro
app.use('/api/limpieza', requiereSesion, requiereFuncion('limpieza', { tambienAdmin: true }), require('./src/rutas/limpieza'));
app.use('/api/arbitraje', requiereSesion, requiereFuncion('arbitro'), require('./src/rutas/arbitraje'));
app.use('/api/admin', requiereSesion, requiereAdmin, require('./src/rutas/admin'));
app.use('/api/perfil', requiereSesion, require('./src/rutas/perfil'));
app.use('/api', noEncontrado);

// ---------- Páginas protegidas ----------
function pagina(archivo, accion, descripcion) {
  return asincrono(async (req, res) => {
    await bitacora.registrar(req, { accion, modulo: 'Navegación', descripcion });
    res.sendFile(path.join(VISTAS, archivo));
  });
}

app.get('/admin', sinCache, requiereSesion, requiereAdmin,
  pagina('admin.html', 'ACCESO_PANEL', 'Entró al panel de administración'));
app.get('/perfil', sinCache, requiereSesion,
  pagina('perfil.html', 'ACCESO_PANEL', 'Entró a su perfil de usuario'));
app.get(['/inicio', '/inicio.html'], requiereSesion, (req, res) =>
  res.redirect(req.usuario.nivel === 'Administrador' ? '/admin' : '/perfil'));

// ---------- Archivos públicos (login, css, js) ----------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', dotfiles: 'deny' }));

// ---------- Errores ----------
app.use(noEncontrado);
app.use(manejadorErrores);

process.on('unhandledRejection', (err) => console.error('[Promesa no controlada]', err));

// ---------- Arranque ----------
/** Revisa que ya se hayan ejecutado los scripts de sql/ en la base. Lanza un error con el script que falta. */
async function revisarBaseDeDatos() {
  const [r] = await consulta(`
    SELECT
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE LOWER(TABLE_NAME) = 'usuario' AND COLUMN_NAME = 'MFA_Activo') AS mfa,
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
        WHERE LOWER(TABLE_NAME) = 'bitacora') AS bitacora,
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE LOWER(TABLE_NAME) = 'pago' AND COLUMN_NAME = 'Comprobante') AS reservas,
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE LOWER(TABLE_NAME) = 'bitacora' AND COLUMN_NAME = 'Hash_Integridad') AS integridad,
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
        WHERE LOWER(TABLE_NAME) = 'bitacora_cadena') AS cadena,
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
        WHERE LOWER(TABLE_NAME) IN ('tarea_limpieza', 'reporte_condicion', 'comprobante_archivo')) AS limpieza,
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE (LOWER(TABLE_NAME) = 'pago' AND COLUMN_NAME = 'Estado_Pago')
           OR (LOWER(TABLE_NAME) = 'juego' AND COLUMN_NAME = 'idReserva')
           OR (LOWER(TABLE_NAME) = 'asignacion_arbitro' AND COLUMN_NAME = 'Fecha_Respuesta')) AS modulos`);
  if (!Number(r.mfa) || !Number(r.bitacora)) throw new Error('Falta ejecutar el script sql/02_seguridad_y_bitacora.sql en SQL Server.');
  if (!Number(r.reservas)) throw new Error('Falta ejecutar el script sql/03_canchas_y_reservas.sql en SQL Server.');
  if (!Number(r.integridad) || !Number(r.cadena)) throw new Error('Falta ejecutar el script sql/04_integridad_y_monitoreo.sql en SQL Server.');
  if (Number(r.limpieza) < 3 || Number(r.modulos) < 3) {
    throw new Error('Falta ejecutar el script sql/05_modulos_deportivos.sql en SQL Server (Equipos, Árbitros, Pagos, Limpieza y Reportes).');
  }
}

if (process.env.VERCEL) {
  // En Vercel no se levanta un servidor: Vercel llama a la app en cada petición (api/index.js).
  // Solo se revisa la base y se avisa en los registros de Vercel.
  revisarBaseDeDatos()
    .then(() => console.log(`✔ Conectado a SQL Server (${process.env.DB_NAME})`))
    .catch((err) => console.error('✘ Base de datos:', err.message));
} else {
  revisarBaseDeDatos()
    .then(() => {
      console.log(`✔ Conectado a SQL Server (${process.env.DB_NAME} en ${process.env.DB_HOST})`);

      // [OWASP A05] Avisar en la consola si algo de la configuración está mal
      revisarConfiguracion(consulta).then(({ revisiones }) => {
        const pendientes = revisiones.filter((x) => x.estado === 'atencion');
        if (!pendientes.length) return console.log('✔ Configuración de seguridad sin pendientes (OWASP A05)');
        console.warn(`⚠ Configuración de seguridad: ${pendientes.length} pendiente(s) (OWASP A05). Míralos en Panel → Seguridad OWASP.`);
        for (const p of pendientes) console.warn(`   - ${p.nombre}: ${p.detalle}`);
      }).catch(() => { /* solo informativo */ });
      // [OWASP A08 / A09] Integridad del código y de la bitácora (al arrancar y cada 10 min)
      archivoRegistro.limpiarViejos().catch(() => {});
      vigilancia.iniciar().then(({ codigo, bitacora: b }) => {
        if (codigo && codigo.estado === 'ok') console.log(`✔ Código sin cambios: ${codigo.total} archivos coinciden con su firma (OWASP A08)`);
        else if (codigo && codigo.estado === 'sin_manifiesto') console.warn('⚠ El código aún no está firmado. Ejecuta: npm run firmar-codigo (OWASP A08)');
        else if (codigo) console.warn(`⚠ El código cambió desde que se firmó (OWASP A08): ${[...(codigo.modificados || []), ...(codigo.nuevos || []), ...(codigo.faltantes || [])].slice(0, 5).join(', ') || codigo.estado}`);
        if (b && b.ok) console.log(`✔ Bitácora íntegra: ${b.firmados} registro(s) firmados en cadena (OWASP A09)`);
        else if (b && b.error) console.warn(`⚠ No se pudo revisar la bitácora: ${b.error}`);
        else if (b) console.warn(`⚠ La bitácora tiene ${b.pendientes} alteración(es) sin revisar (OWASP A09). Míralas en Panel → Seguridad OWASP.`);
      }).catch(() => {});
      app.listen(PORT, () => console.log(`✔ Servidor listo en http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error('✘ No se pudo arrancar con la base de datos:', err.message);
      console.error('  Revisa los datos de tu archivo .env (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_CIFRADO)');
      console.error('  y que ya ejecutaste los scripts de la carpeta sql/ en orden.');
      process.exit(1);
    });
}

module.exports = app;
