// =====================================================================
//  API de Limpieza y reporte de condiciones de cancha
//  La usan los administradores (Panel → Limpieza) y el personal de
//  limpieza (Mi perfil → Limpieza). Solo un administrador puede marcar
//  un reporte como atendido o borrar tareas de otras personas.
//    GET  /?fecha              partidos del día, tareas, alerta urgente y catálogos
//    GET  /tareas              todas las tareas (con filtros)
//    POST /tareas · PUT /tareas/:id · POST /tareas/:id/estado · DELETE /tareas/:id
//    GET  /reportes · POST /reportes · POST /reportes/:id/atender
// =====================================================================
const express = require('express');

const { consulta } = require('../../config/db');
const V = require('../../public/js/validacion');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { soloCampos } = require('../seguridad/campos');
const { expulsar } = require('../seguridad/expulsion');
const { SQL_ROL } = require('../funciones');
const { ErrorApp, errorValidacion, validacionEvadida, asincrono } = require('../errores');

const router = express.Router();
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const dos = (n) => String(n).padStart(2, '0');
const fechaIso = (f) => `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
const esAdmin = (req) => req.usuario.nivel === 'Administrador';

const idValido = (valor, que) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) throw new ErrorApp(400, `Identificador de ${que} no válido.`);
  return n;
};

const SELECT_TAREA = `
  SELECT t.idTarea_Limpieza AS id, t.Tipo_Tarea AS tipo, t.Tarea AS tarea, t.idCancha, c.Cancha AS cancha, t.Lugar AS lugar,
         CONVERT(CHAR(10), t.Fecha, 23) AS fecha, LEFT(CONVERT(CHAR(8), t.Hora, 108), 5) AS hora,
         t.idUsuario_Asignado AS idUsuarioAsignado, ua.Nombre + ' ' + ua.Apellido_Paterno AS asignado,
         t.Estado_Tarea AS estado, t.Notas AS notas, t.idUsuario_Registro AS idUsuarioRegistro,
         ur.Nombre + ' ' + ur.Apellido_Paterno AS registro, t.Fecha_Completada AS completada
    FROM Tarea_Limpieza t
    LEFT JOIN Cancha c   ON c.idCancha = t.idCancha
    LEFT JOIN Usuario ua ON ua.idUsuario = t.idUsuario_Asignado
    LEFT JOIN Usuario ur ON ur.idUsuario = t.idUsuario_Registro`;

const SELECT_REPORTE = `
  SELECT rp.idReporte_Condicion AS id, rp.idCancha, c.Cancha AS cancha, rp.Tipo_Problema AS tipoProblema,
         rp.Descripcion AS descripcion, rp.Urgencia AS urgencia, rp.Estado_Reporte AS estado,
         rp.Fecha_Reporte AS fecha, u.Nombre + ' ' + u.Apellido_Paterno AS reporta,
         rp.Fecha_Atencion AS fechaAtencion, ua.Nombre + ' ' + ua.Apellido_Paterno AS atiende, rp.Nota_Atencion AS nota
    FROM Reporte_Condicion rp
    JOIN Cancha c ON c.idCancha = rp.idCancha
    LEFT JOIN Usuario u  ON u.idUsuario = rp.idUsuario_Reporta
    LEFT JOIN Usuario ua ON ua.idUsuario = rp.idUsuario_Atiende`;

const lugarDe = (t) => t.cancha || t.lugar || '—';

async function tareaPorId(id) {
  const [t] = await consulta(`${SELECT_TAREA} WHERE t.idTarea_Limpieza = @id`, { id });
  return t || null;
}

async function personal() {
  return consulta(`
    SELECT u.idUsuario AS id, CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS nombre
      FROM Usuario u JOIN Rol r ON r.idRol = u.idRol
     WHERE u.Estado = 'Activo' AND ${SQL_ROL.limpieza}
     ORDER BY u.Nombre, u.Apellido_Paterno`);
}

/** Cancha existente y persona de limpieza activa (si se eligió). */
async function revisarTarea(d) {
  const errores = {};
  if (d.idCancha) {
    const [c] = await consulta('SELECT COUNT(*) AS n FROM Cancha WHERE idCancha = @idCancha', d);
    if (!Number(c.n)) errores.idCancha = 'La cancha no existe.';
  }
  if (d.idUsuarioAsignado) {
    const ids = (await personal()).map((p) => Number(p.id));
    if (!ids.includes(d.idUsuarioAsignado)) errores.idUsuarioAsignado = 'Solo se puede asignar a personal de limpieza activo.';
  }
  if (Object.keys(errores).length) throw errorValidacion(errores);
}

/* ------------------------------------------------------------------ */
router.get('/', asincrono(async (req, res) => {
  const hoy = fechaIso(new Date());
  const fecha = FECHA.test(req.query.fecha || '') && V.fechaReal(req.query.fecha) ? req.query.fecha : hoy;

  const [partidos, tareas, urgentes, abiertos, canchas] = await consulta(`
    SELECT r.idReserva, r.Folio AS folio, LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS hora, LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin,
           c.Cancha AS cancha, t.Torneo AS torneo, j.idJuego,
           el.Equipo AS local, ev.Equipo AS visitante, q.Equipo AS equipo, CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS cliente
      FROM Reserva r
      JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
      JOIN Cancha c ON c.idCancha = r.idCancha
      JOIN Usuario u ON u.idUsuario = r.idUsuario
      LEFT JOIN Equipo q ON q.idEquipo = r.idEquipo
      LEFT JOIN Juego j ON j.idReserva = r.idReserva
      LEFT JOIN Torneo t ON t.idTorneo = j.idTorneo
      LEFT JOIN Equipo el ON el.idEquipo = j.idEquipo_Local
      LEFT JOIN Equipo ev ON ev.idEquipo = j.idEquipo_Visitante
     WHERE r.Fecha_Reserva = @fecha AND e.Estado_Reserva <> 'Cancelada'
     ORDER BY r.Hora_Inicio, c.Cancha;
    ${SELECT_TAREA} WHERE t.Fecha = @fecha ORDER BY t.Hora, t.idTarea_Limpieza;
    ${SELECT_REPORTE} WHERE rp.Estado_Reporte <> 'Resuelto' AND rp.Urgencia = 'Alta'
     ORDER BY rp.Fecha_Reporte DESC OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY;
    SELECT COUNT(*) AS total FROM Reporte_Condicion WHERE Estado_Reporte <> 'Resuelto';
    SELECT c.idCancha AS id, c.Cancha AS nombre, c.Estado_Cancha AS estado FROM Cancha c ORDER BY c.Cancha;`, { fecha });

  res.json({
    fecha, esHoy: fecha === hoy, esAdmin: esAdmin(req), yo: req.usuario.id,
    partidos: partidos.map((p) => ({
      hora: p.hora, fin: p.fin, cancha: p.cancha, folio: p.folio,
      competencia: p.idJuego ? p.torneo : (p.equipo ? 'Amistoso' : 'Reserva'),
      equipos: p.idJuego ? `${p.local} vs. ${p.visitante}` : (p.equipo || p.cliente)
    })),
    tareas,
    urgentes,
    reportesAbiertos: Number(abiertos[0].total),
    canchas,
    personal: await personal(),
    tipos: V.TIPOS_TAREA
  });
}));

/** Para la insignia del menú: reportes urgentes sin resolver. */
router.get('/alertas', asincrono(async (req, res) => {
  const [f] = await consulta(`SELECT COUNT(*) AS total FROM Reporte_Condicion WHERE Estado_Reporte <> 'Resuelto' AND Urgencia = 'Alta'`);
  res.json({ urgentes: Number(f.total) });
}));

/* ------------------------------------------------------------------ */
/*  Tareas                                                             */
/* ------------------------------------------------------------------ */
router.get('/tareas', asincrono(async (req, res) => {
  const condiciones = [];
  const p = {};
  if (FECHA.test(req.query.desde || '')) { p.desde = req.query.desde; condiciones.push('t.Fecha >= @desde'); }
  if (FECHA.test(req.query.hasta || '')) { p.hasta = req.query.hasta; condiciones.push('t.Fecha <= @hasta'); }
  if (V.ESTADOS_TAREA.includes(req.query.estado)) { p.estado = req.query.estado; condiciones.push('t.Estado_Tarea = @estado'); }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const pagina = Math.max(1, Math.min(10000, parseInt(req.query.pagina, 10) || 1));
  const porPagina = 10;
  const [conteo, tareas] = await consulta(`
    SELECT COUNT(*) AS total FROM Tarea_Limpieza t ${where};
    ${SELECT_TAREA} ${where} ORDER BY t.Fecha DESC, t.Hora DESC OFFSET @saltar ROWS FETCH NEXT @tomar ROWS ONLY;`,
  { ...p, tomar: porPagina, saltar: (pagina - 1) * porPagina });
  const total = Number(conteo[0].total);
  res.json({ tareas, total, pagina, paginas: Math.max(1, Math.ceil(total / porPagina)) });
}));

const CAMPOS_TAREA = ['tipo', 'tarea', 'idCancha', 'lugar', 'fecha', 'hora', 'idUsuarioAsignado', 'estado', 'notas'];

router.post('/tareas', contexto('TAREA_CREADA', 'Limpieza', 'Tarea_Limpieza'), soloCampos(CAMPOS_TAREA), asincrono(async (req, res) => {
  const v = V.validarTarea(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);
  const d = v.datos;
  await revisarTarea(d);
  const r = await consulta(`
    INSERT INTO Tarea_Limpieza (Tipo_Tarea, Tarea, idCancha, Lugar, Fecha, Hora, idUsuario_Asignado, Estado_Tarea, Notas,
                                idUsuario_Registro, Fecha_Completada)
    VALUES (@tipo, @tarea, @idCancha, @lugar, @fecha, @hora, @idUsuarioAsignado, @estado, @notas, @yo,
            CASE WHEN @estado = 'Completada' THEN GETDATE() ELSE NULL END)`, { ...d, hora: `${d.hora}:00`, yo: req.usuario.id });
  const t = await tareaPorId(r.insertId);
  await bitacora.registrar(req, {
    accion: 'TAREA_CREADA', modulo: 'Limpieza', tabla: 'Tarea_Limpieza', idRegistro: t.id,
    descripcion: `Programó la tarea "${t.tarea}" en ${lugarDe(t)} el ${t.fecha} a las ${t.hora}` +
      `${t.asignado ? ` (responsable: ${t.asignado})` : ''} · ${t.estado}`,
    despues: { tarea: t.tarea, lugar: lugarDe(t), fecha: t.fecha, hora: t.hora, responsable: t.asignado, estado: t.estado }
  });
  res.status(201).json({ mensaje: 'Tarea agregada.', tarea: t });
}));

router.put('/tareas/:id', contexto('TAREA_EDITADA', 'Limpieza', 'Tarea_Limpieza'), soloCampos(CAMPOS_TAREA), asincrono(async (req, res) => {
  const id = idValido(req.params.id, 'tarea');
  const v = V.validarTarea(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);
  const d = v.datos;
  const antes = await tareaPorId(id);
  if (!antes) throw new ErrorApp(404, 'La tarea no existe.');
  await revisarTarea(d);
  await consulta(`
    UPDATE Tarea_Limpieza SET Tipo_Tarea = @tipo, Tarea = @tarea, idCancha = @idCancha, Lugar = @lugar, Fecha = @fecha, Hora = @hora,
           idUsuario_Asignado = @idUsuarioAsignado, Estado_Tarea = @estado, Notas = @notas,
           Fecha_Completada = CASE WHEN @estado = 'Completada' THEN COALESCE(Fecha_Completada, GETDATE()) ELSE NULL END
     WHERE idTarea_Limpieza = @id`, { ...d, hora: `${d.hora}:00`, id });
  const despues = await tareaPorId(id);
  const campos = (t) => ({ tarea: t.tarea, lugar: lugarDe(t), fecha: t.fecha, hora: t.hora, responsable: t.asignado || '—', estado: t.estado, notas: t.notas });
  const dif = bitacora.diferencias(campos(antes), campos(despues));
  if (dif.campos.length) {
    await bitacora.registrar(req, {
      accion: 'TAREA_EDITADA', modulo: 'Limpieza', tabla: 'Tarea_Limpieza', idRegistro: id,
      descripcion: `Editó la tarea "${antes.tarea}". ` + dif.campos.map((c) => `${c}: "${dif.antes[c] ?? '—'}" → "${dif.despues[c] ?? '—'}"`).join('; '),
      antes: dif.antes, despues: dif.despues
    });
  }
  res.json({ mensaje: dif.campos.length ? 'Tarea actualizada.' : 'No había cambios que guardar.', tarea: despues });
}));

router.post('/tareas/:id/estado', contexto('TAREA_ESTADO', 'Limpieza', 'Tarea_Limpieza'), soloCampos(['estado']), asincrono(async (req, res) => {
  const id = idValido(req.params.id, 'tarea');
  const estado = req.body.estado;
  if (!V.ESTADOS_TAREA.includes(estado)) throw validacionEvadida({ estado: 'Estado no válido.' });
  const antes = await tareaPorId(id);
  if (!antes) throw new ErrorApp(404, 'La tarea no existe.');
  if (antes.estado === estado) return res.json({ mensaje: `La tarea ya estaba "${estado}".`, tarea: antes });
  await consulta(`UPDATE Tarea_Limpieza SET Estado_Tarea = @estado,
                         Fecha_Completada = CASE WHEN @estado = 'Completada' THEN GETDATE() ELSE NULL END
                   WHERE idTarea_Limpieza = @id`, { estado, id });
  await bitacora.registrar(req, {
    accion: 'TAREA_ESTADO', modulo: 'Limpieza', tabla: 'Tarea_Limpieza', idRegistro: id,
    descripcion: `Cambió la tarea "${antes.tarea}" (${lugarDe(antes)}) de "${antes.estado}" a "${estado}"`,
    antes: { estado: antes.estado }, despues: { estado }
  });
  res.json({ mensaje: `Tarea marcada como "${estado}".`, tarea: await tareaPorId(id) });
}));

router.delete('/tareas/:id', contexto('TAREA_ELIMINADA', 'Limpieza', 'Tarea_Limpieza'), soloCampos([]), asincrono(async (req, res) => {
  const id = idValido(req.params.id, 'tarea');
  const t = await tareaPorId(id);
  if (!t) throw new ErrorApp(404, 'La tarea no existe.');
  // El personal solo puede borrar las tareas que él mismo registró
  if (!esAdmin(req) && Number(t.idUsuarioRegistro) !== req.usuario.id) {
    throw new ErrorApp(403, 'Solo puedes eliminar las tareas que tú registraste. Pide a un administrador que la quite.');
  }
  await consulta('DELETE FROM Tarea_Limpieza WHERE idTarea_Limpieza = @id', { id });
  await bitacora.registrar(req, {
    accion: 'TAREA_ELIMINADA', modulo: 'Limpieza', tabla: 'Tarea_Limpieza', idRegistro: id,
    descripcion: `Eliminó la tarea "${t.tarea}" (${lugarDe(t)}, ${t.fecha} ${t.hora})`,
    antes: { tarea: t.tarea, lugar: lugarDe(t), fecha: t.fecha, hora: t.hora, estado: t.estado }
  });
  res.json({ mensaje: 'Tarea eliminada.' });
}));

/* ------------------------------------------------------------------ */
/*  Reportes de condición                                              */
/* ------------------------------------------------------------------ */
router.get('/reportes', asincrono(async (req, res) => {
  const estado = V.ESTADOS_REPORTE.includes(req.query.estado) ? req.query.estado : null;
  const reportes = await consulta(`${SELECT_REPORTE}
     WHERE (@estado IS NULL OR rp.Estado_Reporte = @estado)
     ORDER BY CASE WHEN rp.Estado_Reporte = 'Resuelto' THEN 1 ELSE 0 END,
              CASE rp.Urgencia WHEN 'Alta' THEN 1 WHEN 'Media' THEN 2 WHEN 'Baja' THEN 3 ELSE 0 END, rp.Fecha_Reporte DESC
     OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY`, { estado });
  res.json({ reportes });
}));

router.post('/reportes', contexto('REPORTE_CONDICION', 'Limpieza', 'Reporte_Condicion'),
  soloCampos(['idCancha', 'tipoProblema', 'descripcion', 'urgencia']), asincrono(async (req, res) => {
    const v = V.validarReporteCondicion(req.body);
    if (!v.ok) throw validacionEvadida(v.errores);
    const d = v.datos;
    const [c] = await consulta('SELECT Cancha AS nombre FROM Cancha WHERE idCancha = @idCancha', d);
    if (!c) throw errorValidacion({ idCancha: 'La cancha no existe.' });
    const r = await consulta(`
      INSERT INTO Reporte_Condicion (idCancha, Tipo_Problema, Descripcion, Urgencia, idUsuario_Reporta)
      VALUES (@idCancha, @tipoProblema, @descripcion, @urgencia, @yo)`, { ...d, yo: req.usuario.id });
    await bitacora.registrar(req, {
      accion: 'REPORTE_CONDICION', modulo: 'Limpieza', tabla: 'Reporte_Condicion', idRegistro: r.insertId,
      resultado: d.urgencia === 'Alta' ? 'Fallo' : 'Éxito',
      descripcion: `Reportó en ${c.nombre}: ${d.tipoProblema} (urgencia ${d.urgencia}). ${d.descripcion}`.slice(0, 500),
      despues: { cancha: c.nombre, problema: d.tipoProblema, urgencia: d.urgencia }
    });
    res.status(201).json({
      mensaje: d.urgencia === 'Alta' ? 'Reporte urgente enviado. El administrador ya lo ve como alerta.' : 'Reporte guardado.',
      id: r.insertId
    });
  }));

router.post('/reportes/:id/atender', contexto('REPORTE_ATENDIDO', 'Limpieza', 'Reporte_Condicion'), soloCampos(['estado', 'nota']),
  asincrono(async (req, res) => {
    if (!esAdmin(req)) {
      // [A01] La pantalla del personal no tiene este botón
      return expulsar(req, res, { motivo: 'Personal de limpieza intentó marcar un reporte como atendido (solo administradores)' });
    }
    const id = idValido(req.params.id, 'reporte');
    const v = V.validarAtencionReporte(req.body);
    if (!v.ok) throw validacionEvadida(v.errores);
    const [rp] = await consulta(`${SELECT_REPORTE} WHERE rp.idReporte_Condicion = @id`, { id });
    if (!rp) throw new ErrorApp(404, 'El reporte no existe.');
    if (rp.estado === 'Resuelto') throw new ErrorApp(409, 'Este reporte ya está resuelto.');
    if (rp.estado === v.datos.estado) throw new ErrorApp(409, `El reporte ya está "${rp.estado}".`);
    await consulta(`
      UPDATE Reporte_Condicion SET Estado_Reporte = @estado, Nota_Atencion = COALESCE(@nota, Nota_Atencion),
             idUsuario_Atiende = @yo, Fecha_Atencion = GETDATE()
       WHERE idReporte_Condicion = @id`, { ...v.datos, yo: req.usuario.id, id });
    await bitacora.registrar(req, {
      accion: 'REPORTE_ATENDIDO', modulo: 'Limpieza', tabla: 'Reporte_Condicion', idRegistro: id,
      descripcion: `Marcó "${v.datos.estado}" el reporte de ${rp.cancha}: ${rp.tipoProblema}${v.datos.nota ? `. Nota: ${v.datos.nota}` : ''}`,
      antes: { estado: rp.estado }, despues: { estado: v.datos.estado, nota: v.datos.nota }
    });
    res.json({ mensaje: v.datos.estado === 'Resuelto' ? 'Reporte resuelto.' : 'Reporte marcado en proceso.' });
  }));

module.exports = router;
