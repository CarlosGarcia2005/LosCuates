// =====================================================================
//  [OWASP A05] Revisión de configuración
//  Revisa el .env, la cuenta de SQL Server que usa la app y el propio servidor.
//  Cada revisión devuelve:
//    { estado: 'activo' | 'atencion' | 'info', nombre, detalle, arreglo? }
//    activo   = bien configurado
//    atencion = hay que corregirlo (se cuenta como pendiente)
//    info     = normal en la computadora de desarrollo, cambia al publicar (Vercel + Azure SQL)
// =====================================================================
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');

const CONTRASENAS_DEFECTO = /^(|root|sa|admin|password|contraseña|contrasena|123456|12345678|sqlserver|rancho|rancho_seco|cambiaestaclave_2026!)$/i;
const TEXTO_EJEMPLO = /cambia|example|ejemplo|secret|secreto|changeme|xxxx/i;

const revision = (estado, nombre, detalle, arreglo) => ({ estado, nombre, detalle, ...(arreglo ? { arreglo } : {}) });

/** Revisa las variables del .env (función pura: se prueba con npm test). */
function revisarEntorno(env = process.env, { gitignore } = {}) {
  const r = [];
  const jwt = env.JWT_SECRET || '';
  const mfa = env.MFA_CLAVE || '';
  const produccion = env.NODE_ENV === 'production';

  if (jwt.length >= 64 && !TEXTO_EJEMPLO.test(jwt)) {
    r.push(revision('activo', 'Clave JWT larga y aleatoria', `JWT_SECRET tiene ${jwt.length} caracteres.`));
  } else {
    r.push(revision('atencion', 'Clave JWT débil',
      jwt.length < 64 ? `JWT_SECRET tiene solo ${jwt.length} caracteres (mínimo recomendado: 64).` : 'JWT_SECRET parece un texto de ejemplo.',
      'Ejecuta "npm run generar-claves" y copia el nuevo JWT_SECRET a tu .env (cierra las sesiones abiertas).'));
  }

  if (jwt && mfa && jwt === mfa) {
    r.push(revision('atencion', 'Claves repetidas', 'JWT_SECRET y MFA_CLAVE son iguales: si se filtra una, se filtran las dos.',
      'Genera claves distintas con "npm run generar-claves".'));
  } else {
    r.push(revision('activo', 'Una clave para cada uso', 'JWT_SECRET (sesiones) y MFA_CLAVE (cifrado) son distintas.'));
  }

  const usuarioBd = (env.DB_USER || '').toLowerCase();
  if (usuarioBd === 'sa' || usuarioBd === 'root') {
    r.push(revision('atencion', `La app entra a SQL Server como ${usuarioBd}`,
      `${usuarioBd} puede borrar bases, crear usuarios y cambiar la configuración del servidor.`,
      'Usa una cuenta propia de la app (por ejemplo rancho_app) con permisos solo de lectura y escritura.'));
  } else {
    r.push(revision('activo', 'Cuenta de SQL Server propia de la app', `La app entra como "${env.DB_USER || '—'}", no como sa.`));
  }

  const claveBd = env.DB_PASSWORD || '';
  if (CONTRASENAS_DEFECTO.test(claveBd) || claveBd.length < 12) {
    r.push(revision('atencion', 'Contraseña de SQL Server débil',
      CONTRASENAS_DEFECTO.test(claveBd) ? 'DB_PASSWORD está vacía o es una contraseña por defecto / de ejemplo.'
        : `DB_PASSWORD tiene ${claveBd.length} caracteres (usa 12 o más).`,
      "En SSMS: ALTER LOGIN tu_usuario WITH PASSWORD = 'tu-nueva-clave-de-12-o-mas'; (en Azure también se cambia desde el portal) y pon la misma en DB_PASSWORD."));
  } else {
    r.push(revision('activo', 'Contraseña de SQL Server robusta', `DB_PASSWORD tiene ${claveBd.length} caracteres.`));
  }

  r.push(produccion
    ? revision('activo', 'Modo producción', 'NODE_ENV=production: cookies Secure, HSTS y mensajes de error mínimos.')
    : revision('info', 'Modo desarrollo', 'NODE_ENV=development es normal en tu PC. En Vercel ponlo en production.'));

  if (env.TRUST_PROXY === '1' && !produccion) {
    r.push(revision('atencion', 'TRUST_PROXY encendido sin producción',
      'Con TRUST_PROXY=1 el servidor confía en la IP que mande cualquiera en X-Forwarded-For.',
      'Déjalo en 0 en tu PC; actívalo solo detrás de un proxy (en Vercel va en 1).'));
  }

  if (gitignore !== undefined) {
    r.push(/^\.env\s*$/m.test(gitignore)
      ? revision('activo', '.env fuera del repositorio', '.gitignore excluye el archivo .env: las claves no se suben a GitHub.')
      : revision('atencion', '.env podría subirse a GitHub', '.gitignore no incluye ".env".', 'Agrega una línea ".env" al archivo .gitignore.'));
  }
  return r;
}

/**
 * Permisos de más que tiene la cuenta con la que la app entra a SQL Server.
 * La app solo necesita leer y escribir datos (db_datareader + db_datawriter).
 * @param {object} p  fila de revisarBaseDatos: sysadmin, dbOwner, control, alterar, crearTablas, usuarios
 */
function privilegiosSobrantes(p = {}) {
  const sobrantes = [];
  if (Number(p.sysadmin) === 1) sobrantes.push('sysadmin');
  if (Number(p.dbOwner) === 1) sobrantes.push('db_owner');
  if (Number(p.control) === 1 && Number(p.dbOwner) !== 1) sobrantes.push('CONTROL');
  if (Number(p.alterar) === 1 && Number(p.dbOwner) !== 1 && Number(p.control) !== 1) sobrantes.push('ALTER');
  if (Number(p.crearTablas) === 1 && Number(p.dbOwner) !== 1 && Number(p.control) !== 1) sobrantes.push('CREATE TABLE');
  if (Number(p.usuarios) === 1 && Number(p.dbOwner) !== 1 && Number(p.control) !== 1) sobrantes.push('ALTER ANY USER');
  return sobrantes;
}

/** Revisa la cuenta y el servidor SQL Server / Azure SQL. `consulta` es la de config/db.js. */
async function revisarBaseDatos(consulta) {
  const r = [];
  let info = {};
  try {
    const [datos] = await consulta(`
      SELECT SUSER_SNAME() AS cuenta, USER_NAME() AS usuarioBd, DB_NAME() AS base,
             CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(50)) AS version,
             CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100)) AS comentario,
             CAST(SERVERPROPERTY('EngineEdition') AS INT) AS motor,
             ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0) AS sysadmin,
             ISNULL(IS_ROLEMEMBER('db_owner'), 0) AS dbOwner,
             ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL'), 0) AS control,
             ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER'), 0) AS alterar,
             ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE'), 0) AS crearTablas,
             ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER ANY USER'), 0) AS usuarios,
             SESSIONPROPERTY('ANSI_WARNINGS') AS avisosAnsi`);
    info = datos;
    const sobrantes = privilegiosSobrantes(datos);
    const base = datos.base || process.env.DB_NAME || 'la base';

    r.push(sobrantes.length
      ? revision('atencion', 'Privilegios de más en la base de datos',
        `La app entra como ${datos.cuenta} (${datos.usuarioBd}), que tiene ${sobrantes.join(', ')}. Solo necesita leer y escribir datos.`,
        'En SSMS, conectado a la base del proyecto: CREATE USER rancho_app WITH PASSWORD = \'clave-larga-y-segura\'; ' +
        'ALTER ROLE db_datareader ADD MEMBER rancho_app; ALTER ROLE db_datawriter ADD MEMBER rancho_app; ' +
        'y usa DB_USER=rancho_app con esa contraseña.')
      : revision('activo', 'Mínimo privilegio en la base de datos',
        `La cuenta ${datos.cuenta} solo puede leer y escribir datos en ${base} (no borrar tablas ni crear usuarios).`));

    const local = /^(localhost|127\.0\.0\.1|\.|\(local\))$/i.test(String(process.env.DB_HOST || '').split('\\')[0]);
    r.push(process.env.DB_CIFRADO === '1'
      ? revision('activo', 'Conexión cifrada con la base de datos', 'DB_CIFRADO=1: los datos viajan cifrados (TLS) y se verifica el certificado del servidor.')
      : local
        ? revision('info', 'Conexión sin cifrar (base local)', 'Normal si SQL Server está en tu propia computadora. Con Azure SQL pon DB_CIFRADO=1.')
        : revision('atencion', 'Conexión sin cifrar con la base de datos', 'La base está en otro equipo y DB_CIFRADO no es 1.',
          'Pon DB_CIFRADO=1 en el .env (Azure SQL lo exige).'));

    r.push(Number(datos.avisosAnsi) === 1
      ? revision('activo', 'Textos largos rechazados', 'SQL Server rechaza un texto demasiado largo en vez de recortarlo en silencio (ANSI_WARNINGS).')
      : revision('atencion', 'ANSI_WARNINGS apagado', 'Un texto demasiado largo se recortaría sin avisar.', 'No desactives ANSI_WARNINGS en la conexión.'));
  } catch (err) {
    r.push(revision('atencion', 'No se pudo revisar la base de datos', `Error al consultar los permisos: ${String(err.message).slice(0, 120)}`));
  }
  return { revisiones: r, info };
}

/** Controles fijos del servidor (están en el código, siempre activos). */
function revisarServidor() {
  return [
    revision('activo', 'Errores sin detalles técnicos', 'El usuario ve un mensaje y un código de referencia; el detalle (SQL, rutas) solo queda en la consola.'),
    revision('activo', 'Cabeceras de seguridad', 'CSP, X-Frame-Options, nosniff, Referrer-Policy y Permissions-Policy en cada respuesta; sin X-Powered-By.'),
    revision('activo', 'Solo métodos HTTP necesarios', 'TRACE, CONNECT y otros métodos se rechazan con 405.'),
    revision('activo', 'Sin listado de carpetas', 'Solo se publica la carpeta public/; .env, server.js y archivos ocultos no se pueden descargar.')
  ];
}

/** Revisión completa. */
async function revisarConfiguracion(consulta) {
  let gitignore;
  try { gitignore = fs.readFileSync(path.join(RAIZ, '.gitignore'), 'utf8'); } catch { gitignore = ''; }
  const bd = await revisarBaseDatos(consulta);
  return { revisiones: [...revisarEntorno(process.env, { gitignore }), ...bd.revisiones, ...revisarServidor()], baseDatos: bd.info };
}

module.exports = { revisarEntorno, privilegiosSobrantes, revisarBaseDatos, revisarServidor, revisarConfiguracion };
