/* =====================================================================
   Panel de administración · Seguridad (OWASP A01 a A07)
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, fechaHora, numero, ocupado } = window.App;
  const { fila, celda, filaVacia, etiquetaAccion } = window.Panel;
  const $ = (id) => document.getElementById(id);

  const ICONO = { activo: '✓', atencion: '!', info: 'i' };
  const ETIQUETA = { activo: 'Protegido', atencion: 'Hay que corregirlo', info: 'Informativo' };

  function itemControl(c) {
    return h('li', null,
      h('span', { class: `marca marca--${c.estado}`, 'aria-label': ETIQUETA[c.estado] || c.estado }, ICONO[c.estado] || '?'),
      h('div', null,
        h('strong', null, c.nombre),
        h('small', null, c.detalle),
        c.arreglo ? h('small', { class: 'arreglo' }, 'Cómo corregirlo: ', h('code', null, c.arreglo)) : null));
  }

  function tarjetaRiesgo(r) {
    const boton = r.boton ? h('button', { class: 'boton boton--secundario riesgo__boton', type: 'button' }, r.boton.texto) : null;
    if (boton && r.boton.accion === 'auditoria') boton.addEventListener('click', () => revisarDependencias(boton));
    if (boton && r.boton.accion === 'revisar-integridad') boton.addEventListener('click', () => marcarIntegridad(boton));
    return h('article', { class: `tarjeta riesgo ${r.numero > 0 ? 'riesgo--alerta' : ''}`, id: `riesgo-${r.id}` },
      h('div', { class: 'riesgo__cabeza' },
        h('span', { class: 'riesgo__id' }, `OWASP ${r.id}`),
        h('h2', null, r.nombre),
        h('div', { class: 'riesgo__numero' },
          h('strong', null, numero(r.numero)),
          h('span', null, r.tipo === 'pendientes' ? 'pendiente(s) de corregir' : 'evento(s) en el periodo')),
        h('p', { class: 'riesgo__detalle' }, r.detalle)),
      h('ul', { class: 'controles' }, ...r.controles.map(itemControl)),
      boton);
  }

  /* [A06] npm audit desde el panel */
  async function revisarDependencias(boton) {
    ocupado(boton, true, 'Revisando… (puede tardar 1 minuto)');
    const r = await api('POST', '/api/admin/seguridad/auditoria', {});
    ocupado(boton, false);
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error', 7000);
    if (r.ok) cargarSeguridad();
  }

  /* [A09] Marcar alteraciones de la bitácora como revisadas */
  async function marcarIntegridad(boton) {
    ocupado(boton, true, 'Guardando…');
    const r = await api('POST', '/api/admin/seguridad/integridad/revisar', {});
    ocupado(boton, false);
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error', 7000);
    if (r.ok) cargarSeguridad();
  }

  /* [A09] Alertas sin atender (arriba de las tarjetas) */
  function pintarAlertas(alertas) {
    const caja = $('alertasSeguridad');
    actualizarInsignia(alertas);
    if (!alertas.length) { caja.hidden = true; caja.replaceChildren(); return; }
    caja.hidden = false;
    caja.replaceChildren(
      h('h2', null, `🚨 ${alertas.length} alerta(s) de seguridad sin atender`),
      ...alertas.map((a) => {
        const boton = h('button', { class: 'boton boton--secundario', type: 'button' }, 'Marcar como atendida');
        boton.addEventListener('click', async () => {
          ocupado(boton, true, 'Guardando…');
          const r = await api('POST', `/api/admin/seguridad/alertas/${encodeURIComponent(a.id)}/atender`, {});
          ocupado(boton, false);
          aviso(r.datos.mensaje, r.ok ? 'exito' : 'error');
          if (r.ok) cargarSeguridad();
        });
        return h('div', { class: 'alerta-seg' },
          h('div', null,
            h('strong', null, String(a.descripcion).replace(/^\[A09\]\s*/, '')),     // textContent: nunca HTML
            h('small', null, `${fechaHora(a.fecha)} · IP ${a.ip || '—'} · alerta #${a.id}`)),
          boton);
      }));
  }

  function actualizarInsignia(alertas) {
    const insignia = $('menuAlertas');
    insignia.textContent = String(alertas.length);
    insignia.hidden = alertas.length === 0;
  }

  /* Revisa alertas nuevas cada minuto sin renovar la sesión (no cuenta como actividad) */
  const vistas = new Set();
  let primera = true;
  async function sondearAlertas() {
    try {
      const resp = await fetch('/api/admin/seguridad/alertas', {
        credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', 'X-Sin-Renovar': '1', Accept: 'application/json' }
      });
      if (!resp.ok) return;
      const { alertas } = await resp.json();
      actualizarInsignia(alertas);
      const nuevas = alertas.filter((a) => !vistas.has(a.id));
      nuevas.forEach((a) => vistas.add(a.id));
      if (!primera && nuevas.length) {
        aviso(`🚨 Nueva alerta de seguridad: ${String(nuevas[0].descripcion).replace(/^\[A09\]\s*/, '')}`, 'error', 10000);
        if (!$('seccion-seguridad').hidden) pintarAlertas(alertas);
      }
      primera = false;
    } catch { /* sin conexión: se intenta en el siguiente minuto */ }
  }
  sondearAlertas();
  setInterval(sondearAlertas, 60 * 1000);

  async function cargarSeguridad() {
    const r = await api('GET', `/api/admin/seguridad?dias=${encodeURIComponent($('segDias').value)}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');

    pintarAlertas(r.datos.alertas || []);
    (r.datos.alertas || []).forEach((a) => vistas.add(a.id));
    $('riesgosOwasp').replaceChildren(...r.datos.riesgos.map(tarjetaRiesgo));

    $('tablaSeguridad').replaceChildren(...(r.datos.recientes.length ? r.datos.recientes.map((b) => {
      const tr = fila(
        celda(fechaHora(b.Fecha), 'texto-tenue sin-salto'),
        celda(h('div', null, h('strong', null, b.Correo_Usuario || 'Sin sesión'), h('br'), h('small', { class: 'texto-tenue' }, b.Rol_Usuario || '—'))),
        celda(etiquetaAccion(b.Accion)),
        celda(h('div', { class: 'descripcion' }, b.Descripcion)),   // textContent: un <script> se ve como texto
        celda(b.IP || '—', 'mono'));
      tr.className = 'fila-clic';
      tr.tabIndex = 0;
      tr.addEventListener('click', () => window.Panel.verDetalleBitacora(b.idBitacora));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.Panel.verDetalleBitacora(b.idBitacora); });
      return tr;
    }) : [filaVacia(5, 'Sin eventos de seguridad. Ejecuta "npm run prueba-owasp" para simular ataques.')]));
  }

  $('segDias').addEventListener('change', cargarSeguridad);
  $('btnSegActualizar').addEventListener('click', cargarSeguridad);
  window.Panel.registrar('seguridad', 'Seguridad OWASP', cargarSeguridad);
})();
