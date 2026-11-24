/* =====================================================================
   Panel de administración · Pagos
   La reserva de cada pago es automática: la de Reservas o la que aparta
   la cancha para un partido de torneo. "Registrar pago" abre una ventana.
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, mostrarErrores, limpiarErrores, limpiarAlEscribir, datosFormulario, ocupado, dinero, numero, iniciales } = window.App;
  const { confirmar } = window.Panel;
  const { icono, paginacion, abrirEmergente, cerrarEmergente, F, opciones } = window.UI;
  const V = window.Validacion;
  const $ = (id) => document.getElementById(id);

  const TIPOS_ARCHIVO = ['image/png', 'image/jpeg', 'application/pdf'];
  const estado = { fecha: null, pagina: 1, todos: false, datos: null, catalogos: null, pagoArchivo: null, pagoDiscrepancia: null };

  /* -------------------------------------------------------------- */
  /*  Apariencia                                                     */
  /* -------------------------------------------------------------- */
  const claseMetodo = (m) => (/efectivo/i.test(m) ? 'metodo--efectivo' : /transfer/i.test(m) ? 'metodo--transferencia' : 'metodo--tarjeta');
  const metodoChip = (m) => h('span', { class: `metodo-chip ${claseMetodo(m)}` }, m);
  function estadoPago(e) {
    const mapa = {
      Pagado: ['pago--pagado', 'check'], Validado: ['pago--validado', 'check'],
      Pendiente: ['pago--pendiente', 'reloj'], 'Con discrepancia': ['pago--discrepancia', 'exclamacion']
    };
    const [clase, ic] = mapa[e] || ['pago--sin', 'info'];
    return h('span', { class: `pago-estado ${clase}` }, icono(ic), e);
  }
  const variacion = (v, texto) => (v === null
    ? h('small', null, `Sin datos ${texto} para comparar`)
    : h('small', { class: v >= 0 ? 'sube' : 'baja' }, `${v >= 0 ? '↑' : '↓'} ${Math.abs(v)}% ${texto}`));

  function kpi(etiqueta, valor, detalle, ic, clase) {
    return h('article', { class: 'tarjeta kpi' },
      h('span', null, etiqueta), h('span', { class: `kpi__icono ${clase}` }, icono(ic)), h('strong', null, valor), detalle);
  }

  /* -------------------------------------------------------------- */
  /*  Carga                                                          */
  /* -------------------------------------------------------------- */
  async function cargar() {
    if (!estado.fecha) estado.fecha = F.hoy();
    $('pgFecha').value = estado.fecha;
    $('pgFechaTexto').textContent = F.chip(estado.fecha);
    const p = new URLSearchParams({ fecha: estado.fecha, pagina: estado.pagina });
    if (estado.todos) p.set('todos', '1');
    const q = $('pgBuscar').value.trim();
    if (q) p.set('q', q);
    if ($('pgEstado').value) p.set('estado', $('pgEstado').value);
    const r = await api('GET', `/api/admin/pagos?${p}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const d = r.datos;
    estado.datos = d;
    const k = d.indicadores;
    const comparar = d.esHoy ? 'vs ayer' : 'vs el día anterior';

    $('pgKpis').replaceChildren(
      kpi(d.esHoy ? 'Pagos del día' : `Pagos del ${F.corta(d.fecha)}`, numero(k.pagosDia), variacion(k.pagosVariacion, comparar), 'recibo', 'kpi__icono--verde'),
      kpi('Por validar', numero(k.porValidar),
        h('small', null, k.porValidar ? `${k.requierenRevision} requiere${k.requierenRevision === 1 ? '' : 'n'} revisión${k.conDiscrepancia ? ` · ${k.conDiscrepancia} con discrepancia` : ''}` : 'Todo al día'),
        'reloj', 'kpi__icono--ambar'),
      kpi(d.esHoy ? 'Ingresos del día' : `Ingresos del ${F.corta(d.fecha)}`, dinero(k.ingresosDia).replace(/\.00$/, ''), variacion(k.ingresosVariacion, comparar), 'billete', 'kpi__icono--azul'),
      kpi('Pagos pendientes', numero(k.pendientesPago), h('small', null, 'Por confirmación (reservas sin pago)'), 'cartera', 'kpi__icono--morado'));

    $('pgSubtitulo').textContent = d.todos ? 'Todos los movimientos registrados'
      : d.esHoy ? 'Movimientos registrados el día de hoy' : `Movimientos registrados el ${F.media(d.fecha)}`;
    $('tablaPagos').replaceChildren(...(d.registros.length ? d.registros.map(filaPago)
      : [h('tr', null, h('td', { colspan: 8, class: 'vacio' }, q || $('pgEstado').value ? 'Ningún pago coincide con la búsqueda.'
        : d.todos ? 'Todavía no hay pagos registrados.' : 'No hay pagos registrados este día.'))]));
    $('pgInfo').textContent = `Mostrando ${d.registros.length} de ${numero(d.total)} movimiento${d.total === 1 ? '' : 's'}`;
    paginacion($('pgPaginas'), d.pagina, d.paginas, (n) => { estado.pagina = n; cargar(); });
    $('pgPaginas').hidden = d.paginas <= 1;
    $('pgVerTodos').textContent = d.todos ? 'Ver solo el día →' : 'Ver todos los pagos →';

    $('pgContador').textContent = d.comprobantes.length;
    $('pgComprobantes').replaceChildren(...(d.comprobantes.length ? d.comprobantes.map(tarjetaComprobante)
      : [h('div', { class: 'vacio-tarjeta' }, icono('checkCirculo'), 'No hay comprobantes por revisar.')]));
  }

  function filaPago(x) {
    const fecha = new Date(x.fechaPago);
    return h('tr', null,
      h('td', null, h('div', { class: 'celda-persona' }, h('span', { class: 'avatar avatar--suave' }, iniciales(x.cliente)),
        h('div', null, h('strong', null, x.cliente), h('small', null, x.equipo || x.concepto)))),
      h('td', null, x.folio ? h('span', { class: 'folio', title: x.torneo ? `${x.concepto} · ${x.torneo}` : x.concepto }, `#${x.folio}`)
        : h('span', { class: 'texto-tenue', title: x.torneo || '' }, x.concepto)),
      h('td', { class: 'sin-salto' }, x.cancha || '—'),
      h('td', null, metodoChip(x.metodo)),
      h('td', null, h('span', { class: 'monto' }, dinero(x.monto))),
      h('td', null, estadoPago(x.estadoPago)),
      h('td', null, h('div', { class: 'fecha-celda' }, F.numerica(fecha), h('small', null, F.hora(fecha)))),
      h('td', null, h('button', { class: 'boton-puntos', type: 'button', 'aria-label': `Acciones del pago de ${x.cliente}`, 'aria-haspopup': 'menu',
        onclick: (e) => menu(e.currentTarget, x) }, '···')));
  }

  function tarjetaComprobante(x) {
    return h('div', { class: 'comprobante' },
      h('div', { class: 'comprobante__fila' },
        h('span', { class: 'avatar-cuadro' }, iniciales(x.cliente)),
        h('div', null, h('strong', null, x.cliente), h('small', null, `${x.folio ? `#${x.folio}` : x.concepto} · ${x.metodo}${x.referencia ? ` · Ref. ${x.referencia}` : ''}`)),
        h('span', { class: 'monto' }, dinero(x.monto))),
      h('div', { class: 'comprobante__acciones' },
        h('button', { class: 'boton boton--secundario', type: 'button', onclick: () => verComprobante(x) }, 'Ver comprobante'),
        h('button', { class: 'boton-cuadro boton-cuadro--verde', type: 'button', title: 'Validar pago', 'aria-label': `Validar el pago de ${x.cliente}`, onclick: () => validar(x) }, icono('check')),
        h('button', { class: 'boton-cuadro boton-cuadro--rojo', type: 'button', title: 'Marcar con discrepancia', 'aria-label': `Rechazar el pago de ${x.cliente}`, onclick: () => abrirDiscrepancia(x) }, icono('x'))));
  }

  /* ---------- Menú ··· de cada pago ---------- */
  function menu(boton, x) {
    const efectivo = /efectivo/i.test(x.metodo);
    const acciones = [
      x.tieneComprobante && ['ojo', 'Ver comprobante', () => verComprobante(x)],
      !efectivo && ['subir', x.tieneComprobante ? 'Reemplazar comprobante' : 'Subir comprobante', () => elegirArchivo(x)],
      ['Pendiente', 'Con discrepancia'].includes(x.estadoPago) && ['check', 'Validar pago', () => validar(x)],
      x.estadoPago === 'Pendiente' && ['x', 'Marcar con discrepancia', () => abrirDiscrepancia(x), 'peligro'],
      x.estadoPago === 'Con discrepancia' && x.nota && ['exclamacion', 'Ver la discrepancia', () => aviso(`Discrepancia: ${x.nota}`, 'error', 9000)],
      x.folio && ['calendario', 'Ver en Reservas', () => irAReservas(x.folio)]
    ].filter(Boolean);
    $('pgMenu').replaceChildren(...acciones.map(([ic, texto, fn, clase]) =>
      h('button', { type: 'button', role: 'menuitem', class: clase || null, onclick: () => { cerrarEmergente(); fn(); } }, icono(ic), texto)));
    abrirEmergente($('pgMenu'), boton, { posicion: true });
  }

  function irAReservas(folio) {
    const buscar = $('rsBuscar');
    if (buscar) buscar.value = folio;
    location.hash = '#reservas';
  }

  /* -------------------------------------------------------------- */
  /*  Acciones                                                       */
  /* -------------------------------------------------------------- */
  const verComprobante = (x) => window.open(`/api/admin/pagos/${x.idPago}/comprobante`, '_blank', 'noopener');

  async function validar(x) {
    const ok = await confirmar(`¿Validar el pago de ${x.cliente}?`,
      `Confirma que recibiste ${dinero(x.monto)} por ${x.metodo}${x.folio ? `. La reserva ${x.folio} quedará confirmada` : ''}.`, 'Validar pago');
    if (!ok) return;
    const r = await api('POST', `/api/admin/pagos/${x.idPago}/validar`);
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error');
    if (r.ok) cargar();
  }

  const formDiscrepancia = $('formDiscrepancia');
  limpiarAlEscribir(formDiscrepancia);
  function abrirDiscrepancia(x) {
    estado.pagoDiscrepancia = x;
    formDiscrepancia.reset();
    limpiarErrores(formDiscrepancia);
    $('dlgDiscrepanciaSub').textContent = `${x.cliente} · ${dinero(x.monto)} · ${x.metodo}${x.folio ? ` · ${x.folio}` : ''}`;
    $('dlgDiscrepancia').showModal();
    $('dsNota').focus();
  }
  formDiscrepancia.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = V.validarNotaRevision(datosFormulario(formDiscrepancia));
    if (!v.ok) return mostrarErrores(formDiscrepancia, v.errores);
    const boton = formDiscrepancia.querySelector('[type=submit]');
    ocupado(boton, true, 'Guardando…');
    const r = await api('POST', `/api/admin/pagos/${estado.pagoDiscrepancia.idPago}/discrepancia`, v.datos);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formDiscrepancia, r.datos.errores || {}, r.datos.mensaje);
    $('dlgDiscrepancia').close();
    aviso(r.datos.mensaje);
    cargar();
  });

  function elegirArchivo(x) {
    estado.pagoArchivo = x;
    $('pgArchivo').value = '';
    $('pgArchivo').click();
  }
  $('pgArchivo').addEventListener('change', async (e) => {
    const archivo = e.target.files[0];
    const x = estado.pagoArchivo;
    if (!archivo || !x) return;
    if (!TIPOS_ARCHIVO.includes(archivo.type)) return aviso('El comprobante debe ser PNG, JPG o PDF.', 'error');
    if (archivo.size > 5 * 1024 * 1024) return aviso('El comprobante no puede pesar más de 5 MB.', 'error');
    try {
      const resp = await fetch(`/api/admin/pagos/${x.idPago}/comprobante`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'X-Requested-With': 'fetch', 'Content-Type': archivo.type, Accept: 'application/json' }, body: archivo
      });
      let datos = {};
      try { datos = await resp.json(); } catch { datos = {}; }
      aviso(datos.mensaje || (resp.ok ? 'Comprobante guardado.' : 'No se pudo subir el comprobante.'), resp.ok ? 'exito' : 'error');
      if (resp.ok) cargar();
    } catch {
      aviso('No hay conexión con el servidor.', 'error');
    }
  });

  /* -------------------------------------------------------------- */
  /*  Registrar pago (ventana)                                       */
  /* -------------------------------------------------------------- */
  const formPago = $('formPago');
  limpiarAlEscribir(formPago);
  const juegos = () => {
    const t = estado.catalogos.torneos.find((x) => String(x.id) === $('pgTorneo').value);
    return t ? t.juegos : [];
  };

  function mostrarReserva() {
    const j = juegos().find((x) => String(x.idJuego) === $('pgJuego').value);
    $('pgReserva').hidden = !j;
    if (!j) return;
    $('pgReserva').replaceChildren(icono('calendario'), h('div', null,
      h('strong', null, `Reserva ${j.folio} (automática)`),
      h('small', null, `${j.cancha} · ${F.larga(j.fecha)} · ${j.inicio}–${j.fin}`),
      h('small', null, `Paga: ${j.cliente} (${j.local}, equipo local)`)));
  }

  $('pgTorneo').addEventListener('change', () => {
    const lista = juegos();
    $('pgJuego').disabled = !$('pgTorneo').value;
    opciones($('pgJuego'), lista.map((j) => ({
      valor: j.idJuego, texto: `Jornada ${j.jornada} · ${F.diaCorto(j.fecha)} ${j.inicio} · ${j.local} vs ${j.visitante}`
    })), { vacio: !$('pgTorneo').value ? 'Primero selecciona un torneo' : lista.length ? 'Selecciona el juego' : 'Este torneo no tiene juegos por pagar' });
    mostrarReserva();
  });
  $('pgJuego').addEventListener('change', mostrarReserva);
  $('pgMonto').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^\d.]/g, ''); });

  async function abrirRegistro() {
    const r = await api('GET', '/api/admin/pagos/catalogos');
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    estado.catalogos = r.datos;
    formPago.reset();
    limpiarErrores(formPago);
    opciones($('pgTorneo'), r.datos.torneos.map((t) => ({ valor: t.id, texto: `${t.nombre} (${t.juegos.length} por pagar)` })),
      { vacio: r.datos.torneos.length ? 'Selecciona un torneo...' : 'No hay juegos de torneo pendientes de pago' });
    opciones($('pgMetodo'), r.datos.metodos.map((m) => ({ valor: m.id, texto: m.nombre })));
    $('pgTorneo').dispatchEvent(new Event('change'));
    $('dlgPago').showModal();
    $('pgTorneo').focus();
  }

  formPago.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = V.validarPagoJuego(datosFormulario(formPago));
    if (!v.ok) return mostrarErrores(formPago, v.errores, 'Revisa los campos marcados.');
    const boton = $('btnGuardarPago');
    ocupado(boton, true, 'Registrando…');
    const r = await api('POST', '/api/admin/pagos', v.datos);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formPago, r.datos.errores || {}, r.datos.mensaje);
    $('dlgPago').close();
    aviso(r.datos.mensaje, 'exito', 6000);
    estado.fecha = F.hoy();
    estado.todos = false;
    estado.pagina = 1;
    cargar();
  });

  /* -------------------------------------------------------------- */
  /*  Filtros                                                        */
  /* -------------------------------------------------------------- */
  $('pgFecha').addEventListener('change', () => {
    if (!$('pgFecha').value) return;
    estado.fecha = $('pgFecha').value;
    estado.todos = false;
    estado.pagina = 1;
    cargar();
  });
  let espera;
  $('pgBuscar').addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(() => { estado.pagina = 1; cargar(); }, 300); });
  $('pgEstado').addEventListener('change', () => { estado.pagina = 1; cargar(); });
  $('pgVerTodos').addEventListener('click', () => { estado.todos = !estado.todos; estado.pagina = 1; cargar(); });
  $('pgExportar').addEventListener('click', () => { window.location.href = '/api/admin/pagos/exportar'; });
  $('btnRegistrarPago').addEventListener('click', abrirRegistro);

  window.Panel.registrar('pagos', 'Pagos', cargar);
  /** Para "Ver todos →" desde Reportes */
  window.Pagos = { verTodos() { estado.todos = true; estado.pagina = 1; } };
})();
