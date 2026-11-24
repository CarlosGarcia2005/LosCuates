// =====================================================================
//  Lógica de pagos compartida por Reservas, Pagos, Reportes y Dashboard
//  (una sola definición: así ningún módulo cuenta distinto que otro)
//
//  Estado_Pago:
//    Pagado            efectivo: se cobra al momento → la reserva queda Confirmada
//    Pendiente         transferencia/tarjeta: falta revisar el comprobante
//    Validado          un administrador revisó y aprobó el pago → reserva Confirmada
//    Con discrepancia  el comprobante o el monto no coinciden (sigue por validar)
//
//  "Ingresos" = pagos Pagados o Validados de reservas que no se cancelaron.
// =====================================================================
const crypto = require('crypto');

const { consulta, transaccion } = require('../../config/db');
const { ErrorApp, errorValidacion } = require('../errores');

// Los comprobantes se guardan en la tabla Comprobante_Archivo (no en disco): así funcionan
// igual en la computadora y en Vercel, donde los archivos del servidor no se conservan.
const NOMBRE_ARCHIVO = /^[a-f0-9]{32}\.(png|jpg|pdf)$/;
const TIPOS = {
  png: { mime: 'image/png', inline: true },
  jpg: { mime: 'image/jpeg', inline: true },
  pdf: { mime: 'application/pdf', inline: false }
};

const ESTADOS_PAGO = ['Pagado', 'Pendiente', 'Validado', 'Con discrepancia'];

/** Condición SQL de "ingreso confirmado" (alias p = Pago, e = Estado_Reserva de su reserva, si tiene). */
const SQL_INGRESO = `p.Estado_Pago IN ('Pagado', 'Validado') AND (e.Estado_Reserva IS NULL OR e.Estado_Reserva <> 'Cancelada')`;

const esEfectivo = (metodo) => /efectivo/i.test(metodo || '');
const dinero = (n) => `$${Number(n).toFixed(2)}`;

/** Pago con todo lo que se muestra en pantalla (cliente, equipo, reserva, cancha, torneo). */
const SELECT_PAGO = `
  SELECT p.idPago, p.Monto AS monto, p.Estado_Pago AS estadoPago, p.Referencia AS referencia,
         p.Nota_Revision AS nota, p.Fecha_Pago AS fechaPago, p.Fecha_Revision AS fechaRevision,
         p.idMetodo_Pago AS idMetodoPago, m.Metodo_Pago AS metodo,
         CASE WHEN p.Comprobante IS NULL THEN 0 ELSE 1 END AS tieneComprobante,
         r.idReserva, r.Folio AS folio, CONVERT(CHAR(10), r.Fecha_Reserva, 23) AS fechaReserva,
         LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio, LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin,
         e.Estado_Reserva AS estadoReserva, c.idCancha, c.Cancha AS cancha,
         COALESCE(u.Nombre + ' ' + u.Apellido_Paterno, ui.Nombre + ' ' + ui.Apellido_Paterno) AS cliente,
         COALESCE(u.Correo, ui.Correo) AS correo,
         COALESCE(q.Equipo, qi.Equipo) AS equipo,
         jg.idJuego, jg.Jornada AS jornada, COALESCE(t.Torneo, ti.Torneo) AS torneo,
         CASE WHEN jg.idJuego IS NOT NULL THEN 'Partido de torneo'
              WHEN r.idReserva IS NOT NULL THEN 'Reserva'
              WHEN it.idTorneo IS NOT NULL THEN 'Inscripción a torneo'
              ELSE 'Otro' END AS concepto
    FROM Pago p
    JOIN Metodo_Pago m           ON m.idMetodo_Pago = p.idMetodo_Pago
    LEFT JOIN Reserva r          ON r.idPago = p.idPago
    LEFT JOIN Estado_Reserva e   ON e.idEstado_Reserva = r.idEstado_Reserva
    LEFT JOIN Usuario u          ON u.idUsuario = r.idUsuario
    LEFT JOIN Equipo q           ON q.idEquipo = r.idEquipo
    LEFT JOIN Cancha c           ON c.idCancha = r.idCancha
    LEFT JOIN Juego jg           ON jg.idReserva = r.idReserva
    LEFT JOIN Torneo t           ON t.idTorneo = jg.idTorneo
    LEFT JOIN Inscripcion_Torneo it ON it.idPago = p.idPago
    LEFT JOIN Equipo qi          ON qi.idEquipo = it.idEquipo
    LEFT JOIN Usuario ui         ON ui.idUsuario = qi.idUsuario
    LEFT JOIN Torneo ti          ON ti.idTorneo = it.idTorneo`;

const normalizarPago = (f) => f && ({
  ...f,
  monto: Number(f.monto),
  tieneComprobante: Number(f.tieneComprobante) === 1,
  cliente: f.cliente || 'Sin cliente',
  idJuego: f.idJuego === null || f.idJuego === undefined ? null : Number(f.idJuego)
});

async function pagoPorId(idPago, cx) {
  const [f] = await consulta(`${SELECT_PAGO} WHERE p.idPago = @idPago`, { idPago }, cx);
  return normalizarPago(f) || null;
}

/** { Pendiente: 1, Confirmada: 2, ... } */
async function idsEstados(cx) {
  const filas = await consulta('SELECT idEstado_Reserva AS id, Estado_Reserva AS nombre FROM Estado_Reserva', {}, cx);
  const mapa = Object.fromEntries(filas.map((f) => [f.nombre, f.id]));
  for (const necesario of ['Pendiente', 'Confirmada', 'Cancelada', 'Finalizada']) {
    if (!mapa[necesario]) throw new ErrorApp(500, 'Faltan estados de reserva en la base. Ejecuta sql/03_canchas_y_reservas.sql.');
  }
  return mapa;
}

async function metodoPorId(idMetodoPago, cx) {
  const [m] = await consulta('SELECT Metodo_Pago AS nombre FROM Metodo_Pago WHERE idMetodo_Pago = @idMetodoPago',
    { idMetodoPago }, cx);
  if (!m) throw errorValidacion({ idMetodoPago: 'El método de pago no existe.' });
  return m.nombre;
}

/** Crea el pago (dentro de la transacción cx). Efectivo = Pagado; lo demás = Pendiente de validar. */
async function insertarPago(cx, { monto, idMetodoPago, referencia = null }) {
  const metodo = await metodoPorId(idMetodoPago, cx);
  const estadoPago = esEfectivo(metodo) ? 'Pagado' : 'Pendiente';
  const r = await consulta(`
    INSERT INTO Pago (idMetodo_Pago, Monto, Estado_Pago, Referencia)
    VALUES (@idMetodoPago, @monto, @estadoPago, @referencia)`, { idMetodoPago, monto, estadoPago, referencia }, cx);
  return { idPago: r.insertId, metodo, estadoPago };
}

/**
 * Registra el pago de una reserva que aún no tiene pago (Reservas y Pagos usan esta misma función).
 * Efectivo → reserva Confirmada. Transferencia/tarjeta → queda por validar.
 */
async function pagarReserva(cx, idReserva, { monto, idMetodoPago, referencia = null, descripcion = null }) {
  const estados = await idsEstados(cx);
  const [r] = await consulta(`
    SELECT r.idPago, e.Estado_Reserva AS estado FROM Reserva r WITH (UPDLOCK, ROWLOCK)
      JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
     WHERE r.idReserva = @idReserva`, { idReserva }, cx);
  if (!r) throw new ErrorApp(404, 'La reserva no existe.');
  if (r.idPago) throw new ErrorApp(409, 'Esta reserva ya tiene un pago registrado.');
  if (r.estado !== 'Pendiente') throw new ErrorApp(409, `No se puede registrar pago a una reserva ${r.estado.toLowerCase()}.`);

  const pago = await insertarPago(cx, { monto, idMetodoPago, referencia });
  await consulta(`
    UPDATE Reserva SET idPago = @idPago, idEstado_Reserva = @idEstado,
           Descripcion = COALESCE(@descripcion, Descripcion)
     WHERE idReserva = @idReserva`, {
    idPago: pago.idPago, idEstado: estados[pago.estadoPago === 'Pagado' ? 'Confirmada' : 'Pendiente'], descripcion, idReserva
  }, cx);
  return pago;
}

/** Aprueba un pago Pendiente o Con discrepancia: Validado + su reserva Confirmada. */
async function validarPago(cx, idPago) {
  const estados = await idsEstados(cx);
  const [p] = await consulta(`
    SELECT p.Estado_Pago AS estadoPago, r.idReserva, e.Estado_Reserva AS estadoReserva
      FROM Pago p WITH (UPDLOCK, ROWLOCK)
      LEFT JOIN Reserva r ON r.idPago = p.idPago
      LEFT JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
     WHERE p.idPago = @idPago`, { idPago }, cx);
  if (!p) throw new ErrorApp(404, 'El pago no existe.');
  if (!['Pendiente', 'Con discrepancia'].includes(p.estadoPago)) {
    throw new ErrorApp(409, `Este pago ya está ${p.estadoPago.toLowerCase()}; no hay nada que validar.`);
  }
  if (p.estadoReserva === 'Cancelada') throw new ErrorApp(409, 'La reserva de este pago está cancelada.');
  await consulta(`UPDATE Pago SET Estado_Pago = 'Validado', Fecha_Revision = GETDATE() WHERE idPago = @idPago`, { idPago }, cx);
  if (p.idReserva && p.estadoReserva === 'Pendiente') {
    await consulta('UPDATE Reserva SET idEstado_Reserva = @id WHERE idReserva = @idReserva',
      { id: estados.Confirmada, idReserva: p.idReserva }, cx);
  }
  return { anterior: p.estadoPago };
}

/** Marca un pago Pendiente como "Con discrepancia" (comprobante o monto no coinciden). */
async function marcarDiscrepancia(cx, idPago, nota) {
  const [p] = await consulta('SELECT Estado_Pago AS estadoPago FROM Pago WITH (UPDLOCK, ROWLOCK) WHERE idPago = @idPago', { idPago }, cx);
  if (!p) throw new ErrorApp(404, 'El pago no existe.');
  if (p.estadoPago !== 'Pendiente') {
    throw new ErrorApp(409, p.estadoPago === 'Con discrepancia' ? 'Este pago ya está marcado con discrepancia.'
      : `Solo se pueden rechazar pagos pendientes de validar (este está ${p.estadoPago.toLowerCase()}).`);
  }
  await consulta(`UPDATE Pago SET Estado_Pago = 'Con discrepancia', Nota_Revision = @nota, Fecha_Revision = GETDATE()
                   WHERE idPago = @idPago`, { idPago, nota }, cx);
}

/* ------------------------------------------------------------------ */
/*  Comprobantes (PNG, JPG o PDF)                                      */
/* ------------------------------------------------------------------ */

/** Reconoce el archivo por sus primeros bytes, no por el nombre ni por lo que diga el navegador. */
function tipoReal(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

/**
 * Guarda el archivo como comprobante del pago. Si el pago estaba "Con discrepancia",
 * vuelve a "Pendiente" para que se revise el comprobante nuevo.
 * @returns {Promise<{anterior: string|null, sha256: string}>}
 */
async function guardarComprobante(idPago, buffer, ext) {
  const [anterior] = await consulta('SELECT Comprobante, Estado_Pago AS estadoPago FROM Pago WHERE idPago = @idPago', { idPago });
  if (!anterior) throw new ErrorApp(404, 'El pago no existe.');
  const nombre = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await transaccion(async (cx) => {
    await consulta(`INSERT INTO Comprobante_Archivo (Nombre, Contenido, Tamano) VALUES (@nombre, @contenido, @tamano)`,
      { nombre, contenido: buffer, tamano: buffer.length }, cx);
    await consulta(`
      UPDATE Pago SET Comprobante = @nombre,
             Estado_Pago = CASE WHEN Estado_Pago = 'Con discrepancia' THEN 'Pendiente' ELSE Estado_Pago END
       WHERE idPago = @idPago`, { nombre, idPago }, cx);
    if (anterior.Comprobante && NOMBRE_ARCHIVO.test(anterior.Comprobante)) {
      await consulta('DELETE FROM Comprobante_Archivo WHERE Nombre = @viejo', { viejo: anterior.Comprobante }, cx);
    }
  });
  return {
    reemplazo: Boolean(anterior.Comprobante),
    reabierto: anterior.estadoPago === 'Con discrepancia',
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

/** Envía el archivo del comprobante (o 404). */
async function enviarComprobante(res, next, archivo, nombreDescarga) {
  if (!archivo || !NOMBRE_ARCHIVO.test(archivo)) throw new ErrorApp(404, 'Este pago no tiene comprobante.');
  const [f] = await consulta('SELECT Contenido FROM Comprobante_Archivo WHERE Nombre = @archivo', { archivo });
  if (!f || !f.Contenido) throw new ErrorApp(404, 'No se encontró el archivo del comprobante.');
  const ext = archivo.split('.').pop();
  res.setHeader('Content-Type', TIPOS[ext].mime);
  res.setHeader('Content-Disposition', `${TIPOS[ext].inline ? 'inline' : 'attachment'}; filename="${nombreDescarga}.${ext}"`);
  res.send(Buffer.from(f.Contenido));
}

module.exports = {
  ESTADOS_PAGO, SQL_INGRESO, SELECT_PAGO, TIPOS, NOMBRE_ARCHIVO,
  esEfectivo, dinero, normalizarPago, pagoPorId, idsEstados, metodoPorId, insertarPago,
  pagarReserva, validarPago, marcarDiscrepancia, tipoReal, guardarComprobante, enviarComprobante
};
