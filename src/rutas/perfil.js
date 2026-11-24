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
const { soloCampos } = require('../seguridad/campos');
const { expulsar } = require('../seguridad/expulsion');
const { ErrorApp, errorValidacion, validacionEvadida, asincrono } = require('../errores');

const router = express.Router();

const limitadorCambios = crearLimitador({
  ventanaMs: 10 * 60 * 1000, maximo: 15, mensaje: 'Demasiados intentos. Espera unos minutos.',
  alExceder: (req, { maximo, minutos }) => bitacora.registrar(req, {
    accion: 'FUERZA_BRUTA', modulo: 'Seguridad', resultado: 'Fallo',
    descripcion: `[A07] Más de ${maximo} intentos de cambiar datos o contraseña en ${minutos} minutos (posible adivinanza del código MFA).`
  })
});

// Campos que un usuario normal nunca puede mandar
const CAMPOS_ADMINISTRATIVOS = ['idRol', 'rol', 'estado', 'nivel', 'Nivel_Acceso', 'idUsuario', 'mfaActivo', 'Token_Version',
  'Estado', 'Rol', 'MFA_Activo', 'MFA_Secreto', 'Contrasena', 'Contraseña', 'Intentos_Fallidos', 'Bloqueado_Hasta'];

/** [A01] Si en el JSON vienen campos de permisos, no se discute: se expulsa. */
async function expulsarSiEsAdministrativo(req, res, sobrantes) {
  const administrativos = sobrantes.filter((c) => CAMPOS_ADMINISTRATIVOS.includes(c));
  if (!administrativos.length) return false;
  await expulsar(req, res, {
    motivo: `Intentó cambiar sus propios permisos desde el perfil enviando ${administrativos.join(', ')}`,
    datos: { camposAdministrativos: administrativos }
  });
  return true;
}

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

router.put('/', limitadorCambios, contexto('PERFIL_EDITADO', 'Perfil', 'Usuario'),
  soloCampos(['nombre', 'apellidoPaterno', 'apellidoMaterno', 'telefono', 'correo', 'idGenero', 'codigo'], expulsarSiEsAdministrativo),
  asincrono(async (req, res) => {
  const u = req.usuarioCompleto;

  const v = V.validarPerfil(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);
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
  soloCampos(['actual', 'nueva', 'confirmar', 'codigo'], expulsarSiEsAdministrativo),
  asincrono(async (req, res) => {
    const u = req.usuarioCompleto;
    const v = V.validarCambioContrasena(req.body);
    if (!v.ok) throw validacionEvadida(v.errores);

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
    jwt.emitirAcceso(res, { ...req.usuario, tokenVersion: req.usuario.tokenVersion + 1 }, req.sesionInicio);

    await bitacora.registrar(req, {
      accion: 'CONTRASENA_CAMBIADA', modulo: 'Perfil', tabla: 'Usuario', idRegistro: u.idUsuario,
      descripcion: 'Cambió su contraseña (confirmado con MFA). Se cerraron sus otras sesiones.'
    });
    res.json({ mensaje: 'Contraseña actualizada.' });
  }));

/* [OWASP A07] Cerrar la sesión en todos los demás equipos (si el usuario
   sospecha que alguien más entró con su cuenta). Se confirma con MFA. */
router.post('/cerrar-sesiones', limitadorCambios, contexto('SESIONES_CERRADAS', 'Perfil', 'Usuario'),
  soloCampos(['codigo'], expulsarSiEsAdministrativo),
  asincrono(async (req, res) => {
    const u = req.usuarioCompleto;
    const v = V.validarCodigo(req.body);
    if (!v.ok) throw validacionEvadida(v.errores);
    await confirmarMfa(req, u, v.datos.codigo, 'SESIONES_CERRADAS');

    await consulta('UPDATE Usuario SET Token_Version = Token_Version + 1 WHERE idUsuario = @id', { id: u.idUsuario });
    jwt.emitirAcceso(res, { ...req.usuario, tokenVersion: req.usuario.tokenVersion + 1 }, req.sesionInicio);

    await bitacora.registrar(req, {
      accion: 'SESIONES_CERRADAS', modulo: 'Seguridad', tabla: 'Usuario', idRegistro: u.idUsuario,
      descripcion: '[A07] Cerró su sesión en todos los demás equipos (confirmado con MFA). Solo sigue abierta la de este navegador.'
    });
    res.json({ mensaje: 'Listo. Se cerraron tus sesiones en los demás equipos.' });
  }));

module.exports = router;
