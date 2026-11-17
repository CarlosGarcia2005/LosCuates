/* =====================================================================
   Panel de administración
   ===================================================================== */
(function () {
  'use strict';
  const {
    api, h, aviso, mostrarErrores, limpiarErrores, limpiarAlEscribir, datosFormulario, ocupado,
    fechaHora, fecha, dinero, numero, iniciales, cerrarSesion
  } = window.App;
  const V = window.Validacion;

  const $ = (id) => document.getElementById(id);
  const estado = { yo: null, roles: [], generos: [], bitacora: { pagina: 1, paginas: 1 }, usuarioEditando: null };

  /* -------------------------------------------------------------- */
  /*  Catálogo de acciones de la bitácora                            */
  /* -------------------------------------------------------------- */
  const ACCIONES = {
    LOGIN_EXITOSO: ['Inicio de sesión', 'verde'],
    LOGIN_PASO_1: ['Contraseña correcta', 'azul'],
    LOGIN_FALLIDO: ['Inicio fallido', 'rojo'],
    MFA_FALLIDO: ['Código MFA fallido', 'rojo'],
    MFA_CONFIGURADO: ['MFA activado', 'verde'],
    MFA_RESTABLECIDO: ['MFA restablecido', 'ambar'],
    CUENTA_BLOQUEADA: ['Cuenta bloqueada', 'rojo'],
    CUENTA_DESBLOQUEADA: ['Cuenta desbloqueada', 'ambar'],
    LOGOUT: ['Cierre de sesión', ''],
    ACCESO_PANEL: ['Acceso a pantalla', ''],
    ACCESO_DENEGADO: ['Acceso denegado', 'rojo'],
    USUARIO_CREADO: ['Usuario creado', 'verde'],
    USUARIO_EDITADO: ['Usuario editado', 'azul'],
    CONTRASENA_RESTABLECIDA: ['Contraseña asignada', 'ambar'],
    CONTRASENA_CAMBIADA: ['Contraseña cambiada', 'ambar'],
    HASH_ACTUALIZADO: ['Hash actualizado', ''],
    ROL_CREADO: ['Rol creado', 'verde'],
    ROL_EDITADO: ['Rol editado', 'azul'],
    PERFIL_EDITADO: ['Perfil editado', 'azul'],
    BITACORA_EXPORTADA: ['Bitácora exportada', ''],
    ERROR_SERVIDOR: ['Error del servidor', 'rojo'],
    SOLICITUD_RECHAZADA: ['Solicitud rechazada', 'rojo'],
    BD_INSERCION: ['Inserción directa en BD', 'oscuro'],
    BD_ACTUALIZACION: ['Cambio directo en BD', 'oscuro'],
    BD_ELIMINACION: ['Borrado directo en BD', 'oscuro'],
    CANCHA_CREADA: ['Cancha registrada', 'verde'],
    CANCHA_EDITADA: ['Cancha editada', 'azul'],
    CANCHA_ELIMINADA: ['Cancha eliminada', 'rojo'],
    RESERVA_CREADA: ['Reserva registrada', 'verde'],
    PAGO_REGISTRADO: ['Pago registrado', 'verde'],
    PAGO_VALIDADO: ['Pago validado', 'verde'],
    RESERVA_CANCELADA: ['Reserva cancelada', 'ambar'],
    RESERVA_FINALIZADA: ['Reserva finalizada', 'azul'],
    COMPROBANTE_SUBIDO: ['Comprobante subido', 'azul'],
    COMPROBANTE_CONSULTADO: ['Comprobante consultado', ''],
    RESERVAS_EXPORTADAS: ['Reservas exportadas', ''],
    SISTEMA: ['Sistema', 'oscuro']
  };
  const etiquetaAccion = (codigo) => {
    const [texto, color] = ACCIONES[codigo] || [codigo, ''];
    return h('span', { class: `etiqueta ${color ? 'etiqueta--' + color : ''}`, title: codigo }, texto);
  };
  const etiquetaResultado = (r) => h('span', { class: `etiqueta ${r === 'Fallo' ? 'etiqueta--rojo' : 'etiqueta--verde'}` }, r);
  const etiquetaEstado = (e) => h('span', { class: `etiqueta ${e === 'Activo' ? 'etiqueta--verde' : 'etiqueta--rojo'}` }, e);
  const fila = (...celdas) => h('tr', null, ...celdas);
  const celda = (contenido, clase) => h('td', clase ? { class: clase } : null, contenido);
  const filaVacia = (columnas, texto) => h('tr', null, h('td', { colspan: columnas, class: 'vacio' }, texto));

  const ICONO_EDITAR = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4');
    svg.append(p);
    return svg;
  };

  /* -------------------------------------------------------------- */
  /*  Diálogos                                                       */
  /* -------------------------------------------------------------- */
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target === d || e.target.closest('[data-cerrar]')) d.close();
    });
  });

  function confirmar(titulo, texto, textoBoton = 'Confirmar') {
    return new Promise((resolver) => {
      const dlg = $('dlgConfirmar');
      $('dlgConfirmarTitulo').textContent = titulo;
      $('dlgConfirmarTexto').textContent = texto;
      const btn = $('btnConfirmar');
      btn.textContent = textoBoton;
      const alAceptar = () => { dlg.close('si'); };
      btn.addEventListener('click', alAceptar, { once: true });
      dlg.addEventListener('close', () => {
        btn.removeEventListener('click', alAceptar);
        resolver(dlg.returnValue === 'si');
        dlg.returnValue = '';
      }, { once: true });
      dlg.showModal();
    });
  }

  function llenarSelect(select, opciones, { vacio } = {}) {
    select.replaceChildren(
      ...(vacio ? [h('option', { value: '' }, vacio)] : []),
      ...opciones.map((o) => h('option', { value: o.valor }, o.texto))
    );
  }

  /* -------------------------------------------------------------- */
  /*  Navegación entre secciones                                     */
  /* -------------------------------------------------------------- */
  const CARGAR = { dashboard: cargarDashboard, usuarios: cargarUsuarios, roles: cargarRoles, bitacora: cargarBitacora };
  const TITULOS = { dashboard: 'Dashboard', usuarios: 'Usuarios', roles: 'Roles', bitacora: 'Bitácora' };

  // Otras secciones (canchas.js, reservas.js) se registran aquí y reutilizan las utilidades del panel
  window.Panel = {
    registrar(nombre, titulo, cargar) { CARGAR[nombre] = cargar; TITULOS[nombre] = titulo; },
    confirmar, llenarSelect, fila, celda, filaVacia, ICONO_EDITAR, etiquetaAccion
  };

  function mostrarSeccion() {
    const nombre = (location.hash || '#dashboard').slice(1);
    const seccion = CARGAR[nombre] ? nombre : 'dashboard';
    document.querySelectorAll('main section[data-seccion]').forEach((s) => { s.hidden = s.dataset.seccion !== seccion; });
    document.querySelectorAll('.menu a[data-seccion]').forEach((a) => {
      if (a.dataset.seccion === seccion) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.title = `${TITULOS[seccion]} | Rancho Seco`;
    CARGAR[seccion]();
  }

  /* -------------------------------------------------------------- */
  /*  DASHBOARD                                                      */
  /* -------------------------------------------------------------- */
  function indicador(etiqueta, valor, detalle, alerta) {
    return h('article', { class: `tarjeta indicador ${alerta ? 'indicador--alerta' : ''}` },
      h('p', { class: 'indicador__etiqueta' }, etiqueta),
      h('p', { class: 'indicador__valor' }, valor),
      h('p', { class: 'indicador__detalle' }, detalle));
  }

  async function cargarDashboard() {
    const r = await api('GET', '/api/admin/dashboard');
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const i = r.datos.indicadores;
    const pctMfa = i.usuariosTotal ? Math.round((i.usuariosMfa / i.usuariosTotal) * 100) : 0;

    $('indicadores').replaceChildren(
      indicador('Usuarios activos', numero(i.usuariosActivos), `de ${numero(i.usuariosTotal)} registrados · ${numero(i.usuariosInactivos)} inactivos`),
      indicador('Cuentas con MFA', numero(i.usuariosMfa), `${pctMfa}% de los usuarios`),
      indicador('Reservas de hoy', numero(i.reservasHoy), `${numero(i.reservasPendientes)} pendientes · ${numero(i.reservasTotal)} en total`),
      indicador('Ingresos del mes', dinero(i.ingresosMes), `Histórico: ${dinero(i.ingresosTotal)}`),
      indicador('Torneos abiertos', numero(i.torneosAbiertos), `${numero(i.equipos)} equipos registrados`),
      indicador('Canchas disponibles', `${numero(i.canchasDisponibles)} / ${numero(i.canchasTotal)}`, 'El resto en mantenimiento u ocupadas'),
      indicador('Inicios de sesión (24 h)', numero(i.loginsExitosos24h), `${numero(i.movimientos24h)} movimientos en la bitácora`),
      indicador('Intentos fallidos (24 h)', numero(i.loginsFallidos24h), `${numero(i.usuariosBloqueados)} cuenta(s) bloqueada(s) ahora`, i.loginsFallidos24h > 0)
    );

    const max = Math.max(1, ...r.datos.porRol.map((x) => x.total));
    $('porRol').replaceChildren(...r.datos.porRol.map((x) => {
      const relleno = h('div', { class: 'barra__relleno' });
      relleno.style.width = `${(x.total / max) * 100}%`;
      return h('div', { class: 'barra__fila' },
        h('span', { class: 'barra__nombre', title: x.Rol }, x.Rol,
          x.Nivel_Acceso === 'Administrador' ? h('small', { class: 'texto-tenue' }, ' · admin') : null),
        h('div', { class: 'barra__pista' }, relleno),
        h('span', { class: 'barra__valor' }, x.total));
    }));

    $('actividad').replaceChildren(...(r.datos.actividad.length ? r.datos.actividad.map((a) =>
      h('li', null,
        h('span', { class: `actividad__punto ${a.Resultado === 'Fallo' ? 'actividad__punto--fallo' : ''}` }),
        h('div', null,
          h('p', null, a.Descripcion),
          h('small', null, `${fechaHora(a.Fecha)} · ${a.Correo_Usuario || 'Sin sesión'} · ${(ACCIONES[a.Accion] || [a.Accion])[0]}`)))
    ) : [h('li', { class: 'texto-tenue' }, 'Sin movimientos todavía.')]));

    $('proximasReservas').replaceChildren(...(r.datos.proximasReservas.length ? r.datos.proximasReservas.map((x) =>
      fila(celda(x.Folio, 'mono'), celda(fecha(x.Fecha)), celda(`${x.Inicio} – ${x.Fin}`), celda(x.Cancha), celda(x.Cliente),
        celda(h('span', { class: `etiqueta ${x.Estado === 'Confirmada' ? 'etiqueta--verde' : x.Estado === 'Cancelada' ? 'etiqueta--rojo' : 'etiqueta--ambar'}` }, x.Estado)))
    ) : [filaVacia(6, 'No hay reservas próximas.')]));
  }

  /* -------------------------------------------------------------- */
  /*  CATÁLOGOS                                                      */
  /* -------------------------------------------------------------- */
  async function cargarCatalogos() {
    const r = await api('GET', '/api/admin/catalogos');
    if (!r.ok) return;
    estado.roles = r.datos.roles;
    estado.generos = r.datos.generos;
    const opcionesRol = estado.roles.map((x) => ({ valor: x.id, texto: x.nivel === 'Administrador' ? `${x.nombre} (administrador)` : x.nombre }));
    llenarSelect($('uRol'), opcionesRol);
    llenarSelect($('uGenero'), estado.generos.map((x) => ({ valor: x.id, texto: x.nombre })));
    const actual = $('fRol').value;
    llenarSelect($('fRol'), estado.roles.map((x) => ({ valor: x.id, texto: x.nombre })), { vacio: 'Todos' });
    $('fRol').value = actual;
  }

  /* -------------------------------------------------------------- */
  /*  USUARIOS                                                       */
  /* -------------------------------------------------------------- */
  async function cargarUsuarios() {
    const params = new URLSearchParams();
    const f = $('filtrosUsuarios');
    for (const k of ['buscar', 'idRol', 'estado']) if (f.elements[k].value) params.set(k, f.elements[k].value);
    const r = await api('GET', `/api/admin/usuarios?${params}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');

    $('tablaUsuarios').replaceChildren(...(r.datos.usuarios.length ? r.datos.usuarios.map((u) => {
      const nombre = `${u.Nombre} ${u.Apellido_Paterno} ${u.Apellido_Materno || ''}`.trim();
      const esYo = estado.yo && u.idUsuario === estado.yo.id;
      return fila(
        celda(h('div', { class: 'celda-persona' },
          h('span', { class: 'avatar' }, iniciales(`${u.Nombre} ${u.Apellido_Paterno}`)),
          h('div', null, h('strong', null, nombre, esYo ? h('span', { class: 'texto-tenue' }, ' (tú)') : null), h('small', null, u.Correo)))),
        celda(h('span', { class: `etiqueta ${u.Nivel_Acceso === 'Administrador' ? 'etiqueta--oscuro' : ''}` }, u.Rol)),
        celda(u.Telefono ? String(u.Telefono) : '—', 'mono'),
        celda([etiquetaEstado(u.Estado), u.Bloqueado ? h('span', { class: 'etiqueta etiqueta--rojo', title: 'Bloqueada por intentos fallidos' }, ' Bloqueada') : null]),
        celda(h('span', { class: `etiqueta ${u.MFA_Activo ? 'etiqueta--verde' : 'etiqueta--ambar'}` }, u.MFA_Activo ? 'Activo' : 'Pendiente')),
        celda(fechaHora(u.Ultimo_Acceso), 'texto-tenue'),
        celda(h('div', { class: 'celda-acciones' },
          h('button', { class: 'boton boton--icono', type: 'button', title: `Editar a ${nombre}`, 'aria-label': `Editar a ${nombre}`,
            onclick: () => abrirUsuario(u.idUsuario) }, ICONO_EDITAR())))
      );
    }) : [filaVacia(7, 'No hay usuarios con esos filtros.')]));
  }

  let esperaBusqueda;
  $('filtrosUsuarios').addEventListener('input', () => {
    clearTimeout(esperaBusqueda);
    esperaBusqueda = setTimeout(cargarUsuarios, 300);
  });
  $('filtrosUsuarios').addEventListener('submit', (e) => { e.preventDefault(); cargarUsuarios(); });

  const formUsuario = $('formUsuario');
  limpiarAlEscribir(formUsuario);

  function abrirNuevoUsuario() {
    estado.usuarioEditando = null;
    formUsuario.reset();
    limpiarErrores(formUsuario);
    $('dlgUsuarioTitulo').textContent = 'Nuevo usuario';
    $('dlgUsuarioSub').textContent = 'Al entrar por primera vez configurará su verificación en dos pasos.';
    formUsuario.querySelectorAll('[data-solo-nuevo]').forEach((c) => { c.hidden = false; c.querySelector('input').disabled = false; });
    $('accionesSeguridad').hidden = true;
    const cliente = estado.roles.find((x) => x.nivel === 'Usuario');
    if (cliente) $('uRol').value = cliente.id;
    $('dlgUsuario').showModal();
    $('uNombre').focus();
  }

  async function abrirUsuario(id) {
    const r = await api('GET', `/api/admin/usuarios/${id}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const u = r.datos.usuario;
    estado.usuarioEditando = u;
    formUsuario.reset();
    limpiarErrores(formUsuario);
    $('dlgUsuarioTitulo').textContent = `Editar a ${u.nombre} ${u.apellidoPaterno}`;
    $('dlgUsuarioSub').textContent = `${u.correo} · MFA ${u.mfaActivo ? 'activo' : 'pendiente de configurar'}`;
    formUsuario.querySelectorAll('[data-solo-nuevo]').forEach((c) => { c.hidden = true; c.querySelector('input').disabled = true; });

    const el = formUsuario.elements;
    el.nombre.value = u.nombre || '';
    el.apellidoPaterno.value = u.apellidoPaterno || '';
    el.apellidoMaterno.value = u.apellidoMaterno || '';
    el.telefono.value = u.telefono || '';
    el.correo.value = u.correo || '';
    el.idGenero.value = u.idGenero;
    el.idRol.value = u.idRol;
    el.estado.value = u.estado;

    $('accionesSeguridad').hidden = false;
    $('btnDesbloquear').hidden = !u.bloqueadoHasta;
    $('btnResetMfa').hidden = !u.mfaActivo || u.idUsuario === estado.yo.id;
    $('dlgUsuario').showModal();
  }

  formUsuario.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nuevo = !estado.usuarioEditando;
    const datos = datosFormulario(formUsuario);
    const v = V.validarUsuarioAdmin(datos, { nuevo });
    if (!v.ok) return mostrarErrores(formUsuario, v.errores, 'Revisa los campos marcados.');

    const boton = $('btnGuardarUsuario');
    ocupado(boton, true, 'Guardando…');
    const cuerpo = { ...v.datos };
    if (nuevo) cuerpo.confirmar = datos.confirmar;
    const r = nuevo
      ? await api('POST', '/api/admin/usuarios', cuerpo)
      : await api('PUT', `/api/admin/usuarios/${estado.usuarioEditando.idUsuario}`, cuerpo);
    ocupado(boton, false);

    if (!r.ok) return mostrarErrores(formUsuario, r.datos.errores || {}, r.datos.mensaje);
    $('dlgUsuario').close();
    aviso(r.datos.mensaje);
    cargarUsuarios();
  });

  $('btnNuevoUsuario').addEventListener('click', abrirNuevoUsuario);

  // ----- Acciones de seguridad -----
  const formContrasena = $('formContrasena');
  limpiarAlEscribir(formContrasena);

  $('btnAsignarContrasena').addEventListener('click', () => {
    const u = estado.usuarioEditando;
    formContrasena.reset();
    limpiarErrores(formContrasena);
    $('dlgContrasenaSub').textContent = `Para ${u.nombre} ${u.apellidoPaterno} (${u.correo})`;
    $('dlgContrasena').showModal();
  });

  formContrasena.addEventListener('submit', async (e) => {
    e.preventDefault();
    const datos = datosFormulario(formContrasena);
    const v = V.validarNuevaContrasena(datos);
    if (!v.ok) return mostrarErrores(formContrasena, v.errores);
    const boton = formContrasena.querySelector('[type=submit]');
    ocupado(boton, true, 'Guardando…');
    const r = await api('POST', `/api/admin/usuarios/${estado.usuarioEditando.idUsuario}/contrasena`, datos);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formContrasena, r.datos.errores || {}, r.datos.mensaje);
    $('dlgContrasena').close();
    aviso(r.datos.mensaje);
  });

  $('btnResetMfa').addEventListener('click', async () => {
    const u = estado.usuarioEditando;
    const ok = await confirmar('¿Restablecer el MFA?',
      `${u.nombre} tendrá que escanear un código QR nuevo la próxima vez que inicie sesión y se cerrarán sus sesiones abiertas.`,
      'Restablecer MFA');
    if (!ok) return;
    const r = await api('POST', `/api/admin/usuarios/${u.idUsuario}/mfa-reset`);
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error');
    if (r.ok) { $('dlgUsuario').close(); cargarUsuarios(); }
  });

  $('btnDesbloquear').addEventListener('click', async () => {
    const r = await api('POST', `/api/admin/usuarios/${estado.usuarioEditando.idUsuario}/desbloquear`);
    aviso(r.datos.mensaje, r.ok ? 'exito' : 'error');
    if (r.ok) { $('btnDesbloquear').hidden = true; cargarUsuarios(); }
  });

  /* -------------------------------------------------------------- */
  /*  ROLES                                                          */
  /* -------------------------------------------------------------- */
  const formRol = $('formRol');
  limpiarAlEscribir(formRol);
  let rolEditando = null;

  async function cargarRoles() {
    const r = await api('GET', '/api/admin/roles');
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    $('tablaRoles').replaceChildren(...r.datos.roles.map((x) => fila(
      celda(h('strong', null, x.Rol)),
      celda(h('span', { class: `etiqueta ${x.Nivel_Acceso === 'Administrador' ? 'etiqueta--oscuro' : ''}` }, x.Nivel_Acceso)),
      celda(numero(x.usuarios)),
      celda(numero(x.activos || 0)),
      celda(h('div', { class: 'celda-acciones' },
        h('button', { class: 'boton boton--icono', type: 'button', title: `Editar rol ${x.Rol}`, 'aria-label': `Editar rol ${x.Rol}`,
          onclick: () => abrirRol(x) }, ICONO_EDITAR())))
    )));
  }

  function abrirRol(rol) {
    rolEditando = rol || null;
    formRol.reset();
    limpiarErrores(formRol);
    $('dlgRolTitulo').textContent = rol ? `Editar rol "${rol.Rol}"` : 'Nuevo rol';
    if (rol) { formRol.elements.rol.value = rol.Rol; formRol.elements.nivel.value = rol.Nivel_Acceso; }
    $('dlgRol').showModal();
    formRol.elements.rol.focus();
  }

  formRol.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = V.validarRol(datosFormulario(formRol));
    if (!v.ok) return mostrarErrores(formRol, v.errores);
    const boton = formRol.querySelector('[type=submit]');
    ocupado(boton, true, 'Guardando…');
    const r = rolEditando
      ? await api('PUT', `/api/admin/roles/${rolEditando.idRol}`, v.datos)
      : await api('POST', '/api/admin/roles', v.datos);
    ocupado(boton, false);
    if (!r.ok) return mostrarErrores(formRol, r.datos.errores || {}, r.datos.mensaje);
    $('dlgRol').close();
    aviso(r.datos.mensaje);
    await cargarCatalogos();
    cargarRoles();
  });

  $('btnNuevoRol').addEventListener('click', () => abrirRol(null));

  /* -------------------------------------------------------------- */
  /*  BITÁCORA                                                       */
  /* -------------------------------------------------------------- */
  const formBitacora = $('filtrosBitacora');

  function filtrosActuales() {
    const p = new URLSearchParams();
    for (const el of formBitacora.elements) if (el.name && el.value) p.set(el.name, el.value.trim());
    return p;
  }

  async function cargarOpcionesBitacora() {
    const r = await api('GET', '/api/admin/bitacora/opciones');
    if (!r.ok) return;
    const accion = $('bAccion').value, modulo = $('bModulo').value;
    llenarSelect($('bAccion'), r.datos.acciones.map((a) => ({ valor: a, texto: (ACCIONES[a] || [a])[0] })), { vacio: 'Todas' });
    llenarSelect($('bModulo'), r.datos.modulos.map((m) => ({ valor: m, texto: m })), { vacio: 'Todos' });
    $('bAccion').value = accion; $('bModulo').value = modulo;
  }

  async function cargarBitacora() {
    cargarOpcionesBitacora();
    const p = filtrosActuales();
    p.set('pagina', estado.bitacora.pagina);
    p.set('porPagina', 25);
    const r = await api('GET', `/api/admin/bitacora?${p}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const d = r.datos;
    estado.bitacora = { pagina: d.pagina, paginas: d.paginas };

    $('tablaBitacora').replaceChildren(...(d.registros.length ? d.registros.map((b) => {
      const tr = fila(
        celda(fechaHora(b.Fecha), 'texto-tenue sin-salto'),
        celda(h('div', null, h('strong', null, b.Correo_Usuario || 'Sin sesión'), h('br'), h('small', { class: 'texto-tenue' }, b.Rol_Usuario || '—'))),
        celda(etiquetaAccion(b.Accion)),
        celda(b.Modulo),
        celda(h('div', { class: 'descripcion' }, b.Descripcion, b.TieneDatos ? h('small', { class: 'texto-tenue' }, ' · ver cambios') : null)),
        celda(etiquetaResultado(b.Resultado)),
        celda(b.IP || '—', 'mono')
      );
      tr.className = 'fila-clic';
      tr.tabIndex = 0;
      tr.addEventListener('click', () => verDetalle(b.idBitacora));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') verDetalle(b.idBitacora); });
      return tr;
    }) : [filaVacia(7, 'No hay movimientos con esos filtros.')]));

    $('infoPaginacion').textContent = `${numero(d.total)} movimiento(s) · página ${d.pagina} de ${d.paginas}`;
    $('btnAnterior').disabled = d.pagina <= 1;
    $('btnSiguiente').disabled = d.pagina >= d.paginas;
  }

  let esperaBitacora;
  formBitacora.addEventListener('input', () => {
    clearTimeout(esperaBitacora);
    esperaBitacora = setTimeout(() => { estado.bitacora.pagina = 1; cargarBitacora(); }, 350);
  });
  formBitacora.addEventListener('reset', () => setTimeout(() => { estado.bitacora.pagina = 1; cargarBitacora(); }, 0));
  formBitacora.addEventListener('submit', (e) => e.preventDefault());
  $('btnAnterior').addEventListener('click', () => { estado.bitacora.pagina -= 1; cargarBitacora(); });
  $('btnSiguiente').addEventListener('click', () => { estado.bitacora.pagina += 1; cargarBitacora(); });
  $('btnExportar').addEventListener('click', () => {
    window.location.href = `/api/admin/bitacora/exportar?${filtrosActuales()}`;
    setTimeout(cargarBitacora, 1500);
  });

  const CAMPOS = {
    nombre: 'Nombre', apellidoPaterno: 'Apellido paterno', apellidoMaterno: 'Apellido materno', telefono: 'Teléfono',
    correo: 'Correo', genero: 'Género', rol: 'Rol', estado: 'Estado', nivel: 'Nivel de acceso', mfaActivo: 'MFA activo',
    errores: 'Errores de validación', filtros: 'Filtros', camposEnviados: 'Campos enviados'
  };
  const nombreCampo = (c) => CAMPOS[c] || c;
  const valorLegible = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const esObjeto = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function tablaCambios(antes, despues) {
    const campos = [...new Set([...Object.keys(antes || {}), ...Object.keys(despues || {})])];
    if (!campos.length) return null;
    const soloNuevos = !antes;
    return h('div', { class: 'tabla-contenedor' }, h('table', { class: 'cambios' },
      h('thead', null, h('tr', null, h('th', null, 'Campo'), ...(soloNuevos ? [h('th', null, 'Valor')] : [h('th', null, 'Antes'), h('th', null, 'Después')]))),
      h('tbody', null, ...campos.map((c) => soloNuevos
        ? fila(celda(h('strong', null, nombreCampo(c))), celda(valorLegible(despues[c]), 'despues'))
        : fila(celda(h('strong', null, nombreCampo(c))), celda(valorLegible(antes && antes[c]), 'antes'), celda(valorLegible(despues && despues[c]), 'despues'))))));
  }

  async function verDetalle(id) {
    const r = await api('GET', `/api/admin/bitacora/${id}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const b = r.datos.registro;
    $('dlgBitacoraSub').textContent = `Movimiento #${b.idBitacora} · ${fechaHora(b.Fecha)}`;

    const dato = (titulo, valor) => [h('dt', null, titulo), h('dd', null, valor)];
    const contenido = [
      h('dl', { class: 'detalle' },
        ...dato('Acción', [etiquetaAccion(b.Accion), h('span', { class: 'mono texto-tenue' }, ` ${b.Accion}`)]),
        ...dato('Resultado', etiquetaResultado(b.Resultado)),
        ...dato('Usuario', `${b.Correo_Usuario || 'Sin sesión'}${b.idUsuario ? ` (id ${b.idUsuario})` : ''}`),
        ...dato('Rol', b.Rol_Usuario || '—'),
        ...dato('Módulo', b.Modulo),
        ...dato('Tabla / registro', `${b.Tabla_Afectada || '—'}${b.idRegistro ? ` · id ${b.idRegistro}` : ''}`),
        ...dato('Descripción', b.Descripcion),
        ...dato('Origen', b.Origen),
        ...dato('IP', h('span', { class: 'mono' }, b.IP || '—')),
        ...dato('Navegador / equipo', h('span', { class: 'texto-tenue' }, b.Navegador || '—')))
    ];

    const antes = b.Datos_Anteriores, despues = b.Datos_Nuevos;
    if (esObjeto(antes) || esObjeto(despues)) {
      const tabla = tablaCambios(esObjeto(antes) ? antes : null, esObjeto(despues) ? despues : {});
      if (tabla) contenido.push(h('p', { class: 'subtitulo' }, 'Datos registrados'), tabla);
    } else if (antes || despues) {
      // Cambios directos en la BD (vienen como lista de filas)
      if (antes) contenido.push(h('p', { class: 'subtitulo' }, 'Antes'), h('pre', { class: 'json' }, JSON.stringify(antes, null, 2)));
      if (despues) contenido.push(h('p', { class: 'subtitulo' }, 'Después'), h('pre', { class: 'json' }, JSON.stringify(despues, null, 2)));
    }

    $('detalleBitacora').replaceChildren(...contenido);
    $('dlgBitacora').showModal();
  }

  /* -------------------------------------------------------------- */
  /*  Inicio                                                         */
  /* -------------------------------------------------------------- */
  $('btnSalir').addEventListener('click', cerrarSesion);
  $('btnRefrescarDashboard').addEventListener('click', cargarDashboard);
  window.addEventListener('hashchange', mostrarSeccion);

  (async function iniciar() {
    const r = await api('GET', '/api/auth/sesion');
    if (!r.ok) return;
    estado.yo = r.datos.usuario;
    $('usuarioNombre').textContent = estado.yo.nombre;
    $('usuarioRol').textContent = estado.yo.rol;
    $('usuarioIniciales').textContent = iniciales(estado.yo.nombre);
    $('saludo').textContent = `Hola, ${estado.yo.nombre.split(' ')[0]}. Este es el resumen del complejo deportivo.`;
    await cargarCatalogos();
    mostrarSeccion();
  })();
})();
