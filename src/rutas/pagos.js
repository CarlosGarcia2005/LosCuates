// =====================================================================
//  API de Pagos (solo administradores)
//  Todos los cobros del deportivo: los de Reservas y los de partidos de torneo.
//  La reserva (folio RES-xxxxx) siempre es automática: la de la reserva o la
//  que apartó la cancha para el partido. Aquí no se escribe a mano.
//    GET  /?fecha&q&estado&todos&pagina   indicadores + movimientos + comprobantes por revisar
//    GET  /catalogos                      torneos con juegos sin pagar y métodos de pago
//    POST /                               registrar el pago de un juego (Torneo → Juego)
//    POST /:id/validar  ·  POST /:id/discrepancia  ·  GET|PUT /:id/comprobante  ·  GET /exportar
// =====================================================================
const express = require('express');

const { consulta, transaccion } = require('../../config/db');
const V = require('../../public/js/validacion');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { soloCampos } = require('../seguridad/campos');
const P = require('../servicios/pagos');
const { ErrorApp, errorValidacion, validacionEvadida, asincrono } = require('../errores');

const router = express.Router();
const POR_PAGINA = 8;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const TAMANO_MAXIMO = 5 * 1024 * 1024;

const dos = (n) => String(n).padStart(2, '0');
const fechaIso = (f) => `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
const sumarDias = (iso, n) => { const [a, m, d] = iso.split('-').map(Number); return fechaIso(new Date(a, m - 1, d + n)); };
// En SQL Server los comodines de LIKE se vuelven texto normal encerrándolos en corchetes: % → [%]
const escaparLike = (t) => t.replace(/[[%_]/g, (c) => `[${c}]`);
const variacion = (hoy, ayer) => (ayer > 0 ? Math.round(((hoy - ayer) / ayer) * 100) : null);

const idValido = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) throw new ErrorApp(400, 'Identificador de pago no válido.');
  return n;
};

/** Pagos de reservas canceladas no se cuentan como "por validar". */
const NO_CANCELADA = "(e.Estado_Reserva IS NULL OR e.Estado_Reserva <> 'Cancelada')";

function filtrosLista(query, dia) {
  const condiciones = [];
  const p = {};
  if (query.todos !== '1') {
    p.desde = dia; p.hastaSig = sumarDias(dia, 1);
    condiciones.push('p.Fecha_Pago >= @desde AND p.Fecha_Pago < @hastaSig');
  }
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 60) : '';
  if (q) {
    p.texto = `%${escaparLike(q)}%`;
    condiciones.push(`(r.Folio LIKE @texto OR (u.Nombre + ' ' + u.Apellido_Paterno) LIKE @texto OR q.Equipo LIKE @texto
                       OR p.Referencia LIKE @texto OR (ui.Nombre + ' ' + ui.Apellido_Paterno) LIKE @texto OR qi.Equipo LIKE @texto)`);
  }
  if (P.ESTADOS_PAGO.includes(query.estado)) { p.estado = query.estado; condiciones.push('p.Estado_Pago = @estado'); }
  return { where: condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '', parametros: p };
}

/* ------------------------------------------------------------------ */
router.get('/', asincrono(async (req, res) => {
  const hoy = fechaIso(new Date());
  const dia = FECHA.test(req.query.fecha || '') && V.fechaReal(req.query.fecha) ? req.query.fecha : hoy;
  const ayer = sumarDias(dia, -1);
  const manana = sumarDias(dia, 1);
  const pagina = Math.max(1, Math.min(10000, parseInt(req.query.pagina, 10) || 1));
  const { where, parametros } = filtrosLista(req.query, dia);
  const ingreso = (desde, hasta) => `
    (SELECT ISNULL(SUM(p.Monto), 0) FROM Pago p
       LEFT JOIN Reserva r ON r.idPago = p.idPago LEFT JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
      WHERE p.Fecha_Pago >= ${desde} AND p.Fecha_Pago < ${hasta} AND ${P.SQL_INGRESO})`;

  // pendientesPago usa el mismo criterio que Reservas → "Pendientes de pago" (reservas pendientes sin pago)
  const [kpis, conteo, registros, comprobantes] = await consulta(`
    SELECT
      (SELECT COUNT(*) FROM Pago WHERE Fecha_Pago >= @dia AND Fecha_Pago < @manana) AS pagosDia,
      (SELECT COUNT(*) FROM Pago WHERE Fecha_Pago >= @ayer AND Fecha_Pago < @dia) AS pagosAyer,
      ${ingreso('@dia', '@manana')} AS ingresosDia,
      ${ingreso('@ayer', '@dia')} AS ingresosAyer,
      (SELECT COUNT(*) FROM Pago p LEFT JOIN Reserva r ON r.idPago = p.idPago
         LEFT JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE p.Estado_Pago IN ('Pendiente', 'Con discrepancia') AND ${NO_CANCELADA}) AS porValidar,
      (SELECT COUNT(*) FROM Pago p LEFT JOIN Reserva r ON r.idPago = p.idPago
         LEFT JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE p.Estado_Pago = 'Con discrepancia' AND ${NO_CANCELADA}) AS conDiscrepancia,
      (SELECT COUNT(*) FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE r.idPago IS NULL AND e.Estado_Reserva = 'Pendiente') AS pendientesPago;
    SELECT COUNT(*) AS total ${P.SELECT_PAGO.slice(P.SELECT_PAGO.indexOf('FROM Pago p'))} ${where};
    ${P.SELECT_PAGO} ${where}
     ORDER BY p.Fecha_Pago DESC, p.idPago DESC
     OFFSET @saltar ROWS FETCH NEXT @tomar ROWS ONLY;
    ${P.SELECT_PAGO}
     WHERE p.Estado_Pago = 'Pendiente' AND p.Comprobante IS NOT NULL AND ${NO_CANCELADA}
     ORDER BY p.Fecha_Pago
     OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY;`,
  { ...parametros, dia, ayer, manana, tomar: POR_PAGINA, saltar: (pagina - 1) * POR_PAGINA });

  const k = Object.fromEntries(Object.entries(kpis[0]).map(([c, v]) => [c, Number(v)]));
  const total = Number(conteo[0].total);
  res.json({
    fecha: dia, esHoy: dia === hoy, todos: req.query.todos === '1',
    indicadores: {
      pagosDia: k.pagosDia, pagosVariacion: variacion(k.pagosDia, k.pagosAyer),
      ingresosDia: k.ingresosDia, ingresosVariacion: variacion(k.ingresosDia, k.ingresosAyer),
      porValidar: k.porValidar, conDiscrepancia: k.conDiscrepancia, requierenRevision: comprobantes.length,
      pendientesPago: k.pendientesPago
    },
    total, pagina, porPagina: POR_PAGINA, paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
    registros: registros.map(P.normalizarPago),
    comprobantes: comprobantes.map(P.normalizarPago)
  });
}));

/** Torneos que tienen juegos con la reserva aún sin pagar, y métodos de pago. */
router.get('/catalogos', asincrono(async (req, res) => {
  const [juegos, metodos] = await consulta(`
    SELECT t.idTorneo, t.Torneo AS torneo, j.idJuego, j.Jornada AS jornada,
           CONVERT(CHAR(10), j.Fecha_Juego, 23) AS fecha, LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio,
           LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin, r.idReserva, r.Folio AS folio, c.Cancha AS cancha,
           el.Equipo AS local, ev.Equipo AS visitante, u.Nombre + ' ' + u.Apellido_Paterno AS cliente
      FROM Juego j
      JOIN Torneo t ON t.idTorneo = j.idTorneo
      JOIN Reserva r ON r.idReserva = j.idReserva
      JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
      JOIN Usuario u ON u.idUsuario = r.idUsuario
      JOIN Cancha c ON c.idCancha = r.idCancha
      JOIN Equipo el ON el.idEquipo = j.idEquipo_Local
      JOIN Equipo ev ON ev.idEquipo = j.idEquipo_Visitante
     WHERE r.idPago IS NULL AND e.Estado_Reserva = 'Pendiente' AND j.Estado_Juego <> 'Cancelado'
     ORDER BY t.Torneo, j.Fecha_Juego;
    SELECT idMetodo_Pago AS id, Metodo_Pago AS nombre FROM Metodo_Pago ORDER BY idMetodo_Pago;`);
  const torneos = [];
  for (const j of juegos) {
    let t = torneos.find((x) => x.id === Number(j.idTorneo));
    if (!t) torneos.push(t = { id: Number(j.idTorneo), nombre: j.torneo, juegos: [] });
    t.juegos.push({ ...j, idJuego: Number(j.idJuego), idReserva: Number(j.idReserva) });
  }
  res.json({ torneos, metodos });
}));

/* ------------------------------------------------------------------ */
/*  Registrar el pago de un juego de torneo                            */
/* ------------------------------------------------------------------ */
router.post('/', contexto('PAGO_REGISTRADO', 'Pagos', 'Pago'), soloCampos(['idTorneo', 'idJuego', 'monto', 'idMetodoPago', 'referencia']),
  asincrono(async (req, res) => {
    const v = V.validarPagoJuego(req.body);
    if (!v.ok) throw validacionEvadida(v.errores);
    const d = v.datos;

    const { juego, pago } = await transaccion(async (cx) => {
      const [juego] = await consulta(`
        SELECT j.idJuego, j.idTorneo, j.idReserva, r.Folio AS folio, t.Torneo AS torneo,
               el.Equipo AS local, ev.Equipo AS visitante
          FROM Juego j JOIN Torneo t ON t.idTorneo = j.idTorneo
          LEFT JOIN Reserva r ON r.idReserva = j.idReserva
          JOIN Equipo el ON el.idEquipo = j.idEquipo_Local
          JOIN Equipo ev ON ev.idEquipo = j.idEquipo_Visitante
         WHERE j.idJuego = @idJuego`, d, cx);
      if (!juego) throw errorValidacion({ idJuego: 'El juego no existe.' });
      if (Number(juego.idTorneo) !== d.idTorneo) throw validacionEvadida({ idJuego: 'Ese juego no pertenece al torneo elegido.' });
      if (!juego.idReserva) throw errorValidacion({ idJuego: 'Este juego no tiene reserva. Ejecuta sql/05_modulos_deportivos.sql.' });
      const pago = await P.pagarReserva(cx, Number(juego.idReserva), d);
      return { juego, pago };
    });

    const detalle = await P.pagoPorId(pago.idPago);
    await bitacora.registrar(req, {
      accion: 'PAGO_REGISTRADO', modulo: 'Pagos', tabla: 'Pago', idRegistro: pago.idPago,
      descripcion: `Registró un pago de ${P.dinero(d.monto)} (${pago.metodo}) del partido ${juego.local} vs ${juego.visitante} ` +
        `(${juego.torneo}), reserva ${juego.folio}${d.referencia ? `, referencia ${d.referencia}` : ''}` +
        (pago.estadoPago === 'Pagado' ? '. Reserva confirmada.' : '. Queda por validar.'),
      despues: { folio: juego.folio, monto: d.monto, metodo: pago.metodo, estado: pago.estadoPago, referencia: d.referencia }
    });
    res.status(201).json({
      mensaje: pago.estadoPago === 'Pagado' ? `Pago registrado. ${juego.folio} quedó pagada.`
        : `Pago registrado. ${juego.folio} queda por validar: sube o revisa el comprobante.`,
      pago: detalle
    });
  }));

/* ------------------------------------------------------------------ */
/*  Validar o marcar con discrepancia                                  */
/* ------------------------------------------------------------------ */
router.post('/:id/validar', contexto('PAGO_VALIDADO', 'Pagos', 'Pago'), soloCampos([]), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const { anterior } = await transaccion((cx) => P.validarPago(cx, id));
  const p = await P.pagoPorId(id);
  await bitacora.registrar(req, {
    accion: 'PAGO_VALIDADO', modulo: 'Pagos', tabla: 'Pago', idRegistro: id,
    descripcion: `Validó el pago de ${P.dinero(p.monto)} (${p.metodo}) de ${p.cliente}` +
      `${p.folio ? ` · ${p.folio} quedó confirmada` : ''}${anterior === 'Con discrepancia' ? ' (tenía discrepancia)' : ''}`,
    antes: { estado: anterior }, despues: { estado: 'Validado', folio: p.folio }
  });
  res.json({ mensaje: `Pago validado${p.folio ? `. ${p.folio} quedó confirmada` : ''}.`, pago: p });
}));

router.post('/:id/discrepancia', contexto('PAGO_DISCREPANCIA', 'Pagos', 'Pago'), soloCampos(['nota']), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const v = V.validarNotaRevision(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);
  await transaccion((cx) => P.marcarDiscrepancia(cx, id, v.datos.nota));
  const p = await P.pagoPorId(id);
  await bitacora.registrar(req, {
    accion: 'PAGO_DISCREPANCIA', modulo: 'Pagos', tabla: 'Pago', idRegistro: id,
    descripcion: `Marcó con discrepancia el pago de ${P.dinero(p.monto)} de ${p.cliente}${p.folio ? ` (${p.folio})` : ''}: ${v.datos.nota}`,
    antes: { estado: 'Pendiente' }, despues: { estado: 'Con discrepancia', nota: v.datos.nota }
  });
  res.json({ mensaje: 'Pago marcado con discrepancia. Sigue por validar hasta que se corrija.', pago: p });
}));

/* ------------------------------------------------------------------ */
/*  Comprobantes                                                       */
/* ------------------------------------------------------------------ */
router.get('/:id/comprobante', asincrono(async (req, res, next) => {
  const id = idValido(req.params.id);
  const [f] = await consulta('SELECT Comprobante AS archivo FROM Pago WHERE idPago = @id', { id });
  if (!f || !f.archivo) throw new ErrorApp(404, 'Este pago no tiene comprobante.');
  const p = await P.pagoPorId(id);
  await bitacora.registrar(req, {
    accion: 'COMPROBANTE_CONSULTADO', modulo: 'Pagos', tabla: 'Pago', idRegistro: id,
    descripcion: `Abrió el comprobante del pago de ${p.cliente}${p.folio ? ` (${p.folio})` : ''}`
  });
  await P.enviarComprobante(res, next, f.archivo, `comprobante_${p.folio || `pago_${id}`}`);
}));

router.put('/:id/comprobante', contexto('COMPROBANTE_SUBIDO', 'Pagos', 'Pago'),
  express.raw({ type: Object.values(P.TIPOS).map((t) => t.mime), limit: TAMANO_MAXIMO }),
  asincrono(async (req, res) => {
    const id = idValido(req.params.id);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ErrorApp(415, 'El comprobante debe ser una imagen PNG o JPG, o un PDF.');
    const ext = P.tipoReal(req.body);
    if (!ext || P.TIPOS[ext].mime !== String(req.headers['content-type']).split(';')[0].trim()) {
      throw new ErrorApp(415, 'El archivo no es un PNG, JPG o PDF válido.');
    }
    const p = await P.pagoPorId(id);
    if (!p) throw new ErrorApp(404, 'El pago no existe.');
    const r = await P.guardarComprobante(id, req.body, ext);
    await bitacora.registrar(req, {
      accion: 'COMPROBANTE_SUBIDO', modulo: 'Pagos', tabla: 'Pago', idRegistro: id,
      descripcion: `${r.reemplazo ? 'Reemplazó' : 'Subió'} el comprobante del pago de ${p.cliente}${p.folio ? ` (${p.folio})` : ''} ` +
        `(${ext.toUpperCase()}, ${(req.body.length / 1024).toFixed(0)} KB)${r.reabierto ? '. El pago vuelve a quedar pendiente de validar.' : ''}`,
      despues: { folio: p.folio, tipo: ext, tamanoKB: Math.round(req.body.length / 1024), sha256: r.sha256 }
    });
    res.json({ mensaje: r.reabierto ? 'Comprobante guardado. El pago vuelve a estar pendiente de validar.' : 'Comprobante guardado.' });
  }));

/* ------------------------------------------------------------------ */
/*  Exportar los pagos por validar (CSV)                               */
/* ------------------------------------------------------------------ */
const csvCelda = (v) => {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
};

router.get('/exportar', asincrono(async (req, res) => {
  const filas = (await consulta(`${P.SELECT_PAGO}
     WHERE p.Estado_Pago IN ('Pendiente', 'Con discrepancia') AND ${NO_CANCELADA}
     ORDER BY p.Fecha_Pago OFFSET 0 ROWS FETCH NEXT 5000 ROWS ONLY`)).map(P.normalizarPago);
  await bitacora.registrar(req, {
    accion: 'PAGOS_EXPORTADOS', modulo: 'Pagos', tabla: 'Pago',
    descripcion: `Exportó ${filas.length} pago(s) por validar a CSV`
  });
  const columnas = [['Fecha', (f) => (f.fechaPago instanceof Date ? fechaIso(f.fechaPago) : String(f.fechaPago).slice(0, 10))],
    ['Cliente', (f) => f.cliente], ['Equipo', (f) => f.equipo], ['Reserva', (f) => f.folio], ['Cancha', (f) => f.cancha],
    ['Concepto', (f) => f.concepto], ['Metodo', (f) => f.metodo], ['Monto', (f) => f.monto.toFixed(2)], ['Estado', (f) => f.estadoPago],
    ['Referencia', (f) => f.referencia], ['Comprobante', (f) => (f.tieneComprobante ? 'Sí' : 'No')], ['Nota', (f) => f.nota]];
  const lineas = [columnas.map((c) => c[0]).join(',')].concat(filas.map((f) => columnas.map(([, fn]) => csvCelda(fn(f))).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pagos_por_validar_${fechaIso(new Date())}.csv"`);
  res.send('﻿' + lineas.join('\r\n'));
}));

module.exports = router;
