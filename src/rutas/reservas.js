// =====================================================================
//  API de Reservas y Pagos (solo administradores)
// =====================================================================
const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const { consulta, insertar, transaccion } = require('../../config/db');
const V = require('../../public/js/validacion');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { ErrorApp, errorValidacion, asincrono } = require('../errores');

const router = express.Router();

const CARPETA_COMPROBANTES = path.join(__dirname, '..', '..', 'almacen', 'comprobantes');
const TAMANO_MAXIMO = 5 * 1024 * 1024;
const TIPOS = {
  png: { mime: 'image/png', inline: true },
  jpg: { mime: 'image/jpeg', inline: true },
  pdf: { mime: 'application/pdf', inline: false }
};
const NOMBRE_ARCHIVO = /^[a-f0-9]{32}\.(png|jpg|pdf)$/;

const idValido = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) throw new ErrorApp(400, 'Identificador de reserva no válido.');
  return n;
};
const escaparLike = (t) => t.replace(/[\\%_[\]]/g, (c) => `\\${c}`);
const esEfectivo = (metodo) => /efectivo/i.test(metodo || '');
const dinero = (n) => `$${Number(n).toFixed(2)}`;

/** Estado que se muestra en pantalla, a partir del estado guardado y si tiene pago. */
const ESTADO_VISTA = `
  CASE WHEN e.Estado_Reserva = 'Cancelada'  THEN 'cancelada'
       WHEN e.Estado_Reserva = 'Finalizada' THEN 'finalizada'
       WHEN e.Estado_Reserva = 'Confirmada' AND r.idPago IS NOT NULL THEN 'pagada'
       WHEN e.Estado_Reserva = 'Confirmada' THEN 'confirmada'
       WHEN r.idPago IS NOT NULL THEN 'por_validar'
       ELSE 'pendiente' END`;
const ESTADOS_VISTA = ['pendiente', 'por_validar', 'pagada', 'confirmada', 'cancelada', 'finalizada'];

const SELECT_RESERVA = `
  SELECT r.idReserva, r.Folio AS folio, CONVERT(char(10), r.Fecha_Reserva, 23) AS fecha,
         LEFT(CONVERT(char(8), r.Hora_Inicio, 108), 5) AS inicio,
         LEFT(CONVERT(char(8), r.Hora_Fin, 108), 5) AS fin,
         r.Descripcion AS descripcion, r.idUsuario, CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS cliente,
         u.Correo AS correo, r.idEquipo, q.Equipo AS equipo, r.idCancha, c.Cancha AS cancha,
         e.Estado_Reserva AS estado, r.idPago, p.Monto AS monto, m.Metodo_Pago AS metodo,
         CASE WHEN p.Comprobante IS NULL THEN 0 ELSE 1 END AS tieneComprobante,
         ${ESTADO_VISTA} AS estadoVista
    FROM Reserva r
    JOIN Usuario u ON u.idUsuario = r.idUsuario
    JOIN Cancha c ON c.idCancha = r.idCancha
    JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
    LEFT JOIN Equipo q ON q.idEquipo = r.idEquipo
    LEFT JOIN Pago p ON p.idPago = r.idPago
    LEFT JOIN Metodo_Pago m ON m.idMetodo_Pago = p.idMetodo_Pago`;

const normalizar = (f) => f && ({ ...f, monto: f.monto === null ? null : Number(f.monto), tieneComprobante: Number(f.tieneComprobante) === 1 });

async function reservaPorId(id, cx) {
  const [f] = await consulta(`${SELECT_RESERVA} WHERE r.idReserva = @id`, { id }, cx);
  return normalizar(f) || null;
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

const paraBitacora = (r) => ({
  folio: r.folio, cliente: r.correo, equipo: r.equipo, cancha: r.cancha, fecha: r.fecha,
  horario: `${r.inicio}-${r.fin}`, estado: r.estado, monto: r.monto, metodo: r.metodo, descripcion: r.descripcion
});

/* =================================================================== */
/*  LISTADO + RESUMEN                                                   */
/* =================================================================== */
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

function filtros(query) {
  const condiciones = [];
  const p = {};
  const q = (k) => (typeof query[k] === 'string' ? query[k].trim() : '');
  if (q('q')) {
    p.texto = `%${escaparLike(q('q').slice(0, 60))}%`;
    condiciones.push(`(r.Folio LIKE @texto ESCAPE '\\' OR CONCAT(u.Nombre, ' ', u.Apellido_Paterno) LIKE @texto ESCAPE '\\'
                       OR u.Correo LIKE @texto ESCAPE '\\' OR q.Equipo LIKE @texto ESCAPE '\\')`);
  }
  if (FECHA.test(q('desde'))) { p.desde = q('desde'); condiciones.push('r.Fecha_Reserva >= @desde'); }
  if (FECHA.test(q('hasta'))) { p.hasta = q('hasta'); condiciones.push('r.Fecha_Reserva <= @hasta'); }
  if (ESTADOS_VISTA.includes(q('estado'))) { p.estadoVista = q('estado'); condiciones.push(`(${ESTADO_VISTA}) = @estadoVista`); }
  if (Number.isInteger(Number(q('idCancha'))) && Number(q('idCancha')) > 0) {
    p.idCanchaFiltro = Number(q('idCancha')); condiciones.push('r.idCancha = @idCanchaFiltro');
  }
  return { where: condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '', parametros: p };
}

const FROM_LISTA = `
    FROM Reserva r
    JOIN Usuario u ON u.idUsuario = r.idUsuario
    JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
    LEFT JOIN Equipo q ON q.idEquipo = r.idEquipo`;

router.get('/', asincrono(async (req, res) => {
  const pagina = Math.max(1, Math.min(10000, parseInt(req.query.pagina, 10) || 1));
  const porPagina = [10, 25, 50].includes(Number(req.query.porPagina)) ? Number(req.query.porPagina) : 10;
  const { where, parametros } = filtros(req.query);

  const [resumen, conteo, registros] = await consulta(`
    SELECT
      (SELECT COUNT(*) FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE r.Fecha_Reserva = CAST(GETDATE() AS DATE) AND e.Estado_Reserva <> 'Cancelada') AS hoy,
      (SELECT COUNT(*) FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE e.Estado_Reserva = 'Pendiente' AND r.idPago IS NOT NULL) AS porValidar,
      (SELECT COUNT(*) FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE e.Estado_Reserva = 'Pendiente' AND r.idPago IS NULL) AS sinPago,
      (SELECT ISNULL(SUM(p.Monto), 0) FROM Reserva r
         JOIN Pago p ON p.idPago = r.idPago
         JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
        WHERE CAST(p.Fecha_Pago AS DATE) = CAST(GETDATE() AS DATE)
          AND e.Estado_Reserva <> 'Cancelada') AS ingresosDia;
    SELECT COUNT(*) AS total ${FROM_LISTA} ${where};
    ${SELECT_RESERVA} ${where}
     ORDER BY r.Fecha_Reserva DESC, r.Hora_Inicio ASC, r.idReserva DESC
     OFFSET @saltar ROWS FETCH NEXT @tomar ROWS ONLY;`,
  { ...parametros, tomar: porPagina, saltar: (pagina - 1) * porPagina });

  const total = Number(conteo[0].total);
  const r = resumen[0];
  res.json({
    resumen: { hoy: Number(r.hoy), porValidar: Number(r.porValidar), sinPago: Number(r.sinPago), ingresosDia: Number(r.ingresosDia) },
    total, pagina, porPagina, paginas: Math.max(1, Math.ceil(total / porPagina)),
    registros: registros.map(normalizar)
  });
}));

/* =================================================================== */
/*  CATÁLOGOS DEL FORMULARIO                                            */
/* =================================================================== */
router.get('/catalogos', asincrono(async (req, res) => {
  const [clientes, equipos, canchas, metodos, pendientes] = await consulta(`
    SELECT idUsuario AS id, CONCAT(Nombre, ' ', Apellido_Paterno) AS nombre, Correo AS correo
      FROM Usuario WHERE Estado = 'Activo' ORDER BY Nombre, Apellido_Paterno;
    SELECT idEquipo AS id, Equipo AS nombre, idUsuario FROM Equipo ORDER BY Equipo;
    SELECT c.idCancha AS id, c.Cancha AS nombre, t.Tipo_Cancha AS tipo
      FROM Cancha c JOIN Tipo_Cancha t ON t.idTipo_Cancha = c.idTipo_Cancha
     WHERE c.Estado_Cancha = 'Activa' ORDER BY c.Cancha;
    SELECT idMetodo_Pago AS id, Metodo_Pago AS nombre FROM Metodo_Pago ORDER BY idMetodo_Pago;
    ${SELECT_RESERVA}
     WHERE e.Estado_Reserva = 'Pendiente' AND r.idPago IS NULL
     ORDER BY r.Fecha_Reserva, r.Hora_Inicio
     OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY;`);
  res.json({ clientes, equipos, canchas, metodos, pendientes: pendientes.map(normalizar), horarios: V.horarios() });
}));

router.get('/disponibilidad', asincrono(async (req, res) => {
  const idCancha = Number(req.query.idCancha);
  const fecha = String(req.query.fecha || '');
  if (!Number.isInteger(idCancha) || idCancha < 1 || idCancha > 255 || !FECHA.test(fecha)) {
    throw new ErrorApp(400, 'Cancha o fecha no válida.');
  }
  const ocupados = await consulta(`
    SELECT r.Folio AS folio, LEFT(CONVERT(char(8), r.Hora_Inicio, 108), 5) AS inicio,
           LEFT(CONVERT(char(8), r.Hora_Fin, 108), 5) AS fin
      FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
     WHERE r.idCancha = @idCancha AND r.Fecha_Reserva = @fecha AND e.Estado_Reserva <> 'Cancelada'
     ORDER BY r.Hora_Inicio`, { idCancha, fecha });
  res.json({ ocupados });
}));

/* =================================================================== */
/*  NUEVA RESERVA (con pago opcional)                                   */
/* =================================================================== */
async function crearReserva(d) {
  return transaccion(async (cx) => {
    const estados = await idsEstados(cx);

    // Bloquear la cancha: dos reservas al mismo tiempo no pueden ganar el mismo horario
    const [cancha] = await consulta(
      `SELECT idCancha, Cancha AS nombre, Estado_Cancha AS estado
         FROM Cancha WITH (UPDLOCK, ROWLOCK) WHERE idCancha = @idCancha`,
      { idCancha: d.idCancha }, cx);
    if (!cancha) throw errorValidacion({ idCancha: 'La cancha no existe.' });
    if (cancha.estado !== 'Activa') throw errorValidacion({ idCancha: 'Esta cancha está inactiva y no recibe reservas.' });

    const [cliente] = await consulta('SELECT Estado FROM Usuario WHERE idUsuario = @idUsuario', { idUsuario: d.idUsuario }, cx);
    if (!cliente || cliente.Estado !== 'Activo') throw errorValidacion({ idUsuario: 'El cliente no existe o está inactivo.' });

    if (d.idEquipo) {
      const [equipo] = await consulta('SELECT idUsuario FROM Equipo WHERE idEquipo = @idEquipo', { idEquipo: d.idEquipo }, cx);
      if (!equipo) throw errorValidacion({ idEquipo: 'El equipo no existe.' });
      if (Number(equipo.idUsuario) !== d.idUsuario) throw errorValidacion({ idEquipo: 'Ese equipo no pertenece al cliente elegido.' });
    }

    const [choque] = await consulta(`
      SELECT TOP (1) r.Folio AS folio, LEFT(CONVERT(char(8), r.Hora_Inicio, 108), 5) AS inicio,
             LEFT(CONVERT(char(8), r.Hora_Fin, 108), 5) AS fin
        FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
       WHERE r.idCancha = @idCancha AND r.Fecha_Reserva = @fecha AND e.Estado_Reserva <> 'Cancelada'
         AND r.Hora_Inicio < CAST(@fin AS TIME) AND r.Hora_Fin > CAST(@inicio AS TIME)`,
    { idCancha: d.idCancha, fecha: d.fecha, inicio: `${d.horaInicio}:00`, fin: `${d.horaFin}:00` }, cx);
    if (choque) {
      throw errorValidacion({ horario: `Ese horario ya está ocupado por ${choque.folio} (${choque.inicio}–${choque.fin}).` });
    }

    let idPago = null, metodo = null;
    if (d.pago) {
      metodo = await metodoPorId(d.pago.idMetodoPago, cx);
      const p = await insertar('INSERT INTO Pago (idMetodo_Pago, Monto) VALUES (@idMetodoPago, @monto)', d.pago, cx);
      idPago = p.insertId;
    }

    const [sig] = await consulta(`
      SELECT ISNULL(MAX(TRY_CAST(SUBSTRING(Folio, 5, 20) AS INT)), 0) + 1 AS siguiente
        FROM Reserva WITH (UPDLOCK, HOLDLOCK) WHERE Folio LIKE 'RES-%'`, {}, cx);
    const folio = `RES-${String(sig.siguiente).padStart(5, '0')}`;

    const estado = idPago && esEfectivo(metodo) ? 'Confirmada' : 'Pendiente';
    const r = await insertar(`
      INSERT INTO Reserva (idUsuario, idEquipo, idPago, idCancha, idEstado_Reserva, Folio,
                           Fecha_Reserva, Hora_Inicio, Hora_Fin, Descripcion)
      VALUES (@idUsuario, @idEquipo, @idPago, @idCancha, @idEstado, @folio, @fecha, @inicio, @fin, @descripcion)`, {
      idUsuario: d.idUsuario, idEquipo: d.idEquipo, idPago, idCancha: d.idCancha, idEstado: estados[estado], folio,
      fecha: d.fecha, inicio: `${d.horaInicio}:00`, fin: `${d.horaFin}:00`, descripcion: d.descripcion
    }, cx);
    return reservaPorId(r.insertId, cx);
  });
}

router.post('/', contexto('RESERVA_CREADA', 'Reservas', 'Reserva'), asincrono(async (req, res) => {
  const v = V.validarReserva(req.body);
  if (!v.ok) throw errorValidacion(v.errores);

  let reserva;
  for (let intento = 1; ; intento++) {
    try {
      reserva = await crearReserva(v.datos);
      break;
    } catch (err) {
      // Dos administradores generaron el mismo folio al mismo tiempo: reintentar
      const numero = err && (err.number || (err.originalError && err.originalError.info && err.originalError.info.number));
      if ((numero === 2627 || numero === 2601) && /folio/i.test(err.message) && intento < 3) continue;
      throw err;
    }
  }

  await bitacora.registrar(req, {
    accion: 'RESERVA_CREADA', modulo: 'Reservas', tabla: 'Reserva', idRegistro: reserva.idReserva,
    descripcion: `Registró la reserva ${reserva.folio} de ${reserva.correo} en ${reserva.cancha} el ${reserva.fecha} ` +
      `de ${reserva.inicio} a ${reserva.fin}`,
    despues: paraBitacora(reserva)
  });
  if (reserva.idPago) {
    await bitacora.registrar(req, {
      accion: 'PAGO_REGISTRADO', modulo: 'Reservas', tabla: 'Pago', idRegistro: reserva.idPago,
      descripcion: `Registró un pago de ${dinero(reserva.monto)} (${reserva.metodo}) para ${reserva.folio}` +
        (reserva.estado === 'Confirmada' ? '. Reserva confirmada.' : '. Queda por validar.'),
      despues: { folio: reserva.folio, monto: reserva.monto, metodo: reserva.metodo, estado: reserva.estado }
    });
  }

  const mensaje = !reserva.idPago ? `Reserva ${reserva.folio} registrada. Queda pendiente de pago.`
    : reserva.estado === 'Confirmada' ? `Reserva ${reserva.folio} registrada y pagada.`
      : `Reserva ${reserva.folio} registrada. El pago queda por validar.`;
  res.status(201).json({ mensaje, reserva });
}));

/* =================================================================== */
/*  PAGO DE UNA RESERVA EXISTENTE                                       */
/* =================================================================== */
router.post('/:id/pago', contexto('PAGO_REGISTRADO', 'Reservas', 'Reserva'), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const v = V.validarPago(req.body);
  if (!v.ok) throw errorValidacion(v.errores);

  const despues = await transaccion(async (cx) => {
    const estados = await idsEstados(cx);
    const [r] = await consulta(`
      SELECT r.idPago, e.Estado_Reserva AS estado FROM Reserva r WITH (UPDLOCK, ROWLOCK)
        JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
       WHERE r.idReserva = @id`, { id }, cx);
    if (!r) throw new ErrorApp(404, 'La reserva no existe.');
    if (r.idPago) throw new ErrorApp(409, 'Esta reserva ya tiene un pago registrado.');
    if (r.estado !== 'Pendiente') throw new ErrorApp(409, `No se puede registrar pago a una reserva ${r.estado.toLowerCase()}.`);

    const metodo = await metodoPorId(v.datos.idMetodoPago, cx);
    const p = await insertar('INSERT INTO Pago (idMetodo_Pago, Monto) VALUES (@idMetodoPago, @monto)', v.datos, cx);
    await consulta(`
      UPDATE Reserva SET idPago = @idPago, idEstado_Reserva = @idEstado,
             Descripcion = COALESCE(@descripcion, Descripcion)
       WHERE idReserva = @id`, {
      idPago: p.insertId, idEstado: estados[esEfectivo(metodo) ? 'Confirmada' : 'Pendiente'], descripcion: v.datos.descripcion, id
    }, cx);
    return reservaPorId(id, cx);
  });

  await bitacora.registrar(req, {
    accion: 'PAGO_REGISTRADO', modulo: 'Reservas', tabla: 'Pago', idRegistro: despues.idPago,
    descripcion: `Registró un pago de ${dinero(despues.monto)} (${despues.metodo}) para ${despues.folio}` +
      (despues.estado === 'Confirmada' ? '. Reserva confirmada.' : '. Queda por validar.'),
    antes: { estado: 'Pendiente', pago: null },
    despues: { folio: despues.folio, monto: despues.monto, metodo: despues.metodo, estado: despues.estado }
  });
  res.json({
    mensaje: despues.estado === 'Confirmada' ? `Pago registrado. ${despues.folio} quedó confirmada.`
      : `Pago registrado. ${despues.folio} queda por validar.`,
    reserva: despues
  });
}));

/* =================================================================== */
/*  CAMBIOS DE ESTADO                                                   */
/* =================================================================== */
function cambioDeEstado({ ruta, accion, desde, hacia, requierePago, soloPasadas, verbo, mensaje }) {
  router.post(`/:id/${ruta}`, contexto(accion, 'Reservas', 'Reserva'), asincrono(async (req, res) => {
    const id = idValido(req.params.id);
    const { antes, despues } = await transaccion(async (cx) => {
      const estados = await idsEstados(cx);
      const [r] = await consulta(`
        SELECT r.idPago, e.Estado_Reserva AS estado,
               CASE WHEN r.Fecha_Reserva <= CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END AS yaLlego
          FROM Reserva r WITH (UPDLOCK, ROWLOCK)
          JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
         WHERE r.idReserva = @id`, { id }, cx);
      if (!r) throw new ErrorApp(404, 'La reserva no existe.');
      if (!desde.includes(r.estado)) throw new ErrorApp(409, `No se puede ${verbo} una reserva ${r.estado.toLowerCase()}.`);
      if (requierePago && !r.idPago) throw new ErrorApp(409, 'La reserva no tiene un pago registrado.');
      if (soloPasadas && !Number(r.yaLlego)) throw new ErrorApp(409, 'Solo se pueden finalizar reservas de hoy o de días anteriores.');
      const previo = await reservaPorId(id, cx);
      await consulta('UPDATE Reserva SET idEstado_Reserva = @idEstado WHERE idReserva = @id', { idEstado: estados[hacia], id }, cx);
      return { antes: previo, despues: await reservaPorId(id, cx) };
    });

    await bitacora.registrar(req, {
      accion, modulo: 'Reservas', tabla: 'Reserva', idRegistro: id,
      descripcion: `${mensaje(despues)} (estado: "${antes.estado}" → "${despues.estado}")`,
      antes: { estado: antes.estado }, despues: { folio: despues.folio, estado: despues.estado }
    });
    res.json({ mensaje: mensaje(despues), reserva: despues });
  }));
}

cambioDeEstado({
  ruta: 'validar', accion: 'PAGO_VALIDADO', desde: ['Pendiente'], hacia: 'Confirmada', requierePago: true, verbo: 'validar',
  mensaje: (r) => `Pago de ${r.folio} validado (${dinero(r.monto)}, ${r.metodo}). Reserva confirmada`
});
cambioDeEstado({
  ruta: 'cancelar', accion: 'RESERVA_CANCELADA', desde: ['Pendiente', 'Confirmada'], hacia: 'Cancelada', verbo: 'cancelar',
  mensaje: (r) => `Reserva ${r.folio} cancelada; el horario quedó libre` +
    (r.idPago ? `. El pago de ${dinero(r.monto)} sigue registrado por si hay que devolverlo` : '')
});
cambioDeEstado({
  ruta: 'finalizar', accion: 'RESERVA_FINALIZADA', desde: ['Confirmada'], hacia: 'Finalizada', soloPasadas: true, verbo: 'finalizar',
  mensaje: (r) => `Reserva ${r.folio} marcada como finalizada`
});

/* =================================================================== */
/*  COMPROBANTE DE PAGO (PNG, JPG o PDF, máximo 5 MB)                   */
/* =================================================================== */

/** Reconoce el archivo por sus primeros bytes, no por el nombre ni por lo que diga el navegador. */
function tipoReal(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

const recibirArchivo = express.raw({ type: Object.values(TIPOS).map((t) => t.mime), limit: TAMANO_MAXIMO });

router.put('/:id/comprobante', contexto('COMPROBANTE_SUBIDO', 'Reservas', 'Pago'), recibirArchivo,
  asincrono(async (req, res) => {
    const id = idValido(req.params.id);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ErrorApp(415, 'El comprobante debe ser una imagen PNG o JPG, o un PDF.');
    }
    const ext = tipoReal(req.body);
    if (!ext || TIPOS[ext].mime !== String(req.headers['content-type']).split(';')[0].trim()) {
      throw new ErrorApp(415, 'El archivo no es un PNG, JPG o PDF válido.');
    }

    const reserva = await reservaPorId(id);
    if (!reserva) throw new ErrorApp(404, 'La reserva no existe.');
    if (!reserva.idPago) throw new ErrorApp(409, 'Primero registra el pago de la reserva.');

    const [anterior] = await consulta('SELECT Comprobante FROM Pago WHERE idPago = @idPago', { idPago: reserva.idPago });
    const nombre = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    await fs.mkdir(CARPETA_COMPROBANTES, { recursive: true });
    await fs.writeFile(path.join(CARPETA_COMPROBANTES, nombre), req.body, { flag: 'wx' });

    try {
      await consulta('UPDATE Pago SET Comprobante = @nombre WHERE idPago = @idPago', { nombre, idPago: reserva.idPago });
    } catch (err) {
      await fs.unlink(path.join(CARPETA_COMPROBANTES, nombre)).catch(() => {});
      throw err;
    }
    if (anterior && anterior.Comprobante && NOMBRE_ARCHIVO.test(anterior.Comprobante)) {
      await fs.unlink(path.join(CARPETA_COMPROBANTES, anterior.Comprobante)).catch(() => {});
    }

    await bitacora.registrar(req, {
      accion: 'COMPROBANTE_SUBIDO', modulo: 'Reservas', tabla: 'Pago', idRegistro: reserva.idPago,
      descripcion: `${anterior && anterior.Comprobante ? 'Reemplazó' : 'Subió'} el comprobante de pago de ${reserva.folio} ` +
        `(${ext.toUpperCase()}, ${(req.body.length / 1024).toFixed(0)} KB)`,
      despues: { folio: reserva.folio, tipo: ext, tamanoKB: Math.round(req.body.length / 1024) }
    });
    res.json({ mensaje: 'Comprobante guardado.' });
  }));

router.get('/:id/comprobante', asincrono(async (req, res, next) => {
  const id = idValido(req.params.id);
  const [f] = await consulta(`
    SELECT r.Folio AS folio, p.Comprobante AS archivo
      FROM Reserva r JOIN Pago p ON p.idPago = r.idPago
     WHERE r.idReserva = @id`, { id });
  if (!f || !f.archivo || !NOMBRE_ARCHIVO.test(f.archivo)) throw new ErrorApp(404, 'Esta reserva no tiene comprobante.');

  const ext = f.archivo.split('.').pop();
  await bitacora.registrar(req, {
    accion: 'COMPROBANTE_CONSULTADO', modulo: 'Reservas', tabla: 'Pago', idRegistro: id,
    descripcion: `Abrió el comprobante de pago de ${f.folio}`
  });
  res.setHeader('Content-Type', TIPOS[ext].mime);
  res.setHeader('Content-Disposition',
    `${TIPOS[ext].inline ? 'inline' : 'attachment'}; filename="comprobante_${f.folio}.${ext}"`);
  res.sendFile(f.archivo, { root: CARPETA_COMPROBANTES, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) next(new ErrorApp(404, 'No se encontró el archivo del comprobante.'));
  });
}));

/* =================================================================== */
/*  EXPORTAR CSV                                                        */
/* =================================================================== */
const csvCelda = (v) => {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
};
const NOMBRES_ESTADO = {
  pendiente: 'Pendiente de pago', por_validar: 'Por validar', pagada: 'Pagada',
  confirmada: 'Confirmada', cancelada: 'Cancelada', finalizada: 'Finalizada'
};

router.get('/exportar', asincrono(async (req, res) => {
  const { where, parametros } = filtros(req.query);
  const filas = (await consulta(`${SELECT_RESERVA} ${where}
     ORDER BY r.Fecha_Reserva DESC, r.Hora_Inicio ASC
     OFFSET 0 ROWS FETCH NEXT 10000 ROWS ONLY`, parametros)).map(normalizar);

  await bitacora.registrar(req, {
    accion: 'RESERVAS_EXPORTADAS', modulo: 'Reservas', tabla: 'Reserva',
    descripcion: `Exportó ${filas.length} reserva(s) a CSV`, despues: { filtros: req.query }
  });

  const columnas = [['Folio', 'folio'], ['Fecha', 'fecha'], ['Inicio', 'inicio'], ['Fin', 'fin'], ['Cancha', 'cancha'],
    ['Cliente', 'cliente'], ['Correo', 'correo'], ['Equipo', 'equipo'], ['Estado', 'estadoTexto'],
    ['Monto', 'monto'], ['Metodo de pago', 'metodo'], ['Descripcion', 'descripcion']];
  const lineas = [columnas.map((c) => c[0]).join(',')].concat(filas.map((f) =>
    columnas.map(([, k]) => csvCelda(k === 'estadoTexto' ? NOMBRES_ESTADO[f.estadoVista] : f[k])).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="reservas_${V.fechaLocal()}.csv"`);
  res.send('﻿' + lineas.join('\r\n'));
}));

module.exports = router;
