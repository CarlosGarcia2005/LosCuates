// =====================================================================
//  API "Mis partidos" para usuarios con rol Árbitro (desde Mi perfil)
//  GET /mis-partidos · POST /asignaciones/:id/confirmar · POST /asignaciones/:id/rechazar
//  [OWASP A01] Cada árbitro solo ve y responde SUS asignaciones: el id se
//  compara con el de la sesión; si alguien intenta responder la de otro, se le expulsa.
// =====================================================================
const express = require('express');

const { consulta, transaccion } = require('../../config/db');
const V = require('../../public/js/validacion');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { soloCampos } = require('../seguridad/campos');
const { expulsar } = require('../seguridad/expulsion');
const { ErrorApp, validacionEvadida, asincrono } = require('../errores');

const textoFecha = (...args) => require('./arbitros').textoFecha(...args);
const router = express.Router();

const SELECT_MIA = `
  SELECT a.idAsignacion_Arbitro AS id, a.idUsuario, a.Rol_Arbitro AS puesto, a.Estado_Asignacion AS estado,
         a.Motivo_Rechazo AS motivo, a.Fecha_Asignacion AS fechaAsignacion, a.Fecha_Respuesta AS fechaRespuesta,
         j.idJuego, j.Jornada AS jornada, CONVERT(CHAR(10), j.Fecha_Juego, 23) AS fecha,
         LEFT(CONVERT(CHAR(8), r.Hora_Inicio, 108), 5) AS inicio, LEFT(CONVERT(CHAR(8), r.Hora_Fin, 108), 5) AS fin,
         c.Cancha AS cancha, tc.Tipo_Cancha AS superficie, t.Torneo AS torneo,
         el.Equipo AS local, ev.Equipo AS visitante,
         CASE WHEN j.Fecha_Juego < GETDATE() THEN 1 ELSE 0 END AS yaPaso
    FROM Asignacion_Arbitro a
    JOIN Juego j ON j.idJuego = a.idJuego
    JOIN Reserva r ON r.idReserva = j.idReserva
    JOIN Cancha c ON c.idCancha = j.idCancha
    JOIN Tipo_Cancha tc ON tc.idTipo_Cancha = c.idTipo_Cancha
    JOIN Torneo t ON t.idTorneo = j.idTorneo
    JOIN Equipo el ON el.idEquipo = j.idEquipo_Local
    JOIN Equipo ev ON ev.idEquipo = j.idEquipo_Visitante`;

const vista = (f) => ({ ...f, yaPaso: Number(f.yaPaso) === 1, puestoNombre: V.NOMBRES_PUESTO[f.puesto] || f.puesto });

router.get('/mis-partidos', asincrono(async (req, res) => {
  const filas = await consulta(`${SELECT_MIA}
     WHERE a.idUsuario = @yo AND j.Estado_Juego <> 'Cancelado' AND j.Fecha_Juego >= DATEADD(DAY, -30, GETDATE())
     ORDER BY j.Fecha_Juego`, { yo: req.usuario.id });
  const lista = filas.map(vista);
  const proximos = lista.filter((x) => !x.yaPaso);
  res.json({
    proximos,
    anteriores: lista.filter((x) => x.yaPaso).reverse(),
    resumen: {
      pendientes: proximos.filter((x) => x.estado === 'Pendiente').length,
      confirmados: proximos.filter((x) => x.estado === 'Confirmado').length,
      rechazados: proximos.filter((x) => x.estado === 'Rechazado').length
    }
  });
}));

/** Responde una asignación propia de un partido que todavía no se juega. */
function responder(estado) {
  const accion = estado === 'Confirmado' ? 'ASIGNACION_CONFIRMADA' : 'ASIGNACION_RECHAZADA';
  return [contexto(accion, 'Árbitros', 'Asignacion_Arbitro'), soloCampos(estado === 'Confirmado' ? [] : ['motivo']),
    asincrono(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1 || id > 4294967295) throw new ErrorApp(400, 'Asignación no válida.');
      let motivo = null;
      if (estado === 'Rechazado') {
        const v = V.validarRechazo(req.body);
        if (!v.ok) throw validacionEvadida(v.errores);
        motivo = v.datos.motivo;
      }

      const r = await transaccion(async (cx) => {
        const [a] = await consulta(`${SELECT_MIA.replace('FROM Asignacion_Arbitro a', 'FROM Asignacion_Arbitro a WITH (UPDLOCK, ROWLOCK)')}
           WHERE a.idAsignacion_Arbitro = @id`, { id }, cx);
        if (!a) throw new ErrorApp(404, 'Esa asignación ya no existe (quizá te reemplazaron).');
        if (Number(a.idUsuario) !== req.usuario.id) return { ajena: true };
        if (Number(a.yaPaso) === 1) throw new ErrorApp(409, 'Ese partido ya se jugó.');
        if (a.estado === estado) throw new ErrorApp(409, `Ya habías ${estado === 'Confirmado' ? 'confirmado' : 'rechazado'} este partido.`);
        await consulta(`UPDATE Asignacion_Arbitro SET Estado_Asignacion = @estado, Motivo_Rechazo = @motivo, Fecha_Respuesta = GETDATE()
                         WHERE idAsignacion_Arbitro = @id`, { estado, motivo, id }, cx);
        return { a: vista(a) };
      });

      if (r.ajena) {
        return expulsar(req, res, {
          motivo: `Intentó responder la asignación #${id}, que pertenece a otro árbitro`,
          datos: { asignacion: id }
        });
      }
      const a = r.a;
      // Mismo formato que usa el módulo Árbitros en la bitácora: "Sáb 21 nov · 10:00"
      const partido = `${a.local} vs ${a.visitante} (${textoFecha(a.fecha, a.inicio)}, ${a.cancha})`;
      await bitacora.registrar(req, {
        accion, modulo: 'Árbitros', tabla: 'Asignacion_Arbitro', idRegistro: id,
        descripcion: estado === 'Confirmado'
          ? `Confirmó que arbitrará ${partido} como ${a.puestoNombre}`
          : `Rechazó arbitrar ${partido} como ${a.puestoNombre}. Motivo: ${motivo}`,
        antes: { estado: a.estado }, despues: { estado, puesto: a.puestoNombre, motivo }
      });
      res.json({
        mensaje: estado === 'Confirmado' ? 'Confirmaste tu participación. ¡Gracias!'
          : 'Rechazaste el partido. El administrador ya lo ve para asignar a alguien más.'
      });
    })];
}

router.post('/asignaciones/:id/confirmar', ...responder('Confirmado'));
router.post('/asignaciones/:id/rechazar', ...responder('Rechazado'));

module.exports = router;
