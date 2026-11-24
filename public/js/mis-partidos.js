/* =====================================================================
   Mi perfil · Mis partidos (usuarios con rol Árbitro)
   El árbitro confirma o rechaza (con motivo) los partidos que le asignan.
   El administrador ve la respuesta en Árbitros → Confirmaciones.
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, mostrarErrores, limpiarErrores, limpiarAlEscribir, datosFormulario, ocupado, numero } = window.App;
  const { icono, F, colorCancha, dialogos } = window.UI;
  const V = window.Validacion;
  const $ = (id) => document.getElementById(id);
  if (!$('seccion-mis-partidos')) return;
  dialogos();

  const CLASE = { Confirmado: 'estado--confirmado', Pendiente: 'estado--pendiente', Rechazado: 'estado--rechazado' };
  let rechazando = null;

  async function cargar() {
    const r = await api('GET', '/api/arbitraje/mis-partidos');
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const d = r.datos;
    const stat = (ic, clase, n, texto) => h('article', { class: 'tarjeta stat' },
      h('span', { class: `stat__icono ${clase}` }, icono(ic)), h('div', null, h('strong', null, numero(n)), h('small', null, texto)));
    $('mpResumen').replaceChildren(
      stat('reloj', 'stat__icono--ambar', d.resumen.pendientes, 'Por responder'),
      stat('escudoOk', '', d.resumen.confirmados, 'Confirmados'),
      stat('x', 'stat__icono--azul', d.resumen.rechazados, 'Rechazados'));
    const insignia = $('menuMisPartidos');
    if (insignia) { insignia.textContent = d.resumen.pendientes; insignia.hidden = !d.resumen.pendientes; }

    $('mpProximos').replaceChildren(...(d.proximos.length ? d.proximos.map(tarjeta)
      : [h('div', { class: 'tarjeta vacio-tarjeta' }, icono('silbato'), 'No tienes partidos asignados por ahora.')]));
    $('mpAnteriores').replaceChildren(...(d.anteriores.length ? d.anteriores.map((x) => h('tr', null,
      h('td', { class: 'sin-salto' }, `${F.corta(x.fecha)} · ${x.inicio}`), h('td', null, `${x.local} vs ${x.visitante}`),
      h('td', null, x.torneo), h('td', null, x.puestoNombre),
      // Un partido que ya pasó sin respuesta se muestra como "Sin respuesta"
      h('td', null, h('span', { class: `estado-pastilla ${x.estado === 'Pendiente' ? 'estado--sin' : CLASE[x.estado]}` }, x.estado === 'Pendiente' ? 'Sin respuesta' : x.estado))))
      : [h('tr', null, h('td', { colspan: 5, class: 'vacio' }, 'Sin partidos en los últimos 30 días.'))]));
  }

  function tarjeta(x) {
    const acciones = [];
    if (x.estado !== 'Confirmado') {
      acciones.push(h('button', { class: 'boton boton--primario', type: 'button', onclick: () => responder(x, 'confirmar') },
        icono('check'), x.estado === 'Rechazado' ? 'Sí puedo, aceptar' : 'Confirmar'));
    }
    if (x.estado !== 'Rechazado') {
      acciones.push(h('button', { class: 'boton boton--peligro', type: 'button', onclick: () => abrirRechazo(x) },
        icono('x'), x.estado === 'Confirmado' ? 'Ya no puedo asistir' : 'Rechazar'));
    }
    return h('article', { class: 'tarjeta partido-tarjeta' },
      h('div', { class: 'partido-tarjeta__cabeza' },
        h('div', null, h('small', null, `${F.larga(x.fecha)} · ${x.inicio}–${x.fin}`), h('h3', null, `${x.local} vs ${x.visitante}`)),
        h('span', { class: `estado-pastilla ${CLASE[x.estado]}` }, x.estado)),
      h('dl', null,
        h('div', null, h('dt', null, 'Torneo'), h('dd', null, `${x.torneo} · J${x.jornada}`)),
        h('div', null, h('dt', null, 'Cancha'), h('dd', null, h('span', { class: `celda-con-punto ${colorCancha(x.cancha)}` }, h('span', { class: 'anillo' }), h('span', { class: 'texto-normal' }, x.cancha)))),
        h('div', null, h('dt', null, 'Modalidad'), h('dd', null, x.superficie)),
        h('div', null, h('dt', null, 'Tu puesto'), h('dd', null, x.puestoNombre))),
      x.estado === 'Rechazado' && x.motivo ? h('p', { class: 'motivo' }, `Tu motivo: ${x.motivo}`) : null,
      h('div', { class: 'partido-tarjeta__acciones' }, ...acciones));
  }

  async function responder(x, accion, motivo) {
    const r = await api('POST', `/api/arbitraje/asignaciones/${x.id}/${accion}`, accion === 'rechazar' ? { motivo } : undefined);
    if (!r.ok) { aviso(r.datos.mensaje, 'error'); return r; }
    aviso(r.datos.mensaje);
    cargar();
    return r;
  }

  const form = $('formRechazo');
  limpiarAlEscribir(form);
  function abrirRechazo(x) {
    rechazando = x;
    form.reset();
    limpiarErrores(form);
    $('dlgRechazoSub').textContent = `${x.local} vs ${x.visitante} · ${F.larga(x.fecha)}, ${x.inicio} · ${x.puestoNombre}`;
    $('dlgRechazo').showModal();
    $('rzMotivo').focus();
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = V.validarRechazo(datosFormulario(form));
    if (!v.ok) return mostrarErrores(form, v.errores);
    const boton = form.querySelector('[type=submit]');
    ocupado(boton, true, 'Enviando…');
    const r = await api('POST', `/api/arbitraje/asignaciones/${rechazando.id}/rechazar`, v.datos);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(form, r.datos.errores || {}, r.datos.mensaje);
    $('dlgRechazo').close();
    aviso(r.datos.mensaje);
    cargar();
  });

  window.MisPartidos = { cargar };
})();
