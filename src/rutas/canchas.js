// =====================================================================
//  API de Canchas (solo administradores)
//  GET / · POST / · PUT /:id · DELETE /:id
// =====================================================================
const express = require('express');

const { consulta, transaccion } = require('../../config/db');
const V = require('../../public/js/validacion');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { soloCampos } = require('../seguridad/campos');
const { ErrorApp, errorValidacion, validacionEvadida, asincrono } = require('../errores');

const router = express.Router();

const idValido = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new ErrorApp(400, 'Identificador de cancha no válido.');
  return n;
};

const ETIQUETAS = { nombre: 'Nombre', tipo: 'Tipo', estado: 'Estado' };
const describir = (dif) =>
  dif.campos.map((c) => `${ETIQUETAS[c] || c}: "${dif.antes[c] ?? '—'}" → "${dif.despues[c] ?? '—'}"`).join('; ');

async function canchaPorId(id, cx) {
  const [c] = await consulta(`
    SELECT c.idCancha, c.Cancha AS nombre, c.idTipo_Cancha AS idTipo, t.Tipo_Cancha AS tipo, c.Estado_Cancha AS estado
      FROM Cancha c JOIN Tipo_Cancha t ON t.idTipo_Cancha = c.idTipo_Cancha
     WHERE c.idCancha = @id`, { id }, cx);
  return c || null;
}

async function revisarDatos(d, idActual, cx) {
  const [r] = await consulta(`
    SELECT (SELECT COUNT(*) FROM Tipo_Cancha WHERE idTipo_Cancha = @idTipo) AS tipo,
           (SELECT COUNT(*) FROM Cancha WHERE Cancha = @nombre AND idCancha <> @idActual) AS repetida`,
  { idTipo: d.idTipo, nombre: d.nombre, idActual: idActual || 0 }, cx);
  const errores = {};
  if (!Number(r.tipo)) errores.idTipo = 'El tipo de cancha no existe.';
  if (Number(r.repetida)) errores.nombre = 'Ya existe una cancha con ese nombre.';
  if (Object.keys(errores).length) throw errorValidacion(errores);
}

/* ------------------------------------------------------------------ */
router.get('/', asincrono(async (req, res) => {
  const [canchas, tipos] = await consulta(`
    SELECT c.idCancha, c.Cancha AS nombre, c.idTipo_Cancha AS idTipo, t.Tipo_Cancha AS tipo, c.Estado_Cancha AS estado,
           (SELECT COUNT(*) FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
             WHERE r.idCancha = c.idCancha AND r.Fecha_Reserva >= CAST(GETDATE() AS DATE)
               AND e.Estado_Reserva IN ('Pendiente', 'Confirmada')) AS proximas
      FROM Cancha c JOIN Tipo_Cancha t ON t.idTipo_Cancha = c.idTipo_Cancha
     ORDER BY c.Cancha;
    SELECT idTipo_Cancha AS id, Tipo_Cancha AS nombre FROM Tipo_Cancha ORDER BY Tipo_Cancha;`);

  const lista = canchas.map((c) => ({ ...c, proximas: Number(c.proximas) }));
  const activas = lista.filter((c) => c.estado === 'Activa').length;
  res.json({
    canchas: lista,
    tipos,
    resumen: { total: lista.length, activas, inactivas: lista.length - activas }
  });
}));

router.post('/', contexto('CANCHA_CREADA', 'Canchas', 'Cancha'), soloCampos(['nombre', 'idTipo', 'estado']), asincrono(async (req, res) => {
  const v = V.validarCancha(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);
  await revisarDatos(v.datos);

  const r = await consulta(
    'INSERT INTO Cancha (idTipo_Cancha, Cancha, Estado_Cancha) VALUES (@idTipo, @nombre, @estado)', v.datos);
  const nueva = await canchaPorId(r.insertId);

  await bitacora.registrar(req, {
    accion: 'CANCHA_CREADA', modulo: 'Canchas', tabla: 'Cancha', idRegistro: nueva.idCancha,
    descripcion: `Registró la cancha "${nueva.nombre}" (${nueva.tipo}) como ${nueva.estado}`,
    despues: { nombre: nueva.nombre, tipo: nueva.tipo, estado: nueva.estado }
  });
  res.status(201).json({ mensaje: 'Cancha registrada correctamente.', cancha: nueva });
}));

router.put('/:id', contexto('CANCHA_EDITADA', 'Canchas', 'Cancha'), soloCampos(['nombre', 'idTipo', 'estado']), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const v = V.validarCancha(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);

  const antes = await canchaPorId(id);
  if (!antes) throw new ErrorApp(404, 'La cancha no existe.');
  await revisarDatos(v.datos, id);

  const despues = await transaccion(async (cx) => {
    await consulta(`UPDATE Cancha SET idTipo_Cancha = @idTipo, Cancha = @nombre, Estado_Cancha = @estado
                     WHERE idCancha = @id`, { ...v.datos, id }, cx);
    return canchaPorId(id, cx);
  });

  const campos = (c) => ({ nombre: c.nombre, tipo: c.tipo, estado: c.estado });
  const dif = bitacora.diferencias(campos(antes), campos(despues));
  let aviso = '';
  if (antes.estado === 'Activa' && despues.estado === 'Inactiva') {
    const [p] = await consulta(`
      SELECT COUNT(*) AS total FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
       WHERE r.idCancha = @id AND r.Fecha_Reserva >= CAST(GETDATE() AS DATE) AND e.Estado_Reserva IN ('Pendiente', 'Confirmada')`, { id });
    if (Number(p.total)) aviso = ` Ojo: tiene ${p.total} reserva(s) próxima(s); revísalas en Reservas.`;
  }

  if (dif.campos.length) {
    await bitacora.registrar(req, {
      accion: 'CANCHA_EDITADA', modulo: 'Canchas', tabla: 'Cancha', idRegistro: id,
      descripcion: `Editó la cancha "${antes.nombre}". ${describir(dif)}`.slice(0, 500),
      antes: dif.antes, despues: dif.despues
    });
  }
  res.json({ mensaje: (dif.campos.length ? 'Cancha actualizada.' : 'No había cambios que guardar.') + aviso, cancha: despues });
}));

router.delete('/:id', contexto('CANCHA_ELIMINADA', 'Canchas', 'Cancha'), soloCampos([]), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const cancha = await canchaPorId(id);
  if (!cancha) throw new ErrorApp(404, 'La cancha no existe.');

  const [uso] = await consulta(`
    SELECT (SELECT COUNT(*) FROM Reserva WHERE idCancha = @id) AS reservas,
           (SELECT COUNT(*) FROM Juego   WHERE idCancha = @id) AS juegos,
           (SELECT COUNT(*) FROM Tarea_Limpieza WHERE idCancha = @id) +
           (SELECT COUNT(*) FROM Reporte_Condicion WHERE idCancha = @id) AS limpieza`, { id });
  if (Number(uso.reservas) || Number(uso.juegos) || Number(uso.limpieza)) {
    throw new ErrorApp(409, `No se puede eliminar "${cancha.nombre}" porque tiene ${uso.reservas} reserva(s), ` +
      `${uso.juegos} juego(s) y ${uso.limpieza} registro(s) de limpieza. Márcala como Inactiva para que ya no reciba reservas.`);
  }

  await consulta('DELETE FROM Cancha WHERE idCancha = @id', { id });
  await bitacora.registrar(req, {
    accion: 'CANCHA_ELIMINADA', modulo: 'Canchas', tabla: 'Cancha', idRegistro: id,
    descripcion: `Eliminó la cancha "${cancha.nombre}" (${cancha.tipo})`,
    antes: { nombre: cancha.nombre, tipo: cancha.tipo, estado: cancha.estado }
  });
  res.json({ mensaje: `La cancha "${cancha.nombre}" se eliminó.` });
}));

module.exports = router;
