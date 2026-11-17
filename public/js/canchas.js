/* =====================================================================
   Panel de administración · Canchas
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, mostrarErrores, limpiarErrores, limpiarAlEscribir, datosFormulario, ocupado, numero } = window.App;
  const { confirmar, llenarSelect, fila, celda, filaVacia, ICONO_EDITAR } = window.Panel;
  const V = window.Validacion;
  const $ = (id) => document.getElementById(id);

  const SVG = 'http://www.w3.org/2000/svg';
  /** Ícono SVG a partir de trazos (sin innerHTML). */
  function icono(trazos) {
    const svg = document.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    for (const t of trazos) {
      const [tipo, attrs] = t;
      const el = document.createElementNS(SVG, tipo);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  }
  const ICONO_CANCHA = () => icono([
    ['rect', { x: '2.5', y: '5', width: '19', height: '14', rx: '1.5' }], ['line', { x1: '12', y1: '5', x2: '12', y2: '19' }],
    ['circle', { cx: '12', cy: '12', r: '2.6' }], ['path', { d: 'M2.5 9.5h2.5v5H2.5M21.5 9.5H19v5h2.5' }]]);
  const ICONO_BORRAR = () => icono([['path', { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' }]]);
  const ICONO_ACTIVA = () => icono([['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'm8.5 12 2.5 2.5 4.5-5' }]]);
  const ICONO_PAUSA = () => icono([['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M10 9v6M14 9v6' }]]);

  const COLORES = ['', 'mosaico--azul', 'mosaico--rojo', 'mosaico--ambar'];
  const colorDe = (texto) => COLORES[[...texto].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORES.length];

  const formCancha = $('formCancha');
  limpiarAlEscribir(formCancha);
  let tipos = [];
  let editando = null;

  function indicador(icon, claseIcono, etiqueta, valor, detalle) {
    return h('article', { class: 'tarjeta indicador indicador--con-icono' },
      h('span', { class: `indicador__icono ${claseIcono}` }, icon),
      h('div', null,
        h('p', { class: 'indicador__etiqueta' }, etiqueta),
        h('p', { class: 'indicador__valor' }, valor),
        detalle ? h('p', { class: 'indicador__detalle' }, detalle) : null));
  }

  async function cargarCanchas() {
    const r = await api('GET', '/api/admin/canchas');
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const { canchas, resumen } = r.datos;
    tipos = r.datos.tipos;

    $('indicadoresCanchas').replaceChildren(
      indicador(ICONO_CANCHA(), '', 'Total de canchas', numero(resumen.total), 'Instalaciones registradas'),
      indicador(ICONO_ACTIVA(), '', 'Canchas activas', numero(resumen.activas), 'Reciben reservaciones'),
      indicador(ICONO_PAUSA(), 'indicador__icono--rojo', 'Fuera de servicio', numero(resumen.inactivas), 'No aceptan reservaciones'));
    $('subtituloCanchas').textContent = `${resumen.total} instalación(es) registrada(s)`;

    $('tablaCanchas').replaceChildren(...(canchas.length ? canchas.map((c) => fila(
      celda(h('div', { class: 'celda-cancha' },
        h('span', { class: `mosaico ${colorDe(c.nombre)}` }, ICONO_CANCHA()),
        h('strong', null, c.nombre))),
      celda(c.tipo),
      celda(h('span', { class: `etiqueta etiqueta--punto ${c.estado === 'Activa' ? 'etiqueta--verde' : 'etiqueta--rojo'}` }, c.estado)),
      celda(c.proximas ? `${numero(c.proximas)} próxima(s)` : 'Sin reservas', c.proximas ? '' : 'texto-tenue'),
      celda(h('div', { class: 'celda-acciones' },
        h('button', { class: 'boton boton--icono', type: 'button', title: `Editar ${c.nombre}`, 'aria-label': `Editar ${c.nombre}`,
          onclick: () => abrirCancha(c) }, ICONO_EDITAR()),
        h('button', { class: 'boton boton--icono boton--icono-rojo', type: 'button', title: `Eliminar ${c.nombre}`, 'aria-label': `Eliminar ${c.nombre}`,
          onclick: () => eliminarCancha(c) }, ICONO_BORRAR())))
    )) : [filaVacia(5, 'Todavía no hay canchas. Registra la primera con "Nueva cancha".')]));
  }

  function abrirCancha(cancha) {
    editando = cancha || null;
    formCancha.reset();
    limpiarErrores(formCancha);
    llenarSelect($('cnTipo'), tipos.map((t) => ({ valor: t.id, texto: t.nombre })));
    $('dlgCanchaKicker').textContent = cancha ? 'Editar registro' : 'Nuevo registro';
    $('dlgCanchaTitulo').textContent = cancha ? `Editar ${cancha.nombre}` : 'Nueva cancha';
    $('btnGuardarCancha').textContent = cancha ? 'Guardar cambios' : 'Guardar cancha';
    if (cancha) {
      formCancha.elements.nombre.value = cancha.nombre;
      formCancha.elements.idTipo.value = cancha.idTipo;
      const radio = formCancha.querySelector(`input[name="estado"][value="${cancha.estado === 'Inactiva' ? 'Inactiva' : 'Activa'}"]`);
      if (radio) radio.checked = true;
    }
    $('dlgCancha').showModal();
    formCancha.elements.nombre.focus();
  }

  formCancha.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = V.validarCancha(datosFormulario(formCancha));
    if (!v.ok) return mostrarErrores(formCancha, v.errores, 'Revisa los campos marcados.');

    const boton = $('btnGuardarCancha');
    ocupado(boton, true, 'Guardando…');
    const r = editando
      ? await api('PUT', `/api/admin/canchas/${editando.idCancha}`, v.datos)
      : await api('POST', '/api/admin/canchas', v.datos);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formCancha, r.datos.errores || {}, r.datos.mensaje);
    $('dlgCancha').close();
    aviso(r.datos.mensaje);
    cargarCanchas();
  });

  async function eliminarCancha(c) {
    const ok = await confirmar(`¿Eliminar "${c.nombre}"?`,
      'Solo se pueden eliminar canchas sin reservas ni juegos. Si ya tiene historial, mejor márcala como Inactiva.',
      'Eliminar cancha');
    if (!ok) return;
    const r = await api('DELETE', `/api/admin/canchas/${c.idCancha}`);
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error');
    if (r.ok) cargarCanchas();
  }

  $('btnNuevaCancha').addEventListener('click', () => abrirCancha(null));
  window.Panel.registrar('canchas', 'Canchas', cargarCanchas);
  window.Panel.icono = icono;
})();
