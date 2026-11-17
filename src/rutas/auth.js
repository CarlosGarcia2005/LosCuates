// =====================================================================
//  Autenticación en dos pasos
//    1) POST /api/auth/login  → correo + contraseña
//    2) POST /api/auth/mfa    → código de 6 dígitos (Authenticator)
//  Solo después del paso 2 se entrega el JWT de acceso.
// =====================================================================
const express = require('express');
const QRCode = require('qrcode');

const { consulta } = require('../../config/db');
const V = require('../../public/js/validacion');
const contrasenas = require('../seguridad/contrasena');
const totp = require('../seguridad/totp');
const { cifrar, descifrar } = require('../seguridad/cifrado');
const jwt = require('../seguridad/jwt');
const { crearLimitador } = require('../seguridad/limitador');
const usuarios = require('../usuarios');
const bitacora = require('../bitacora');
const { requiereSesion, contexto } = require('../autenticacion');
const { ErrorApp, errorValidacion, asincrono } = require('../errores');

const router = express.Router();

const EMISOR_MFA = 'Rancho Seco';
const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;
const MENSAJE_CREDENCIALES = 'Usuario o contraseña incorrectos.';

const limitadorLogin = crearLimitador({
  ventanaMs: 15 * 60 * 1000, maximo: 20,
  mensaje: 'Demasiados intentos de inicio de sesión desde este equipo. Espera 15 minutos.'
});
const limitadorMfa = crearLimitador({
  ventanaMs: 5 * 60 * 1000, maximo: 15,
  mensaje: 'Demasiados intentos con el código. Espera unos minutos.'
});

const actorDe = (u) => usuarios.actor(u);
const textoMinutos = (seg) => Math.max(1, Math.ceil(seg / 60));

/** Suma un intento fallido y bloquea la cuenta al llegar al máximo. */
async function intentoFallido(req, u, motivo, accion) {
  const filas = await consulta(`
      UPDATE Usuario SET Intentos_Fallidos = Intentos_Fallidos + 1 WHERE idUsuario = @id;
      UPDATE Usuario
         SET Bloqueado_Hasta = DATEADD(MINUTE, @min, GETDATE()), Intentos_Fallidos = 0
       WHERE idUsuario = @id AND Intentos_Fallidos >= @max;
      SELECT Intentos_Fallidos,
             CASE WHEN Bloqueado_Hasta > GETDATE() THEN 1 ELSE 0 END AS Bloqueado
        FROM Usuario WHERE idUsuario = @id;`,
    { id: u.idUsuario, max: MAX_INTENTOS, min: MINUTOS_BLOQUEO });
  const fila = filas[0];
  const intentos = Number(fila.Intentos_Fallidos);
  const bloqueado = Number(fila.Bloqueado) === 1;

  await bitacora.registrar(req, {
    accion, modulo: 'Autenticación', tabla: 'Usuario', idRegistro: u.idUsuario, actor: actorDe(u),
    descripcion: bloqueado ? `${motivo}. Se alcanzó el máximo de intentos.` : `${motivo} (intento ${intentos} de ${MAX_INTENTOS})`,
    resultado: 'Fallo'
  });

  if (bloqueado) {
    await bitacora.registrar(req, {
      accion: 'CUENTA_BLOQUEADA', modulo: 'Autenticación', tabla: 'Usuario', idRegistro: u.idUsuario,
      actor: actorDe(u), descripcion: `Cuenta bloqueada ${MINUTOS_BLOQUEO} minutos por intentos fallidos`, resultado: 'Fallo'
    });
  }
  return bloqueado;
}

function mensajeBloqueo(segundos) {
  return `Tu cuenta está bloqueada temporalmente por intentos fallidos. Intenta de nuevo en ${textoMinutos(segundos)} minuto(s).`;
}

/* ------------------------------------------------------------------ */
/*  PASO 1: correo y contraseña                                        */
/* ------------------------------------------------------------------ */
router.post('/login', limitadorLogin, contexto('LOGIN_FALLIDO', 'Autenticación', 'Usuario'),
  asincrono(async (req, res) => {
    const v = V.validarLogin(req.body);
    if (!v.ok) throw errorValidacion(v.errores);
    const { correo, contrasena } = v.datos;

    const u = await usuarios.porCorreo(correo);

    if (!u) {
      await contrasenas.verificarSenuelo(contrasena);
      await bitacora.registrar(req, {
        accion: 'LOGIN_FALLIDO', modulo: 'Autenticación', actor: { correo },
        descripcion: 'Intento de inicio de sesión con un correo que no está registrado', resultado: 'Fallo'
      });
      throw new ErrorApp(401, MENSAJE_CREDENCIALES);
    }

    if (Number(u.Segundos_Bloqueo) > 0) {
      await bitacora.registrar(req, {
        accion: 'LOGIN_FALLIDO', modulo: 'Autenticación', tabla: 'Usuario', idRegistro: u.idUsuario,
        actor: actorDe(u), descripcion: 'Intento de inicio de sesión con la cuenta bloqueada', resultado: 'Fallo'
      });
      throw new ErrorApp(423, mensajeBloqueo(Number(u.Segundos_Bloqueo)));
    }

    const { valida, requiereMigracion } = await contrasenas.verificar(contrasena, u.Contrasena);
    if (!valida) {
      const bloqueado = await intentoFallido(req, u, 'Contraseña incorrecta', 'LOGIN_FALLIDO');
      throw new ErrorApp(bloqueado ? 423 : 401, bloqueado ? mensajeBloqueo(MINUTOS_BLOQUEO * 60) : MENSAJE_CREDENCIALES);
    }

    if (u.Estado !== 'Activo') {
      await bitacora.registrar(req, {
        accion: 'LOGIN_FALLIDO', modulo: 'Autenticación', tabla: 'Usuario', idRegistro: u.idUsuario,
        actor: actorDe(u), descripcion: `Intento de inicio de sesión con cuenta en estado "${u.Estado}"`, resultado: 'Fallo'
      });
      throw new ErrorApp(403, 'Tu cuenta está inactiva. Contacta al administrador.');
    }

    // Migrar hash viejo (SHA-256) a scrypt
    if (requiereMigracion) {
      await consulta('UPDATE Usuario SET Contrasena = @hash WHERE idUsuario = @id',
        { id: u.idUsuario, hash: await contrasenas.hashear(contrasena) });
      await bitacora.registrar(req, {
        accion: 'HASH_ACTUALIZADO', modulo: 'Seguridad', tabla: 'Usuario', idRegistro: u.idUsuario, actor: actorDe(u),
        descripcion: 'La contraseña se migró de SHA-256 a scrypt automáticamente'
      });
    }

    await consulta('UPDATE Usuario SET Intentos_Fallidos = 0 WHERE idUsuario = @id', { id: u.idUsuario });

    // Primera vez: hay que configurar el Authenticator
    if (!u.MFA_Activo) {
      const secreto = totp.generarSecreto();
      await consulta('UPDATE Usuario SET MFA_Secreto = @secreto, MFA_Ultimo_Paso = NULL WHERE idUsuario = @id',
        { id: u.idUsuario, secreto: cifrar(secreto) });

      const qr = await QRCode.toDataURL(totp.uriOtpauth(secreto, u.Correo, EMISOR_MFA), {
        width: 220, margin: 1, errorCorrectionLevel: 'M'
      });

      jwt.emitirMfa(res, actorDe(u), 'configurar');
      await bitacora.registrar(req, {
        accion: 'LOGIN_PASO_1', modulo: 'Autenticación', tabla: 'Usuario', idRegistro: u.idUsuario, actor: actorDe(u),
        descripcion: 'Contraseña correcta. Se generó un código QR para configurar MFA por primera vez'
      });
      return res.json({ paso: 'configurar', qr, secreto: secreto.match(/.{1,4}/g).join(' '), cuenta: u.Correo });
    }

    jwt.emitirMfa(res, actorDe(u), 'verificar');
    await bitacora.registrar(req, {
      accion: 'LOGIN_PASO_1', modulo: 'Autenticación', tabla: 'Usuario', idRegistro: u.idUsuario, actor: actorDe(u),
      descripcion: 'Contraseña correcta. Falta el código MFA'
    });
    res.json({ paso: 'verificar' });
  }));

/* ------------------------------------------------------------------ */
/*  PASO 2: código MFA                                                 */
/* ------------------------------------------------------------------ */
router.post('/mfa', limitadorMfa, contexto('MFA_FALLIDO', 'Autenticación', 'Usuario'),
  asincrono(async (req, res) => {
    const temporal = jwt.verificar(jwt.leerCookies(req)[jwt.COOKIE_MFA], 'mfa');
    if (!temporal) throw new ErrorApp(401, 'El tiempo para escribir el código terminó. Vuelve a iniciar sesión.');

    const v = V.validarCodigo(req.body);
    if (!v.ok) throw errorValidacion(v.errores);

    const u = await usuarios.porId(Number(temporal.sub));
    if (!u || u.Estado !== 'Activo' || Number(u.Token_Version) !== temporal.ver || !u.MFA_Secreto) {
      jwt.borrarCookies(res);
      throw new ErrorApp(401, 'Vuelve a iniciar sesión.');
    }
    if (Number(u.Segundos_Bloqueo) > 0) throw new ErrorApp(423, mensajeBloqueo(Number(u.Segundos_Bloqueo)));

    const paso = totp.verificarCodigo(descifrar(u.MFA_Secreto), v.datos.codigo, u.MFA_Ultimo_Paso);
    if (paso === null) {
      const bloqueado = await intentoFallido(req, u, 'Código MFA incorrecto o ya usado', 'MFA_FALLIDO');
      if (bloqueado) jwt.borrarCookies(res);
      throw new ErrorApp(bloqueado ? 423 : 401,
        bloqueado ? mensajeBloqueo(MINUTOS_BLOQUEO * 60) : 'El código no es correcto. Revisa tu app e intenta de nuevo.',
        { errores: bloqueado ? undefined : { codigo: 'Código incorrecto.' } });
    }

    await consulta(`UPDATE Usuario
                       SET MFA_Activo = 1, MFA_Ultimo_Paso = @paso, Intentos_Fallidos = 0,
                           Bloqueado_Hasta = NULL, Ultimo_Acceso = GETDATE()
                     WHERE idUsuario = @id`, { id: u.idUsuario, paso });

    if (temporal.modo === 'configurar') {
      await bitacora.registrar(req, {
        accion: 'MFA_CONFIGURADO', modulo: 'Seguridad', tabla: 'Usuario', idRegistro: u.idUsuario, actor: actorDe(u),
        descripcion: 'El usuario vinculó su app Authenticator (MFA activado)',
        antes: { mfaActivo: false }, despues: { mfaActivo: true }
      });
    }

    jwt.borrarCookieMfa(res);
    jwt.emitirAcceso(res, actorDe(u));
    await bitacora.registrar(req, {
      accion: 'LOGIN_EXITOSO', modulo: 'Autenticación', tabla: 'Usuario', idRegistro: u.idUsuario, actor: actorDe(u),
      descripcion: `Inicio de sesión completo (contraseña + MFA) como ${u.Rol}`
    });

    res.json({
      destino: u.Nivel_Acceso === 'Administrador' ? '/admin' : '/perfil',
      usuario: { nombre: `${u.Nombre} ${u.Apellido_Paterno}`, rol: u.Rol }
    });
  }));

/* ------------------------------------------------------------------ */
router.get('/sesion', requiereSesion, (req, res) => {
  const { id, nombre, correo, rol, nivel } = req.usuario;
  res.json({ usuario: { id, nombre, correo, rol, nivel } });
});

router.post('/logout', asincrono(async (req, res) => {
  const datos = jwt.verificar(jwt.leerCookies(req)[jwt.COOKIE_ACCESO], 'acceso');
  if (datos) {
    const u = await usuarios.porId(Number(datos.sub));
    if (u && Number(u.Token_Version) === datos.ver) {
      // Subir la versión invalida este y cualquier otro token emitido antes
      await consulta('UPDATE Usuario SET Token_Version = Token_Version + 1 WHERE idUsuario = @id', { id: u.idUsuario });
      await bitacora.registrar(req, {
        accion: 'LOGOUT', modulo: 'Autenticación', tabla: 'Usuario', idRegistro: u.idUsuario,
        actor: actorDe(u), descripcion: 'Cerró sesión'
      });
    }
  }
  jwt.borrarCookies(res);
  res.json({ mensaje: 'Sesión cerrada.' });
}));

module.exports = router;
