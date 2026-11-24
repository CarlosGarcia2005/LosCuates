// =====================================================================
//  API de Equipos (solo administradores)
//  GET / · GET /catalogos · POST / · PUT /:id · DELETE /:id
//  Cada equipo tiene un responsable: un usuario activo con rol "Cliente".
// =====================================================================
const express = require('express');

const { consulta } = require('../../config/db');
const V = require('../../public/js/validacion');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { soloCampos } = require('../seguridad/campos');
const { SQL_ROL } = require('../funciones');
const { ErrorApp, errorValidacion, validacionEvadida, asincrono } = require('../errores');

const router = express.Router();
const POR_PAGINA = 8;

const idValido = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) throw new ErrorApp(400, 'Identificador de equipo no válido.');
  return n;
};
// En SQL Server los comodines de LIKE se vuelven texto normal encerrándolos en corchetes: % → [%]
const escaparLike = (t) => t.replace(/[[%_]/g, (c) => `[${c}]`);

const SELECT_EQUIPO = `
  SELECT q.idEquipo, q.Equipo AS nombre, q.idUsuario,
         CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS responsable, u.Correo AS correo,
         r.Rol AS rolResponsable, u.Estado AS estadoResponsable,
         (SELECT COUNT(*) FROM Reserva rv WHERE rv.idEquipo = q.idEquipo) AS reservas,
         (SELECT COUNT(*) FROM Juego j WHERE j.idEquipo_Local = q.idEquipo OR j.idEquipo_Visitante = q.idEquipo) AS partidos
    FROM Equipo q
    JOIN Usuario u ON u.idUsuario = q.idUsuario
    JOIN Rol r ON r.idRol = u.idRol`;

const normalizar = (f) => f && ({ ...f, reservas: Number(f.reservas), partidos: Number(f.partidos) });

async function equipoPorId(id) {
  const [f] = await consulta(`${SELECT_EQUIPO} WHERE q.idEquipo = @id`, { id });
  return normalizar(f) || null;
}

/** El responsable debe existir, estar activo y tener rol Cliente; el nombre no se puede repetir. */
async function revisarDatos(d, idActual) {
  const [r] = await consulta(`
    SELECT (SELECT COUNT(*) FROM Usuario u JOIN Rol r ON r.idRol = u.idRol
             WHERE u.idUsuario = @idUsuario AND u.Estado = 'Activo' AND ${SQL_ROL.cliente}) AS cliente,
           (SELECT COUNT(*) FROM Equipo WHERE Equipo = @nombre AND idEquipo <> @idActual) AS repetido`,
  { idUsuario: d.idUsuario, nombre: d.nombre, idActual: idActual || 0 });
  const errores = {};
  if (!Number(r.cliente)) errores.idUsuario = 'El responsable debe ser un usuario activo con rol Cliente.';
  if (Number(r.repetido)) errores.nombre = 'Ya existe un equipo con ese nombre.';
  if (Object.keys(errores).length) throw errorValidacion(errores);
}

/* ------------------------------------------------------------------ */
router.get('/', asincrono(async (req, res) => {
  const buscar = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';
  const pagina = Math.max(1, Math.min(10000, parseInt(req.query.pagina, 10) || 1));
  const texto = buscar ? `%${escaparLike(buscar)}%` : null;
  const [conteo, filas] = await consulta(`
    SELECT COUNT(*) AS total FROM Equipo q JOIN Usuario u ON u.idUsuario = q.idUsuario
     WHERE (@texto IS NULL OR q.Equipo LIKE @texto OR CONCAT(u.Nombre, ' ', u.Apellido_Paterno) LIKE @texto);
    ${SELECT_EQUIPO}
     WHERE (@texto IS NULL OR q.Equipo LIKE @texto OR CONCAT(u.Nombre, ' ', u.Apellido_Paterno) LIKE @texto)
     ORDER BY q.Equipo
     OFFSET @saltar ROWS FETCH NEXT @tomar ROWS ONLY;`, { texto, tomar: POR_PAGINA, saltar: (pagina - 1) * POR_PAGINA });
  const total = Number(conteo[0].total);
  const [todos] = await consulta('SELECT COUNT(*) AS total FROM Equipo');
  res.json({
    equipos: filas.map(normalizar), total, totalRegistrados: Number(todos.total),
    pagina, porPagina: POR_PAGINA, paginas: Math.max(1, Math.ceil(total / POR_PAGINA))
  });
}));

router.get('/catalogos', asincrono(async (req, res) => {
  const clientes = await consulta(`
    SELECT u.idUsuario AS id, CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS nombre, u.Correo AS correo
      FROM Usuario u JOIN Rol r ON r.idRol = u.idRol
     WHERE u.Estado = 'Activo' AND ${SQL_ROL.cliente}
     ORDER BY u.Nombre, u.Apellido_Paterno`);
  res.json({ clientes });
}));

router.post('/', contexto('EQUIPO_CREADO', 'Equipos', 'Equipo'), soloCampos(['nombre', 'idUsuario']), asincrono(async (req, res) => {
  const v = V.validarEquipo(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);
  await revisarDatos(v.datos);

  const r = await consulta('INSERT INTO Equipo (idUsuario, Equipo) VALUES (@idUsuario, @nombre)', v.datos);
  const nuevo = await equipoPorId(r.insertId);
  await bitacora.registrar(req, {
    accion: 'EQUIPO_CREADO', modulo: 'Equipos', tabla: 'Equipo', idRegistro: nuevo.idEquipo,
    descripcion: `Registró el equipo "${nuevo.nombre}" con responsable ${nuevo.correo}`,
    despues: { nombre: nuevo.nombre, responsable: nuevo.correo }
  });
  res.status(201).json({ mensaje: `Equipo "${nuevo.nombre}" registrado.`, equipo: nuevo });
}));

router.put('/:id', contexto('EQUIPO_EDITADO', 'Equipos', 'Equipo'), soloCampos(['nombre', 'idUsuario']), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const v = V.validarEquipo(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);
  const antes = await equipoPorId(id);
  if (!antes) throw new ErrorApp(404, 'El equipo no existe.');
  // Si el responsable no cambió, se acepta aunque ya no tenga rol Cliente (datos anteriores)
  if (v.datos.idUsuario !== antes.idUsuario) await revisarDatos(v.datos, id);
  else {
    const [r] = await consulta('SELECT COUNT(*) AS repetido FROM Equipo WHERE Equipo = @nombre AND idEquipo <> @id', { nombre: v.datos.nombre, id });
    if (Number(r.repetido)) throw errorValidacion({ nombre: 'Ya existe un equipo con ese nombre.' });
  }

  await consulta('UPDATE Equipo SET Equipo = @nombre, idUsuario = @idUsuario WHERE idEquipo = @id', { ...v.datos, id });
  const despues = await equipoPorId(id);
  const dif = bitacora.diferencias({ nombre: antes.nombre, responsable: antes.correo }, { nombre: despues.nombre, responsable: despues.correo });
  if (dif.campos.length) {
    await bitacora.registrar(req, {
      accion: 'EQUIPO_EDITADO', modulo: 'Equipos', tabla: 'Equipo', idRegistro: id,
      descripcion: `Editó el equipo "${antes.nombre}". ` +
        dif.campos.map((c) => `${c === 'nombre' ? 'Nombre' : 'Responsable'}: "${dif.antes[c]}" → "${dif.despues[c]}"`).join('; '),
      antes: dif.antes, despues: dif.despues
    });
  }
  res.json({ mensaje: dif.campos.length ? 'Equipo actualizado.' : 'No había cambios que guardar.', equipo: despues });
}));

router.delete('/:id', contexto('EQUIPO_ELIMINADO', 'Equipos', 'Equipo'), soloCampos([]), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const equipo = await equipoPorId(id);
  if (!equipo) throw new ErrorApp(404, 'El equipo no existe.');
  const [uso] = await consulta('SELECT COUNT(*) AS inscripciones FROM Inscripcion_Torneo WHERE idEquipo = @id', { id });
  const inscripciones = Number(uso.inscripciones);
  if (equipo.reservas || equipo.partidos || inscripciones) {
    const partes = [];
    if (equipo.reservas) partes.push(`${equipo.reservas} reserva(s)`);
    if (equipo.partidos) partes.push(`${equipo.partidos} partido(s)`);
    if (inscripciones) partes.push(`${inscripciones} inscripción(es) a torneos`);
    throw new ErrorApp(409, `No se puede eliminar "${equipo.nombre}" porque tiene ${partes.join(', ')}. Se conserva para no perder el historial.`);
  }
  await consulta('DELETE FROM Equipo WHERE idEquipo = @id', { id });
  await bitacora.registrar(req, {
    accion: 'EQUIPO_ELIMINADO', modulo: 'Equipos', tabla: 'Equipo', idRegistro: id,
    descripcion: `Eliminó el equipo "${equipo.nombre}" (responsable ${equipo.correo})`,
    antes: { nombre: equipo.nombre, responsable: equipo.correo }
  });
  res.json({ mensaje: `El equipo "${equipo.nombre}" se eliminó.` });
}));

module.exports = router;
