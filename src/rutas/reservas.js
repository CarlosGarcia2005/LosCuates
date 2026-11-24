// =====================================================================
//  API de Reservas y Pagos (solo administradores)
// =====================================================================
const express = require('express');

const { consulta, transaccion } = require('../../config/db');
const V = require('../../public/js/validacion');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { soloCampos } = require('../seguridad/campos');
const { ErrorApp, errorValidacion, validacionEvadida, reglaNegocio, asincrono } = require('../errores');
const ssrf = require('../seguridad/ssrf');
const P = require('../servicios/pagos');

const router = express.Router();

const TAMANO_MAXIMO = 5 * 1024 * 1024;
const { TIPOS, esEfectivo, dinero, idsEstados } = P;

// [OWASP A04] Diseño contra el acaparamiento: un cliente no puede apartar
// canchas sin pagar de forma ilimitada (dejaría a los demás sin horarios).
const MAX_PENDIENTES_SIN_PAGO = 3;

const idValido = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) throw new ErrorApp(400, 'Identificador de reserva no válido.');
  return n;
};
// En SQL Server los comodines de LIKE se vuelven texto normal encerrándolos en corchetes: % → [%]
const escaparLike = (t) => t.replace(/[[%_]/g, (c) => `[${c}]`);

/** Estado que se muestra en pantalla, a partir del estado guardado y si tiene pago. */
const ESTADO_VISTA = `
  CASE WHEN e.Estado_Reserva = 'Cancelada'  THEN 'cancelada'
       WHEN e.Estado_Reserva = 'Finalizada' THEN 'finalizada'
       WHEN e.Estado_Reserva = 'Confirmada' AND r.idPago IS NOT NULL THEN 'pagada'
       WHEN e.Estado_Reserva = 'Confirmada' THEN 'confirmada'
       WHEN r.idPago IS NOT NULL AND p.Estado_Pago = 'Con discrepancia' THEN 'discrepancia'
       WHEN r.idPago IS NOT NULL THEN 'por_validar'
       ELSE 'pendiente' END`;
const ESTADOS_VISTA = ['pendiente', 'por_validar', 'discrepancia', 'pagada', 'confirmada', 'cancelada', 'finalizada'];

const SELECT_RESERVA = `
  SELECT r.idReserva, r.Folio AS folio, CONVERT(CHAR(10), r.Fecha_Reserva, 23) AS fecha,
         LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio, LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin,
         r.Descripcion AS descripcion, r.idUsuario, CONCAT(u.Nombre, ' ', u.Apellido_Paterno) AS cliente,
         u.Correo AS correo, r.idEquipo, q.Equipo AS equipo, r.idCancha, c.Cancha AS cancha,
         e.Estado_Reserva AS estado, r.idPago, p.Monto AS monto, m.Metodo_Pago AS metodo,
         p.Estado_Pago AS estadoPago, p.Nota_Revision AS notaPago,
         CASE WHEN p.Comprobante IS NULL THEN 0 ELSE 1 END AS tieneComprobante,
         jg.idJuego, t.Torneo AS torneo,
         ${ESTADO_VISTA} AS estadoVista
    FROM Reserva r
    JOIN Usuario u ON u.idUsuario = r.idUsuario
    JOIN Cancha c ON c.idCancha = r.idCancha
    JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
    LEFT JOIN Equipo q ON q.idEquipo = r.idEquipo
    LEFT JOIN Pago p ON p.idPago = r.idPago
    LEFT JOIN Metodo_Pago m ON m.idMetodo_Pago = p.idMetodo_Pago
    LEFT JOIN Juego jg ON jg.idReserva = r.idReserva
    LEFT JOIN Torneo t ON t.idTorneo = jg.idTorneo`;

const normalizar = (f) => f && ({
  ...f, monto: f.monto === null ? null : Number(f.monto), tieneComprobante: Number(f.tieneComprobante) === 1,
  idJuego: f.idJuego === null || f.idJuego === undefined ? null : Number(f.idJuego)
});

async function reservaPorId(id, cx) {
  const [f] = await consulta(`${SELECT_RESERVA} WHERE r.idReserva = @id`, { id }, cx);
  return normalizar(f) || null;
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
    condiciones.push(`(r.Folio LIKE @texto OR CONCAT(u.Nombre, ' ', u.Apellido_Paterno) LIKE @texto
                       OR u.Correo LIKE @texto OR q.Equipo LIKE @texto)`);
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
    LEFT JOIN Equipo q ON q.idEquipo = r.idEquipo
    LEFT JOIN Pago p ON p.idPago = r.idPago`;

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
        WHERE p.Fecha_Pago >= CAST(GETDATE() AS DATE) AND p.Fecha_Pago < DATEADD(DAY, 1, CAST(GETDATE() AS DATE)) AND ${P.SQL_INGRESO}) AS ingresosDia;
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
    SELECT r.Folio AS folio, LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio, LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin
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
      'SELECT idCancha, Cancha AS nombre, Estado_Cancha AS estado FROM Cancha WITH (UPDLOCK, ROWLOCK) WHERE idCancha = @idCancha',
      { idCancha: d.idCancha }, cx);
    if (!cancha) throw errorValidacion({ idCancha: 'La cancha no existe.' });
    if (cancha.estado !== 'Activa') throw errorValidacion({ idCancha: 'Esta cancha está inactiva y no recibe reservas.' });

    const [cliente] = await consulta('SELECT Estado FROM Usuario WHERE idUsuario = @idUsuario', { idUsuario: d.idUsuario }, cx);
    if (!cliente || cliente.Estado !== 'Activo') throw errorValidacion({ idUsuario: 'El cliente no existe o está inactivo.' });

    if (!d.pago) {
      const [pendientes] = await consulta(`
        SELECT COUNT(*) AS total
          FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
         WHERE r.idUsuario = @idUsuario AND e.Estado_Reserva = 'Pendiente'
           AND r.idPago IS NULL AND r.Fecha_Reserva >= CAST(GETDATE() AS DATE)
           AND NOT EXISTS (SELECT 1 FROM Juego j WHERE j.idReserva = r.idReserva)`, { idUsuario: d.idUsuario }, cx);
      if (Number(pendientes.total) >= MAX_PENDIENTES_SIN_PAGO) {
        const msg = `Este cliente ya tiene ${MAX_PENDIENTES_SIN_PAGO} reservas pendientes de pago. ` +
          'Registra el pago de esta reserva o de alguna anterior.';
        throw reglaNegocio(msg, { idUsuario: msg });
      }
    }

    if (d.idEquipo) {
      const [equipo] = await consulta('SELECT idUsuario FROM Equipo WHERE idEquipo = @idEquipo', { idEquipo: d.idEquipo }, cx);
      if (!equipo) throw errorValidacion({ idEquipo: 'El equipo no existe.' });
      if (Number(equipo.idUsuario) !== d.idUsuario) throw errorValidacion({ idEquipo: 'Ese equipo no pertenece al cliente elegido.' });
    }

    const [choque] = await consulta(`
      SELECT TOP (1) r.Folio AS folio, LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio, LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin
        FROM Reserva r JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
       WHERE r.idCancha = @idCancha AND r.Fecha_Reserva = @fecha AND e.Estado_Reserva <> 'Cancelada'
         AND r.Hora_Inicio < @fin AND r.Hora_Fin > @inicio`, { idCancha: d.idCancha, fecha: d.fecha, inicio: `${d.horaInicio}:00`, fin: `${d.horaFin}:00` }, cx);
    if (choque) {
      throw errorValidacion({ horario: `Ese horario ya está ocupado por ${choque.folio} (${choque.inicio}–${choque.fin}).` });
    }

    let idPago = null, metodo = null;
    if (d.pago) {
      const pago = await P.insertarPago(cx, d.pago);
      idPago = pago.idPago;
      metodo = pago.metodo;
    }

    const [sig] = await consulta(`
      SELECT ISNULL(MAX(TRY_CAST(SUBSTRING(Folio, 5, 20) AS INT)), 0) + 1 AS siguiente
        FROM Reserva WITH (UPDLOCK, HOLDLOCK) WHERE Folio LIKE 'RES-%'`, {}, cx);
    const folio = `RES-${String(sig.siguiente).padStart(5, '0')}`;

    const estado = idPago && esEfectivo(metodo) ? 'Confirmada' : 'Pendiente';
    const r = await consulta(`
      INSERT INTO Reserva (idUsuario, idEquipo, idPago, idCancha, idEstado_Reserva, Folio,
                           Fecha_Reserva, Hora_Inicio, Hora_Fin, Descripcion)
      VALUES (@idUsuario, @idEquipo, @idPago, @idCancha, @idEstado, @folio, @fecha, @inicio, @fin, @descripcion)`, {
      idUsuario: d.idUsuario, idEquipo: d.idEquipo, idPago, idCancha: d.idCancha, idEstado: estados[estado], folio,
      fecha: d.fecha, inicio: `${d.horaInicio}:00`, fin: `${d.horaFin}:00`, descripcion: d.descripcion
    }, cx);
    return reservaPorId(r.insertId, cx);
  });
}

router.post('/', contexto('RESERVA_CREADA', 'Reservas', 'Reserva'),
  soloCampos(['idUsuario', 'idEquipo', 'idCancha', 'fecha', 'horario', 'horaInicio', 'horaFin', 'descripcion', 'monto', 'idMetodoPago']),
  asincrono(async (req, res) => {
  const v = V.validarReserva(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);

  let reserva;
  for (let intento = 1; ; intento++) {
    try {
      reserva = await crearReserva(v.datos);
      break;
    } catch (err) {
      // Dos administradores generaron el mismo folio al mismo tiempo: reintentar
      if (err && err.errno === 1062 && /folio|RES-/i.test(err.message) && intento < 3) continue;
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
router.post('/:id/pago', contexto('PAGO_REGISTRADO', 'Reservas', 'Reserva'), soloCampos(['monto', 'idMetodoPago', 'descripcion']), asincrono(async (req, res) => {
  const id = idValido(req.params.id);
  const v = V.validarPago(req.body);
  if (!v.ok) throw validacionEvadida(v.errores);

  const despues = await transaccion(async (cx) => {
    await P.pagarReserva(cx, id, v.datos);
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
function cambioDeEstado({ ruta, accion, desde, hacia, requierePago, soloPasadas, noPartidos, verbo, mensaje, antesDeCambiar }) {
  router.post(`/:id/${ruta}`, contexto(accion, 'Reservas', 'Reserva'), soloCampos([]), asincrono(async (req, res) => {
    const id = idValido(req.params.id);
    const { antes, despues } = await transaccion(async (cx) => {
      const estados = await idsEstados(cx);
      const [r] = await consulta(`
        SELECT r.idPago, e.Estado_Reserva AS estado,
               CASE WHEN r.Fecha_Reserva <= CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END AS yaLlego
          FROM Reserva r WITH (UPDLOCK, ROWLOCK) JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
         WHERE r.idReserva = @id`, { id }, cx);
      if (!r) throw new ErrorApp(404, 'La reserva no existe.');
      if (!desde.includes(r.estado)) throw new ErrorApp(409, `No se puede ${verbo} una reserva ${r.estado.toLowerCase()}.`);
      if (requierePago && !r.idPago) throw new ErrorApp(409, 'La reserva no tiene un pago registrado.');
      if (soloPasadas && !Number(r.yaLlego)) throw new ErrorApp(409, 'Solo se pueden finalizar reservas de hoy o de días anteriores.');
      const previo = await reservaPorId(id, cx);
      if (noPartidos && previo.idJuego) {
        throw new ErrorApp(409, `${previo.folio} es la reserva de un partido de "${previo.torneo}". ` +
          'Para cambiarlo o quitarlo usa Árbitros → Partidos programados (editar o eliminar el partido).');
      }
      if (antesDeCambiar) await antesDeCambiar(cx, previo);
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
  antesDeCambiar: (cx, r) => P.validarPago(cx, r.idPago),     // el pago queda "Validado" (lo mismo que en Pagos)
  mensaje: (r) => `Pago de ${r.folio} validado (${dinero(r.monto)}, ${r.metodo}). Reserva confirmada`
});
cambioDeEstado({
  ruta: 'cancelar', accion: 'RESERVA_CANCELADA', desde: ['Pendiente', 'Confirmada'], hacia: 'Cancelada', verbo: 'cancelar', noPartidos: true,
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

const { tipoReal } = P;

const recibirArchivo = express.raw({ type: Object.values(TIPOS).map((t) => t.mime), limit: TAMANO_MAXIMO });

/** Guarda el archivo (ya revisado) como comprobante del pago de la reserva. */
async function guardarComprobante(req, id, buffer, ext, origen) {
  const reserva = await reservaPorId(id);
  if (!reserva) throw new ErrorApp(404, 'La reserva no existe.');
  if (!reserva.idPago) throw new ErrorApp(409, 'Primero registra el pago de la reserva.');
  const r = await P.guardarComprobante(reserva.idPago, buffer, ext);
  await bitacora.registrar(req, {
    accion: 'COMPROBANTE_SUBIDO', modulo: 'Reservas', tabla: 'Pago', idRegistro: reserva.idPago,
    descripcion: `${r.reemplazo ? 'Reemplazó' : 'Subió'} el comprobante de pago de ${reserva.folio} ` +
      `(${ext.toUpperCase()}, ${(buffer.length / 1024).toFixed(0)} KB)${origen ? ` ${origen}` : ''}` +
      (r.reabierto ? '. El pago vuelve a quedar pendiente de validar.' : ''),
    despues: { folio: reserva.folio, tipo: ext, tamanoKB: Math.round(buffer.length / 1024), sha256: r.sha256 }
  });
  return reserva;
}

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
    await guardarComprobante(req, id, req.body, ext);
    res.json({ mensaje: 'Comprobante guardado.' });
  }));

/* [OWASP A10] Comprobante desde un enlace: el SERVIDOR descarga el archivo.
   Es justo el tipo de función que se usa para ataques SSRF, por eso la
   descarga pasa por src/seguridad/ssrf.js y cada intento bloqueado se registra. */
router.post('/:id/comprobante-url', contexto('COMPROBANTE_SUBIDO', 'Reservas', 'Pago'), soloCampos(['url']),
  asincrono(async (req, res) => {
    const id = idValido(req.params.id);
    const v = V.validarEnlace(req.body);
    if (!v.ok) throw validacionEvadida(v.errores);
    const enlace = ssrf.urlParaBitacora(v.datos.url);
    // Cómo lo escribió el usuario (127.0.0.1 puede venir "disfrazado" como 0x7f000001), sin usuario:contraseña
    const escrito = String(v.datos.url).replace(/\/\/[^/@\s]*@/, '//').slice(0, 200);

    const reserva = await reservaPorId(id);
    if (!reserva) throw new ErrorApp(404, 'La reserva no existe.');
    if (!reserva.idPago) throw new ErrorApp(409, 'Primero registra el pago de la reserva.');

    let descarga;
    try {
      descarga = await ssrf.descargarSeguro(v.datos.url);
    } catch (err) {
      if (err instanceof ssrf.ErrorSsrf) {
        await bitacora.registrar(req, {
          accion: 'INTENTO_SSRF', modulo: 'Seguridad', tabla: 'Pago', idRegistro: reserva.idPago, resultado: 'Fallo',
          descripcion: `[A10] Se bloqueó la descarga de ${enlace}${escrito !== enlace ? ` (escrito como ${escrito})` : ''} ` +
            `(${err.motivo}): ${err.message}`,
          despues: { url: enlace, escrito, motivo: err.motivo, ...err.detalle }
        });
        throw new ErrorApp(400, err.message, { errores: { url: err.message }, ssrf: true });
      }
      if (err instanceof ssrf.ErrorDescarga) throw new ErrorApp(400, err.message, { errores: { url: err.message } });
      throw err;
    }

    const ext = tipoReal(descarga.cuerpo);
    if (!ext) {
      throw new ErrorApp(415, 'El enlace no es una imagen PNG o JPG ni un PDF.', { errores: { url: 'El enlace no es una imagen PNG o JPG ni un PDF.' } });
    }
    await guardarComprobante(req, id, descarga.cuerpo, ext, `desde ${new URL(descarga.urlFinal).hostname} (IP ${descarga.ip})`);
    res.json({ mensaje: 'Comprobante descargado y guardado.' });
  }));

router.get('/:id/comprobante', asincrono(async (req, res, next) => {
  const id = idValido(req.params.id);
  const [f] = await consulta(`
    SELECT r.Folio AS folio, p.Comprobante AS archivo
      FROM Reserva r JOIN Pago p ON p.idPago = r.idPago
     WHERE r.idReserva = @id`, { id });
  if (!f || !f.archivo) throw new ErrorApp(404, 'Esta reserva no tiene comprobante.');
  await bitacora.registrar(req, {
    accion: 'COMPROBANTE_CONSULTADO', modulo: 'Reservas', tabla: 'Pago', idRegistro: id,
    descripcion: `Abrió el comprobante de pago de ${f.folio}`
  });
  await P.enviarComprobante(res, next, f.archivo, `comprobante_${f.folio}`);
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
  pendiente: 'Pendiente de pago', por_validar: 'Por validar', discrepancia: 'Con discrepancia', pagada: 'Pagada',
  confirmada: 'Confirmada', cancelada: 'Cancelada', finalizada: 'Finalizada'
};

router.get('/exportar', asincrono(async (req, res) => {
  const { where, parametros } = filtros(req.query);
  const filas = (await consulta(`${SELECT_RESERVA} ${where}
     ORDER BY r.Fecha_Reserva DESC, r.Hora_Inicio ASC OFFSET 0 ROWS FETCH NEXT 10000 ROWS ONLY`, parametros)).map(normalizar);

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
