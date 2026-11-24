// =====================================================================
//  API de Reportes y auditoría (solo administradores)
//    GET /?desde&hasta&metodo              ingresos, indicadores, distribución, movimientos y bitácora
//    GET /movimientos?…&pagina  ·  GET /bitacora?…&pagina
//    GET /exportar?formato=pdf|xlsx&…      descarga el reporte (queda en la bitácora)
//  Los ingresos usan la misma regla que Pagos y el Dashboard (servicios/pagos.js).
// =====================================================================
const express = require('express');

const { consulta } = require('../../config/db');
const V = require('../../public/js/validacion');
const bitacora = require('../bitacora');
const vigilancia = require('../seguridad/vigilancia');
const P = require('../servicios/pagos');
const { Pdf } = require('../reportes/pdf');
const { libro } = require('../reportes/xlsx');
const { ErrorApp, asincrono } = require('../errores');

const router = express.Router();
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const POR_PAGINA = 5;
const MAX_DIAS = 732;
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MODULOS = ['Reservas', 'Pagos', 'Canchas', 'Equipos', 'Árbitros', 'Limpieza', 'Usuarios', 'Roles', 'Reportes', 'Perfil', 'Bitácora'];

const dos = (n) => String(n).padStart(2, '0');
const fechaIso = (f) => `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
const aFecha = (iso) => { const [a, m, d] = iso.split('-').map(Number); return new Date(a, m - 1, d); };
const sumarDias = (iso, n) => { const f = aFecha(iso); f.setDate(f.getDate() + n); return fechaIso(f); };
const diasEntre = (a, b) => Math.round((aFecha(b) - aFecha(a)) / 86400000) + 1;
const lunesDe = (iso) => { const f = aFecha(iso); f.setDate(f.getDate() - ((f.getDay() + 6) % 7)); return fechaIso(f); };
const largo = (iso) => { const f = aFecha(iso); return `${f.getDate()} de ${MESES[f.getMonth()]} de ${f.getFullYear()}`; };
const variacion = (actual, anterior) => (anterior > 0 ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : null);
const pesos = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Lee y valida los filtros. Por defecto: los últimos 7 días. */
function filtros(query) {
  const hoy = fechaIso(new Date());
  let hasta = FECHA.test(query.hasta || '') && V.fechaReal(query.hasta) ? query.hasta : hoy;
  let desde = FECHA.test(query.desde || '') && V.fechaReal(query.desde) ? query.desde : sumarDias(hasta, -6);
  if (desde > hasta) [desde, hasta] = [hasta, desde];
  if (diasEntre(desde, hasta) > MAX_DIAS) throw new ErrorApp(400, 'El rango no puede ser mayor a 2 años.');
  const idMetodo = Number(query.metodo);
  return { desde, hasta, idMetodo: Number.isInteger(idMetodo) && idMetodo > 0 && idMetodo < 256 ? idMetodo : null };
}

/** Agrupa por día (≤ 31 días), por semana (≤ 120 días) o por mes. */
function agrupacionDe(dias) { return dias <= 31 ? 'dia' : dias <= 120 ? 'semana' : 'mes'; }

function serieVacia(desde, hasta, agrupacion) {
  const cubetas = [];
  if (agrupacion === 'dia') {
    for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
      const d = aFecha(f);
      cubetas.push({ clave: f, desde: f, hasta: f, etiqueta: `${DIAS[d.getDay()]} ${d.getDate()}`,
        detalle: `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`, total: 0, pagos: 0 });
    }
  } else if (agrupacion === 'semana') {
    for (let f = lunesDe(desde); f <= hasta; f = sumarDias(f, 7)) {
      const ini = f < desde ? desde : f;
      const fin = sumarDias(f, 6) > hasta ? hasta : sumarDias(f, 6);
      const a = aFecha(ini), b = aFecha(fin);
      cubetas.push({ clave: f, desde: ini, hasta: fin, etiqueta: `${a.getDate()} ${MES_CORTO[a.getMonth()]}`,
        detalle: `Semana del ${a.getDate()} ${MES_CORTO[a.getMonth()]} al ${b.getDate()} ${MES_CORTO[b.getMonth()]}`, total: 0, pagos: 0 });
    }
  } else {
    const a = aFecha(desde);
    for (let f = new Date(a.getFullYear(), a.getMonth(), 1); fechaIso(f) <= hasta; f = new Date(f.getFullYear(), f.getMonth() + 1, 1)) {
      const ini = fechaIso(f) < desde ? desde : fechaIso(f);
      const ultimo = fechaIso(new Date(f.getFullYear(), f.getMonth() + 1, 0));
      cubetas.push({ clave: fechaIso(f).slice(0, 7), desde: ini, hasta: ultimo > hasta ? hasta : ultimo,
        etiqueta: `${MES_CORTO[f.getMonth()].replace(/^./, (c) => c.toUpperCase())}${a.getFullYear() !== aFecha(hasta).getFullYear() ? ` ${String(f.getFullYear()).slice(2)}` : ''}`,
        detalle: `${MESES[f.getMonth()].replace(/^./, (c) => c.toUpperCase())} ${f.getFullYear()}`, total: 0, pagos: 0 });
    }
  }
  return cubetas;
}

const FROM_INGRESOS = `
    FROM Pago p
    LEFT JOIN Reserva r ON r.idPago = p.idPago
    LEFT JOIN Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
    LEFT JOIN Cancha c ON c.idCancha = r.idCancha
    LEFT JOIN Juego jg ON jg.idReserva = r.idReserva
    LEFT JOIN Inscripcion_Torneo it ON it.idPago = p.idPago`;

/**
 * Totales del periodo. Todo sale de la MISMA base (pagos que cuentan como ingreso, por fecha de pago),
 * para que no haya discrepancias: Número de reservas = reservas (incluye las de partidos) pagadas
 * en el periodo, y Pago promedio por reserva = ingresos de esas reservas ÷ ese número.
 */
async function totales(desde, hasta, idMetodo) {
  const [ing] = await consulta(`
    SELECT ISNULL(SUM(p.Monto), 0) AS ingresos, COUNT(*) AS pagos,
           ISNULL(SUM(CASE WHEN r.idReserva IS NOT NULL THEN p.Monto ELSE 0 END), 0) AS ingresosReservas,
           COUNT(DISTINCT r.idReserva) AS reservas
      ${FROM_INGRESOS}
     WHERE p.Fecha_Pago >= @desde AND p.Fecha_Pago < @hastaSig AND ${P.SQL_INGRESO}
       AND (@idMetodo IS NULL OR p.idMetodo_Pago = @idMetodo)`,
  { desde, hastaSig: sumarDias(hasta, 1), idMetodo });
  const reservas = Number(ing.reservas || 0);
  return {
    ingresos: Number(ing.ingresos), pagos: Number(ing.pagos), reservas,
    promedio: reservas ? Math.round((Number(ing.ingresosReservas) / reservas) * 100) / 100 : 0
  };
}

const SQL_MOVIMIENTOS = (where) => `${P.SELECT_PAGO}
   WHERE p.Fecha_Pago >= @desde AND p.Fecha_Pago < @hastaSig AND (@idMetodo IS NULL OR p.idMetodo_Pago = @idMetodo) ${where}`;

async function movimientos({ desde, hasta, idMetodo }, { pagina = 1, limite = POR_PAGINA } = {}) {
  const parametros = { desde, hastaSig: sumarDias(hasta, 1), idMetodo, tomar: limite, saltar: (pagina - 1) * limite };
  const [conteo, filas] = await consulta(`
    SELECT COUNT(*) AS total ${P.SELECT_PAGO.slice(P.SELECT_PAGO.indexOf('FROM Pago p'))}
     WHERE p.Fecha_Pago >= @desde AND p.Fecha_Pago < @hastaSig AND (@idMetodo IS NULL OR p.idMetodo_Pago = @idMetodo);
    ${SQL_MOVIMIENTOS('')} ORDER BY p.Fecha_Pago DESC, p.idPago DESC OFFSET @saltar ROWS FETCH NEXT @tomar ROWS ONLY;`, parametros);
  const total = Number(conteo[0].total);
  return { registros: filas.map(P.normalizarPago), total, pagina, paginas: Math.max(1, Math.ceil(total / limite)) };
}

async function auditoria({ desde, hasta }, { pagina = 1, limite = POR_PAGINA } = {}) {
  const parametros = { desde, hastaSig: sumarDias(hasta, 1), modulos: MODULOS, tomar: limite, saltar: (pagina - 1) * limite };
  const [conteo, filas] = await consulta(`
    SELECT COUNT(*) AS total FROM Bitacora b WHERE b.Fecha >= @desde AND b.Fecha < @hastaSig AND b.Modulo IN (@modulos);
    SELECT b.idBitacora, b.Fecha, b.Accion, b.Modulo, b.Descripcion, b.Resultado,
           COALESCE(u.Nombre + ' ' + u.Apellido_Paterno, b.Correo_Usuario, 'Sistema') AS usuario
      FROM Bitacora b LEFT JOIN Usuario u ON u.idUsuario = b.idUsuario
     WHERE b.Fecha >= @desde AND b.Fecha < @hastaSig AND b.Modulo IN (@modulos)
     ORDER BY b.idBitacora DESC OFFSET @saltar ROWS FETCH NEXT @tomar ROWS ONLY;`, parametros);
  const total = Number(conteo[0].total);
  return { registros: filas, total, pagina, paginas: Math.max(1, Math.ceil(total / limite)) };
}

/** ¿La bitácora sigue íntegra? (usa la última revisión si tiene menos de 10 minutos) */
async function integridad() {
  const ultimo = vigilancia.ultimo;
  const reciente = ultimo.fecha && Date.now() - new Date(ultimo.fecha).getTime() < 10 * 60 * 1000;
  try {
    const r = reciente && ultimo.bitacora ? ultimo.bitacora : await vigilancia.revisarBitacora();
    return { protegida: Boolean(r && r.ok), pendientes: r ? (r.pendientes || 0) : 0, firmados: r ? (r.firmados || 0) : 0 };
  } catch {
    return { protegida: false, pendientes: null, firmados: 0 };
  }
}

/** Todo lo que muestran la pantalla, el PDF y el Excel. */
async function datosReporte(f, { completo = false } = {}) {
  const dias = diasEntre(f.desde, f.hasta);
  const agrupacion = agrupacionDe(dias);
  const params = { desde: f.desde, hastaSig: sumarDias(f.hasta, 1), idMetodo: f.idMetodo };

  const [porDia, porGrupo, metodos] = await consulta(`
    SELECT CONVERT(CHAR(10), p.Fecha_Pago, 23) AS dia, SUM(p.Monto) AS total, COUNT(*) AS pagos
      ${FROM_INGRESOS}
     WHERE p.Fecha_Pago >= @desde AND p.Fecha_Pago < @hastaSig AND ${P.SQL_INGRESO}
       AND (@idMetodo IS NULL OR p.idMetodo_Pago = @idMetodo)
     GROUP BY CONVERT(CHAR(10), p.Fecha_Pago, 23);
    SELECT x.grupo, SUM(x.monto) AS total
      FROM (SELECT CASE WHEN jg.idJuego IS NOT NULL OR (r.idReserva IS NULL AND it.idTorneo IS NOT NULL) THEN '__torneos'
                        WHEN c.idCancha IS NULL THEN '__otros' ELSE c.Cancha END AS grupo,
                   p.Monto AS monto
              ${FROM_INGRESOS}
             WHERE p.Fecha_Pago >= @desde AND p.Fecha_Pago < @hastaSig AND ${P.SQL_INGRESO}
               AND (@idMetodo IS NULL OR p.idMetodo_Pago = @idMetodo)) x
     GROUP BY x.grupo;
    SELECT idMetodo_Pago AS id, Metodo_Pago AS nombre FROM Metodo_Pago ORDER BY idMetodo_Pago;`, params);

  // Serie
  const serie = serieVacia(f.desde, f.hasta, agrupacion);
  for (const fila of porDia) {
    const cubeta = serie.find((c) => fila.dia >= c.desde && fila.dia <= c.hasta);
    if (cubeta) { cubeta.total += Number(fila.total); cubeta.pagos += Number(fila.pagos); }
  }
  serie.forEach((c) => { c.total = Math.round(c.total * 100) / 100; });

  // Indicadores contra el periodo anterior del mismo tamaño
  const anteriorHasta = sumarDias(f.desde, -1);
  const anteriorDesde = sumarDias(anteriorHasta, -(dias - 1));
  const [actual, anterior] = await Promise.all([totales(f.desde, f.hasta, f.idMetodo), totales(anteriorDesde, anteriorHasta, f.idMetodo)]);

  // Distribución: las 3 canchas que más ingresan, Torneos y Otros (el resto)
  const grupos = porGrupo.map((g) => ({ grupo: g.grupo, total: Number(g.total) }));
  const torneos = grupos.filter((g) => g.grupo === '__torneos').reduce((t, g) => t + g.total, 0);
  const canchas = grupos.filter((g) => !g.grupo.startsWith('__')).sort((a, b) => b.total - a.total);
  const otros = grupos.filter((g) => g.grupo === '__otros').reduce((t, g) => t + g.total, 0) +
    canchas.slice(3).reduce((t, g) => t + g.total, 0);
  const totalDist = grupos.reduce((t, g) => t + g.total, 0);
  const distribucion = [
    ...canchas.slice(0, 3).map((g) => ({ nombre: g.grupo, total: g.total })),
    { nombre: 'Torneos', total: torneos, tipo: 'torneos' },
    { nombre: 'Otros', total: otros, tipo: 'otros' }
  ].map((d) => ({ ...d, total: Math.round(d.total * 100) / 100 }))
    // "Otros" solo aparece cuando tiene ingresos (las canchas y Torneos siempre se muestran)
    .filter((d) => d.tipo !== 'otros' || d.total > 0);
  // Porcentajes con un decimal que siempre suman exactamente 100 % (residuo mayor)
  if (totalDist > 0) {
    const base = distribucion.map((d) => { const v = (d.total / totalDist) * 1000; return { d, n: Math.floor(v), resto: v - Math.floor(v) }; });
    let falta = 1000 - base.reduce((t, b) => t + b.n, 0);
    [...base].sort((a, b) => b.resto - a.resto).forEach((b) => { if (falta > 0) { b.n += 1; falta -= 1; } });
    base.forEach((b) => { b.d.pct = b.n / 10; });
  } else distribucion.forEach((d) => { d.pct = 0; });

  const nombreMetodo = f.idMetodo ? (metodos.find((m) => Number(m.id) === f.idMetodo) || {}).nombre || 'Método' : 'Todos los métodos';
  const comparacion = dias === 7 ? 'vs semana anterior' : dias >= 28 && dias <= 31 ? 'vs mes anterior' : 'vs periodo anterior';

  return {
    filtros: { ...f, dias, agrupacion, nombreMetodo, desdeTexto: largo(f.desde), hastaTexto: largo(f.hasta) },
    actualizado: new Date().toISOString(),
    metodos,
    serie,
    indicadores: {
      comparacion,
      ingresos: actual.ingresos, ingresosVariacion: variacion(actual.ingresos, anterior.ingresos),
      promedio: actual.promedio, promedioVariacion: variacion(actual.promedio, anterior.promedio),
      reservas: actual.reservas, reservasVariacion: variacion(actual.reservas, anterior.reservas),
      pagos: actual.pagos
    },
    distribucion, totalDistribucion: Math.round(totalDist * 100) / 100,
    movimientos: await movimientos(f, completo ? { limite: 1000 } : {}),
    bitacora: await auditoria(f, completo ? { limite: 500 } : {}),
    integridad: await integridad()
  };
}

/* ------------------------------------------------------------------ */
router.get('/', asincrono(async (req, res) => {
  res.json(await datosReporte(filtros(req.query)));
}));

router.get('/movimientos', asincrono(async (req, res) => {
  const pagina = Math.max(1, Math.min(10000, parseInt(req.query.pagina, 10) || 1));
  res.json(await movimientos(filtros(req.query), { pagina }));
}));

router.get('/bitacora', asincrono(async (req, res) => {
  const pagina = Math.max(1, Math.min(10000, parseInt(req.query.pagina, 10) || 1));
  res.json(await auditoria(filtros(req.query), { pagina }));
}));

/* ------------------------------------------------------------------ */
/*  Exportar                                                           */
/* ------------------------------------------------------------------ */
const ESTADO_TEXTO = { Pagado: 'Pagado', Validado: 'Pagado', Pendiente: 'Pendiente', 'Con discrepancia': 'Con discrepancia' };
const fechaHoraLocal = (v) => {
  const d = v instanceof Date ? v : new Date(v);
  return { fecha: `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()}`, hora: `${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}` };
};
const horario = (m) => (m.inicio ? `${m.inicio} - ${m.fin}` : '—');

function generarPdf(d) {
  const pdf = new Pdf({ titulo: 'Reportes y auditoría · Rancho Seco' });
  const VERDE = '#0d3b1c', VERDE_M = '#15803d', GRIS = '#6b7280', BORDE = '#e3e8e5';
  const M = 40, W = 612 - 2 * M;

  const cabecera = () => {
    pdf.rect(0, 0, 612, 64, { relleno: VERDE });
    pdf.texto(M, 28, 'RANCHO SECO · PANEL ADMINISTRATIVO', { tam: 8, negrita: true, color: '#a7c7b0' });
    pdf.texto(M, 48, 'Reportes y auditoría', { tam: 18, negrita: true, color: '#ffffff' });
    const act = fechaHoraLocal(d.actualizado);
    pdf.texto(612 - M, 28, 'ÚLTIMA ACTUALIZACIÓN', { tam: 7, negrita: true, color: '#a7c7b0', alinear: 'der' });
    pdf.texto(612 - M, 46, `${act.fecha} · ${act.hora.slice(0, 5)}`, { tam: 11, negrita: true, color: '#ffffff', alinear: 'der' });
  };
  let y;
  const nuevaPagina = () => { pdf.nuevaPagina(); cabecera(); y = 88; };
  cabecera();
  y = 88;

  pdf.texto(M, y, `Periodo: ${d.filtros.desdeTexto} — ${d.filtros.hastaTexto}  ·  ${d.filtros.nombreMetodo}`, { tam: 10, color: '#374151' });
  y += 16;

  // Indicadores
  const k = d.indicadores;
  const tarjetas = [
    ['Total ingresos', pesos(k.ingresos), k.ingresosVariacion],
    ['Pago promedio por reserva', pesos(k.promedio), k.promedioVariacion],
    ['Número de reservas', String(k.reservas), k.reservasVariacion]
  ];
  const anchoT = (W - 20) / 3;
  tarjetas.forEach(([t, v, vari], i) => {
    const x = M + i * (anchoT + 10);
    pdf.rect(x, y, anchoT, 62, { relleno: '#f8faf9', borde: BORDE, radio: 6 });
    pdf.texto(x + 12, y + 18, t, { tam: 8.5, color: GRIS });
    pdf.texto(x + 12, y + 40, v, { tam: 16, negrita: true });
    pdf.texto(x + 12, y + 54, vari === null ? `Sin datos ${k.comparacion}` : `${vari >= 0 ? '+' : ''}${vari}% ${k.comparacion}`,
      { tam: 7.5, color: vari === null ? GRIS : vari >= 0 ? VERDE_M : '#b91c1c' });
  });
  y += 78;

  // Gráfica de ingresos
  const titulo = { dia: 'Ingresos diarios', semana: 'Ingresos semanales', mes: 'Ingresos mensuales' }[d.filtros.agrupacion];
  pdf.rect(M, y, W, 210, { borde: BORDE, radio: 6 });
  pdf.texto(M + 14, y + 18, 'RENDIMIENTO', { tam: 7, negrita: true, color: VERDE_M });
  pdf.texto(M + 14, y + 34, titulo, { tam: 12, negrita: true });
  const gx = M + 62, gy = y + 50, gw = W - 82, gh = 128;
  const max = Math.max(...d.serie.map((s) => s.total), 0);
  const paso = (() => { const crudo = max / 5 || 1; const mag = 10 ** Math.floor(Math.log10(crudo)); return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= crudo); })();
  const tope = Math.max(paso * 5, 1);
  for (let i = 0; i <= 5; i++) {
    const yy = gy + gh - (gh * i) / 5;
    pdf.linea(gx, yy, gx + gw, yy, { color: '#edf1ee', ancho: 0.7 });
    pdf.texto(gx - 8, yy + 3, `$${Math.round((tope * i) / 5).toLocaleString('es-MX')}`, { tam: 7, color: GRIS, alinear: 'der' });
  }
  const n = d.serie.length;
  const xDe = (i) => (n === 1 ? gx + gw / 2 : gx + (gw * i) / (n - 1));
  const puntos = d.serie.map((s, i) => ({ x: xDe(i), y: gy + gh - (gh * s.total) / tope }));
  pdf.curva(puntos, { color: '#dcfce7', ancho: 9 });      // halo verde claro, como en la pantalla
  pdf.curva(puntos, { color: VERDE_M, ancho: 2 });
  const cada = Math.max(1, Math.ceil(n / 12));
  puntos.forEach((p, i) => {
    if (n <= 31) pdf.circulo(p.x, p.y, 2.6, { relleno: '#ffffff', borde: VERDE_M, ancho: 1.4 });
    if (i % cada === 0 || i === n - 1) pdf.texto(p.x, gy + gh + 14, d.serie[i].etiqueta, { tam: 7, color: GRIS, alinear: 'centro' });
  });
  y += 226;

  // Distribución por cancha (dona + tabla)
  pdf.rect(M, y, W, 170, { borde: BORDE, radio: 6 });
  pdf.texto(M + 14, y + 18, 'DISTRIBUCIÓN', { tam: 7, negrita: true, color: VERDE_M });
  pdf.texto(M + 14, y + 34, 'Ingresos por cancha', { tam: 12, negrita: true });
  // Mismos colores que la dona del panel (public/js/reportes.js): canchas en verdes, Torneos verde claro, Otros gris
  const COLORES_CANCHA = ['#0b3b1e', '#15803d', '#22c55e'];
  const colorDe = (s, i) => (s.tipo === 'torneos' ? '#86efac' : s.tipo === 'otros' ? '#94a3b8' : COLORES_CANCHA[i] || '#94a3b8');
  const cx = M + 92, cy = y + 104, radio = 46;
  let acumulado = 0;
  if (d.totalDistribucion > 0) {
    d.distribucion.forEach((s, i) => {
      const f = s.total / d.totalDistribucion;
      pdf.arcoDona(cx, cy, radio, 18, acumulado, acumulado + f, colorDe(s, i));
      acumulado += f;
    });
  } else {
    pdf.circulo(cx, cy, radio, { borde: '#e5e7eb', ancho: 18 });
  }
  pdf.texto(cx, cy + 2, pesos(d.totalDistribucion).replace(/\.\d\d$/, ''), { tam: 10, negrita: true, alinear: 'centro' });
  pdf.texto(cx, cy + 13, 'Total', { tam: 7, color: GRIS, alinear: 'centro' });
  const tx = M + 200, tw = W - 214;
  pdf.texto(tx, y + 52, 'CANCHA', { tam: 7, negrita: true, color: GRIS });
  pdf.texto(tx + tw - 70, y + 52, 'INGRESOS', { tam: 7, negrita: true, color: GRIS, alinear: 'der' });
  pdf.texto(tx + tw, y + 52, '%', { tam: 7, negrita: true, color: GRIS, alinear: 'der' });
  d.distribucion.forEach((s, i) => {
    const yy = y + 70 + i * 16;
    pdf.rect(tx, yy - 7, 7, 7, { relleno: colorDe(s, i) });
    pdf.texto(tx + 14, yy, s.nombre, { tam: 8.5, maxAncho: tw - 170 });
    pdf.texto(tx + tw - 70, yy, pesos(s.total), { tam: 8.5, negrita: true, alinear: 'der' });
    pdf.texto(tx + tw, yy, `${s.pct}%`, { tam: 8.5, color: GRIS, alinear: 'der' });
  });
  const yt = y + 70 + d.distribucion.length * 16;
  pdf.linea(tx, yt - 9, tx + tw, yt - 9, { color: BORDE });
  pdf.texto(tx, yt + 2, 'Total', { tam: 8.5, negrita: true });
  pdf.texto(tx + tw - 70, yt + 2, pesos(d.totalDistribucion), { tam: 8.5, negrita: true, alinear: 'der' });
  pdf.texto(tx + tw, yt + 2, d.totalDistribucion ? '100%' : '0%', { tam: 8.5, negrita: true, alinear: 'der' });

  // Tablas
  const tabla = (tituloTabla, kicker, columnas, filas, vacio) => {
    nuevaPagina();
    pdf.texto(M, y, kicker, { tam: 7, negrita: true, color: VERDE_M });
    pdf.texto(M, y + 16, tituloTabla, { tam: 13, negrita: true });
    y += 30;
    const encabezado = () => {
      pdf.rect(M, y, W, 20, { relleno: '#f3f6f4' });
      let x = M + 8;
      for (const c of columnas) {
        pdf.texto(c.der ? x + c.w - 10 : x, y + 13, c.t, { tam: 7, negrita: true, color: GRIS, alinear: c.der ? 'der' : 'izq' });
        x += c.w;
      }
      y += 20;
    };
    encabezado();
    if (!filas.length) { pdf.texto(M + W / 2, y + 24, vacio, { tam: 9, color: GRIS, alinear: 'centro' }); y += 40; return; }
    for (const fila of filas) {
      if (y > 742) { nuevaPagina(); encabezado(); }
      let x = M + 8;
      fila.forEach((v, i) => {
        const c = columnas[i];
        const color = typeof v === 'object' && v ? v.color : '#111827';
        const texto = typeof v === 'object' && v ? v.t : v;
        pdf.texto(c.der ? x + c.w - 10 : x, y + 13, texto ?? '—', { tam: 7.8, color, negrita: Boolean(c.negrita), alinear: c.der ? 'der' : 'izq', maxAncho: c.w - 12 });
        x += c.w;
      });
      pdf.linea(M, y + 20, M + W, y + 20, { color: '#eef1ef', ancho: 0.6 });
      y += 20;
    }
  };

  tabla('Movimientos', 'TRANSACCIONES', [
    { t: 'FECHA', w: 62 }, { t: 'CLIENTE', w: 112 }, { t: 'CANCHA', w: 72 }, { t: 'HORARIO', w: 70 },
    { t: 'MÉTODO', w: 76 }, { t: 'MONTO', w: 70, der: true, negrita: true }, { t: 'ESTADO', w: 70 }
  ], d.movimientos.registros.map((m) => {
    const est = ESTADO_TEXTO[m.estadoPago] || m.estadoPago;
    return [fechaHoraLocal(m.fechaPago).fecha, m.cliente, m.cancha || m.concepto, horario(m), m.metodo, pesos(m.monto),
      { t: est, color: est === 'Pagado' ? VERDE_M : est === 'Pendiente' ? '#a16207' : '#b91c1c' }];
  }), 'No hay movimientos en este periodo.');

  tabla(`Bitácora de auditoría${d.integridad.protegida ? ' · Registro protegido' : ''}`, 'RNF_28 · TRAZABILIDAD', [
    { t: 'USUARIO', w: 110 }, { t: 'FECHA', w: 62 }, { t: 'HORA', w: 50 }, { t: 'ACCIÓN', w: 238 }, { t: 'MÓDULO', w: 72 }
  ], d.bitacora.registros.map((b) => {
    const fh = fechaHoraLocal(b.Fecha);
    return [b.usuario, fh.fecha, fh.hora, b.Descripcion, b.Modulo];
  }), 'No hay movimientos en la bitácora en este periodo.');

  // Pies de página
  const total = pdf.numeroPaginas;
  for (let i = 0; i < total; i++) {
    pdf.irA(i);
    pdf.linea(M, 770, 612 - M, 770, { color: BORDE, ancho: 0.6 });
    pdf.texto(M, 782, 'Gestor Deportivo Rancho Seco · Reporte generado desde el panel administrativo', { tam: 7, color: GRIS });
    pdf.texto(612 - M, 782, `Página ${i + 1} de ${total}`, { tam: 7, color: GRIS, alinear: 'der' });
  }
  return pdf.generar();
}

function generarExcel(d) {
  const f = d.filtros;
  const resumen = {
    nombre: 'Resumen', anchos: [34, 20, 22],
    filas: [
      [{ v: 'Reportes y auditoría · Rancho Seco', estilo: 'titulo' }],
      [{ v: `Periodo: ${f.desdeTexto} — ${f.hastaTexto} · ${f.nombreMetodo}`, estilo: 'nota' }],
      [],
      [{ v: 'Indicador', estilo: 'encabezado' }, { v: 'Valor', estilo: 'encabezado' }, { v: `Variación ${d.indicadores.comparacion}`, estilo: 'encabezado' }],
      ['Total ingresos', { v: d.indicadores.ingresos, estilo: 'dinero' }, d.indicadores.ingresosVariacion === null ? 'Sin datos' : { v: d.indicadores.ingresosVariacion / 100, estilo: 'porcentaje' }],
      ['Pago promedio por reserva', { v: d.indicadores.promedio, estilo: 'dinero' }, d.indicadores.promedioVariacion === null ? 'Sin datos' : { v: d.indicadores.promedioVariacion / 100, estilo: 'porcentaje' }],
      ['Número de reservas', d.indicadores.reservas, d.indicadores.reservasVariacion === null ? 'Sin datos' : { v: d.indicadores.reservasVariacion / 100, estilo: 'porcentaje' }],
      ['Pagos confirmados', d.indicadores.pagos, ''],
      [],
      [{ v: 'Bitácora', estilo: 'negrita' }, d.integridad.protegida ? 'Registro protegido (cadena íntegra)' : 'Revisar integridad en Seguridad'],
      [{ v: 'Generado', estilo: 'negrita' }, fechaHoraLocal(d.actualizado).fecha + ' ' + fechaHoraLocal(d.actualizado).hora]
    ]
  };
  const serie = {
    nombre: { dia: 'Ingresos diarios', semana: 'Ingresos semanales', mes: 'Ingresos mensuales' }[f.agrupacion],
    anchos: [30, 18, 12], congelar: 1, filtro: `A1:C${d.serie.length + 1}`,
    filas: [[{ v: 'Periodo', estilo: 'encabezado' }, { v: 'Ingresos', estilo: 'encabezado' }, { v: 'Pagos', estilo: 'encabezado' }],
      ...d.serie.map((s) => [s.detalle, { v: s.total, estilo: 'dinero' }, s.pagos]),
      [{ v: 'Total', estilo: 'negrita' }, { v: d.serie.reduce((t, s) => t + s.total, 0), estilo: 'dineroTotal' }, d.serie.reduce((t, s) => t + s.pagos, 0)]]
  };
  const cancha = {
    nombre: 'Por cancha', anchos: [26, 18, 10],
    filas: [[{ v: 'Cancha', estilo: 'encabezado' }, { v: 'Ingresos', estilo: 'encabezado' }, { v: '%', estilo: 'encabezado' }],
      ...d.distribucion.map((s) => [s.nombre, { v: s.total, estilo: 'dinero' }, { v: s.pct / 100, estilo: 'porcentaje' }]),
      [{ v: 'Total', estilo: 'negrita' }, { v: d.totalDistribucion, estilo: 'dineroTotal' }, { v: d.totalDistribucion ? 1 : 0, estilo: 'porcentaje' }]]
  };
  const movs = d.movimientos.registros;
  const movimientosHoja = {
    nombre: 'Movimientos', anchos: [12, 26, 22, 14, 16, 14, 16, 16, 18], congelar: 1, filtro: `A1:I${movs.length + 1}`,
    filas: [['Fecha', 'Cliente', 'Equipo', 'Reserva', 'Cancha', 'Horario', 'Método', 'Monto', 'Estado'].map((t) => ({ v: t, estilo: 'encabezado' })),
      ...movs.map((m) => [fechaHoraLocal(m.fechaPago).fecha, m.cliente, m.equipo || '', m.folio || m.concepto, m.cancha || '', horario(m), m.metodo,
        { v: m.monto, estilo: 'dinero' }, ESTADO_TEXTO[m.estadoPago] || m.estadoPago])]
  };
  const bit = d.bitacora.registros;
  const bitacoraHoja = {
    nombre: 'Bitácora', anchos: [26, 12, 10, 70, 14], congelar: 1, filtro: `A1:E${bit.length + 1}`,
    filas: [['Usuario', 'Fecha', 'Hora', 'Acción', 'Módulo'].map((t) => ({ v: t, estilo: 'encabezado' })),
      ...bit.map((b) => { const fh = fechaHoraLocal(b.Fecha); return [b.usuario, fh.fecha, fh.hora, b.Descripcion, b.Modulo]; })]
  };
  return libro([resumen, serie, cancha, movimientosHoja, bitacoraHoja], { titulo: 'Reportes y auditoría · Rancho Seco' });
}

router.get('/exportar', asincrono(async (req, res) => {
  const formato = req.query.formato === 'xlsx' ? 'xlsx' : req.query.formato === 'pdf' ? 'pdf' : null;
  if (!formato) throw new ErrorApp(400, 'Formato no válido.');
  const f = filtros(req.query);
  const d = await datosReporte(f, { completo: true });
  const archivo = formato === 'pdf' ? generarPdf(d) : generarExcel(d);
  await bitacora.registrar(req, {
    accion: 'REPORTE_EXPORTADO', modulo: 'Reportes', tabla: null,
    descripcion: `Exportó reporte de ingresos (${formato.toUpperCase()}) del ${f.desde} al ${f.hasta} · ${d.filtros.nombreMetodo}`,
    despues: { formato, desde: f.desde, hasta: f.hasta, metodo: d.filtros.nombreMetodo, movimientos: d.movimientos.total }
  });
  const nombre = `reporte_ingresos_${f.desde}_a_${f.hasta}.${formato}`;
  res.setHeader('Content-Type', formato === 'pdf' ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.setHeader('Content-Length', archivo.length);
  res.end(archivo);
}));

module.exports = router;
module.exports.serieVacia = serieVacia;
module.exports.agrupacionDe = agrupacionDe;
module.exports._generarPdf = generarPdf;
module.exports._generarExcel = generarExcel;
