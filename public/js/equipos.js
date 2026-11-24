/* =====================================================================
   Panel de administración · Equipos
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, mostrarErrores, limpiarErrores, limpiarAlEscribir, datosFormulario, ocupado, iniciales, numero } = window.App;
  const { confirmar, fila, celda, filaVacia } = window.Panel;
  const { icono, paginacion, tonoDe, opciones } = window.UI;
  const V = window.Validacion;
  const $ = (id) => document.getElementById(id);

  const estado = { pagina: 1, editando: null, clientes: [] };
  const form = $('formEquipo');
  limpiarAlEscribir(form);

  /* ---------- Listado ---------- */
  async function cargar() {
    const p = new URLSearchParams({ pagina: estado.pagina });
    const q = $('eqBuscar').value.trim();
    if (q) p.set('q', q);
    const r = await api('GET', `/api/admin/equipos?${p}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const d = r.datos;
    estado.pagina = d.pagina;
    $('subEquipos').textContent = `${numero(d.totalRegistrados)} equipo${d.totalRegistrados === 1 ? '' : 's'} registrado${d.totalRegistrados === 1 ? '' : 's'}`;

    $('tablaEquipos').replaceChildren(...(d.equipos.length ? d.equipos.map((e) => fila(
      celda(h('div', { class: 'celda-equipo' },
        h('span', { class: `avatar-cuadro ${tonoDe(e.nombre)}` }, iniciales(e.nombre)),
        h('div', null, h('strong', null, e.nombre), h('span', { class: 'etiqueta etiqueta--naranja' }, 'Equipo')))),
      celda(h('div', { class: 'celda-persona' },
        h('span', { class: 'avatar avatar--suave' }, iniciales(e.responsable)),
        h('div', null, h('strong', null, e.responsable), h('small', null, `${e.rolResponsable} / Equipo`)))),
      celda(h('div', { class: 'celda-acciones' },
        h('button', { class: 'boton-fila', type: 'button', title: `Editar ${e.nombre}`, 'aria-label': `Editar ${e.nombre}`, onclick: () => abrir(e) }, icono('editar')),
        h('button', { class: 'boton-fila boton-fila--rojo', type: 'button', title: `Eliminar ${e.nombre}`, 'aria-label': `Eliminar ${e.nombre}`, onclick: () => eliminar(e) }, icono('borrar'))))
    )) : [filaVacia(3, q ? 'Ningún equipo coincide con la búsqueda.' : 'Todavía no hay equipos. Registra el primero con "Añadir equipo".')]));

    $('infoEquipos').textContent = `Mostrando ${d.equipos.length} de ${numero(d.total)} equipo${d.total === 1 ? '' : 's'}`;
    paginacion($('paginasEquipos'), d.pagina, d.paginas, (n) => { estado.pagina = n; cargar(); });
  }

  let espera;
  $('eqBuscar').addEventListener('input', () => {
    clearTimeout(espera);
    espera = setTimeout(() => { estado.pagina = 1; cargar(); }, 300);
  });

  /* ---------- Añadir / editar ---------- */
  function revisarBoton() {
    const v = V.validarEquipo(datosFormulario(form));
    $('btnGuardarEquipo').disabled = !v.ok;
    $('eqContador').textContent = `${$('eqNombre').value.length}/40`;
  }
  form.addEventListener('input', revisarBoton);
  form.addEventListener('change', revisarBoton);

  async function abrir(equipo) {
    const r = await api('GET', '/api/admin/equipos/catalogos');
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    estado.clientes = r.datos.clientes;
    estado.editando = equipo || null;
    form.reset();
    limpiarErrores(form);
    const lista = estado.clientes.map((c) => ({ valor: c.id, texto: `${c.nombre} · ${c.correo}` }));
    // Si el responsable actual ya no es Cliente, se muestra para no perderlo al editar
    if (equipo && !estado.clientes.some((c) => Number(c.id) === equipo.idUsuario)) {
      lista.unshift({ valor: equipo.idUsuario, texto: `${equipo.responsable} · ${equipo.correo} (${equipo.rolResponsable})` });
    }
    opciones($('eqUsuario'), lista, { vacio: lista.length ? 'Selecciona un usuario cliente' : 'No hay usuarios con rol Cliente' });
    $('eqUsuarioAyuda').textContent = lista.length ? 'Selecciona al usuario responsable del equipo'
      : 'Primero crea un usuario con rol "Cliente" en Usuarios.';
    $('dlgEquipoTitulo').textContent = equipo ? 'Editar equipo' : 'Añadir equipo';
    $('dlgEquipoSub').textContent = equipo ? `Actualiza los datos de ${equipo.nombre}` : 'Registra un nuevo equipo';
    $('btnGuardarEquipo').textContent = equipo ? 'Guardar cambios' : 'Añadir equipo';
    if (equipo) { $('eqNombre').value = equipo.nombre; $('eqUsuario').value = String(equipo.idUsuario); }
    revisarBoton();
    $('dlgEquipo').showModal();
    $('eqNombre').focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = V.validarEquipo(datosFormulario(form));
    if (!v.ok) return mostrarErrores(form, v.errores, 'Revisa los campos marcados.');
    const boton = $('btnGuardarEquipo');
    ocupado(boton, true, 'Guardando…');
    const r = estado.editando
      ? await api('PUT', `/api/admin/equipos/${estado.editando.idEquipo}`, v.datos)
      : await api('POST', '/api/admin/equipos', v.datos);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(form, r.datos.errores || {}, r.datos.mensaje);
    $('dlgEquipo').close();
    aviso(r.datos.mensaje);
    cargar();
  });

  async function eliminar(e) {
    const ok = await confirmar(`¿Eliminar "${e.nombre}"?`,
      e.reservas || e.partidos
        ? `Este equipo tiene ${e.reservas} reserva(s) y ${e.partidos} partido(s); para conservar el historial no se podrá eliminar.`
        : 'El equipo se quitará del catálogo. Esta acción no se puede deshacer.', 'Eliminar equipo');
    if (!ok) return;
    const r = await api('DELETE', `/api/admin/equipos/${e.idEquipo}`);
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error', r.ok ? 4200 : 8000);
    if (r.ok) cargar();
  }

  $('btnNuevoEquipo').addEventListener('click', () => abrir(null));
  window.Panel.registrar('equipos', 'Equipos', cargar);
})();
