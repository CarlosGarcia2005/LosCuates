/* =====================================================================
   Panel de administración · Árbitros (asignación del cuerpo arbitral)
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, mostrarErrores, limpiarErrores, limpiarAlEscribir, ocupado, iniciales, numero, fechaHora } = window.App;
  const { confirmar, llenarSelect } = window.Panel;
  const { icono, paginacion, abrirEmergente, cerrarEmergente, F, colorCancha, opciones, sondeo } = window.UI;
  const V = window.Validacion;
  const $ = (id) => document.getElementById(id);

  const ESTADOS = {
    confirmado: ['Confirmado', 'estado--confirmado'], pendiente: ['Pendiente', 'estado--pendiente'],
    rechazado: ['Rechazado', 'estado--rechazado'], incompleto: ['Incompleto', 'estado--incompleto'],
    sin_asignar: ['Sin asignar', 'estado--sin_asignar']
  };
  const PUESTO_CORTO = { Central: 'Central', Lateral: 'Lateral', Contralateral: 'Contralateral', Cuarto: 'Cuarto árbitro' };
  const MES = (i) => F.MESES_CORTOS[i].replace(/^./, (c) => c.toUpperCase());

  const estado = {
    semana: null, filtro: '', pagina: 1, datos: null, seleccionado: null, tipoLibre: '7',
    disponibilidad: null, catalogos: null, partidoEditando: null, historial: { tipo: '', pagina: 1 }, reasignando: null
  };

  /* -------------------------------------------------------------- */
  /*  Semana                                                         */
  /* -------------------------------------------------------------- */
  function textoSemana(lunes) {
    const a = F.aFecha(lunes), b = F.aFecha(F.sumarDias(lunes, 6));
    return a.getMonth() === b.getMonth()
      ? `${a.getDate()} – ${b.getDate()} ${MES(a.getMonth())}, ${b.getFullYear()}`
      : `${a.getDate()} ${MES(a.getMonth())} – ${b.getDate()} ${MES(b.getMonth())}, ${b.getFullYear()}`;
  }
  function lunesDe(iso) { const f = F.aFecha(iso); f.setDate(f.getDate() - ((f.getDay() + 6) % 7)); return F.iso(f); }

  $('arbSemanaBoton').addEventListener('click', () => {
    const actual = lunesDe(F.hoy());
    const lista = [];
    for (let i = -4; i <= 8; i++) lista.push(F.sumarDias(actual, i * 7));
    $('arbSemanas').replaceChildren(...lista.map((l) => h('button', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(l === estado.semana),
      onclick: () => { cerrarEmergente(); estado.semana = l; estado.pagina = 1; cargar(); }
    }, textoSemana(l), l === actual ? h('small', null, 'Esta semana') : null)));
    abrirEmergente($('arbSemanas'), $('arbSemanaBoton'));
  });

  /* -------------------------------------------------------------- */
  /*  Tabla de partidos                                              */
  /* -------------------------------------------------------------- */
  const pastilla = (clave) => { const [t, c] = ESTADOS[clave] || [clave, '']; return h('span', { class: `estado-pastilla ${c}` }, t); };

  function celdaArbitro(p) {
    const caja = h('div', { class: 'arbitro-celda' });
    const central = p.arbitros.find((a) => a.puesto === 'Central') || p.arbitros[0];
    if (!central) {
      caja.append(h('strong', { class: 'texto-tenue' }, 'Sin asignar'), h('small', null, p.puestos.length > 1 ? '4 oficiales por asignar' : 'Central por asignar'));
      return caja;
    }
    caja.append(h('strong', null, central.nombre));
    const otros = p.arbitros.filter((a) => a !== central);
    if (p.puestos.length > 1 || otros.length) {
      const lista = h('ul', { class: 'lista-asistentes', hidden: true },
        ...p.arbitros.map((a) => h('li', null, h('span', null, `${PUESTO_CORTO[a.puesto] || a.puesto}:`), h('span', null, a.nombre),
          h('span', { class: `estado-arbitro ${a.estado}` }, a.estado))),
        ...p.puestos.filter((x) => !p.arbitros.some((a) => a.puesto === x)).map((x) =>
          h('li', null, h('span', null, `${PUESTO_CORTO[x]}:`), h('span', { class: 'texto-tenue' }, 'sin asignar'))));
      const chip = h('button', {
        class: 'chip-asistentes', type: 'button', 'aria-expanded': 'false',
        onclick: (e) => { e.stopPropagation(); lista.hidden = !lista.hidden; chip.setAttribute('aria-expanded', String(!lista.hidden)); }
      }, otros.length >= p.puestos.length - 1 ? `+${otros.length} Asistentes` : `${otros.length}/${p.puestos.length - 1} asistentes`, icono('chevron'));
      if (otros.length < p.puestos.length - 1) chip.classList.add('chip-asistentes--faltan');
      caja.append(chip, lista);
    } else {
      caja.append(h('small', null, 'Central'));
    }
    return caja;
  }

  function filaPartido(p) {
    const tr = h('tr', { class: p.idJuego === estado.seleccionado ? 'seleccionado' : null, tabIndex: 0, 'aria-label': `${p.local} contra ${p.visitante}` },
      h('td', null, h('div', { class: 'dia-hora' }, h('strong', null, F.DIAS_CORTOS[F.aFecha(p.fecha).getDay()]), h('small', null, p.inicio))),
      h('td', null, h('span', { class: `celda-con-punto ${colorCancha(p.cancha)}` }, h('span', { class: 'anillo' }), h('span', { class: 'texto-normal' }, p.cancha)),
        // En pantallas angostas la superficie se muestra aquí (se ocultan las columnas Superficie y Tipo de árbitro)
        h('small', { class: 'solo-compacto', title: p.puestos.length > 1 ? `Cuerpo arbitral · ${p.puestos.length} oficiales` : 'Árbitro central' }, p.superficie)),
      h('td', { class: 'col-sup' }, h('span', { class: 'chip-superficie' }, p.superficie)),
      h('td', { class: 'col-tipo' }, h('div', { class: 'tipo-arbitro' }, p.puestos.length > 1
        ? [h('strong', null, 'Cuerpo Arbitral'), h('small', null, `${p.puestos.length} oficiales`)]
        : h('strong', null, 'Árbitro Central'))),
      h('td', null, h('div', { class: 'equipos-celda' }, h('strong', null, p.local), h('small', null, `vs ${p.visitante}`))),
      h('td', null, celdaArbitro(p)),
      h('td', null, pastilla(p.estado)),
      h('td', null, h('div', { class: 'celda-acciones' },
        h('button', { class: 'boton-fila', type: 'button', title: p.yaPaso ? 'Ya se jugó' : `Editar ${p.local} vs ${p.visitante}`,
          'aria-label': `Editar ${p.local} vs ${p.visitante}`, disabled: p.yaPaso, onclick: (e) => { e.stopPropagation(); abrirPartido(p.idJuego); } }, icono('editar')),
        h('button', { class: 'boton-fila boton-fila--rojo', type: 'button', title: p.yaPaso ? 'Ya se jugó' : `Eliminar ${p.local} vs ${p.visitante}`,
          'aria-label': `Eliminar ${p.local} vs ${p.visitante}`, disabled: p.yaPaso, onclick: (e) => { e.stopPropagation(); eliminarPartido(p); } }, icono('borrar')))));
    // Al dar clic en la fila, el partido se carga en "Asignar árbitros"
    const elegir = () => { if (!p.yaPaso) seleccionar(p.idJuego, true); };
    tr.addEventListener('click', elegir);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') elegir(); });
    return tr;
  }

  function pintarTabla() {
    const d = estado.datos;
    $('tablaPartidos').replaceChildren(...(d.partidos.length ? d.partidos.map(filaPartido)
      : [h('tr', null, h('td', { colspan: 8, class: 'vacio' }, estado.filtro ? 'No hay partidos con ese estado esta semana.'
        : 'No hay partidos esta semana. Usa "Programar partido" para agregar uno.'))]));
    $('infoPartidos').textContent = `Mostrando ${d.partidos.length} de ${numero(d.total)} partido${d.total === 1 ? '' : 's'}`;
    paginacion($('paginasPartidos'), d.pagina, d.paginas, (n) => { estado.pagina = n; cargar(); });
  }

  /* -------------------------------------------------------------- */
  /*  Estadísticas y confirmaciones                                  */
  /* -------------------------------------------------------------- */
  function pintarResumen() {
    const { resumen: r, confirmaciones: c } = estado.datos;
    const stat = (ic, clase, n, texto) => h('article', { class: 'tarjeta stat' },
      h('span', { class: `stat__icono ${clase}` }, icono(ic)), h('div', null, h('strong', null, numero(n)), h('small', null, texto)));
    // Mismos números que "Confirmaciones de árbitros" (cada árbitro asignado cuenta una vez)
    $('arbStats').replaceChildren(
      stat('escudoOk', '', c.confirmado, `Asignaci${c.confirmado === 1 ? 'ón confirmada' : 'ones confirmadas'}`),
      stat('reloj', 'stat__icono--ambar', c.pendiente, 'Pendiente de confirmar'),
      stat('usuarios', 'stat__icono--azul', r.arbitrosDisponibles, `Árbitro${r.arbitrosDisponibles === 1 ? ' disponible' : 's disponibles'}`));

    // Porcentajes por residuo mayor: siempre suman exactamente 100 %
    const porcentajes = (() => {
      const claves = ['confirmado', 'pendiente', 'rechazado'];
      if (!c.total) return { confirmado: 0, pendiente: 0, rechazado: 0 };
      const base = claves.map((k) => { const v = (c[k] / c.total) * 100; return { k, n: Math.floor(v), resto: v - Math.floor(v) }; });
      let falta = 100 - base.reduce((a, b) => a + b.n, 0);
      [...base].sort((a, b) => b.resto - a.resto).forEach((x) => { if (falta > 0) { x.n += 1; falta -= 1; } });
      return Object.fromEntries(base.map((x) => [x.k, x.n]));
    })();
    const caja = (clase, ic, titulo, n, texto) => h('div', { class: `estado-caja ${clase}` },
      h('span', { class: 'estado-caja__icono' }, icono(ic)), h('div', null, h('b', null, titulo), h('strong', null, numero(n)), h('small', null, texto)));
    $('arbConfirmaciones').replaceChildren(
      caja('estado-caja--ok', 'check', 'Confirmado', c.confirmado, `${porcentajes.confirmado}% del total`),
      caja('estado-caja--pend', 'reloj', 'Pendiente', c.pendiente, `${porcentajes.pendiente}% del total`),
      caja(c.rechazado ? 'estado-caja--mal' : 'estado-caja--mal estado-caja--cero', 'x', 'Rechazado', c.rechazado, c.rechazado ? 'Requiere atención' : 'Sin rechazos'));

    const rechazos = estado.datos.rechazos;
    $('arbRechazos').replaceChildren(...rechazos.slice(0, 3).map(tarjetaRechazo),
      ...(rechazos.length > 3 ? [h('p', { class: 'mas-rechazos texto-tenue' }, `Y ${rechazos.length - 3} rechazo(s) más en otros partidos próximos.`)] : []));
  }

  function tarjetaRechazo(x) {
    const dato = (t, v, clase) => [h('dt', null, t), h('dd', { class: clase || null }, ...[].concat(v))];
    const f = F.aFecha(x.fecha);
    return h('section', { class: 'accion-requerida', 'aria-label': `Asignación rechazada por ${x.nombre}` },
      h('div', { class: 'accion-requerida__cabeza' },
        h('span', { class: 'accion-requerida__icono' }, icono('alerta')),
        h('div', null, h('small', null, 'ACCIÓN REQUERIDA'), h('h3', null, 'Asignación rechazada')),
        x.nuevo ? h('span', { class: 'etiqueta-nuevo' }, 'NUEVO') : null),
      h('div', { class: 'accion-requerida__cuerpo' },
        h('div', { class: 'persona-rechazo' }, h('span', { class: 'avatar avatar--rojo' }, iniciales(x.nombre)),
          h('div', null, h('strong', null, x.nombre), h('small', null, 'Rechazó su participación en este partido'))),
        h('dl', { class: 'datos-rechazo' },
          h('div', null, ...dato('PARTIDO', `${x.local} vs ${x.visitante}`)),
          h('div', null, ...dato('FECHA Y HORA', `${F.DIAS_CORTOS[f.getDay()]} ${f.getDate()} ${F.MESES_CORTOS[f.getMonth()]} · ${x.inicio} hrs`)),
          h('div', null, ...dato('CANCHA / MODALIDAD', [h('span', { class: `punto-dato ${colorCancha(x.cancha)}` }), `${x.cancha} · ${x.superficie}`])),
          h('div', null, ...dato('DESIGNACIÓN RECHAZADA', [icono('bandera'), x.puestoNombre], 'rojo'))),
        h('dl', { class: 'motivo-rechazo' },
          h('div', null, h('dt', null, 'MOTIVO DEL RECHAZO'), h('dd', null, x.motivo || 'Sin motivo')),
          h('div', null, h('dt', null, 'RECHAZADO EL'), h('dd', null, x.fechaRespuesta ? `${F.numerica(x.fechaRespuesta)} · ${F.hora(x.fechaRespuesta)} hrs` : '—')))),
      h('div', { class: 'accion-requerida__pie' },
        h('span', null, icono('alerta'), 'Falta cubrir 1 posición para completar el cuerpo arbitral.'),
        h('button', { class: 'boton boton--rojo-borde boton--chico', type: 'button', onclick: () => abrirReasignar(x) }, 'Reasignar árbitro', icono('flecha'))));
  }

  /* -------------------------------------------------------------- */
  /*  Carga                                                          */
  /* -------------------------------------------------------------- */
  async function cargar(silencioso = false) {
    if (!estado.semana) estado.semana = lunesDe(F.hoy());
    const p = new URLSearchParams({ semana: estado.semana, pagina: estado.pagina });
    if (estado.filtro) p.set('estado', estado.filtro);
    let datos;
    if (silencioso) {
      datos = await sondeo(`/api/admin/arbitros?${p}`);
      if (!datos) return;
    } else {
      const r = await api('GET', `/api/admin/arbitros?${p}`);
      if (!r.ok) return aviso(r.datos.mensaje, 'error');
      datos = r.datos;
    }
    estado.datos = datos;
    estado.semana = datos.semana.desde;
    $('arbSemanaTexto').textContent = textoSemana(datos.semana.desde);
    $('arbSubtitulo').textContent = `${datos.resumen.partidos} partido${datos.resumen.partidos === 1 ? '' : 's'} para ${datos.semana.actual ? 'esta semana' : 'la semana'}`;
    pintarTabla();
    pintarResumen();
    if (!silencioso) pintarPanel();
  }

  $('arbFiltro').addEventListener('change', () => { estado.filtro = $('arbFiltro').value; estado.pagina = 1; cargar(); });

  // Seguimiento en tiempo real: cada 30 s mientras la sección está abierta (no cuenta como actividad)
  setInterval(() => {
    if (!$('seccion-arbitros').hidden && !document.querySelector('dialog[open]')) cargar(true);
  }, 30 * 1000);

  /* -------------------------------------------------------------- */
  /*  Panel derecho: Asignar árbitros                                */
  /* -------------------------------------------------------------- */
  const formAsignar = $('formAsignar');
  limpiarAlEscribir(formAsignar);

  const partidoActual = () => (estado.datos ? estado.datos.todosLosPartidos.find((p) => p.idJuego === estado.seleccionado) : null);

  function pintarPanel() {
    const lista = estado.datos.todosLosPartidos.filter((p) => !p.yaPaso);
    if (estado.seleccionado && !lista.some((p) => p.idJuego === estado.seleccionado)) estado.seleccionado = null;
    const filtrados = estado.seleccionado ? lista : lista.filter((p) => (p.puestos.length > 1 ? '11' : '7') === estado.tipoLibre);
    opciones($('asPartido'), filtrados.map((p) => ({
      valor: p.idJuego, texto: `${F.DIAS_CORTOS[F.aFecha(p.fecha).getDay()]} ${p.inicio} · ${p.local} vs ${p.visitante}`
    })), { vacio: filtrados.length ? 'Elige un partido de la semana' : `No hay partidos de Fútbol ${estado.tipoLibre} pendientes esta semana`, valor: estado.seleccionado || '' });
    pintarAsignacion();
  }

  async function seleccionar(idJuego, desdeTabla) {
    estado.seleccionado = idJuego || null;
    estado.disponibilidad = null;
    if (desdeTabla) {
      document.querySelectorAll('#tablaPartidos tr').forEach((tr) => tr.classList.remove('seleccionado'));
      pintarPanel();
      if (window.matchMedia('(max-width: 1380px)').matches) $('formAsignar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    document.querySelectorAll('#tablaPartidos tr').forEach((tr, i) => {
      const p = estado.datos.partidos[i];
      if (p) tr.classList.toggle('seleccionado', p.idJuego === estado.seleccionado);
    });
    pintarAsignacion();
    if (estado.seleccionado) {
      const r = await api('GET', `/api/admin/arbitros/disponibilidad?idJuego=${estado.seleccionado}`);
      if (r.ok && estado.seleccionado === idJuego) { estado.disponibilidad = r.datos; pintarAsignacion(); }
    }
  }
  $('asPartido').addEventListener('change', () => seleccionar(Number($('asPartido').value) || null, false));

  $('asSuperficie').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tipo]');
    if (!b || b.disabled) return;
    estado.tipoLibre = b.dataset.tipo;
    estado.seleccionado = null;
    pintarPanel();
  });

  function selectArbitro(puesto, valor, lista, { estadoActual, prefijo = 'as' } = {}) {
    const avatar = h('span', { class: 'avatar avatar--oscuro' }, '?');
    const select = h('select', { name: `arb${puesto}`, id: `${prefijo}${puesto}`, 'aria-label': V.NOMBRES_PUESTO[puesto] });
    opciones(select, lista.map((a) => ({
      valor: a.id, texto: a.libre === false ? `${a.nombre} — ocupado: ${a.ocupadoEn}` : a.nombre, deshabilitada: a.libre === false && a.id !== valor
    })), { vacio: 'Selecciona un árbitro', valor: valor || '' });
    const actualizar = () => {
      const elegido = lista.find((a) => String(a.id) === select.value);
      avatar.textContent = elegido ? iniciales(elegido.nombre) : '?';
      select.classList.toggle('sin-eleccion', !elegido);
    };
    select.addEventListener('change', actualizar);
    actualizar();
    return h('div', { class: 'campo campo-arbitro' },
      h('label', { for: select.id }, h('span', null, V.NOMBRES_PUESTO[puesto], h('span', { class: 'req' }, ' *')),
        estadoActual ? h('span', { class: `estado-arbitro ${estadoActual}` }, estadoActual) : null),
      h('div', { class: 'select-persona' }, avatar, select),
      h('small', { 'data-error': select.name }));
  }

  function pintarAsignacion() {
    const p = partidoActual();
    const tipo = p ? (p.puestos.length > 1 ? '11' : '7') : estado.tipoLibre;
    $('asSuperficie').querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.tipo === tipo));
      b.disabled = Boolean(p) && b.dataset.tipo !== tipo;
      b.title = p && b.dataset.tipo !== tipo ? `Este partido es de ${p.superficie}` : '';
    });
    const puestos = p ? p.puestos : (tipo === '11' ? V.PUESTOS : ['Central']);
    $('asRequiere').textContent = puestos.length > 1 ? `Esta modalidad requiere ${puestos.length} árbitros` : 'Esta modalidad requiere 1 árbitro central';

    const disp = estado.disponibilidad;
    const base = disp ? disp.arbitros : (estado.datos ? estado.datos.arbitros.map((a) => ({ ...a, id: Number(a.id), libre: true })) : []);
    const asignados = p ? Object.fromEntries(p.arbitros.map((a) => [a.puesto, a])) : {};
    const contenedor = $('asArbitros');
    contenedor.replaceChildren(...puestos.map((puesto) => {
      const campo = selectArbitro(puesto, asignados[puesto] ? asignados[puesto].idUsuario : null, base,
        { estadoActual: asignados[puesto] ? asignados[puesto].estado : null });
      campo.querySelector('select').disabled = !p;
      return campo;
    }));

    // Árbitros disponibles (punto verde = libre a esa hora)
    const libres = base.filter((a) => a.libre !== false);
    $('asDisponibles').textContent = `${libres.length} disponible${libres.length === 1 ? '' : 's'}`;
    const MAX = 5;
    $('asAvatares').replaceChildren(...base.slice(0, MAX).map((a) => h('span', {
      class: `avatar${a.libre === false ? ' ocupado' : ''}`, title: a.libre === false ? `${a.nombre} · ocupado: ${a.ocupadoEn}` : `${a.nombre} · libre`
    }, iniciales(a.nombre))), ...(base.length > MAX ? [h('span', { class: 'avatar avatar--mas', title: base.slice(MAX).map((a) => a.nombre).join(', ') }, `+${base.length - MAX}`)] : []));

    const yaTiene = p && p.arbitros.length;
    $('asKicker').textContent = yaTiene ? 'EDITAR ASIGNACIÓN' : 'NUEVA ASIGNACIÓN';
    $('btnAsignar').querySelector('span').textContent = yaTiene ? 'Actualizar asignación' : puestos.length > 1 ? 'Asignar Árbitros' : 'Asignar Árbitro';
    $('btnAsignar').disabled = !p;
    revisarConflictos();
  }

  function revisarConflictos() {
    const disp = estado.disponibilidad;
    const elegidos = [...$('asArbitros').querySelectorAll('select')].map((s) => Number(s.value)).filter(Boolean);
    const repetido = elegidos.find((id, i) => elegidos.indexOf(id) !== i);
    const ocupados = disp ? disp.arbitros.filter((a) => a.libre === false && elegidos.includes(a.id)) : [];
    const aviso = $('asConflictos');
    aviso.classList.toggle('hay-conflicto', Boolean(repetido || ocupados.length));
    aviso.querySelector('span').textContent = repetido ? 'Un árbitro no puede ocupar dos puestos en el mismo partido'
      : ocupados.length ? `${ocupados[0].nombre} tiene otro partido a esa hora` : 'Sin conflictos de horario detectados';
  }
  $('asArbitros').addEventListener('change', revisarConflictos);

  formAsignar.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = partidoActual();
    if (!p) return mostrarErrores(formAsignar, { idJuego: 'Selecciona un partido.' });
    const arbitros = Object.fromEntries([...$('asArbitros').querySelectorAll('select')].map((s) => [s.name.replace('arb', ''), s.value]));
    const v = V.validarArbitros(arbitros, p.puestos, { completos: true });
    if (!v.ok) return mostrarErrores(formAsignar, v.errores, 'Revisa el cuerpo arbitral.');
    const boton = $('btnAsignar');
    ocupado(boton, true, 'Asignando…');
    const r = await api('PUT', `/api/admin/arbitros/partidos/${p.idJuego}/arbitros`, { arbitros: v.datos });
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formAsignar, r.datos.errores || {}, r.datos.mensaje);
    limpiarErrores(formAsignar);
    aviso(r.datos.mensaje);
    await cargar();
    seleccionar(p.idJuego, false);
  });

  /* -------------------------------------------------------------- */
  /*  Programar / editar partido                                     */
  /* -------------------------------------------------------------- */
  const formPartido = $('formPartido');
  limpiarAlEscribir(formPartido);
  const campos = formPartido.elements;

  async function cargarCatalogos() {
    const r = await api('GET', '/api/admin/arbitros/catalogos');
    if (!r.ok) { aviso(r.datos.mensaje, 'error'); return false; }
    estado.catalogos = r.datos;
    return true;
  }

  const torneoDe = (id) => (estado.catalogos.torneos.find((t) => String(t.id) === String(id)) || null);
  const abierto = (t) => !/finaliz|cancel|cerrad/i.test(t.estado);

  function prepararTorneo() {
    const t = estado.partidoEditando ? torneoDe(estado.partidoEditando.idTorneo) : torneoDe(campos.idTorneo.value);
    const idTipo = estado.partidoEditando ? estado.partidoEditando.idTipo : t && t.idTipo;
    const canchas = estado.catalogos.canchas.filter((c) => !idTipo || String(c.idTipo) === String(idTipo));
    const actual = campos.idCancha.value;
    opciones(campos.idCancha, canchas.map((c) => ({ valor: c.id, texto: `${c.nombre} · ${c.tipo}` })),
      { vacio: !idTipo ? 'Primero elige el torneo' : canchas.length ? 'Elige la cancha' : 'No hay canchas activas de esta modalidad', valor: actual });
    if (t) {
      campos.fecha.min = t.fechaInicio > F.hoy() ? t.fechaInicio : F.hoy();
      campos.fecha.max = t.fechaFin;
    }
    const tipoTexto = estado.partidoEditando ? estado.partidoEditando.superficie : t ? t.tipo : '';
    const puestos = tipoTexto ? V.puestosDe(tipoTexto) : [];
    $('ptRequiere').textContent = !tipoTexto ? 'Elige el torneo para saber cuántos árbitros necesita.'
      : puestos.length > 1 ? `${tipoTexto}: central, 2 abanderados y cuarto árbitro.` : `${tipoTexto}: 1 árbitro central.`;
    return puestos;
  }

  async function pintarArbitrosPartido() {
    const puestos = prepararTorneo();
    const contenedor = $('ptArbitros');
    const previos = Object.fromEntries([...contenedor.querySelectorAll('select')].map((s) => [s.name.replace('arb', ''), Number(s.value) || null]));
    const editando = estado.partidoEditando;
    const asignados = editando ? Object.fromEntries(editando.arbitros.map((a) => [a.puesto, a])) : {};
    let lista = estado.catalogos.arbitros.map((a) => ({ ...a, id: Number(a.id), libre: true }));
    const fin = horaFin();
    if (campos.fecha.value && campos.horaInicio.value && fin) {
      const q = new URLSearchParams({ fecha: campos.fecha.value, inicio: campos.horaInicio.value, fin });
      if (editando) q.set('idJuego', editando.idJuego);
      const r = await api('GET', `/api/admin/arbitros/disponibilidad?${q}`);
      if (r.ok) lista = r.datos.arbitros;
    }
    contenedor.replaceChildren(...puestos.map((p) => selectArbitro(p,
      previos[p] !== undefined ? previos[p] : asignados[p] ? asignados[p].idUsuario : null, lista,
      { estadoActual: asignados[p] ? asignados[p].estado : null, prefijo: 'pt' })));
  }

  function horaFin() {
    const inicio = campos.horaInicio.value, dur = Number(campos.duracion.value);
    if (!/^\d{2}:\d{2}$/.test(inicio) || !dur) return null;
    const m = V.aMinutos(inicio) + dur;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  async function abrirPartido(idJuego) {
    if (!(await cargarCatalogos())) return;
    formPartido.reset();
    limpiarErrores(formPartido);
    estado.partidoEditando = null;
    const c = estado.catalogos;
    const horas = c.horarios.map((x) => ({ valor: x.inicio, texto: x.inicio }));
    const nuevo = !idJuego;
    formPartido.querySelectorAll('[data-solo-nuevo]').forEach((el) => {
      el.hidden = !nuevo;
      el.querySelectorAll('select').forEach((s) => { s.disabled = !nuevo; });
    });

    if (nuevo) {
      opciones(campos.idTorneo, c.torneos.filter(abierto).map((t) => ({ valor: t.id, texto: `${t.nombre} · ${t.tipo}` })),
        { vacio: c.torneos.some(abierto) ? 'Elige el torneo' : 'No hay torneos abiertos: crea uno' });
      const equipos = c.equipos.map((q) => ({ valor: q.id, texto: q.nombre }));
      opciones(campos.idLocal, equipos, { vacio: 'Elige al equipo local' });
      opciones(campos.idVisitante, equipos, { vacio: 'Elige al equipo visitante' });
      opciones(campos.horaInicio, horas, { vacio: 'Hora' });
      campos.fecha.value = '';
      campos.fecha.min = F.hoy();
      $('ptResumen').hidden = true;
      $('dlgPartidoKicker').textContent = 'Nuevo partido';
      $('dlgPartidoTitulo').textContent = 'Programar partido';
      $('dlgPartidoSub').textContent = 'Se apartará la cancha con una reserva (folio automático).';
      $('btnGuardarPartido').textContent = 'Programar partido';
    } else {
      const r = await api('GET', `/api/admin/arbitros/partidos/${idJuego}`);
      if (!r.ok) return aviso(r.datos.mensaje, 'error');
      const p = r.datos.partido;
      estado.partidoEditando = p;
      if (!horas.some((x) => x.valor === p.inicio)) horas.unshift({ valor: p.inicio, texto: p.inicio });
      opciones(campos.horaInicio, horas, { valor: p.inicio });
      $('ptResumen').hidden = false;
      $('ptResumen').replaceChildren(icono('balon'), h('div', null,
        h('strong', null, `${p.local} vs ${p.visitante}`),
        h('small', null, `${p.torneo} · ${p.superficie} · Reserva ${p.folio || '—'}${p.pagado ? ' (pagada)' : ''}`)));
      campos.jornada.value = p.jornada;
      campos.fecha.value = p.fecha;
      campos.fecha.min = F.hoy();
      const dur = V.aMinutos(p.fin) - V.aMinutos(p.inicio);
      campos.duracion.value = String([60, 90, 120].includes(dur) ? dur : 60);
      $('dlgPartidoKicker').textContent = 'Editar partido';
      $('dlgPartidoTitulo').textContent = 'Editar partido';
      $('dlgPartidoSub').textContent = 'Si cambias el día, la hora o la cancha, los árbitros deberán volver a confirmar.';
      $('btnGuardarPartido').textContent = 'Guardar cambios';
    }
    prepararTorneo();
    if (estado.partidoEditando) campos.idCancha.value = String(estado.partidoEditando.idCancha);
    await pintarArbitrosPartido();
    $('dlgPartido').showModal();
  }

  campos.idTorneo.addEventListener('change', () => {
    const t = torneoDe(campos.idTorneo.value);
    if (t) {
      campos.jornada.value = String(Math.min(99, (t.ultimaJornada || 0) + 1));
      campos.duracion.value = V.esFutbol11(t.tipo) ? '120' : '60';
    }
    pintarArbitrosPartido();
  });
  ['fecha', 'horaInicio', 'duracion'].forEach((n) => campos[n].addEventListener('change', pintarArbitrosPartido));

  formPartido.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editando = estado.partidoEditando;
    const datos = {
      jornada: campos.jornada.value, idCancha: campos.idCancha.value, fecha: campos.fecha.value,
      horaInicio: campos.horaInicio.value, duracion: campos.duracion.value
    };
    if (!editando) Object.assign(datos, { idTorneo: campos.idTorneo.value, idLocal: campos.idLocal.value, idVisitante: campos.idVisitante.value });
    const v = V.validarPartido(datos, { nuevo: !editando });
    const arbitros = Object.fromEntries([...$('ptArbitros').querySelectorAll('select')].map((s) => [s.name.replace('arb', ''), s.value]));
    const t = editando ? null : torneoDe(datos.idTorneo);
    const puestos = editando ? editando.puestos : t ? V.puestosDe(t.tipo) : [];
    const va = V.validarArbitros(arbitros, puestos, { completos: false });
    const errores = { ...v.errores, ...va.errores };
    if (Object.keys(errores).length) return mostrarErrores(formPartido, errores, 'Revisa los campos marcados.');

    const cuerpo = { ...datos, jornada: v.datos.jornada, duracion: v.datos.duracion, arbitros: va.datos };
    const boton = $('btnGuardarPartido');
    ocupado(boton, true, 'Guardando…');
    const r = editando
      ? await api('PUT', `/api/admin/arbitros/partidos/${editando.idJuego}`, cuerpo)
      : await api('POST', '/api/admin/arbitros/partidos', cuerpo);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formPartido, r.datos.errores || {}, r.datos.mensaje);
    $('dlgPartido').close();
    aviso(r.datos.mensaje, 'exito', 6000);
    // Ir a la semana del partido para verlo
    estado.semana = lunesDe(cuerpo.fecha);
    estado.pagina = 1;
    await cargar();
    if (r.datos.partido) seleccionar(r.datos.partido.idJuego, false);
  });

  $('btnProgramarPartido').addEventListener('click', () => abrirPartido(null));

  /* ---------- Nuevo torneo ---------- */
  const formTorneo = $('formTorneo');
  limpiarAlEscribir(formTorneo);
  $('toCosto').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^\d.]/g, ''); });
  $('btnNuevoTorneo').addEventListener('click', () => {
    formTorneo.reset();
    limpiarErrores(formTorneo);
    llenarSelect($('toTipo'), estado.catalogos.tipos.map((t) => ({ valor: t.id, texto: t.nombre })), { vacio: 'Elige la modalidad' });
    formTorneo.elements.fechaInicio.value = F.hoy();
    $('dlgTorneo').showModal();
    $('toNombre').focus();
  });
  formTorneo.addEventListener('submit', async (e) => {
    e.preventDefault();
    const datos = Object.fromEntries(['nombre', 'idTipo', 'fechaInicio', 'fechaFin', 'costo'].map((k) => [k, formTorneo.elements[k].value]));
    const v = V.validarTorneo(datos);
    if (!v.ok) return mostrarErrores(formTorneo, v.errores);
    const boton = formTorneo.querySelector('[type=submit]');
    ocupado(boton, true, 'Creando…');
    const r = await api('POST', '/api/admin/arbitros/torneos', v.datos);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formTorneo, r.datos.errores || {}, r.datos.mensaje);
    $('dlgTorneo').close();
    aviso(r.datos.mensaje);
    await cargarCatalogos();
    opciones(campos.idTorneo, estado.catalogos.torneos.filter(abierto).map((t) => ({ valor: t.id, texto: `${t.nombre} · ${t.tipo}` })),
      { vacio: 'Elige el torneo', valor: r.datos.torneo.id });
    campos.idTorneo.dispatchEvent(new Event('change'));
  });

  /* ---------- Eliminar ---------- */
  const formEliminar = $('formEliminarPartido');
  let eliminando = null;
  function eliminarPartido(p) {
    eliminando = p;
    formEliminar.reset();
    $('dlgEliminarPartidoSub').textContent = `${p.local} vs ${p.visitante} · ${F.larga(p.fecha)}, ${p.inicio} · ${p.cancha}`;
    const sinArbitros = !p.arbitros.length;
    const radios = formEliminar.elements.modo;
    radios[0].disabled = sinArbitros;
    radios[1].disabled = p.pagado;
    $('eliminarPartidoTexto').textContent = p.pagado
      ? `No disponible: la reserva ${p.folio} ya tiene un pago registrado.`
      : `Se borra el partido y se libera ${p.cancha} (reserva ${p.folio}).`;
    radios[sinArbitros ? 1 : 0].checked = true;
    if (sinArbitros && p.pagado) return aviso('Este partido no tiene árbitros y su reserva ya está pagada: no hay nada que eliminar aquí.', 'error', 7000);
    $('dlgEliminarPartido').showModal();
  }
  formEliminar.addEventListener('submit', async (e) => {
    e.preventDefault();
    const modo = formEliminar.elements.modo.value;
    const boton = formEliminar.querySelector('[type=submit]');
    ocupado(boton, true, 'Eliminando…');
    const r = await api('DELETE', `/api/admin/arbitros/partidos/${eliminando.idJuego}?modo=${modo}`);
    ocupado(boton, false);
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error', 6000);
    if (!r.ok) return;
    $('dlgEliminarPartido').close();
    if (estado.seleccionado === eliminando.idJuego) estado.seleccionado = null;
    cargar();
  });

  /* -------------------------------------------------------------- */
  /*  Historial                                                      */
  /* -------------------------------------------------------------- */
  const ICONOS_HISTORIAL = {
    ASIGNACION_CONFIRMADA: ['check', 'estado--confirmado'], ASIGNACION_RECHAZADA: ['x', 'estado--rechazado'],
    ARBITROS_ASIGNADOS: ['silbato', 'estado--sin_asignar'], ARBITRO_REASIGNADO: ['historial', 'estado--pendiente'],
    ASIGNACION_ELIMINADA: ['borrar', 'estado--rechazado'], PARTIDO_PROGRAMADO: ['calendario', 'estado--confirmado'],
    PARTIDO_EDITADO: ['editar', 'estado--sin_asignar'], PARTIDO_ELIMINADO: ['borrar', 'estado--rechazado'], TORNEO_CREADO: ['balon', 'estado--confirmado']
  };
  async function cargarHistorial() {
    const { tipo, pagina } = estado.historial;
    const r = await api('GET', `/api/admin/arbitros/historial?${new URLSearchParams({ tipo, pagina })}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const d = r.datos;
    $('listaHistorial').replaceChildren(...(d.registros.length ? d.registros.map((x) => {
      const [ic, clase] = ICONOS_HISTORIAL[x.Accion] || ['info', 'estado--sin_asignar'];
      const li = h('li', { tabIndex: 0, title: 'Ver el detalle en la bitácora' },
        h('span', { class: `linea-tiempo__icono ${clase}` }, icono(ic)),
        h('div', null, h('p', null, x.Descripcion), h('small', null, `${fechaHora(x.Fecha)} · ${x.usuario}${x.rol ? ` (${x.rol})` : ''}`)));
      li.addEventListener('click', () => window.Panel.verDetalleBitacora(x.idBitacora));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.Panel.verDetalleBitacora(x.idBitacora); });
      return li;
    }) : [h('li', { class: 'vacio' }, 'Todavía no hay movimientos de este tipo.')]));
    $('infoHistorial').textContent = `${numero(d.total)} movimiento(s) · página ${d.pagina} de ${d.paginas}`;
    paginacion($('paginasHistorial'), d.pagina, d.paginas, (n) => { estado.historial.pagina = n; cargarHistorial(); });
  }
  $('historialFiltros').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tipo]');
    if (!b) return;
    $('historialFiltros').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    estado.historial = { tipo: b.dataset.tipo, pagina: 1 };
    cargarHistorial();
  });
  $('btnHistorial').addEventListener('click', async () => {
    estado.historial = { tipo: '', pagina: 1 };
    $('historialFiltros').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tipo === '')));
    await cargarHistorial();
    $('dlgHistorial').showModal();
  });

  /* -------------------------------------------------------------- */
  /*  Reasignar árbitro                                              */
  /* -------------------------------------------------------------- */
  const formReasignar = $('formReasignar');
  limpiarAlEscribir(formReasignar);
  async function abrirReasignar(x) {
    estado.reasignando = x;
    formReasignar.reset();
    limpiarErrores(formReasignar);
    $('dlgReasignarSub').textContent = `${x.puestoNombre} · ${x.local} vs ${x.visitante}`;
    $('reasignarResumen').replaceChildren(icono('alerta'), h('div', null,
      h('strong', null, `${x.nombre} rechazó: ${x.motivo || 'sin motivo'}`),
      h('small', null, `${F.larga(x.fecha)}, ${x.inicio} hrs · ${x.cancha} · ${x.superficie}`)));
    const [disp, det] = await Promise.all([
      api('GET', `/api/admin/arbitros/disponibilidad?idJuego=${x.idJuego}`),
      api('GET', `/api/admin/arbitros/partidos/${x.idJuego}`)]);
    if (!disp.ok || !det.ok) return aviso((disp.ok ? det : disp).datos.mensaje, 'error');
    const enPartido = new Map(det.datos.partido.arbitros.map((a) => [a.idUsuario, a.puesto]));
    const lista = disp.datos.arbitros;
    opciones($('raArbitro'), lista.map((a) => ({
      valor: a.id,
      texto: enPartido.has(a.id) ? `${a.nombre} — ya está como ${PUESTO_CORTO[enPartido.get(a.id)]}` : a.libre ? a.nombre : `${a.nombre} — ocupado: ${a.ocupadoEn}`,
      deshabilitada: enPartido.has(a.id) || !a.libre
    })), { vacio: 'Selecciona al nuevo árbitro' });
    const actualizar = () => {
      const a = lista.find((y) => String(y.id) === $('raArbitro').value);
      $('raAvatar').textContent = a ? iniciales(a.nombre) : '?';
    };
    $('raArbitro').onchange = actualizar;
    actualizar();
    $('dlgReasignar').showModal();
  }
  formReasignar.addEventListener('submit', async (e) => {
    e.preventDefault();
    const idUsuario = $('raArbitro').value;
    if (!idUsuario) return mostrarErrores(formReasignar, { idUsuario: 'Selecciona al nuevo árbitro.' });
    const boton = formReasignar.querySelector('[type=submit]');
    ocupado(boton, true, 'Reasignando…');
    const r = await api('POST', `/api/admin/arbitros/asignaciones/${estado.reasignando.id}/reasignar`, { idUsuario: Number(idUsuario) });
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formReasignar, r.datos.errores || {}, r.datos.mensaje);
    $('dlgReasignar').close();
    aviso(r.datos.mensaje, 'exito', 6000);
    cargar();
  });

  window.Panel.registrar('arbitros', 'Árbitros', () => cargar());
  window.Arbitros = { confirmar };
})();
