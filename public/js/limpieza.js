/* =====================================================================
   Limpieza y reporte de condiciones de cancha
   Se usa en el panel de administración y en "Mi perfil" del personal
   de limpieza (misma pantalla, mismos datos). Solo un administrador
   puede marcar reportes como atendidos.
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, mostrarErrores, limpiarErrores, limpiarAlEscribir, datosFormulario, ocupado, numero, fechaHora } = window.App;
  const { icono, paginacion, abrirEmergente, cerrarEmergente, F, opciones, dialogos, confirmar, sondeo } = window.UI;
  const V = window.Validacion;
  const $ = (id) => document.getElementById(id);
  if (!$('seccion-limpieza')) return;
  dialogos();

  const ICONO_TIPO = { General: 'balon', Basura: 'basura', Barrido: 'hojaArbol', Gradas: 'gradas', Riego: 'gota', Otro: 'herramienta' };
  const CLASE_ESTADO = { Completada: ['tarea--completada', 'check'], 'En progreso': ['tarea--progreso', 'progreso'], Pendiente: ['tarea--pendiente', 'reloj'] };
  const estado = { fecha: null, datos: null, editando: null, todas: { pagina: 1 }, filtroReportes: '', atendiendo: null };
  const lugar = (t) => t.cancha || t.lugar || '—';

  /* -------------------------------------------------------------- */
  /*  Carga y pintado                                                */
  /* -------------------------------------------------------------- */
  async function cargar() {
    if (!estado.fecha) estado.fecha = F.hoy();
    const r = await api('GET', `/api/limpieza?fecha=${encodeURIComponent(estado.fecha)}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const d = r.datos;
    estado.datos = d;
    estado.fecha = d.fecha;
    $('lpFecha').value = d.fecha;
    $('lpFechaTexto').textContent = F.media(d.fecha);
    $('lpFechaLarga').textContent = F.larga(d.fecha);
    $('lpConteo').textContent = `${d.partidos.length} partido${d.partidos.length === 1 ? '' : 's'}`;

    $('lpPartidos').replaceChildren(...(d.partidos.length ? d.partidos.map((p) => h('tr', null,
      h('td', null, h('strong', null, p.hora)), h('td', { class: 'sin-salto' }, p.cancha),
      h('td', { class: 'texto-tenue' }, p.competencia), h('td', null, p.equipos)))
      : [h('tr', null, h('td', { colspan: 4, class: 'vacio' }, 'No hay partidos ni reservas este día.'))]));

    const actual = $('lpCancha').value;
    opciones($('lpCancha'), d.canchas.map((c) => ({ valor: c.id, texto: c.estado === 'Activa' ? c.nombre : `${c.nombre} (inactiva)` })),
      { vacio: 'Selecciona una cancha', valor: actual });

    $('lpTareasSub').textContent = d.esHoy ? 'Tareas programadas y pendientes para hoy.' : `Tareas programadas para el ${F.media(d.fecha)}.`;
    $('lpTareas').replaceChildren(...(d.tareas.length ? d.tareas.map(itemTarea)
      : [h('li', { class: 'vacio-tarjeta' }, icono('escoba'), 'No hay tareas para este día. Agrega una con "Nueva tarea".')]));
    pintarAlerta();
    actualizarInsignia(d.urgentes.length);
  }

  function itemTarea(t) {
    const [clase, ic] = CLASE_ESTADO[t.estado] || CLASE_ESTADO.Pendiente;
    return h('li', { class: 'tarea' },
      h('span', { class: 'tarea__icono' }, icono(ICONO_TIPO[t.tipo] || 'escoba')),
      h('div', null, h('strong', null, t.tarea), h('small', null, `${lugar(t)}${t.asignado ? ` · ${t.asignado}` : ''}`)),
      h('span', { class: 'tarea__hora' }, t.hora),
      h('span', { class: `tarea-estado ${clase}` }, icono(ic), t.estado),
      h('button', { class: 'boton-puntos', type: 'button', 'aria-label': `Opciones de "${t.tarea}"`, 'aria-haspopup': 'menu',
        onclick: (e) => menuTarea(e.currentTarget, t) }, icono('puntosV')));
  }

  function pintarAlerta() {
    const d = estado.datos;
    const caja = $('lpAlerta');
    const urgente = d.urgentes[0];
    const verTodos = h('button', { class: 'boton boton--enlace', type: 'button', onclick: abrirReportes },
      `Ver todos los reportes${d.reportesAbiertos ? ` (${d.reportesAbiertos} abierto${d.reportesAbiertos === 1 ? '' : 's'})` : ''}`);

    if (!urgente) {
      caja.replaceChildren(h('article', { class: 'tarjeta tarjeta-modulo alerta-ok' },
        h('div', { class: 'tarjeta-modulo__cabeza' }, h('span', { class: 'tarjeta-modulo__icono' }, icono('escudoOk')),
          h('div', null, h('h2', null, 'Sin alertas urgentes'), h('p', null, 'No hay reportes de urgencia alta pendientes.'))),
        h('p', { class: 'nota-linea nota-linea--gris' }, icono('info'), h('span', null, 'Cuando se guarde un reporte con urgencia Alta aparecerá aquí y el administrador lo verá en el menú.')),
        h('div', { class: 'mas-reportes' }, h('span', null, ''), verTodos)));
      return;
    }
    const f = new Date(urgente.fecha);
    const cuando = F.iso(f) === F.hoy() ? `Reportado hoy, ${F.hora(f)}` : `Reportado el ${F.corta(F.iso(f))}, ${F.hora(f)}`;
    const acciones = d.esAdmin ? h('div', { class: 'reporte-acciones' },
      urgente.estado === 'Sin resolver' ? h('button', { class: 'boton boton--secundario boton--chico', type: 'button', onclick: () => abrirAtender(urgente, 'En proceso') }, 'Marcar en proceso') : null,
      h('button', { class: 'boton boton--primario boton--chico', type: 'button', onclick: () => abrirAtender(urgente, 'Resuelto') }, 'Marcar resuelto')) : null;
    caja.replaceChildren(h('article', { class: 'tarjeta alerta-urgente' },
      h('div', { class: 'tarjeta-modulo__cabeza' }, h('span', { class: 'tarjeta-modulo__icono' }, icono('alerta')),
        h('div', null, h('h2', null, 'Alerta de condición urgente'), h('p', null, 'Reporte enviado al administrador'))),
      h('div', { class: 'reporte-tarjeta' },
        h('div', { class: 'reporte-tarjeta__cabeza' }, h('span', { class: 'tarjeta-modulo__icono' }, icono('balon')),
          h('div', null, h('strong', null, urgente.cancha), h('small', null, cuando)),
          h('span', { class: urgente.estado === 'En proceso' ? 'pastilla-azul' : 'pastilla-roja' }, urgente.estado)),
        h('dl', { class: 'reporte-datos' },
          h('div', null, h('dt', null, 'PROBLEMA'), h('dd', null, urgente.tipoProblema)),
          h('div', null, h('dt', null, 'URGENCIA'), h('dd', { class: 'urgencia-alta' }, '● ', urgente.urgencia))),
        h('p', { class: 'reporte-texto' }, urgente.descripcion),
        urgente.nota ? h('p', { class: 'ayuda' }, `Nota del administrador: ${urgente.nota}`) : null,
        acciones),
      h('p', { class: 'nota-linea' }, icono('info'), h('span', null, urgente.estado === 'En proceso'
        ? `${urgente.atiende || 'El administrador'} lo está atendiendo. Seguimiento en proceso.`
        : 'El administrador ha sido notificado. Seguimiento en proceso.')),
      h('div', { class: 'mas-reportes' }, h('span', null, d.urgentes.length > 1 ? `Y ${d.urgentes.length - 1} reporte(s) urgente(s) más.` : ''), verTodos)));
  }

  /* -------------------------------------------------------------- */
  /*  Reporte de condición                                           */
  /* -------------------------------------------------------------- */
  const formReporte = $('formReporteLp');
  limpiarAlEscribir(formReporte);
  formReporte.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = V.validarReporteCondicion(datosFormulario(formReporte));
    if (!v.ok) return mostrarErrores(formReporte, v.errores, 'Revisa los campos marcados.');
    const boton = $('btnGuardarReporteLp');
    ocupado(boton, true, 'Guardando…');
    const r = await api('POST', '/api/limpieza/reportes', v.datos);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formReporte, r.datos.errores || {}, r.datos.mensaje);
    formReporte.reset();
    limpiarErrores(formReporte);
    aviso(r.datos.mensaje, 'exito', 6000);
    cargar();
  });

  /* -------------------------------------------------------------- */
  /*  Tareas: menú, cambio de estado, eliminar                       */
  /* -------------------------------------------------------------- */
  function menuTarea(boton, t) {
    const d = estado.datos;
    const puedeBorrar = d.esAdmin || Number(t.idUsuarioRegistro) === d.yo;
    const items = [
      ...V.ESTADOS_TAREA.filter((e) => e !== t.estado).map((e) => [CLASE_ESTADO[e][1], `Marcar como ${e.toLowerCase()}`, () => cambiarEstado(t, e)]),
      ['editar', 'Editar tarea', () => abrirTarea(t)],
      puedeBorrar && ['borrar', 'Eliminar tarea', () => eliminarTarea(t), 'peligro']
    ].filter(Boolean);
    $('lpMenu').replaceChildren(...items.map(([ic, texto, fn, clase]) =>
      h('button', { type: 'button', role: 'menuitem', class: clase || null, onclick: () => { cerrarEmergente(); fn(); } }, icono(ic), texto)));
    abrirEmergente($('lpMenu'), boton, { posicion: true });
  }

  async function cambiarEstado(t, nuevo) {
    const r = await api('POST', `/api/limpieza/tareas/${t.id}/estado`, { estado: nuevo });
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error');
    if (r.ok) cargar();
  }

  async function eliminarTarea(t) {
    const ok = await confirmar($('dlgConfirmarLp'), `¿Eliminar "${t.tarea}"?`, `${lugar(t)} · ${F.media(t.fecha)}, ${t.hora}. Queda registrado en la bitácora.`, 'Eliminar tarea');
    if (!ok) return;
    const r = await api('DELETE', `/api/limpieza/tareas/${t.id}`);
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error', r.ok ? 4200 : 7000);
    if (r.ok) cargar();
  }

  /* -------------------------------------------------------------- */
  /*  Nueva tarea / editar (ventana)                                 */
  /* -------------------------------------------------------------- */
  const formTarea = $('formTareaLp');
  limpiarAlEscribir(formTarea);
  const ct = formTarea.elements;
  let nombreAutomatico = '';

  function mostrarLugar() {
    const otro = ct.idCancha.value === 'otro';
    $('tlLugarCampo').hidden = !otro;
    ct.lugar.disabled = !otro;
  }
  ct.idCancha.addEventListener('change', mostrarLugar);
  ct.tipo.addEventListener('change', () => {
    // Si no han escrito un nombre propio, se usa el del tipo de tarea
    if (!ct.tarea.value.trim() || ct.tarea.value === nombreAutomatico) {
      nombreAutomatico = ct.tipo.value && ct.tipo.value !== 'Otro' ? estado.datos.tipos[ct.tipo.value] : '';
      ct.tarea.value = nombreAutomatico;
      $('tlContador').textContent = `${ct.tarea.value.length}/80`;
    }
  });
  ct.tarea.addEventListener('input', () => { $('tlContador').textContent = `${ct.tarea.value.length}/80`; });

  function abrirTarea(t) {
    const d = estado.datos;
    estado.editando = t || null;
    formTarea.reset();
    limpiarErrores(formTarea);
    nombreAutomatico = '';
    opciones(ct.tipo, Object.entries(d.tipos).map(([valor, texto]) => ({ valor, texto })), { vacio: 'Elige el tipo de tarea' });
    opciones(ct.idCancha, [...d.canchas.map((c) => ({ valor: c.id, texto: c.nombre })), { valor: 'otro', texto: 'Otro lugar (áreas comunes, gradas, baños...)' }],
      { vacio: 'Elige la cancha o el lugar' });
    opciones(ct.idUsuarioAsignado, d.personal.map((p) => ({ valor: p.id, texto: p.nombre })),
      { vacio: d.personal.length ? 'Sin asignar' : 'No hay personal de limpieza registrado' });
    if (t) {
      ct.tipo.value = t.tipo;
      ct.tarea.value = t.tarea;
      ct.idCancha.value = t.idCancha ? String(t.idCancha) : 'otro';
      ct.lugar.value = t.lugar || '';
      ct.fecha.value = t.fecha;
      ct.hora.value = t.hora;
      ct.idUsuarioAsignado.value = t.idUsuarioAsignado ? String(t.idUsuarioAsignado) : '';
      formTarea.querySelector(`input[name="estado"][value="${t.estado}"]`).checked = true;
      ct.notas.value = t.notas || '';
    } else {
      ct.fecha.value = estado.fecha;
      const ahora = new Date();
      ct.hora.value = `${String(Math.min(22, ahora.getHours() + 1)).padStart(2, '0')}:00`;
      if (d.personal.some((p) => Number(p.id) === d.yo)) ct.idUsuarioAsignado.value = String(d.yo);
    }
    $('tlContador').textContent = `${ct.tarea.value.length}/80`;
    mostrarLugar();
    $('dlgTareaLpKicker').textContent = t ? 'Editar tarea' : 'Nueva tarea';
    $('dlgTareaLpTitulo').textContent = t ? `Editar "${t.tarea}"` : 'Nueva tarea de limpieza';
    $('btnGuardarTareaLp').textContent = t ? 'Guardar cambios' : 'Agregar tarea';
    $('dlgTareaLp').showModal();
    ct.tipo.focus();
  }

  formTarea.addEventListener('submit', async (e) => {
    e.preventDefault();
    const datos = datosFormulario(formTarea);
    if (!ct.idCancha.value) return mostrarErrores(formTarea, { idCancha: 'Elige la cancha o el lugar.' }, 'Revisa los campos marcados.');
    if (datos.idCancha === 'otro') datos.idCancha = '';
    else datos.lugar = '';
    const v = V.validarTarea(datos);
    if (!v.ok) return mostrarErrores(formTarea, v.errores, 'Revisa los campos marcados.');
    const boton = $('btnGuardarTareaLp');
    ocupado(boton, true, 'Guardando…');
    const cuerpo = { ...v.datos, idCancha: v.datos.idCancha || '', lugar: v.datos.lugar || '', idUsuarioAsignado: v.datos.idUsuarioAsignado || '', notas: v.datos.notas || '' };
    const r = estado.editando
      ? await api('PUT', `/api/limpieza/tareas/${estado.editando.id}`, cuerpo)
      : await api('POST', '/api/limpieza/tareas', cuerpo);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formTarea, r.datos.errores || {}, r.datos.mensaje);
    $('dlgTareaLp').close();
    aviso(r.datos.mensaje);
    if (v.datos.fecha !== estado.fecha) estado.fecha = v.datos.fecha;
    cargar();
  });

  $('btnNuevaTarea').addEventListener('click', () => abrirTarea(null));

  /* -------------------------------------------------------------- */
  /*  Todas las tareas (ventana)                                     */
  /* -------------------------------------------------------------- */
  const filtrosTareas = $('filtrosTareasLp');
  async function cargarTodas() {
    const p = new URLSearchParams({ pagina: estado.todas.pagina });
    for (const el of filtrosTareas.elements) if (el.name && el.value) p.set(el.name, el.value);
    const r = await api('GET', `/api/limpieza/tareas?${p}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const d = r.datos;
    $('lpTodasTareas').replaceChildren(...(d.tareas.length ? d.tareas.map((t) => {
      const [clase, ic] = CLASE_ESTADO[t.estado] || CLASE_ESTADO.Pendiente;
      return h('tr', null, h('td', { class: 'sin-salto' }, F.corta(t.fecha)), h('td', null, t.hora),
        h('td', null, h('strong', null, t.tarea), t.notas ? h('small', { class: 'texto-tenue', title: t.notas }, ` · ${t.notas.slice(0, 40)}${t.notas.length > 40 ? '…' : ''}`) : null),
        h('td', null, lugar(t)), h('td', null, t.asignado || h('span', { class: 'texto-tenue' }, 'Sin asignar')),
        h('td', null, h('span', { class: `tarea-estado ${clase} tarea-estado--chico` }, icono(ic), t.estado)));
    }) : [h('tr', null, h('td', { colspan: 6, class: 'vacio' }, 'No hay tareas con esos filtros.'))]));
    $('lpTodasInfo').textContent = `${numero(d.total)} tarea(s) · página ${d.pagina} de ${d.paginas}`;
    paginacion($('lpTodasPaginas'), d.pagina, d.paginas, (n) => { estado.todas.pagina = n; cargarTodas(); });
  }
  filtrosTareas.addEventListener('change', () => { estado.todas.pagina = 1; cargarTodas(); });
  filtrosTareas.addEventListener('submit', (e) => e.preventDefault());
  $('btnVerTareas').addEventListener('click', async () => {
    filtrosTareas.reset();
    filtrosTareas.elements.desde.value = F.sumarDias(estado.fecha, -30);
    filtrosTareas.elements.hasta.value = F.sumarDias(estado.fecha, 30);
    estado.todas.pagina = 1;
    await cargarTodas();
    $('dlgTareasLp').showModal();
  });

  /* -------------------------------------------------------------- */
  /*  Reportes de condición (ventana) y atenderlos                   */
  /* -------------------------------------------------------------- */
  async function cargarReportes() {
    const p = estado.filtroReportes ? `?estado=${encodeURIComponent(estado.filtroReportes)}` : '';
    const r = await api('GET', `/api/limpieza/reportes${p}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const esAdmin = estado.datos && estado.datos.esAdmin;
    const urg = { Alta: 'etiqueta--rojo', Media: 'etiqueta--ambar', Baja: 'etiqueta--verde' };
    const est = { 'Sin resolver': 'etiqueta--rojo', 'En proceso': 'etiqueta--azul', Resuelto: 'etiqueta--verde' };
    $('lpListaReportes').replaceChildren(...(r.datos.reportes.length ? r.datos.reportes.map((x) => h('tr', null,
      h('td', { class: 'texto-tenue sin-salto' }, fechaHora(x.fecha)),
      h('td', { class: 'sin-salto' }, x.cancha),
      h('td', null, h('div', { class: 'descripcion' }, h('strong', null, x.tipoProblema), h('br'), h('small', { class: 'texto-tenue' }, x.descripcion),
        x.nota ? h('small', { class: 'texto-tenue' }, h('br'), `Nota: ${x.nota}`) : null)),
      h('td', null, h('span', { class: `etiqueta ${urg[x.urgencia] || ''}` }, x.urgencia)),
      h('td', null, h('span', { class: `etiqueta etiqueta--punto ${est[x.estado] || ''}` }, x.estado), x.atiende ? h('small', { class: 'texto-tenue' }, h('br'), x.atiende) : null),
      h('td', { class: 'sin-salto' }, x.reporta || '—'),
      h('td', null, esAdmin && x.estado !== 'Resuelto'
        ? h('button', { class: 'boton boton--secundario boton--chico', type: 'button', onclick: () => abrirAtender(x, x.estado === 'Sin resolver' ? 'En proceso' : 'Resuelto') }, 'Atender')
        : null)))
      : [h('tr', null, h('td', { colspan: 7, class: 'vacio' }, 'No hay reportes con ese estado.'))]));
  }
  $('lpReportesFiltros').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-estado]');
    if (!b) return;
    $('lpReportesFiltros').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    estado.filtroReportes = b.dataset.estado;
    cargarReportes();
  });
  async function abrirReportes() {
    estado.filtroReportes = '';
    $('lpReportesFiltros').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.estado === '')));
    await cargarReportes();
    if (!$('dlgReportesLp').open) $('dlgReportesLp').showModal();
  }

  const formAtender = $('formAtenderLp');
  limpiarAlEscribir(formAtender);
  function abrirAtender(x, sugerido) {
    estado.atendiendo = x;
    formAtender.reset();
    limpiarErrores(formAtender);
    $('dlgAtenderLpSub').textContent = `${x.cancha} · ${x.tipoProblema} (urgencia ${x.urgencia})`;
    const radio = formAtender.querySelector(`input[name="estado"][value="${sugerido}"]`);
    if (radio) radio.checked = true;
    formAtender.querySelector('input[value="En proceso"]').disabled = x.estado === 'En proceso';
    $('dlgAtenderLp').showModal();
  }
  formAtender.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = V.validarAtencionReporte(datosFormulario(formAtender));
    if (!v.ok) return mostrarErrores(formAtender, v.errores);
    const boton = formAtender.querySelector('[type=submit]');
    ocupado(boton, true, 'Guardando…');
    const r = await api('POST', `/api/limpieza/reportes/${estado.atendiendo.id}/atender`, { estado: v.datos.estado, nota: v.datos.nota || '' });
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formAtender, r.datos.errores || {}, r.datos.mensaje);
    $('dlgAtenderLp').close();
    aviso(r.datos.mensaje);
    cargar();
    if ($('dlgReportesLp').open) cargarReportes();
  });

  /* -------------------------------------------------------------- */
  /*  Fecha e insignia del menú                                      */
  /* -------------------------------------------------------------- */
  $('lpFecha').addEventListener('change', () => { if ($('lpFecha').value) { estado.fecha = $('lpFecha').value; cargar(); } });

  function actualizarInsignia(n) {
    const insignia = $('menuLimpieza');
    if (!insignia) return;
    insignia.textContent = n;
    insignia.hidden = !n;
    insignia.title = `${n} reporte(s) urgente(s) sin resolver`;
  }
  if ($('menuLimpieza')) {
    const revisar = async () => { const d = await sondeo('/api/limpieza/alertas'); if (d) actualizarInsignia(d.urgentes); };
    revisar();
    setInterval(revisar, 60 * 1000);
  }

  if (window.Panel) window.Panel.registrar('limpieza', 'Limpieza', cargar);
  window.Limpieza = { cargar };
})();
