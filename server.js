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
const { requiereSesion, requiereAdmin } = require('./src/autenticacion');
const { noEncontrado, manejadorErrores, asincrono } = require('./src/errores');
const bitacora = require('./src/bitacora');

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
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1); // detrás de un balanceador en AWS

app.use(cabecerasSeguridad);
app.use(express.json({ limit: '20kb' }));

// ---------- API ----------
app.use('/api', sinCache, protegerCsrf, crearLimitador({ ventanaMs: 60 * 1000, maximo: 300 }));
app.use('/api/auth', require('./src/rutas/auth'));
app.use('/api/admin/canchas', requiereSesion, requiereAdmin, require('./src/rutas/canchas'));
app.use('/api/admin/reservas', requiereSesion, requiereAdmin, require('./src/rutas/reservas'));
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
async function revisarBaseDeDatos() {
  const [r] = await consulta(`
    SELECT
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE LOWER(TABLE_NAME) = 'usuario' AND COLUMN_NAME = 'MFA_Activo') AS mfa,
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
        WHERE LOWER(TABLE_NAME) = 'bitacora') AS bitacora,
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE LOWER(TABLE_NAME) = 'pago' AND COLUMN_NAME = 'Comprobante') AS reservas`);
  if (!Number(r.mfa) || !Number(r.bitacora)) {
    throw new Error('Falta ejecutar el script sql/02_seguridad_y_bitacora.sql en SQL Server.');
  }
  if (!Number(r.reservas)) {
    throw new Error('Falta ejecutar el script sql/03_canchas_y_reservas.sql en SQL Server.');
  }
}

if (process.env.VERCEL) {
  // En Vercel no se levanta servidor: solo se revisa la BD y se avisa en los logs
  revisarBaseDeDatos()
    .then(() => console.log('✔ Conectado a SQL Server'))
    .catch((err) => console.error('✘ Base de datos:', err.message));
} else {
  // En tu computadora funciona igual que antes
  revisarBaseDeDatos()
    .then(() => {
      console.log(`✔ Conectado a SQL Server (${process.env.DB_NAME} en ${process.env.DB_HOST})`);
      app.listen(PORT, () => console.log(`✔ Servidor listo en http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error('✘ No se pudo conectar a SQL Server:', err.message);
      console.error('  Revisa los datos de tu archivo .env (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)');
      console.error('  y que el servicio SQL Server Browser esté encendido si usas una instancia con nombre.');
      process.exit(1);
    });
}

module.exports = app;
