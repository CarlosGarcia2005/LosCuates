// =====================================================================
//  API del perfil (cualquier usuario con sesión)
//  - Consultar y editar SOLO sus datos personales
//  - Cada cambio se confirma con un código MFA
//  - Rol, estado y permisos NO se pueden cambiar desde aquí
// =====================================================================
const express = require('express');

const { consulta } = require('../../config/db');
const V = require('../../public/js/validacion');
const contrasenas = require('../seguridad/contrasena');
const totp = require('../seguridad/totp');
const { descifrar } = require('../seguridad/cifrado');
const jwt = require('../seguridad/jwt');
const { crearLimitador } = require('../seguridad/limitador');
const usuarios = require('../usuarios');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { ErrorApp, errorValidacion, asincrono } = require('../errores');

const router = express.Router();

const limitadorCambios = crearLimitador({
  ventanaMs: 10 * 60 * 1000, maximo: 15, mensaje: 'Demasiados intentos. Espera unos minutos.'
});

// Campos que un usuario normal nunca puede mandar
const CAMPOS_ADMINISTRATIVOS = ['idRol', 'rol', 'estado', 'nivel', 'Nivel_Acceso', 'idUsuario', 'mfaActivo', 'Token_Version'];

/** Verifica el código MFA y marca ese código como usado. */
async function confirmarMfa(req, u, codigo, accion) {
  const paso = u.MFA_Secreto ? totp.verificarCodigo(descifrar(u.MFA_Secreto), codigo, u.MFA_Ultimo_Paso) : null;
  if (paso === null) {
    await bitacora.registrar(req, {
      accion, modulo: 'Perfil', tabla: 'Usuario', idRegistro: u.idUsuario,
      descripcion: 'Código MFA incorrecto al intentar guardar cambios', resultado: 'Fallo'
    });
    throw new ErrorApp(422, 'El código MFA no es correcto.', { errores: { codigo: 'Código incorrecto o ya usado.' } });
  }
  await consulta('UPDATE Usuario SET MFA_Ultimo_Paso = @paso WHERE idUsuario = @id', { id: u.idUsuario, paso });
}

router.get('/', asincrono(async (req, res) => {
  const generos = await consulta('SELECT idGenero AS id, Genero AS nombre FROM Genero ORDER BY idGenero');
  res.json({ usuario: usuarios.vista(req.usuarioCompleto), generos });
}));

router.put('/', limitadorCambios, contexto('PERFIL_EDITADO', 'Perfil', 'Usuario'), asincrono(async (req, res) => {
  const u = req.usuarioCompleto;

  const prohibidos = CAMPOS_ADMINISTRATIVOS.filter((c) => Object.prototype.hasOwnProperty.call(req.body || {}, c));
  if (prohibidos.length) {
    await bitacora.registrar(req, {
      accion: 'ACCESO_DENEGADO', modulo: 'Perfil', tabla: 'Usuario', idRegistro: u.idUsuario,
      descripcion: `Intentó modificar campos administrativos desde su perfil: ${prohibidos.join(', ')}`,
      despues: { camposEnviados: prohibidos }, resultado: 'Fallo'
    });
    throw new ErrorApp(403, 'No tienes permiso para modificar el rol, el estado ni los permisos de tu cuenta.');
  }

  const v = V.validarPerfil(req.body);
  if (!v.ok) throw errorValidacion(v.errores);
  const d = v.datos;

  await confirmarMfa(req, u, d.codigo, 'PERFIL_EDITADO');

  await consulta(`
    UPDATE Usuario
       SET idGenero = @idGenero, Nombre = @nombre, Apellido_Paterno = @apP,
           Apellido_Materno = @apM, Telefono = @tel, Correo = @correo
     WHERE idUsuario = @id`, {
    id: u.idUsuario, idGenero: d.idGenero, nombre: d.nombre, apP: d.apellidoPaterno,
    apM: d.apellidoMaterno, tel: d.telefono || null, correo: d.correo
  });

  const despues = await usuarios.porId(u.idUsuario);
  const dif = bitacora.diferencias(usuarios.paraBitacora(u), usuarios.paraBitacora(despues));
  await bitacora.registrar(req, {
    accion: 'PERFIL_EDITADO', modulo: 'Perfil', tabla: 'Usuario', idRegistro: u.idUsuario,
    descripcion: dif.campos.length
      ? `Actualizó su información personal (${dif.campos.join(', ')}) confirmando con MFA`
      : 'Confirmó su información personal sin cambios',
    antes: dif.antes, despues: dif.despues
  });
  res.json({ mensaje: 'Tu información se actualizó correctamente.', usuario: usuarios.vista(despues) });
}));

router.put('/contrasena', limitadorCambios, contexto('CONTRASENA_CAMBIADA', 'Perfil', 'Usuario'),
  asincrono(async (req, res) => {
    const u = req.usuarioCompleto;
    const v = V.validarCambioContrasena(req.body);
    if (!v.ok) throw errorValidacion(v.errores);

    const { valida } = await contrasenas.verificar(v.datos.actual, u.Contrasena);
    if (!valida) {
      await bitacora.registrar(req, {
        accion: 'CONTRASENA_CAMBIADA', modulo: 'Perfil', tabla: 'Usuario', idRegistro: u.idUsuario,
        descripcion: 'Contraseña actual incorrecta al intentar cambiarla', resultado: 'Fallo'
      });
      throw new ErrorApp(422, 'La contraseña actual no es correcta.', { errores: { actual: 'Contraseña incorrecta.' } });
    }

    await confirmarMfa(req, u, v.datos.codigo, 'CONTRASENA_CAMBIADA');

    await consulta('UPDATE Usuario SET Contrasena = @hash, Token_Version = Token_Version + 1 WHERE idUsuario = @id',
      { id: u.idUsuario, hash: await contrasenas.hashear(v.datos.nueva) });

    // Las demás sesiones se cierran; esta se renueva con la nueva versión
    jwt.emitirAcceso(res, { ...req.usuario, tokenVersion: req.usuario.tokenVersion + 1 });

    await bitacora.registrar(req, {
      accion: 'CONTRASENA_CAMBIADA', modulo: 'Perfil', tabla: 'Usuario', idRegistro: u.idUsuario,
      descripcion: 'Cambió su contraseña (confirmado con MFA). Se cerraron sus otras sesiones.'
    });
    res.json({ mensaje: 'Contraseña actualizada.' });
  }));

module.exports = router;
