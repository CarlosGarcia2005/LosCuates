/* =====================================================================
   Panel de administración · Reservas y pagos
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, mostrarErrores, limpiarErrores, limpiarAlEscribir, datosFormulario, ocupado,
    fecha, dinero, numero, iniciales } = window.App;
  const { confirmar, llenarSelect, fila, celda, filaVacia } = window.Panel;
  const V = window.Validacion;
  const $ = (id) => document.getElementById(id);
  const icono = (...t) => window.Panel.icono(t);

  const ICONOS = {
    calendario: () => icono(['rect', { x: '3', y: '4.5', width: '18', height: '16', rx: '2' }], ['path', { d: 'M16 2.5v4M8 2.5v4M3 10h18' }]),
    reloj: () => icono(['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 7v5l3 2' }]),
    alerta: () => icono(['path', { d: 'M12 3 2 20h20L12 3z' }], ['path', { d: 'M12 10v4M12 17h.01' }]),
    dinero: () => icono(['rect', { x: '2.5', y: '6', width: '19', height: '12', rx: '2' }], ['circle', { cx: '12', cy: '12', r: '2.5' }], ['path', { d: 'M6 9.5v5M18 9.5v5' }]),
    pagar: () => icono(['path', { d: 'M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.6 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3' }]),
    validar: () => icono(['path', { d: 'M20 6 9 17l-5-5' }]),
    comprobante: () => icono(['path', { d: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z' }], ['path', { d: 'M14 3v6h6M9 14h6M9 17h4' }]),
    subir: () => icono(['path', { d: 'M12 16V4M7 9l5-5 5 5M5 20h14' }]),
    finalizar: () => icono(['path', { d: 'M5 21V4M5 4h11l-2 4 2 4H5' }]),
    cancelar: () => icono(['path', { d: 'M6 6l12 12M18 6 6 18' }])
  };

  const ESTADOS = {
    pendiente: ['Pendiente de pago', 'etiqueta--azul'],
    por_validar: ['Por validar', 'etiqueta--ambar'],
    pagada: ['Pagada', 'etiqueta--verde'],
    confirmada: ['Confirmada', 'etiqueta--verde'],
    cancelada: ['Cancelada', 'etiqueta--rojo'],
    finalizada: ['Finalizada', '']
  };
  const TIPOS_ARCHIVO = ['image/png', 'image/jpeg', 'application/pdf'];
  const TAMANO_MAXIMO = 5 * 1024 * 1024;

  const estado = { pagina: 1, paginas: 1, catalogos: null, archivo: null, filaArchivo: null };
  const formReserva = $('formReserva');
  const formFiltros = $('filtrosReservas');
  limpiarAlEscribir(formReserva);

  /* -------------------------------------------------------------- */
  /*  Listado                                                        */
  /* -------------------------------------------------------------- */
  function filtrosActuales() {
    const p = new URLSearchParams();
    for (const el of formFiltros.elements) if (el.name && el.value) p.set(el.name, el.value.trim());
    return p;
  }

  function indicador(icon, claseIcono, etiqueta, valor, detalle, alerta) {
    return h('article', { class: `tarjeta indicador indicador--con-icono ${alerta ? 'indicador--alerta' : ''}` },
      h('span', { class: `indicador__icono ${claseIcono}` }, icon),
      h('div', null,
        h('p', { class: 'indicador__etiqueta' }, etiqueta),
        h('p', { class: 'indicador__valor' }, valor),
        h('p', { class: 'indicador__detalle' }, detalle)));
  }

  function botonAccion(titulo, iconoFn, onclick, clase = '') {
    return h('button', { class: `boton boton--icono ${clase}`, type: 'button', title: titulo, 'aria-label': titulo, onclick }, iconoFn());
  }

  function acciones(r) {
    const lista = [];
    const hoy = V.fechaLocal();
    if (r.estadoVista === 'pendiente') {
      lista.push(botonAccion(`Registrar pago de ${r.folio}`, ICONOS.pagar, () => abrirReserva(r.idReserva), 'boton--icono-verde'));
    }
    if (r.estadoVista === 'por_validar') {
      lista.push(botonAccion(`Validar pago de ${r.folio}`, ICONOS.validar, () => validar(r), 'boton--icono-verde'));
    }
    if (r.idPago) {
      lista.push(r.tieneComprobante
        ? botonAccion(`Ver comprobante de ${r.folio}`, ICONOS.comprobante, () => verComprobante(r))
        : botonAccion(`Subir comprobante de ${r.folio}`, ICONOS.subir, () => elegirComprobanteFila(r)));
    }
    if ((r.estadoVista === 'pagada' || r.estadoVista === 'confirmada') && r.fecha <= hoy) {
      lista.push(botonAccion(`Marcar ${r.folio} como finalizada`, ICONOS.finalizar, () => cambiarEstado(r, 'finalizar')));
    }
    if (['pendiente', 'por_validar', 'pagada', 'confirmada'].includes(r.estadoVista)) {
      lista.push(botonAccion(`Cancelar ${r.folio}`, ICONOS.cancelar, () => cambiarEstado(r, 'cancelar'), 'boton--icono-rojo'));
    }
    return h('div', { class: 'celda-acciones' }, ...lista);
  }

  async function cargarReservas() {
    const p = filtrosActuales();
    p.set('pagina', estado.pagina);
    p.set('porPagina', 10);
    const r = await api('GET', `/api/admin/reservas?${p}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const d = r.datos;
    estado.pagina = d.pagina;
    estado.paginas = d.paginas;

    $('indicadoresReservas').replaceChildren(
      indicador(ICONOS.calendario(), 'indicador__icono--azul', 'Reservas de hoy', numero(d.resumen.hoy), 'Sin contar las canceladas'),
      indicador(ICONOS.alerta(), 'indicador__icono--ambar', 'Por validar', numero(d.resumen.porValidar),
        d.resumen.porValidar ? 'Pagos que requieren atención' : 'Todo al día', d.resumen.porValidar > 0),
      indicador(ICONOS.reloj(), 'indicador__icono--azul', 'Pendientes de pago', numero(d.resumen.sinPago), 'Reservas sin pago registrado'),
      indicador(ICONOS.dinero(), '', 'Ingresos del día', dinero(d.resumen.ingresosDia), 'Pagos de reservas registrados hoy'));

    $('tablaReservas').replaceChildren(...(d.registros.length ? d.registros.map((x) => {
      const [texto, clase] = ESTADOS[x.estadoVista] || [x.estado, ''];
      return fila(
        celda(h('span', { class: 'folio' }, x.folio)),
        celda(h('div', { class: 'celda-persona' },
          h('span', { class: 'avatar' }, iniciales(x.cliente)),
          h('div', null, h('strong', null, x.cliente), h('small', null, x.equipo || x.correo)))),
        celda(x.cancha, 'sin-salto'),
        celda(fecha(x.fecha), 'sin-salto'),
        celda(`${x.inicio} – ${x.fin}`, 'sin-salto mono'),
        celda(x.idPago
          ? h('div', { class: 'pago-celda' }, h('strong', null, dinero(x.monto)), h('small', null, x.metodo))
          : h('span', { class: 'texto-tenue' }, 'Sin pago')),
        celda(h('span', { class: `etiqueta etiqueta--punto ${clase}` }, texto)),
        celda(acciones(x)));
    }) : [filaVacia(8, 'No hay reservas con esos filtros.')]));

    $('infoReservas').textContent = `Mostrando ${d.registros.length} de ${numero(d.total)} reserva(s) · página ${d.pagina} de ${d.paginas}`;
    $('btnReservasAnterior').disabled = d.pagina <= 1;
    $('btnReservasSiguiente').disabled = d.pagina >= d.paginas;
  }

  let espera;
  formFiltros.addEventListener('input', () => {
    clearTimeout(espera);
    espera = setTimeout(() => { estado.pagina = 1; cargarReservas(); }, 350);
  });
  formFiltros.addEventListener('reset', () => setTimeout(() => { estado.pagina = 1; cargarReservas(); }, 0));
  formFiltros.addEventListener('submit', (e) => e.preventDefault());
  $('btnReservasAnterior').addEventListener('click', () => { estado.pagina -= 1; cargarReservas(); });
  $('btnReservasSiguiente').addEventListener('click', () => { estado.pagina += 1; cargarReservas(); });
  $('btnExportarReservas').addEventListener('click', () => {
    window.location.href = `/api/admin/reservas/exportar?${filtrosActuales()}`;
  });

  /* -------------------------------------------------------------- */
  /*  Acciones de la tabla                                           */
  /* -------------------------------------------------------------- */
  async function validar(r) {
    const ok = await confirmar(`¿Validar el pago de ${r.folio}?`,
      `Confirma que recibiste ${dinero(r.monto)} por ${r.metodo}. La reserva quedará como pagada.`, 'Validar pago');
    if (!ok) return;
    const res = await api('POST', `/api/admin/reservas/${r.idReserva}/validar`);
    aviso(res.datos.mensaje, res.ok ? 'exito' : 'error');
    if (res.ok) cargarReservas();
  }

  async function cambiarEstado(r, accion) {
    const textos = {
      cancelar: [`¿Cancelar ${r.folio}?`, `El horario ${r.inicio}–${r.fin} de ${r.cancha} quedará libre.` +
        (r.idPago ? ' El pago seguirá registrado por si hay que devolverlo.' : ''), 'Cancelar reserva'],
      finalizar: [`¿Finalizar ${r.folio}?`, 'Márcala como finalizada cuando el partido ya se jugó.', 'Finalizar']
    }[accion];
    if (!(await confirmar(...textos))) return;
    const res = await api('POST', `/api/admin/reservas/${r.idReserva}/${accion}`);
    aviso(res.datos.mensaje, res.ok ? 'exito' : 'error');
    if (res.ok) cargarReservas();
  }

  function verComprobante(r) {
    window.open(`/api/admin/reservas/${r.idReserva}/comprobante`, '_blank', 'noopener');
  }

  function revisarArchivo(archivo) {
    if (!TIPOS_ARCHIVO.includes(archivo.type)) return 'El comprobante debe ser PNG, JPG o PDF.';
    if (archivo.size > TAMANO_MAXIMO) return 'El comprobante no puede pesar más de 5 MB.';
    if (archivo.size === 0) return 'El archivo está vacío.';
    return null;
  }

  async function subirComprobante(idReserva, archivo) {
    try {
      const resp = await fetch(`/api/admin/reservas/${idReserva}/comprobante`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'fetch', 'Content-Type': archivo.type, Accept: 'application/json' },
        body: archivo
      });
      let datos = {};
      try { datos = await resp.json(); } catch { datos = {}; }
      return { ok: resp.ok, mensaje: datos.mensaje || (resp.ok ? 'Comprobante guardado.' : 'No se pudo subir el comprobante.') };
    } catch {
      return { ok: false, mensaje: 'No hay conexión con el servidor.' };
    }
  }

  function elegirComprobanteFila(r) {
    estado.filaArchivo = r;
    $('archivoComprobanteFila').value = '';
    $('archivoComprobanteFila').click();
  }

  $('archivoComprobanteFila').addEventListener('change', async (e) => {
    const archivo = e.target.files[0];
    const r = estado.filaArchivo;
    if (!archivo || !r) return;
    const error = revisarArchivo(archivo);
    if (error) return aviso(error, 'error');
    const res = await subirComprobante(r.idReserva, archivo);
    aviso(res.mensaje, res.ok ? 'exito' : 'error');
    if (res.ok) cargarReservas();
  });

  /* -------------------------------------------------------------- */
  /*  Panel: nueva reserva / registrar pago                          */
  /* -------------------------------------------------------------- */
  const campos = formReserva.elements;
  const CAMPOS_RESERVA = ['idUsuario', 'idEquipo', 'idCancha', 'fecha', 'horario'];

  function llenarEquipos(idUsuario, seleccionado) {
    const lista = (estado.catalogos.equipos || []).filter((q) => String(q.idUsuario) === String(idUsuario));
    llenarSelect($('rvEquipo'), lista.map((q) => ({ valor: q.id, texto: q.nombre })), { vacio: lista.length ? 'Sin equipo' : 'El cliente no tiene equipos' });
    if (seleccionado) $('rvEquipo').value = seleccionado;
  }

  async function actualizarHorarios() {
    const sel = $('rvHorario');
    const anterior = sel.value;
    const idCancha = campos.idCancha.value;
    const dia = campos.fecha.value;
    let ocupados = [];
    if (idCancha && /^\d{4}-\d{2}-\d{2}$/.test(dia)) {
      const r = await api('GET', `/api/admin/reservas/disponibilidad?idCancha=${encodeURIComponent(idCancha)}&fecha=${encodeURIComponent(dia)}`);
      if (r.ok) ocupados = r.datos.ocupados;
    }
    const ahora = new Date();
    const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes();
    const esHoy = dia === V.fechaLocal(ahora);
    const aMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

    sel.replaceChildren(h('option', { value: '' }, idCancha && dia ? 'Elige un horario' : 'Primero elige cancha y fecha'),
      ...estado.catalogos.horarios.map(({ inicio, fin }) => {
        const choque = ocupados.find((o) => o.inicio < fin && o.fin > inicio);
        const paso = esHoy && aMin(inicio) <= minutosAhora;
        const texto = `${inicio} – ${fin}${choque ? ` · ocupado (${choque.folio})` : paso ? ' · ya pasó' : ''}`;
        return h('option', { value: `${inicio}-${fin}`, disabled: Boolean(choque || paso) }, texto);
      }));
    const opcion = [...sel.options].find((o) => o.value === anterior && !o.disabled);
    sel.value = opcion ? anterior : '';
  }

  function mostrarArchivo() {
    const a = estado.archivo;
    $('rvZona').classList.toggle('con-archivo', Boolean(a));
    $('rvZonaTitulo').textContent = a ? a.name : 'Sube tu comprobante';
    $('rvZonaTexto').textContent = a ? `${(a.size / 1024).toFixed(0)} KB · haz clic para cambiarlo`
      : 'Arrastra el archivo o haz clic para buscar · PNG, JPG o PDF · Máx. 5 MB';
    $('rvQuitarArchivo').hidden = !a;
  }

  function elegirArchivo(archivo) {
    const salida = formReserva.querySelector('[data-error="comprobante"]');
    salida.textContent = '';
    if (!archivo) return;
    const error = revisarArchivo(archivo);
    if (error) { salida.textContent = error; return; }
    estado.archivo = archivo;
    mostrarArchivo();
  }

  /** Cambia entre "Nueva reserva" y "Registrar pago de una reserva pendiente". */
  function aplicarFolio() {
    const id = campos.idReserva.value;
    const existente = id ? estado.catalogos.pendientes.find((p) => String(p.idReserva) === id) : null;
    limpiarErrores(formReserva);

    for (const nombre of CAMPOS_RESERVA) {
      campos[nombre].disabled = Boolean(existente);
      campos[nombre].closest('.campo').classList.toggle('campo--bloqueado', Boolean(existente));
    }
    $('dlgReservaTitulo').textContent = existente ? `Registrar pago de ${existente.folio}` : 'Registrar reserva / pago';
    $('rvMontoAyuda').textContent = existente ? 'El monto es obligatorio para registrar el pago.' : 'Déjalo vacío si el cliente pagará después.';
    $('btnGuardarReserva').textContent = existente ? 'Registrar pago' : 'Registrar reserva / pago';

    llenarSelect($('rvCliente'), estado.catalogos.clientes.map((x) => ({ valor: x.id, texto: `${x.nombre} (${x.correo})` })),
      { vacio: 'Elige al cliente' });
    if (existente) {
      if (!estado.catalogos.clientes.some((x) => String(x.id) === String(existente.idUsuario))) {
        $('rvCliente').append(h('option', { value: existente.idUsuario }, existente.cliente));
      }
      campos.idUsuario.value = existente.idUsuario;
      llenarSelect($('rvEquipo'), [{ valor: existente.idEquipo || '', texto: existente.equipo || 'Sin equipo' }]);
      llenarSelect($('rvCancha'), [{ valor: existente.idCancha, texto: existente.cancha }]);
      campos.fecha.value = existente.fecha;
      llenarSelect($('rvHorario'), [{ valor: `${existente.inicio}-${existente.fin}`, texto: `${existente.inicio} – ${existente.fin}` }]);
      campos.descripcion.value = existente.descripcion || '';
    } else {
      campos.idUsuario.value = '';
      llenarEquipos('');
      llenarSelect($('rvCancha'), estado.catalogos.canchas.map((c) => ({ valor: c.id, texto: `${c.nombre} · ${c.tipo}` })),
        { vacio: estado.catalogos.canchas.length ? 'Elige la cancha' : 'No hay canchas activas' });
      campos.fecha.value = V.fechaLocal();
      campos.descripcion.value = '';
      actualizarHorarios();
    }
  }

  async function abrirReserva(idReserva) {
    const r = await api('GET', '/api/admin/reservas/catalogos');
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    estado.catalogos = r.datos;
    const c = r.datos;

    formReserva.reset();
    estado.archivo = null;
    mostrarArchivo();
    formReserva.querySelector('[data-error="comprobante"]').textContent = '';

    llenarSelect($('rvFolio'), c.pendientes.map((p) => ({
      valor: p.idReserva, texto: `${p.folio} · ${p.cliente} · ${fecha(p.fecha)} ${p.inicio}`
    })), { vacio: 'Nueva reserva (folio automático)' });
    $('rvMetodos').replaceChildren(...c.metodos.map((m, i) =>
      h('label', { class: 'segmento' },
        h('input', { type: 'radio', name: 'idMetodoPago', value: m.id, checked: i === 0 }),
        h('span', null, m.nombre))));
    campos.fecha.min = V.fechaLocal();

    campos.idReserva.value = idReserva ? String(idReserva) : '';
    aplicarFolio();
    $('dlgReserva').showModal();
    (idReserva ? $('rvMonto') : $('rvCliente')).focus();
  }

  $('rvFolio').addEventListener('change', aplicarFolio);
  $('rvCliente').addEventListener('change', () => { if (!campos.idReserva.value) llenarEquipos(campos.idUsuario.value); });
  $('rvCancha').addEventListener('change', actualizarHorarios);
  $('rvFecha').addEventListener('change', actualizarHorarios);
  $('rvMonto').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^\d.]/g, ''); });

  // Comprobante: clic o arrastrar y soltar
  $('rvArchivo').addEventListener('change', (e) => { elegirArchivo(e.target.files[0]); e.target.value = ''; });
  const zona = $('rvZona');
  ['dragenter', 'dragover'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add('arrastrando'); }));
  ['dragleave', 'drop'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove('arrastrando'); }));
  zona.addEventListener('drop', (e) => elegirArchivo(e.dataTransfer.files[0]));
  $('rvQuitarArchivo').addEventListener('click', () => { estado.archivo = null; mostrarArchivo(); });

  formReserva.addEventListener('submit', async (e) => {
    e.preventDefault();
    const idReserva = campos.idReserva.value;
    const datos = datosFormulario(formReserva);
    const boton = $('btnGuardarReserva');
    let respuesta;

    if (idReserva) {
      const v = V.validarPago(datos);
      if (!v.ok) return mostrarErrores(formReserva, v.errores, 'Revisa los campos marcados.');
      ocupado(boton, true, 'Guardando…');
      respuesta = await api('POST', `/api/admin/reservas/${idReserva}/pago`, v.datos);
    } else {
      const v = V.validarReserva(datos);
      if (estado.archivo && v.ok && !v.datos.pago) v.errores.comprobante = 'Para adjuntar un comprobante escribe también el monto del pago.';
      if (Object.keys(v.errores).length) return mostrarErrores(formReserva, v.errores, 'Revisa los campos marcados.');
      const { pago, ...resto } = v.datos;
      ocupado(boton, true, 'Guardando…');
      respuesta = await api('POST', '/api/admin/reservas', {
        ...resto, monto: pago ? pago.monto : '', idMetodoPago: pago ? pago.idMetodoPago : ''
      });
    }

    if (!respuesta.ok) {
      ocupado(boton, false);
      if (respuesta.datos.errores && respuesta.datos.errores.horario) actualizarHorarios();
      return mostrarErrores(formReserva, respuesta.datos.errores || {}, respuesta.datos.mensaje);
    }

    const reserva = respuesta.datos.reserva;
    let mensaje = respuesta.datos.mensaje;
    let tipo = 'exito';
    if (estado.archivo && reserva && reserva.idPago) {
      const subida = await subirComprobante(reserva.idReserva, estado.archivo);
      if (subida.ok) mensaje += ' Comprobante guardado.';
      else { mensaje += ` Pero el comprobante no se guardó: ${subida.mensaje}`; tipo = 'error'; }
    }
    ocupado(boton, false);
    $('dlgReserva').close();
    aviso(mensaje, tipo);
    cargarReservas();
  });

  $('btnNuevaReserva').addEventListener('click', () => abrirReserva(null));
  window.Panel.registrar('reservas', 'Reservas', cargarReservas);
})();
