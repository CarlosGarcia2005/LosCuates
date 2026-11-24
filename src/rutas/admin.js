// =====================================================================
//  API del administrador: dashboard, usuarios, roles y bitácora
//  Todas las rutas exigen sesión (JWT) y rol con nivel "Administrador".
// =====================================================================
const express = require('express');

const { consulta, transaccion } = require('../../config/db');
const V = require('../../public/js/validacion');
const contrasenas = require('../seguridad/contrasena');
const jwt = require('../seguridad/jwt');
const usuarios = require('../usuarios');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { soloCampos } = require('../seguridad/campos');
const { esRolDelSistema, sinAcentos } = require('../funciones');
const P = require('../servicios/pagos');
const { ErrorApp, errorValidacion, validacionEvadida, asincrono } = require('../errores');

const router = express.Router();

const ETIQUETAS = {
  nombre: 'Nombre', apellidoPaterno: 'Apellido paterno', apellidoMaterno: 'Apellido materno',
  telefono: 'Teléfono', correo: 'Correo', genero: 'Género', rol: 'Rol', estado: 'Estado', nivel: 'Nivel de acceso'
};

const idValido = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw new ErrorApp(400, 'Identificador no válido.');
  return n;
};

const describirCambios = (dif) =>
  dif.campos.map((c) => `${ETIQUETAS[c] || c}: "${dif.antes[c] ?? '—'}" → "${dif.despues[c] ?? '—'}"`).join('; ');

/** Escapa los comodines de LIKE (% _ \) para buscar texto literal. */
// En SQL Server los comodines de LIKE se vuelven texto normal encerrándolos en corchetes: % → [%]
const escaparLike = (t) => t.replace(/[[%_]/g, (c) => `[${c}]`);

async function exigirAlMenosUnAdmin(conexion) {
  if ((await usuarios.contarAdminsActivos(conexion)) === 0) {
    throw new ErrorApp(409, 'Debe quedar al menos un administrador activo en el sistema.');
  }
}

async function validarCatalogos(idRol, idGenero) {
  const [f] = await consulta(`
    SELECT (SELECT COUNT(*) FROM Rol WHERE idRol = @idRol) AS rol,
           (SELECT COUNT(*) FROM Genero WHERE idGenero = @idGenero) AS genero`, { idRol, idGenero });
  const errores = {};
  if (idRol && !Number(f.rol)) errores.idRol = 'El rol seleccionado no existe.';
  if (idGenero && !Number(f.genero)) errores.idGenero = 'El género seleccionado no existe.';
  if (Object.keys(errores).length) throw errorValidacion(errores);
}

/** Convierte a número los campos que la base devuelve como texto (SUM de DECIMAL). */
const numeros = (fila) => Object.fromEntries(Object.entries(fila).map(([k, v]) => [k, v === null ? 0 : Number(v)]));

/* =================================================================== */
/*  DASHBOARD                                                           */
/* =================================================================== */
router.get('/dashboard', asincrono(async (req, res) => {
  const [indicadores, porRol, actividad, proximasReservas] = await consulta(`
    SELECT
      (SELECT COUNT(*) FROM Usuario)                                         AS usuariosTotal,
      (SELECT COUNT(*) FROM Usuario WHERE Estado = 'Activo')                 AS usuariosActivos,
      (SELECT COUNT(*) FROM Usuario WHERE Estado <> 'Activo')                AS usuariosInactivos,
      (SELECT COUNT(*) FROM Usuario WHERE MFA_Activo = 1)                    AS usuariosMfa,
      (SELECT COUNT(*) FROM Usuario WHERE Bloqueado_Hasta > GETDATE())           AS usuariosBloqueados,
      (SELECT COUNT(*) FROM Reserva)                                         AS reservasTotal,
      (SELECT COUNT(*) FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE e.Estado_Reserva = 'Pendiente')                                AS reservasPendientes,
      (SELECT COUNT(*) FROM Reserva WHERE Fecha_Reserva = CAST(GETDATE() AS DATE))         AS reservasHoy,
      (SELECT ISNULL(SUM(p.Monto), 0) FROM Pago p
         LEFT JOIN Reserva r ON r.idPago = p.idPago LEFT JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE p.Fecha_Pago >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND ${P.SQL_INGRESO}) AS ingresosMes,
      (SELECT ISNULL(SUM(p.Monto), 0) FROM Pago p
         LEFT JOIN Reserva r ON r.idPago = p.idPago LEFT JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE ${P.SQL_INGRESO})                                              AS ingresosTotal,
      (SELECT COUNT(*) FROM Torneo WHERE Estado_Torneo = 'Abierto')          AS torneosAbiertos,
      (SELECT COUNT(*) FROM Cancha WHERE Estado_Cancha IN ('Activa', 'Disponible')) AS canchasDisponibles,
      (SELECT COUNT(*) FROM Cancha)                                          AS canchasTotal,
      (SELECT COUNT(*) FROM Equipo)                                          AS equipos,
      (SELECT COUNT(*) FROM Bitacora WHERE Accion = 'LOGIN_EXITOSO'
          AND Fecha >= DATEADD(HOUR, -24, GETDATE()))                             AS loginsExitosos24h,
      (SELECT COUNT(*) FROM Bitacora WHERE Accion IN ('LOGIN_FALLIDO', 'MFA_FALLIDO')
          AND Fecha >= DATEADD(HOUR, -24, GETDATE()))                             AS loginsFallidos24h,
      (SELECT COUNT(*) FROM Bitacora WHERE Fecha >= DATEADD(HOUR, -24, GETDATE())) AS movimientos24h;

    SELECT r.idRol, r.Rol, r.Nivel_Acceso,
           COUNT(u.idUsuario) AS total,
           SUM(CASE WHEN u.Estado = 'Activo' THEN 1 ELSE 0 END) AS activos
      FROM Rol r LEFT JOIN Usuario u ON u.idRol = r.idRol
     GROUP BY r.idRol, r.Rol, r.Nivel_Acceso
     ORDER BY total DESC, r.Rol;

    SELECT TOP (8) idBitacora, Fecha, Correo_Usuario, Accion, Descripcion, Resultado
      FROM Bitacora ORDER BY idBitacora DESC;

    SELECT TOP (6) r.Folio, CONVERT(CHAR(10), r.Fecha_Reserva, 23) AS Fecha,
           REPLACE(LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5), ':', '.') AS Inicio, REPLACE(LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5), ':', '.') AS Fin,
           c.Cancha, CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS Cliente, e.Estado_Reserva AS Estado
      FROM Reserva r
      JOIN Cancha c ON c.idCancha = r.idCancha
      JOIN Usuario u ON u.idUsuario = r.idUsuario
      JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
     WHERE r.Fecha_Reserva >= CAST(GETDATE() AS DATE)
     ORDER BY r.Fecha_Reserva, r.Hora_Inicio;`);

  res.json({
    indicadores: numeros(indicadores[0]),
    porRol: porRol.map((x) => ({ ...x, total: Number(x.total), activos: Number(x.activos || 0) })),
    actividad,
    proximasReservas: proximasReservas.map((x) => ({ ...x, Inicio: x.Inicio.replace('.', ':'), Fin: x.Fin.replace('.', ':') }))
  });
}));

/* =================================================================== */
/*  CATÁLOGOS                                                           */
/* =================================================================== */
router.get('/catalogos', asincrono(async (req, res) => {
  const [roles, generos] = await consulta(`
    SELECT idRol AS id, Rol AS nombre, Nivel_Acceso AS nivel FROM Rol ORDER BY Rol;
    SELECT idGenero AS id, Genero AS nombre FROM Genero ORDER BY idGenero;`);
  res.json({ roles, generos });
}));

/* =================================================================== */
/*  USUARIOS                                                            */
/* =================================================================== */
router.get('/usuarios', asincrono(async (req, res) => {
  const buscar = typeof req.query.buscar === 'string' ? req.query.buscar.trim().slice(0, 50) : '';
  const idRol = Number(req.query.idRol);
  const estado = V.ESTADOS.includes(req.query.estado) ? req.query.estado : null;

  const filas = await consulta(`
    SELECT u.idUsuario, u.Nombre, u.Apellido_Paterno, u.Apellido_Materno, u.Correo, u.Telefono,
           u.idRol, r.Rol, r.Nivel_Acceso, u.idGenero, g.Genero, u.Estado, u.MFA_Activo,
           u.Ultimo_Acceso,
           CASE WHEN u.Bloqueado_Hasta > GETDATE() THEN 1 ELSE 0 END AS Bloqueado
      FROM Usuario u
      JOIN Rol r ON r.idRol = u.idRol
      JOIN Genero g ON g.idGenero = u.idGenero
     WHERE (@buscar IS NULL OR u.Nombre LIKE @buscar OR u.Apellido_Paterno LIKE @buscar
            OR u.Apellido_Materno LIKE @buscar OR u.Correo LIKE @buscar)
       AND (@idRol IS NULL OR u.idRol = @idRol)
       AND (@estado IS NULL OR u.Estado = @estado)
     ORDER BY u.Nombre, u.Apellido_Paterno`, {
    buscar: buscar ? `%${escaparLike(buscar)}%` : null,
    idRol: Number.isInteger(idRol) && idRol > 0 && idRol < 256 ? idRol : null,
    estado
  });
  res.json({ usuarios: filas });
}));

router.get('/usuarios/:id', asincrono(async (req, res) => {
  const u = await usuarios.porId(idValido(req.params.id));
  if (!u) throw new ErrorApp(404, 'El usuario no existe.');
  res.json({ usuario: usuarios.vista(u) });
}));

const datosUsuario = (d) => ({
  idGenero: d.idGenero, idRol: d.idRol, nombre: d.nombre, apP: d.apellidoPaterno, apM: d.apellidoMaterno,
  tel: d.telefono || null, correo: d.correo, estado: d.estado
});

router.post('/usuarios', contexto('USUARIO_CREADO', 'Usuarios', 'Usuario'),
  soloCampos(['nombre', 'apellidoPaterno', 'apellidoMaterno', 'telefono', 'correo', 'idGenero', 'idRol', 'estado', 'contrasena', 'confirmar']), asincrono(async (req, res) => {
  const v = V.validarUsuarioAdmin(req.body, { nuevo: true });
  if (!v.ok) throw validacionEvadida(v.errores);
  const d = v.datos;
  await validarCatalogos(d.idRol, d.idGenero);

  const r = await consulta(`
    INSERT INTO Usuario (idGenero, idRol, Nombre, Apellido_Paterno, Apellido_Materno,
                         Telefono, Correo, Contrasena, Estado)
    VALUES (@idGenero, @idRol, @nombre, @apP, @apM, @tel, @correo, @hash, @estado)`,
  { ...datosUsuario(d), hash: await contrasenas.hashear(d.contrasena) });

  const nuevo = await usuarios.porId(r.insertId);
  await bitacora.registrar(req, {
    accion: 'USUARIO_CREADO', modulo: 'Usuarios', tabla: 'Usuario', idRegistro: nuevo.idUsuario,
    descripcion: `Creó al usuario ${nuevo.Correo} con rol "${nuevo.Rol}" y estado "${nuevo.Estado}"`,
    despues: usuarios.paraBitacora(nuevo)
  });
  res.status(201).json({ mensaje: 'Usuario creado correctamente.', usuario: usuarios.vista(nuevo) });
}));

router.put('/usuarios/:id', contexto('USUARIO_EDITADO', 'Usuarios', 'Usuario'),
  soloCampos(['nombre', 'apellidoPaterno', 'apellidoMaterno', 'telefono', 'correo', 'idGenero', 'idRol', 'estado']), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const v = V.validarUsuarioAdmin(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);
  const d = v.datos;
  await validarCatalogos(d.idRol, d.idGenero);

  const antes = await usuarios.porId(id);
  if (!antes) throw new ErrorApp(404, 'El usuario no existe.');

  if (id === req.usuario.id) {
    const [rolNuevo] = await consulta('SELECT Nivel_Acceso FROM Rol WHERE idRol = @idRol', { idRol: d.idRol });
    if (d.estado !== 'Activo' || rolNuevo.Nivel_Acceso !== 'Administrador') {
      throw new ErrorApp(400, 'No puedes quitarte tus propios permisos de administrador ni desactivar tu propia cuenta.');
    }
  }

  const despues = await transaccion(async (cx) => {
    await consulta(`
      UPDATE Usuario
         SET idGenero = @idGenero, idRol = @idRol, Nombre = @nombre, Apellido_Paterno = @apP,
             Apellido_Materno = @apM, Telefono = @tel, Correo = @correo, Estado = @estado
       WHERE idUsuario = @id`, { ...datosUsuario(d), id }, cx);
    await exigirAlMenosUnAdmin(cx);
    return usuarios.porId(id, cx);
  });

  const dif = bitacora.diferencias(usuarios.paraBitacora(antes), usuarios.paraBitacora(despues));
  if (dif.campos.length) {
    await bitacora.registrar(req, {
      accion: 'USUARIO_EDITADO', modulo: 'Usuarios', tabla: 'Usuario', idRegistro: id,
      descripcion: `Editó al usuario ${despues.Correo}. ${describirCambios(dif)}`.slice(0, 500),
      antes: dif.antes, despues: dif.despues
    });
  }
  res.json({
    mensaje: dif.campos.length ? 'Cambios guardados.' : 'No había cambios que guardar.',
    usuario: usuarios.vista(despues)
  });
}));

router.post('/usuarios/:id/contrasena', contexto('CONTRASENA_RESTABLECIDA', 'Usuarios', 'Usuario'), soloCampos(['nueva', 'confirmar']),
  asincrono(async (req, res) => {
    const id = idValido(req.params.id);
    const v = V.validarNuevaContrasena(req.body);
    if (!v.ok) throw validacionEvadida(v.errores);
    const u = await usuarios.porId(id);
    if (!u) throw new ErrorApp(404, 'El usuario no existe.');

    await consulta(`
      UPDATE Usuario
         SET Contrasena = @hash, Token_Version = Token_Version + 1,
             Intentos_Fallidos = 0, Bloqueado_Hasta = NULL
       WHERE idUsuario = @id`, { id, hash: await contrasenas.hashear(v.datos.nueva) });

    await bitacora.registrar(req, {
      accion: 'CONTRASENA_RESTABLECIDA', modulo: 'Usuarios', tabla: 'Usuario', idRegistro: id,
      descripcion: `Asignó una nueva contraseña a ${u.Correo}. Sus sesiones abiertas se cerraron.`
    });

    // Si el admin se cambió su propia contraseña, renovar su token para no sacarlo
    if (id === req.usuario.id) jwt.emitirAcceso(res, { ...req.usuario, tokenVersion: req.usuario.tokenVersion + 1 });
    res.json({ mensaje: 'Contraseña actualizada. El usuario deberá iniciar sesión de nuevo.' });
  }));

router.post('/usuarios/:id/mfa-reset', contexto('MFA_RESTABLECIDO', 'Usuarios', 'Usuario'), soloCampos([]),
  asincrono(async (req, res) => {
    const id = idValido(req.params.id);
    if (id === req.usuario.id) throw new ErrorApp(400, 'Para restablecer tu propio MFA pídeselo a otro administrador.');
    const u = await usuarios.porId(id);
    if (!u) throw new ErrorApp(404, 'El usuario no existe.');

    await consulta(`
      UPDATE Usuario
         SET MFA_Activo = 0, MFA_Secreto = NULL, MFA_Ultimo_Paso = NULL, Token_Version = Token_Version + 1
       WHERE idUsuario = @id`, { id });

    await bitacora.registrar(req, {
      accion: 'MFA_RESTABLECIDO', modulo: 'Usuarios', tabla: 'Usuario', idRegistro: id,
      descripcion: `Restableció el MFA de ${u.Correo}. Deberá escanear un código QR nuevo al iniciar sesión.`,
      antes: { mfaActivo: Boolean(u.MFA_Activo) }, despues: { mfaActivo: false }
    });
    res.json({ mensaje: 'MFA restablecido. El usuario configurará un código nuevo en su próximo inicio de sesión.' });
  }));

router.post('/usuarios/:id/desbloquear', contexto('CUENTA_DESBLOQUEADA', 'Usuarios', 'Usuario'), soloCampos([]),
  asincrono(async (req, res) => {
    const id = idValido(req.params.id);
    const u = await usuarios.porId(id);
    if (!u) throw new ErrorApp(404, 'El usuario no existe.');
    await consulta('UPDATE Usuario SET Intentos_Fallidos = 0, Bloqueado_Hasta = NULL WHERE idUsuario = @id', { id });
    await bitacora.registrar(req, {
      accion: 'CUENTA_DESBLOQUEADA', modulo: 'Usuarios', tabla: 'Usuario', idRegistro: id,
      descripcion: `Desbloqueó la cuenta de ${u.Correo}`
    });
    res.json({ mensaje: 'Cuenta desbloqueada.' });
  }));

/* =================================================================== */
/*  ROLES                                                               */
/* =================================================================== */
router.get('/roles', asincrono(async (req, res) => {
  const filas = await consulta(`
    SELECT r.idRol, r.Rol, r.Nivel_Acceso,
           COUNT(u.idUsuario) AS usuarios,
           SUM(CASE WHEN u.Estado = 'Activo' THEN 1 ELSE 0 END) AS activos
      FROM Rol r LEFT JOIN Usuario u ON u.idRol = r.idRol
     GROUP BY r.idRol, r.Rol, r.Nivel_Acceso
     ORDER BY r.Rol`);
  res.json({ roles: filas.map((x) => ({ ...x, usuarios: Number(x.usuarios), activos: Number(x.activos || 0) })) });
}));

router.post('/roles', contexto('ROL_CREADO', 'Roles', 'Rol'), soloCampos(['rol', 'nivel']), asincrono(async (req, res) => {
  const v = V.validarRol(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);
  const r = await consulta('INSERT INTO Rol (Rol, Nivel_Acceso) VALUES (@rol, @nivel)', v.datos);
  await bitacora.registrar(req, {
    accion: 'ROL_CREADO', modulo: 'Roles', tabla: 'Rol', idRegistro: r.insertId,
    descripcion: `Creó el rol "${v.datos.rol}" con nivel de acceso "${v.datos.nivel}"`,
    despues: { rol: v.datos.rol, nivel: v.datos.nivel }
  });
  res.status(201).json({ mensaje: 'Rol creado correctamente.', id: r.insertId });
}));

router.put('/roles/:id', contexto('ROL_EDITADO', 'Roles', 'Rol'), soloCampos(['rol', 'nivel']), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const v = V.validarRol(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);

  const [antes] = await consulta('SELECT Rol AS rol, Nivel_Acceso AS nivel FROM Rol WHERE idRol = @id', { id });
  if (!antes) throw new ErrorApp(404, 'El rol no existe.');

  if (id === req.usuario.idRol && v.datos.nivel !== 'Administrador') {
    throw new ErrorApp(400, 'No puedes quitarle el nivel de administrador a tu propio rol.');
  }
  // Equipos, Árbitros y Limpieza reconocen estos roles por su nombre
  if (esRolDelSistema(antes.rol) && sinAcentos(antes.rol) !== sinAcentos(v.datos.rol)) {
    throw errorValidacion({ rol: `"${antes.rol}" lo usan los módulos de Equipos, Árbitros o Limpieza; su nombre no se puede cambiar.` });
  }

  await transaccion(async (cx) => {
    await consulta('UPDATE Rol SET Rol = @rol, Nivel_Acceso = @nivel WHERE idRol = @id', { ...v.datos, id }, cx);
    await exigirAlMenosUnAdmin(cx);
  });

  const dif = bitacora.diferencias(antes, v.datos);
  if (dif.campos.length) {
    await bitacora.registrar(req, {
      accion: 'ROL_EDITADO', modulo: 'Roles', tabla: 'Rol', idRegistro: id,
      descripcion: `Editó el rol "${antes.rol}". ${describirCambios(dif)}`.slice(0, 500),
      antes: dif.antes, despues: dif.despues
    });
  }
  res.json({ mensaje: dif.campos.length ? 'Rol actualizado.' : 'No había cambios que guardar.' });
}));

/* =================================================================== */
/*  BITÁCORA                                                            */
/* =================================================================== */
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Arma el WHERE de la bitácora a partir de los filtros (siempre con parámetros). */
function filtrosBitacora(query) {
  const condiciones = [];
  const p = {};
  const q = (k) => (typeof query[k] === 'string' ? query[k].trim() : '');

  if (FECHA.test(q('desde'))) { p.desde = q('desde'); condiciones.push('b.Fecha >= @desde'); }
  if (FECHA.test(q('hasta'))) { p.hasta = q('hasta'); condiciones.push('b.Fecha < DATEADD(DAY, 1, CAST(@hasta AS DATE))'); }
  if (q('usuario')) { p.usuario = `%${escaparLike(q('usuario').slice(0, 100))}%`; condiciones.push('b.Correo_Usuario LIKE @usuario'); }
  if (/^[A-Z_]{3,40}$/.test(q('accion'))) { p.accion = q('accion'); condiciones.push('b.Accion = @accion'); }
  if (q('modulo')) { p.modulo = q('modulo').slice(0, 40); condiciones.push('b.Modulo = @modulo'); }
  if (q('resultado') === 'Éxito' || q('resultado') === 'Fallo') { p.resultado = q('resultado'); condiciones.push('b.Resultado = @resultado'); }
  if (q('q')) {
    p.texto = `%${escaparLike(q('q').slice(0, 200))}%`;
    condiciones.push('(b.Descripcion LIKE @texto OR b.Datos_Anteriores LIKE @texto OR b.Datos_Nuevos LIKE @texto OR b.IP LIKE @texto)');
  }
  return { where: condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '', parametros: p };
}

router.get('/bitacora', asincrono(async (req, res) => {
  const pagina = Math.max(1, Math.min(10000, parseInt(req.query.pagina, 10) || 1));
  const porPagina = [10, 25, 50, 100].includes(Number(req.query.porPagina)) ? Number(req.query.porPagina) : 25;
  const { where, parametros } = filtrosBitacora(req.query);

  const [conteo, registros] = await consulta(`
    SELECT COUNT(*) AS total FROM Bitacora b ${where};
    SELECT b.idBitacora, b.Fecha, b.idUsuario, b.Correo_Usuario, b.Rol_Usuario, b.Accion, b.Modulo,
           b.Tabla_Afectada, b.idRegistro, b.Descripcion, b.IP, b.Resultado, b.Origen,
           CASE WHEN b.Datos_Anteriores IS NOT NULL OR b.Datos_Nuevos IS NOT NULL THEN 1 ELSE 0 END AS TieneDatos
      FROM Bitacora b ${where}
     ORDER BY b.idBitacora DESC
     OFFSET @saltar ROWS FETCH NEXT @tomar ROWS ONLY;`,
  { ...parametros, tomar: porPagina, saltar: (pagina - 1) * porPagina });

  const total = Number(conteo[0].total);
  res.json({ total, pagina, porPagina, paginas: Math.max(1, Math.ceil(total / porPagina)), registros });
}));

router.get('/bitacora/opciones', asincrono(async (req, res) => {
  const [acciones, modulos] = await consulta(`
    SELECT DISTINCT Accion FROM Bitacora ORDER BY Accion;
    SELECT DISTINCT Modulo FROM Bitacora ORDER BY Modulo;`);
  res.json({ acciones: acciones.map((x) => x.Accion), modulos: modulos.map((x) => x.Modulo) });
}));

const csvCelda = (v) => {
  let t = v === null || v === undefined ? '' : (v instanceof Date ? v.toISOString() : String(v));
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;                       // evita inyección de fórmulas en Excel
  return `"${t.replace(/"/g, '""')}"`;
};

router.get('/bitacora/exportar', asincrono(async (req, res) => {
  const { where, parametros } = filtrosBitacora(req.query);
  const filas = await consulta(`
    SELECT TOP (10000) b.idBitacora, REPLACE(CONVERT(CHAR(19), b.Fecha, 120), ':', '.') AS Fecha, b.Correo_Usuario, b.Rol_Usuario,
           b.Accion, b.Modulo, b.Tabla_Afectada, b.idRegistro, b.Descripcion,
           b.Datos_Anteriores, b.Datos_Nuevos, b.IP, b.Navegador, b.Resultado, b.Origen
      FROM Bitacora b ${where}
     ORDER BY b.idBitacora DESC`, parametros);

  await bitacora.registrar(req, {
    accion: 'BITACORA_EXPORTADA', modulo: 'Bitácora', tabla: 'Bitacora',
    descripcion: `Exportó ${filas.length} registro(s) de la bitácora a CSV`,
    despues: { filtros: req.query }
  });

  const columnas = ['idBitacora', 'Fecha', 'Correo_Usuario', 'Rol_Usuario', 'Accion', 'Modulo', 'Tabla_Afectada',
    'idRegistro', 'Descripcion', 'Datos_Anteriores', 'Datos_Nuevos', 'IP', 'Navegador', 'Resultado', 'Origen'];
  const lineas = [columnas.join(',')].concat(filas.map((f) => {
    const fila = { ...f, Fecha: f.Fecha.replace(/\./g, ':').replace(/^(\d{4}-\d{2}-\d{2}) /, '$1 ') };
    return columnas.map((c) => csvCelda(fila[c])).join(',');
  }));
  const ahora = new Date();
  const fecha = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`; // fecha local

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bitacora_${fecha}.csv"`);
  res.send('﻿' + lineas.join('\r\n'));   // BOM para que Excel lea bien los acentos
}));

router.get('/bitacora/:id', asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const [fila] = await consulta('SELECT * FROM Bitacora WHERE idBitacora = @id', { id });
  if (!fila) throw new ErrorApp(404, 'Registro no encontrado.');
  const parsear = (t) => { if (!t) return null; if (typeof t === 'object') return t; try { return JSON.parse(t); } catch { return t; } };
  fila.Datos_Anteriores = parsear(fila.Datos_Anteriores);
  fila.Datos_Nuevos = parsear(fila.Datos_Nuevos);
  res.json({ registro: fila });
}));

module.exports = router;
