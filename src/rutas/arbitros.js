// =====================================================================
//  API de Árbitros (solo administradores)
//  - Partidos programados por semana (cada partido aparta su cancha con una reserva)
//  - Asignación del cuerpo arbitral: Fútbol 7 = 1 central; Fútbol 11 = 4 oficiales
//  - Reasignar a quien rechazó, historial (desde la bitácora) y estadísticas
//  Los árbitros confirman o rechazan desde su cuenta (src/rutas/arbitraje.js).
// =====================================================================
const express = require('express');

const { consulta, transaccion } = require('../../config/db');
const V = require('../../public/js/validacion');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { soloCampos } = require('../seguridad/campos');
const { SQL_ROL } = require('../funciones');
const { idsEstados } = require('../servicios/pagos');
const { ErrorApp, errorValidacion, validacionEvadida, asincrono } = require('../errores');

const router = express.Router();
const POR_PAGINA = 8;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const idValido = (valor, que = 'partido') => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) throw new ErrorApp(400, `Identificador de ${que} no válido.`);
  return n;
};
const dos = (n) => String(n).padStart(2, '0');
const fechaIso = (f) => `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
const aFecha = (iso) => { const [a, m, d] = iso.split('-').map(Number); return new Date(a, m - 1, d); };
const sumarDias = (iso, n) => { const f = aFecha(iso); f.setDate(f.getDate() + n); return fechaIso(f); };
/** Lunes de la semana de una fecha (YYYY-MM-DD). */
function lunesDe(iso) {
  const f = aFecha(iso);
  f.setDate(f.getDate() - ((f.getDay() + 6) % 7));
  return fechaIso(f);
}
const textoFecha = (iso, hora) => {
  const f = aFecha(iso);
  return `${DIAS[f.getDay()]} ${f.getDate()} ${MESES[f.getMonth()]}${hora ? ` · ${hora}` : ''}`;
};
const nombrePuesto = (p) => V.NOMBRES_PUESTO[p] || p;

/* ------------------------------------------------------------------ */
/*  Consultas                                                          */
/* ------------------------------------------------------------------ */
const SELECT_PARTIDO = `
  SELECT j.idJuego, j.Jornada AS jornada, j.Estado_Juego AS estadoJuego,
         CONVERT(CHAR(10), j.Fecha_Juego, 23) AS fecha,
         REPLACE(LEFT(CONVERT(CHAR(8), j.Fecha_Juego, 108), 5), ':', '.') AS horaJuego,
         r.idReserva, r.Folio AS folio, r.idPago,
         LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio, LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin,
         e.Estado_Reserva AS estadoReserva,
         c.idCancha, c.Cancha AS cancha, c.Estado_Cancha AS estadoCancha, tc.idTipo_Cancha AS idTipo, tc.Tipo_Cancha AS superficie,
         t.idTorneo, t.Torneo AS torneo,
         el.idEquipo AS idLocal, el.Equipo AS local, ev.idEquipo AS idVisitante, ev.Equipo AS visitante,
         CASE WHEN j.Fecha_Juego < GETDATE() THEN 1 ELSE 0 END AS yaPaso
    FROM Juego j
    JOIN Cancha c       ON c.idCancha = j.idCancha
    JOIN Tipo_Cancha tc ON tc.idTipo_Cancha = c.idTipo_Cancha
    JOIN Torneo t       ON t.idTorneo = j.idTorneo
    JOIN Equipo el      ON el.idEquipo = j.idEquipo_Local
    JOIN Equipo ev      ON ev.idEquipo = j.idEquipo_Visitante
    LEFT JOIN Reserva r ON r.idReserva = j.idReserva
    LEFT JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva`;

const SELECT_ASIGNACION = `
  SELECT a.idAsignacion_Arbitro AS id, a.idJuego, a.idUsuario, a.Rol_Arbitro AS puesto,
         a.Estado_Asignacion AS estado, a.Motivo_Rechazo AS motivo,
         a.Fecha_Asignacion AS fechaAsignacion, a.Fecha_Respuesta AS fechaRespuesta,
         CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS nombre, u.Correo AS correo
    FROM Asignacion_Arbitro a JOIN Usuario u ON u.idUsuario = a.idUsuario`;

function normalizarPartido(p) {
  const minutos = V.esFutbol11(p.superficie) ? 120 : 60;
  const inicio = p.inicio || String(p.horaJuego || '').replace('.', ':');
  let fin = p.fin;
  if (!fin && V.fechaReal(p.fecha)) {
    const m = V.aMinutos(inicio) + minutos;
    fin = `${dos(Math.floor(m / 60) % 24)}:${dos(m % 60)}`;
  }
  return {
    idJuego: Number(p.idJuego), jornada: Number(p.jornada), estadoJuego: p.estadoJuego,
    fecha: p.fecha, inicio, fin, folio: p.folio || null, idReserva: p.idReserva ? Number(p.idReserva) : null,
    pagado: Boolean(p.idPago), estadoReserva: p.estadoReserva || null,
    idCancha: Number(p.idCancha), cancha: p.cancha, idTipo: Number(p.idTipo), superficie: p.superficie,
    puestos: V.puestosDe(p.superficie),
    idTorneo: Number(p.idTorneo), torneo: p.torneo,
    idLocal: Number(p.idLocal), local: p.local, idVisitante: Number(p.idVisitante), visitante: p.visitante,
    yaPaso: Number(p.yaPaso) === 1
  };
}

/** Estado del cuerpo arbitral de un partido. */
function estadoDe(partido, asignaciones) {
  const activas = asignaciones.filter((a) => partido.puestos.includes(a.puesto));
  if (!asignaciones.length) return 'sin_asignar';
  if (asignaciones.some((a) => a.estado === 'Rechazado')) return 'rechazado';
  if (partido.puestos.some((p) => !activas.some((a) => a.puesto === p))) return 'incompleto';
  if (activas.some((a) => a.estado === 'Pendiente')) return 'pendiente';
  return 'confirmado';
}

async function partidoPorId(idJuego, cx, { bloquear = false } = {}) {
  // bloquear = el partido queda apartado hasta que termine la transacción (como FOR UPDATE en MySQL)
  const select = bloquear ? SELECT_PARTIDO.replace('FROM Juego j', 'FROM Juego j WITH (UPDLOCK, ROWLOCK)') : SELECT_PARTIDO;
  const [p] = await consulta(`${select} WHERE j.idJuego = @idJuego`, { idJuego }, cx);
  return p ? normalizarPartido(p) : null;
}

async function asignacionesDe(ids, cx) {
  if (!ids.length) return [];
  return consulta(`${SELECT_ASIGNACION} WHERE a.idJuego IN (@ids) ORDER BY a.idJuego,
    CASE a.Rol_Arbitro WHEN 'Central' THEN 1 WHEN 'Lateral' THEN 2 WHEN 'Contralateral' THEN 3 WHEN 'Cuarto' THEN 4 ELSE 0 END`, { ids }, cx);
}

async function arbitrosActivos(cx) {
  return consulta(`
    SELECT u.idUsuario AS id, CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS nombre, u.Correo AS correo
      FROM Usuario u JOIN Rol r ON r.idRol = u.idRol
     WHERE u.Estado = 'Activo' AND ${SQL_ROL.arbitro}
     ORDER BY u.Nombre, u.Apellido_Paterno`, {}, cx);
}

/** Árbitros que ya tienen otro partido que se cruza con ese horario: Map idUsuario → texto */
async function ocupados({ fecha, inicio, fin, excluirJuego = 0 }, cx) {
  const filas = await consulta(`
    SELECT a.idUsuario, CONCAT(el.Equipo, ' vs ', ev.Equipo) AS partido,
           LEFT(CONVERT(CHAR(8), r2.Hora_Inicio, 108), 5) AS inicio, LEFT(CONVERT(CHAR(8), r2.Hora_Fin, 108), 5) AS fin
      FROM Asignacion_Arbitro a
      JOIN Juego j2 ON j2.idJuego = a.idJuego
      JOIN Reserva r2 ON r2.idReserva = j2.idReserva
      JOIN Estado_Reserva e2 ON e2.idEstado_Reserva = r2.idEstado_Reserva
      JOIN Equipo el ON el.idEquipo = j2.idEquipo_Local
      JOIN Equipo ev ON ev.idEquipo = j2.idEquipo_Visitante
     WHERE a.Estado_Asignacion <> 'Rechazado' AND j2.idJuego <> @excluirJuego
       AND j2.Estado_Juego <> 'Cancelado' AND e2.Estado_Reserva <> 'Cancelada'
       AND r2.Fecha_Reserva = @fecha AND r2.Hora_Inicio < @fin AND r2.Hora_Fin > @inicio`,
  { fecha, inicio: `${inicio}:00`, fin: `${fin}:00`, excluirJuego }, cx);
  const mapa = new Map();
  for (const f of filas) if (!mapa.has(Number(f.idUsuario))) mapa.set(Number(f.idUsuario), `${f.partido} (${f.inicio}–${f.fin})`);
  return mapa;
}

/** Revisa que cada árbitro elegido sea un árbitro activo y que esté libre a esa hora. */
async function revisarArbitros(datos, partido, cx) {
  const ids = Object.values(datos).filter(Boolean);
  if (!ids.length) return;
  const validos = new Set((await arbitrosActivos(cx)).map((a) => Number(a.id)));
  const ocupado = await ocupados({ fecha: partido.fecha, inicio: partido.inicio, fin: partido.fin, excluirJuego: partido.idJuego || 0 }, cx);
  const errores = {};
  for (const [puesto, id] of Object.entries(datos)) {
    if (!id) continue;
    if (!validos.has(id)) errores[`arb${puesto}`] = 'Ese usuario no es un árbitro activo.';
    else if (ocupado.has(id)) errores[`arb${puesto}`] = `Tiene otro partido a esa hora: ${ocupado.get(id)}.`;
  }
  if (Object.keys(errores).length) throw errorValidacion(errores);
}

/**
 * Deja el cuerpo arbitral del partido igual a `datos` ({ Central: id, ... }).
 * Los árbitros que no cambian conservan su respuesta; los nuevos quedan "Pendiente".
 * @returns {Promise<string[]>} descripción de los cambios
 */
async function aplicarArbitros(cx, partido, datos, nombres, { reiniciar = false } = {}) {
  const actuales = await consulta(`${SELECT_ASIGNACION.replace('FROM Asignacion_Arbitro a', 'FROM Asignacion_Arbitro a WITH (UPDLOCK, HOLDLOCK)')}
     WHERE a.idJuego = @idJuego`, { idJuego: partido.idJuego }, cx);
  const cambios = [];
  const quitar = actuales.filter((a) => !partido.puestos.includes(a.puesto) || Number(a.idUsuario) !== datos[a.puesto]);
  for (const a of quitar) {
    await consulta('DELETE FROM Asignacion_Arbitro WHERE idAsignacion_Arbitro = @id', { id: a.id }, cx);
    if (!datos[a.puesto]) cambios.push(`${nombrePuesto(a.puesto)}: quitó a ${a.nombre}`);
  }
  for (const puesto of partido.puestos) {
    const id = datos[puesto];
    if (!id) continue;
    const sigue = actuales.find((a) => a.puesto === puesto && Number(a.idUsuario) === id);
    if (sigue) {
      if (reiniciar && sigue.estado !== 'Pendiente') {
        await consulta(`UPDATE Asignacion_Arbitro SET Estado_Asignacion = 'Pendiente', Motivo_Rechazo = NULL,
                               Fecha_Respuesta = NULL, Fecha_Asignacion = GETDATE() WHERE idAsignacion_Arbitro = @id`, { id: sigue.id }, cx);
        cambios.push(`${nombrePuesto(puesto)}: ${sigue.nombre} debe volver a confirmar (cambió el horario o la cancha)`);
      }
      continue;
    }
    await consulta(`INSERT INTO Asignacion_Arbitro (idJuego, idUsuario, Rol_Arbitro, Estado_Asignacion)
                    VALUES (@idJuego, @id, @puesto, 'Pendiente')`, { idJuego: partido.idJuego, id, puesto }, cx);
    const previo = actuales.find((a) => a.puesto === puesto);
    cambios.push(previo ? `${nombrePuesto(puesto)}: ${previo.nombre} → ${nombres.get(id) || id}`
      : `${nombrePuesto(puesto)}: ${nombres.get(id) || id}`);
  }
  return cambios;
}

const etiquetaPartido = (p) => `${p.local} vs ${p.visitante} (${textoFecha(p.fecha, p.inicio)}, ${p.cancha})`;

/* ------------------------------------------------------------------ */
/*  Semana: partidos, estadísticas y confirmaciones                    */
/* ------------------------------------------------------------------ */
router.get('/', asincrono(async (req, res) => {
  const hoy = fechaIso(new Date());
  const lunes = lunesDe(FECHA.test(req.query.semana || '') && V.fechaReal(req.query.semana) ? req.query.semana : hoy);
  const domingo = sumarDias(lunes, 6);
  const filtro = ['sin_asignar', 'pendiente', 'confirmado', 'rechazado', 'incompleto'].includes(req.query.estado) ? req.query.estado : null;
  const pagina = Math.max(1, Math.min(1000, parseInt(req.query.pagina, 10) || 1));

  const filas = await consulta(`${SELECT_PARTIDO}
     WHERE j.Fecha_Juego >= @desde AND j.Fecha_Juego < @hasta AND j.Estado_Juego <> 'Cancelado'
     ORDER BY j.Fecha_Juego, c.Cancha`, { desde: lunes, hasta: sumarDias(lunes, 7) });
  const partidos = filas.map(normalizarPartido);
  const asignaciones = await asignacionesDe(partidos.map((p) => p.idJuego));
  for (const p of partidos) {
    p.arbitros = asignaciones.filter((a) => Number(a.idJuego) === p.idJuego).map((a) => ({ ...a, idUsuario: Number(a.idUsuario) }));
    p.estado = estadoDe(p, p.arbitros);
  }

  const contar = (estado) => partidos.filter((p) => p.estado === estado).length;
  const individuales = partidos.flatMap((p) => p.arbitros);
  const conf = {
    confirmado: individuales.filter((a) => a.estado === 'Confirmado').length,
    pendiente: individuales.filter((a) => a.estado === 'Pendiente').length,
    rechazado: individuales.filter((a) => a.estado === 'Rechazado').length
  };
  conf.total = conf.confirmado + conf.pendiente + conf.rechazado;

  const lista = filtro ? partidos.filter((p) => p.estado === filtro) : partidos;
  const total = lista.length;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));

  // Rechazos que necesitan un reemplazo (partidos que aún no se juegan, de cualquier semana)
  const rechazos = await consulta(`
    SELECT TOP (10) a.idAsignacion_Arbitro AS id, a.idJuego, a.idUsuario, a.Rol_Arbitro AS puesto, a.Motivo_Rechazo AS motivo,
           a.Fecha_Respuesta AS fechaRespuesta, CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS nombre,
           CONVERT(CHAR(10), j.Fecha_Juego, 23) AS fecha, LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio,
           c.Cancha AS cancha, tc.Tipo_Cancha AS superficie, el.Equipo AS local, ev.Equipo AS visitante,
           CASE WHEN a.Fecha_Respuesta >= DATEADD(DAY, -1, GETDATE()) THEN 1 ELSE 0 END AS nuevo
      FROM Asignacion_Arbitro a
      JOIN Usuario u ON u.idUsuario = a.idUsuario
      JOIN Juego j ON j.idJuego = a.idJuego
      JOIN Reserva r ON r.idReserva = j.idReserva
      JOIN Cancha c ON c.idCancha = j.idCancha
      JOIN Tipo_Cancha tc ON tc.idTipo_Cancha = c.idTipo_Cancha
      JOIN Equipo el ON el.idEquipo = j.idEquipo_Local
      JOIN Equipo ev ON ev.idEquipo = j.idEquipo_Visitante
     WHERE a.Estado_Asignacion = 'Rechazado' AND j.Fecha_Juego >= GETDATE() AND j.Estado_Juego <> 'Cancelado'
     ORDER BY a.Fecha_Respuesta DESC`);

  const arbitros = await arbitrosActivos();
  res.json({
    semana: { desde: lunes, hasta: domingo, actual: lunesDe(hoy) === lunes },
    resumen: {
      partidos: partidos.length, confirmados: contar('confirmado'), pendientes: contar('pendiente'),
      rechazados: contar('rechazado'), incompletos: contar('incompleto'), sinAsignar: contar('sin_asignar'),
      arbitrosDisponibles: arbitros.length
    },
    confirmaciones: conf,
    partidos: lista.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA),
    todosLosPartidos: partidos.map((p) => ({
      idJuego: p.idJuego, fecha: p.fecha, inicio: p.inicio, fin: p.fin, local: p.local, visitante: p.visitante,
      superficie: p.superficie, puestos: p.puestos, estado: p.estado, yaPaso: p.yaPaso, cancha: p.cancha,
      arbitros: p.arbitros.map((a) => ({ puesto: a.puesto, idUsuario: a.idUsuario, estado: a.estado }))
    })),
    total, pagina, paginas, porPagina: POR_PAGINA,
    rechazos: rechazos.map((r) => ({ ...r, nuevo: Number(r.nuevo) === 1, puestoNombre: nombrePuesto(r.puesto) })),
    arbitros
  });
}));

/* ------------------------------------------------------------------ */
/*  Catálogos para los formularios                                     */
/* ------------------------------------------------------------------ */
router.get('/catalogos', asincrono(async (req, res) => {
  const [torneos, tipos, canchas, equipos] = await consulta(`
    SELECT t.idTorneo AS id, t.Torneo AS nombre, t.idTipo_Cancha AS idTipo, tc.Tipo_Cancha AS tipo,
           CONVERT(CHAR(10), t.Fecha_Inicio, 23) AS fechaInicio, CONVERT(CHAR(10), t.Fecha_Fin, 23) AS fechaFin,
           t.Costo AS costo, t.Estado_Torneo AS estado,
           (SELECT ISNULL(MAX(j.Jornada), 0) FROM Juego j WHERE j.idTorneo = t.idTorneo) AS ultimaJornada
      FROM Torneo t JOIN Tipo_Cancha tc ON tc.idTipo_Cancha = t.idTipo_Cancha
     ORDER BY t.Fecha_Inicio DESC, t.Torneo;
    SELECT idTipo_Cancha AS id, Tipo_Cancha AS nombre FROM Tipo_Cancha ORDER BY Tipo_Cancha;
    SELECT c.idCancha AS id, c.Cancha AS nombre, c.idTipo_Cancha AS idTipo, tc.Tipo_Cancha AS tipo
      FROM Cancha c JOIN Tipo_Cancha tc ON tc.idTipo_Cancha = c.idTipo_Cancha
     WHERE c.Estado_Cancha = 'Activa' ORDER BY c.Cancha;
    SELECT q.idEquipo AS id, q.Equipo AS nombre FROM Equipo q ORDER BY q.Equipo;`);
  res.json({
    torneos: torneos.map((t) => ({ ...t, costo: Number(t.costo), ultimaJornada: Number(t.ultimaJornada) })),
    tipos, canchas, equipos, arbitros: await arbitrosActivos(), duraciones: V.DURACIONES, horarios: V.horarios()
  });
}));

/** Árbitros activos y si están libres a la hora del partido (o de fecha/inicio/fin). */
router.get('/disponibilidad', asincrono(async (req, res) => {
  let horario;
  const idJuego = req.query.idJuego ? idValido(req.query.idJuego) : 0;
  if (req.query.fecha || req.query.inicio || req.query.fin) {
    // Horario que se está eligiendo en el formulario (al editar, sin contar el propio partido)
    const { fecha, inicio, fin } = req.query;
    if (!FECHA.test(fecha || '') || !/^\d{2}:\d{2}$/.test(inicio || '') || !/^\d{2}:\d{2}$/.test(fin || '')) {
      throw new ErrorApp(400, 'Fecha u horario no válido.');
    }
    horario = { fecha, inicio, fin, excluirJuego: idJuego };
  } else if (idJuego) {
    const p = await partidoPorId(idJuego);
    if (!p) throw new ErrorApp(404, 'El partido no existe.');
    horario = { fecha: p.fecha, inicio: p.inicio, fin: p.fin, excluirJuego: p.idJuego };
  } else {
    throw new ErrorApp(400, 'Indica el partido o el horario.');
  }
  const ocupado = await ocupados(horario);
  const lista = (await arbitrosActivos()).map((a) => ({ ...a, id: Number(a.id), libre: !ocupado.has(Number(a.id)), ocupadoEn: ocupado.get(Number(a.id)) || null }));
  res.json({ arbitros: lista, disponibles: lista.filter((a) => a.libre).length });
}));

/* ------------------------------------------------------------------ */
/*  Torneos                                                            */
/* ------------------------------------------------------------------ */
router.post('/torneos', contexto('TORNEO_CREADO', 'Árbitros', 'Torneo'), soloCampos(['nombre', 'idTipo', 'fechaInicio', 'fechaFin', 'costo']),
  asincrono(async (req, res) => {
    const v = V.validarTorneo(req.body);
    if (!v.ok) throw validacionEvadida(v.errores);
    const d = v.datos;
    const [r0] = await consulta(`
      SELECT (SELECT Tipo_Cancha FROM Tipo_Cancha WHERE idTipo_Cancha = @idTipo) AS tipo,
             (SELECT COUNT(*) FROM Torneo WHERE Torneo = @nombre) AS repetido`, d);
    if (!r0.tipo) throw errorValidacion({ idTipo: 'La modalidad no existe.' });
    if (Number(r0.repetido)) throw errorValidacion({ nombre: 'Ya existe un torneo con ese nombre.' });
    const r = await consulta(`
      INSERT INTO Torneo (idTipo_Cancha, Torneo, Fecha_Inicio, Fecha_Fin, Costo, Estado_Torneo)
      VALUES (@idTipo, @nombre, @fechaInicio, @fechaFin, @costo, 'Abierto')`, d);
    await bitacora.registrar(req, {
      accion: 'TORNEO_CREADO', modulo: 'Árbitros', tabla: 'Torneo', idRegistro: r.insertId,
      descripcion: `Creó el torneo "${d.nombre}" (${r0.tipo}) del ${d.fechaInicio} al ${d.fechaFin}`,
      despues: { torneo: d.nombre, modalidad: r0.tipo, inicio: d.fechaInicio, fin: d.fechaFin, costo: d.costo }
    });
    res.status(201).json({ mensaje: `Torneo "${d.nombre}" creado.`, torneo: { id: r.insertId, nombre: d.nombre, idTipo: d.idTipo, tipo: r0.tipo } });
  }));

/* ------------------------------------------------------------------ */
/*  Partidos: programar, editar y eliminar                             */
/* ------------------------------------------------------------------ */

/** Revisa cancha, horario y equipos; aparta (bloquea) la cancha mientras dura la transacción. */
async function revisarHorario(cx, { idCancha, idTipo, fecha, inicio, fin, idLocal, idVisitante, excluirReserva = 0, excluirJuego = 0 }) {
  const [cancha] = await consulta(`
    SELECT c.idCancha, c.Cancha AS nombre, c.Estado_Cancha AS estado, c.idTipo_Cancha AS idTipo, tc.Tipo_Cancha AS tipo
      FROM Cancha c WITH (UPDLOCK, ROWLOCK) JOIN Tipo_Cancha tc ON tc.idTipo_Cancha = c.idTipo_Cancha
     WHERE c.idCancha = @idCancha`, { idCancha }, cx);
  if (!cancha) throw errorValidacion({ idCancha: 'La cancha no existe.' });
  if (cancha.estado !== 'Activa') throw errorValidacion({ idCancha: 'Esta cancha está inactiva.' });
  if (Number(cancha.idTipo) !== Number(idTipo)) {
    throw errorValidacion({ idCancha: `El torneo es de otra modalidad; esta cancha es de ${cancha.tipo}.` });
  }
  const [choque] = await consulta(`
    SELECT TOP (1) r.Folio AS folio, LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio, LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin
      FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
     WHERE r.idCancha = @idCancha AND r.Fecha_Reserva = @fecha AND e.Estado_Reserva <> 'Cancelada'
       AND r.idReserva <> @excluirReserva AND r.Hora_Inicio < @fin AND r.Hora_Fin > @inicio`, { idCancha, fecha, inicio: `${inicio}:00`, fin: `${fin}:00`, excluirReserva }, cx);
  if (choque) throw errorValidacion({ horaInicio: `${cancha.nombre} está ocupada por ${choque.folio} (${choque.inicio}–${choque.fin}).` });

  const [equipo] = await consulta(`
    SELECT TOP (1) IIF(j.idEquipo_Local IN (@idLocal, @idVisitante), el.Equipo, ev.Equipo) AS equipo,
           LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio, LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin
      FROM Juego j
      JOIN Reserva r ON r.idReserva = j.idReserva
      JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
      JOIN Equipo el ON el.idEquipo = j.idEquipo_Local
      JOIN Equipo ev ON ev.idEquipo = j.idEquipo_Visitante
     WHERE j.idJuego <> @excluirJuego AND j.Estado_Juego <> 'Cancelado' AND e.Estado_Reserva <> 'Cancelada'
       AND (j.idEquipo_Local IN (@idLocal, @idVisitante) OR j.idEquipo_Visitante IN (@idLocal, @idVisitante))
       AND r.Fecha_Reserva = @fecha AND r.Hora_Inicio < @fin AND r.Hora_Fin > @inicio`, { idLocal, idVisitante, fecha, inicio: `${inicio}:00`, fin: `${fin}:00`, excluirJuego }, cx);
  if (equipo) throw errorValidacion({ horaInicio: `${equipo.equipo} ya tiene otro partido a esa hora (${equipo.inicio}–${equipo.fin}).` });
  return cancha;
}

async function siguienteFolio(cx) {
  const [sig] = await consulta(`
    SELECT ISNULL(MAX(TRY_CAST(SUBSTRING(Folio, 5, 20) AS INT)), 0) + 1 AS siguiente
      FROM Reserva WITH (UPDLOCK, HOLDLOCK) WHERE Folio LIKE 'RES-%'`, {}, cx);
  return `RES-${String(sig.siguiente).padStart(5, '0')}`;
}

const CAMPOS_PARTIDO = ['idTorneo', 'jornada', 'idLocal', 'idVisitante', 'idCancha', 'fecha', 'horaInicio', 'duracion', 'arbitros'];
const CAMPOS_EDITAR = ['jornada', 'idCancha', 'fecha', 'horaInicio', 'duracion', 'arbitros'];

router.post('/partidos', contexto('PARTIDO_PROGRAMADO', 'Árbitros', 'Juego'), soloCampos(CAMPOS_PARTIDO), asincrono(async (req, res) => {
  const v = V.validarPartido(req.body, { nuevo: true });
  if (!v.ok) throw validacionEvadida(v.errores);
  const d = v.datos;

  let resultado;
  for (let intento = 1; ; intento++) {
    try {
      resultado = await transaccion(async (cx) => {
        const [t] = await consulta(`
          SELECT t.idTorneo, t.Torneo AS nombre, t.idTipo_Cancha AS idTipo, tc.Tipo_Cancha AS tipo, t.Estado_Torneo AS estado,
                 CONVERT(CHAR(10), t.Fecha_Inicio, 23) AS inicio, CONVERT(CHAR(10), t.Fecha_Fin, 23) AS fin
            FROM Torneo t JOIN Tipo_Cancha tc ON tc.idTipo_Cancha = t.idTipo_Cancha WHERE t.idTorneo = @idTorneo`, d, cx);
        if (!t) throw errorValidacion({ idTorneo: 'El torneo no existe.' });
        if (/finaliz|cancel|cerrad/i.test(t.estado)) throw errorValidacion({ idTorneo: `El torneo está ${t.estado.toLowerCase()}.` });
        if (d.fecha < t.inicio || d.fecha > t.fin) {
          throw errorValidacion({ fecha: `El torneo se juega del ${t.inicio} al ${t.fin}.` });
        }
        const equipos = await consulta('SELECT idEquipo, Equipo AS nombre, idUsuario FROM Equipo WHERE idEquipo IN (@ids)',
          { ids: [d.idLocal, d.idVisitante] }, cx);
        const local = equipos.find((q) => Number(q.idEquipo) === d.idLocal);
        const visitante = equipos.find((q) => Number(q.idEquipo) === d.idVisitante);
        if (!local) throw errorValidacion({ idLocal: 'El equipo no existe.' });
        if (!visitante) throw errorValidacion({ idVisitante: 'El equipo no existe.' });

        const cancha = await revisarHorario(cx, { ...d, idTipo: t.idTipo, inicio: d.horaInicio, fin: d.horaFin });
        const puestos = V.puestosDe(t.tipo);
        const va = V.validarArbitros(req.body.arbitros, puestos, { completos: false });
        if (!va.ok) throw validacionEvadida(va.errores);

        const estados = await idsEstados(cx);
        const folio = await siguienteFolio(cx);
        const descripcion = `${t.nombre} · Jornada ${d.jornada} · ${local.nombre} vs ${visitante.nombre}`.slice(0, 255);
        const rv = await consulta(`
          INSERT INTO Reserva (idUsuario, idEquipo, idPago, idCancha, idEstado_Reserva, Folio, Fecha_Reserva, Hora_Inicio, Hora_Fin, Descripcion)
          VALUES (@idUsuario, @idEquipo, NULL, @idCancha, @idEstado, @folio, @fecha, @inicio, @fin, @descripcion)`, {
          idUsuario: local.idUsuario, idEquipo: local.idEquipo, idCancha: d.idCancha, idEstado: estados.Pendiente, folio,
          fecha: d.fecha, inicio: `${d.horaInicio}:00`, fin: `${d.horaFin}:00`, descripcion
        }, cx);
        const jg = await consulta(`
          INSERT INTO Juego (idCancha, idEquipo_Visitante, idEquipo_Local, idTorneo, idReserva, Jornada, Estado_Juego, Fecha_Juego)
          VALUES (@idCancha, @idVisitante, @idLocal, @idTorneo, @idReserva, @jornada, 'Programado', @fechaJuego)`, {
          ...d, idReserva: rv.insertId, fechaJuego: `${d.fecha} ${d.horaInicio}:00`
        }, cx);

        const partido = await partidoPorId(jg.insertId, cx);
        let cambios = [];
        if (Object.values(va.datos).some(Boolean)) {
          await revisarArbitros(va.datos, partido, cx);
          const nombres = new Map((await arbitrosActivos(cx)).map((a) => [Number(a.id), a.nombre]));
          cambios = await aplicarArbitros(cx, partido, va.datos, nombres);
        }
        return { partido, cancha, cambios };
      });
      break;
    } catch (err) {
      if (err && err.errno === 1062 && /folio|RES-/i.test(err.message) && intento < 3) continue;
      throw err;
    }
  }

  const p = resultado.partido;
  await bitacora.registrar(req, {
    accion: 'PARTIDO_PROGRAMADO', modulo: 'Árbitros', tabla: 'Juego', idRegistro: p.idJuego,
    descripcion: `Programó ${p.torneo} · Jornada ${p.jornada}: ${etiquetaPartido(p)}. Reserva ${p.folio}` +
      (resultado.cambios.length ? `. Árbitros: ${resultado.cambios.join('; ')}` : ''),
    despues: { partido: `${p.local} vs ${p.visitante}`, torneo: p.torneo, fecha: p.fecha, horario: `${p.inicio}-${p.fin}`, cancha: p.cancha, folio: p.folio }
  });
  res.status(201).json({ mensaje: `Partido programado. Se apartó ${p.cancha} con la reserva ${p.folio}.`, partido: p });
}));

router.get('/partidos/:id', asincrono(async (req, res) => {
  const p = await partidoPorId(idValido(req.params.id));
  if (!p) throw new ErrorApp(404, 'El partido no existe.');
  p.arbitros = (await asignacionesDe([p.idJuego])).map((a) => ({ ...a, idUsuario: Number(a.idUsuario) }));
  p.estado = estadoDe(p, p.arbitros);
  res.json({ partido: p });
}));

router.put('/partidos/:id', contexto('PARTIDO_EDITADO', 'Árbitros', 'Juego'), soloCampos(CAMPOS_EDITAR), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const v = V.validarPartido(req.body, { nuevo: false });
  if (!v.ok) throw validacionEvadida(v.errores);
  const d = v.datos;

  const { antes, despues, cambios } = await transaccion(async (cx) => {
    const antes = await partidoPorId(id, cx, { bloquear: true });
    if (!antes) throw new ErrorApp(404, 'El partido no existe.');
    if (antes.yaPaso) throw new ErrorApp(409, 'Este partido ya se jugó; se conserva como historial y no se puede editar.');
    const [t] = await consulta(`SELECT CONVERT(CHAR(10), Fecha_Inicio, 23) AS inicio, CONVERT(CHAR(10), Fecha_Fin, 23) AS fin
                                  FROM Torneo WHERE idTorneo = @idTorneo`, { idTorneo: antes.idTorneo }, cx);
    if (d.fecha < t.inicio || d.fecha > t.fin) throw errorValidacion({ fecha: `El torneo se juega del ${t.inicio} al ${t.fin}.` });

    await revisarHorario(cx, {
      idCancha: d.idCancha, idTipo: antes.idTipo, fecha: d.fecha, inicio: d.horaInicio, fin: d.horaFin,
      idLocal: antes.idLocal, idVisitante: antes.idVisitante, excluirReserva: antes.idReserva || 0, excluirJuego: id
    });
    // Si no se mandan árbitros, se conservan los que ya tenía el partido
    const actuales = await asignacionesDe([id], cx);
    const pedidos = req.body.arbitros === undefined
      ? Object.fromEntries(actuales.map((a) => [a.puesto, Number(a.idUsuario)]).filter(([p]) => antes.puestos.includes(p)))
      : req.body.arbitros;
    const va = V.validarArbitros(pedidos, antes.puestos, { completos: false });
    if (!va.ok) throw validacionEvadida(va.errores);

    const cambioHorario = antes.fecha !== d.fecha || antes.inicio !== d.horaInicio || antes.fin !== d.horaFin || antes.idCancha !== d.idCancha;
    await consulta(`UPDATE Juego SET Jornada = @jornada, idCancha = @idCancha, Fecha_Juego = @fechaJuego WHERE idJuego = @id`,
      { jornada: d.jornada, idCancha: d.idCancha, fechaJuego: `${d.fecha} ${d.horaInicio}:00`, id }, cx);
    if (antes.idReserva) {
      await consulta(`UPDATE Reserva SET idCancha = @idCancha, Fecha_Reserva = @fecha, Hora_Inicio = @inicio, Hora_Fin = @fin,
                             Descripcion = @descripcion WHERE idReserva = @idReserva`, {
        idCancha: d.idCancha, fecha: d.fecha, inicio: `${d.horaInicio}:00`, fin: `${d.horaFin}:00`, idReserva: antes.idReserva,
        descripcion: `${antes.torneo} · Jornada ${d.jornada} · ${antes.local} vs ${antes.visitante}`.slice(0, 255)
      }, cx);
    }
    const despues = await partidoPorId(id, cx);
    await revisarArbitros(va.datos, despues, cx);
    const nombres = new Map((await arbitrosActivos(cx)).map((a) => [Number(a.id), a.nombre]));
    const cambios = await aplicarArbitros(cx, despues, va.datos, nombres, { reiniciar: cambioHorario });
    return { antes, despues, cambios };
  });

  const resumen = (p) => ({ jornada: p.jornada, cancha: p.cancha, fecha: p.fecha, horario: `${p.inicio}-${p.fin}` });
  const dif = bitacora.diferencias(resumen(antes), resumen(despues));
  if (dif.campos.length || cambios.length) {
    await bitacora.registrar(req, {
      accion: 'PARTIDO_EDITADO', modulo: 'Árbitros', tabla: 'Juego', idRegistro: id,
      descripcion: `Editó ${despues.local} vs ${despues.visitante}. ` +
        [...dif.campos.map((c) => `${c}: "${dif.antes[c]}" → "${dif.despues[c]}"`), ...cambios].join('; ').slice(0, 420),
      antes: dif.antes, despues: { ...dif.despues, arbitros: cambios }
    });
  }
  res.json({ mensaje: dif.campos.length || cambios.length ? 'Partido actualizado.' : 'No había cambios que guardar.', partido: despues });
}));

/** Eliminar: solo los árbitros (modo "arbitros") o el partido completo con su reserva (modo "partido"). */
router.delete('/partidos/:id', contexto('PARTIDO_ELIMINADO', 'Árbitros', 'Juego'), soloCampos([]), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const modo = req.query.modo === 'partido' ? 'partido' : 'arbitros';
  const { partido, quitados } = await transaccion(async (cx) => {
    const partido = await partidoPorId(id, cx, { bloquear: true });
    if (!partido) throw new ErrorApp(404, 'El partido no existe.');
    if (partido.yaPaso) throw new ErrorApp(409, 'Este partido ya se jugó; se conserva como historial.');
    const quitados = await consulta(`${SELECT_ASIGNACION} WHERE a.idJuego = @id`, { id }, cx);
    if (modo === 'partido' && partido.pagado) {
      throw new ErrorApp(409, `No se puede eliminar: la reserva ${partido.folio} ya tiene un pago registrado. ` +
        'Quita solo los árbitros o revisa el pago en Pagos.');
    }
    await consulta('DELETE FROM Asignacion_Arbitro WHERE idJuego = @id', { id }, cx);
    if (modo === 'partido') {
      await consulta('DELETE FROM Juego WHERE idJuego = @id', { id }, cx);
      if (partido.idReserva) await consulta('DELETE FROM Reserva WHERE idReserva = @idReserva AND idPago IS NULL', { idReserva: partido.idReserva }, cx);
    }
    return { partido, quitados };
  });

  const lista = quitados.map((a) => `${nombrePuesto(a.puesto)}: ${a.nombre}`);
  if (modo === 'partido') {
    await bitacora.registrar(req, {
      accion: 'PARTIDO_ELIMINADO', modulo: 'Árbitros', tabla: 'Juego', idRegistro: id,
      descripcion: `Eliminó el partido ${etiquetaPartido(partido)} y liberó la reserva ${partido.folio}` +
        (lista.length ? `. Árbitros quitados: ${lista.join('; ')}` : ''),
      antes: { partido: `${partido.local} vs ${partido.visitante}`, torneo: partido.torneo, fecha: partido.fecha, folio: partido.folio, arbitros: lista }
    });
    return res.json({ mensaje: `Partido eliminado. ${partido.cancha} quedó libre (${partido.folio}).` });
  }
  if (!quitados.length) throw new ErrorApp(409, 'Este partido no tiene árbitros asignados.');
  await bitacora.registrar(req, {
    accion: 'ASIGNACION_ELIMINADA', modulo: 'Árbitros', tabla: 'Asignacion_Arbitro', idRegistro: id,
    descripcion: `Quitó el cuerpo arbitral de ${etiquetaPartido(partido)}: ${lista.join('; ')}`,
    antes: { arbitros: lista }
  });
  res.json({ mensaje: 'Se quitaron los árbitros del partido.' });
}));

/* ------------------------------------------------------------------ */
/*  Asignar / reasignar                                                */
/* ------------------------------------------------------------------ */
router.put('/partidos/:id/arbitros', contexto('ARBITROS_ASIGNADOS', 'Árbitros', 'Asignacion_Arbitro'), soloCampos(['arbitros']),
  asincrono(async (req, res) => {
    const id = idValido(req.params.id);
    const { partido, cambios } = await transaccion(async (cx) => {
      const partido = await partidoPorId(id, cx, { bloquear: true });
      if (!partido) throw new ErrorApp(404, 'El partido no existe.');
      if (partido.yaPaso) throw new ErrorApp(409, 'Este partido ya se jugó.');
      const v = V.validarArbitros(req.body.arbitros, partido.puestos, { completos: true });
      if (!v.ok) throw validacionEvadida(v.errores);
      await revisarArbitros(v.datos, partido, cx);
      const nombres = new Map((await arbitrosActivos(cx)).map((a) => [Number(a.id), a.nombre]));
      return { partido, cambios: await aplicarArbitros(cx, partido, v.datos, nombres) };
    });
    if (!cambios.length) return res.json({ mensaje: 'El cuerpo arbitral ya estaba así; no hubo cambios.' });
    await bitacora.registrar(req, {
      accion: 'ARBITROS_ASIGNADOS', modulo: 'Árbitros', tabla: 'Asignacion_Arbitro', idRegistro: id,
      descripcion: `Asignó árbitros a ${etiquetaPartido(partido)}: ${cambios.join('; ')}`.slice(0, 500),
      despues: { partido: `${partido.local} vs ${partido.visitante}`, fecha: partido.fecha, cambios }
    });
    res.json({ mensaje: `Árbitros asignados a ${partido.local} vs ${partido.visitante}. Cada uno debe confirmar desde su cuenta.` });
  }));

router.post('/asignaciones/:id/reasignar', contexto('ARBITRO_REASIGNADO', 'Árbitros', 'Asignacion_Arbitro'), soloCampos(['idUsuario']),
  asincrono(async (req, res) => {
    const id = idValido(req.params.id, 'asignación');
    const idUsuario = Number(req.body.idUsuario);
    if (!Number.isInteger(idUsuario) || idUsuario < 1) throw validacionEvadida({ idUsuario: 'Selecciona al árbitro.' });

    const { asignacion, partido, nuevo } = await transaccion(async (cx) => {
      const [asignacion] = await consulta(`${SELECT_ASIGNACION.replace('FROM Asignacion_Arbitro a', 'FROM Asignacion_Arbitro a WITH (UPDLOCK, ROWLOCK)')}
         WHERE a.idAsignacion_Arbitro = @id`, { id }, cx);
      if (!asignacion) throw new ErrorApp(404, 'La asignación no existe.');
      const partido = await partidoPorId(asignacion.idJuego, cx, { bloquear: true });
      if (partido.yaPaso) throw new ErrorApp(409, 'Ese partido ya se jugó.');
      if (Number(asignacion.idUsuario) === idUsuario) throw errorValidacion({ idUsuario: 'Elige a un árbitro distinto.' });
      const [enPartido] = await consulta('SELECT Rol_Arbitro AS puesto FROM Asignacion_Arbitro WHERE idJuego = @idJuego AND idUsuario = @idUsuario',
        { idJuego: partido.idJuego, idUsuario }, cx);
      if (enPartido) throw errorValidacion({ idUsuario: `Ya está en este partido como ${nombrePuesto(enPartido.puesto)}.` });
      try {
        await revisarArbitros({ X: idUsuario }, partido, cx);
      } catch (err) {
        if (err.extra && err.extra.errores) throw errorValidacion({ idUsuario: err.extra.errores.arbX });
        throw err;
      }
      await consulta(`UPDATE Asignacion_Arbitro SET idUsuario = @idUsuario, Estado_Asignacion = 'Pendiente', Motivo_Rechazo = NULL,
                             Fecha_Respuesta = NULL, Fecha_Asignacion = GETDATE() WHERE idAsignacion_Arbitro = @id`, { idUsuario, id }, cx);
      const [nuevo] = await consulta("SELECT CONCAT(Nombre, ' ', Apellido_Paterno) AS nombre FROM Usuario WHERE idUsuario = @idUsuario", { idUsuario }, cx);
      return { asignacion, partido, nuevo };
    });

    await bitacora.registrar(req, {
      accion: 'ARBITRO_REASIGNADO', modulo: 'Árbitros', tabla: 'Asignacion_Arbitro', idRegistro: id,
      descripcion: `Reasignó ${nombrePuesto(asignacion.puesto)} de ${etiquetaPartido(partido)}: ${asignacion.nombre}` +
        `${asignacion.estado === 'Rechazado' ? ` (rechazó: ${asignacion.motivo || 'sin motivo'})` : ''} → ${nuevo.nombre}`.slice(0, 480),
      antes: { arbitro: asignacion.nombre, estado: asignacion.estado, motivo: asignacion.motivo },
      despues: { arbitro: nuevo.nombre, estado: 'Pendiente', puesto: nombrePuesto(asignacion.puesto) }
    });
    res.json({ mensaje: `${nuevo.nombre} quedó como ${nombrePuesto(asignacion.puesto)}. Debe confirmar desde su cuenta.` });
  }));

/* ------------------------------------------------------------------ */
/*  Historial (sale de la bitácora: nada se puede borrar ni alterar)   */
/* ------------------------------------------------------------------ */
const GRUPOS_HISTORIAL = {
  respuestas: ['ASIGNACION_CONFIRMADA', 'ASIGNACION_RECHAZADA'],
  asignaciones: ['ARBITROS_ASIGNADOS', 'ARBITRO_REASIGNADO', 'ASIGNACION_ELIMINADA'],
  partidos: ['PARTIDO_PROGRAMADO', 'PARTIDO_EDITADO', 'PARTIDO_ELIMINADO', 'TORNEO_CREADO']
};
const TODAS_HISTORIAL = Object.values(GRUPOS_HISTORIAL).flat();

router.get('/historial', asincrono(async (req, res) => {
  const acciones = GRUPOS_HISTORIAL[req.query.tipo] || TODAS_HISTORIAL;
  const pagina = Math.max(1, Math.min(1000, parseInt(req.query.pagina, 10) || 1));
  const porPagina = 10;
  const [conteo, filas] = await consulta(`
    SELECT COUNT(*) AS total FROM Bitacora WHERE Accion IN (@acciones) AND Resultado = 'Éxito';
    SELECT b.idBitacora, b.Fecha, b.Accion, b.Descripcion, b.Resultado,
           COALESCE(u.Nombre + ' ' + u.Apellido_Paterno, b.Correo_Usuario, 'Sistema') AS usuario, b.Rol_Usuario AS rol
      FROM Bitacora b LEFT JOIN Usuario u ON u.idUsuario = b.idUsuario
     WHERE b.Accion IN (@acciones) AND b.Resultado = 'Éxito'
     ORDER BY b.idBitacora DESC OFFSET @saltar ROWS FETCH NEXT @tomar ROWS ONLY;`,
  { acciones, tomar: porPagina, saltar: (pagina - 1) * porPagina });
  const total = Number(conteo[0].total);
  res.json({ registros: filas, total, pagina, paginas: Math.max(1, Math.ceil(total / porPagina)) });
}));

module.exports = router;
module.exports.estadoDe = estadoDe;
module.exports.lunesDe = lunesDe;
module.exports.textoFecha = textoFecha;
