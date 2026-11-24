// =====================================================================
//  Consultas de usuarios que se reutilizan en varias rutas
// =====================================================================
const { consulta } = require('../config/db');
const { funcionesDe } = require('./funciones');

const SELECT_USUARIO = `
  SELECT u.idUsuario, u.idGenero, g.Genero, u.idRol, r.Rol, r.Nivel_Acceso,
         u.Nombre, u.Apellido_Paterno, u.Apellido_Materno, u.Telefono, u.Correo,
         u.Contrasena AS Contrasena, u.Estado, u.MFA_Secreto, u.MFA_Activo, u.MFA_Ultimo_Paso,
         u.Intentos_Fallidos, u.Bloqueado_Hasta, u.Ultimo_Acceso, u.Token_Version,
         CASE WHEN u.Bloqueado_Hasta > GETDATE()
              THEN DATEDIFF(SECOND, GETDATE(), u.Bloqueado_Hasta) ELSE 0 END AS Segundos_Bloqueo
    FROM Usuario u
    JOIN Rol r    ON r.idRol = u.idRol
    JOIN Genero g ON g.idGenero = u.idGenero`;

async function porId(id, conexion) {
  const filas = await consulta(`${SELECT_USUARIO} WHERE u.idUsuario = @id`, { id }, conexion);
  return filas[0] || null;
}

async function porCorreo(correo) {
  const filas = await consulta(`${SELECT_USUARIO} WHERE u.Correo = @correo`, { correo });
  return filas[0] || null;
}

/** Datos legibles (sin secretos) para mostrar y para la bitácora. */
function vista(u) {
  if (!u) return null;
  return {
    idUsuario: u.idUsuario,
    nombre: u.Nombre,
    apellidoPaterno: u.Apellido_Paterno,
    apellidoMaterno: u.Apellido_Materno,
    telefono: u.Telefono === null || u.Telefono === undefined ? null : String(u.Telefono),
    correo: u.Correo,
    idGenero: u.idGenero,
    genero: u.Genero,
    idRol: u.idRol,
    rol: u.Rol,
    nivel: u.Nivel_Acceso,
    funciones: funcionesDe(u.Rol),
    estado: u.Estado,
    mfaActivo: Boolean(u.MFA_Activo),
    ultimoAcceso: u.Ultimo_Acceso,
    bloqueadoHasta: Number(u.Segundos_Bloqueo) > 0 ? u.Bloqueado_Hasta : null
  };
}

/** Lo que se guarda en la bitácora al comparar antes/después. */
function paraBitacora(u) {
  const v = vista(u);
  return {
    nombre: v.nombre, apellidoPaterno: v.apellidoPaterno, apellidoMaterno: v.apellidoMaterno,
    telefono: v.telefono, correo: v.correo, genero: v.genero, rol: v.rol, estado: v.estado
  };
}

/** Datos de quien inició sesión (se guardan en req.usuario). */
function actor(u) {
  return {
    id: u.idUsuario,
    nombre: `${u.Nombre} ${u.Apellido_Paterno}`,
    correo: u.Correo,
    idRol: u.idRol,
    rol: u.Rol,
    nivel: u.Nivel_Acceso,
    tokenVersion: Number(u.Token_Version)
  };
}

/** Cuenta los administradores activos (para no dejar el sistema sin ninguno). */
async function contarAdminsActivos(conexion) {
  const filas = await consulta(`
    SELECT COUNT(*) AS total
      FROM Usuario u JOIN Rol r ON r.idRol = u.idRol
     WHERE r.Nivel_Acceso = 'Administrador' AND u.Estado = 'Activo'`, {}, conexion);
  return Number(filas[0].total);
}

module.exports = { porId, porCorreo, vista, paraBitacora, actor, contarAdminsActivos };
