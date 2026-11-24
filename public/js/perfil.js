/* =====================================================================
   Perfil de usuario
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, mostrarErrores, limpiarErrores, limpiarAlEscribir, datosFormulario, ocupado,
    fechaHora, iniciales, cerrarSesion, soloDigitos, soloNumeros, ojoContrasena } = window.App;
  const V = window.Validacion;
  const $ = (id) => document.getElementById(id);

  let perfil = null;
  let pendiente = null; // datos del formulario esperando el código MFA

  const formPerfil = $('formPerfil');
  const formClave = $('formClave');
  const formMfa = $('formMfa');
  [formPerfil, formClave, formMfa].forEach(limpiarAlEscribir);
  soloDigitos($('mCodigo'));
  soloDigitos($('sCodigo'));
  soloNumeros($('pTel'), 10);
  ['sActual', 'sNueva', 'sConfirmar'].forEach((id) => ojoContrasena($(id)));

  window.UI.dialogos();

  /* ---------- Secciones ---------- */
  /** Secciones extra según el rol: Árbitro → Mis partidos; Personal de limpieza → Limpieza */
  const EXTRAS = { arbitro: ['mis-partidos', 'enlaceMisPartidos', () => window.MisPartidos && window.MisPartidos.cargar()],
    limpieza: ['limpieza', 'enlaceLimpieza', () => window.Limpieza && window.Limpieza.cargar()] };
  const funciones = () => (perfil && perfil.funciones) || [];

  function mostrarSeccion() {
    const nombre = (location.hash || '#perfil').slice(1);
    const extras = funciones().map((f) => EXTRAS[f]).filter(Boolean);
    const validas = ['perfil', 'editar', 'seguridad', ...extras.map((x) => x[0])];
    const valida = validas.includes(nombre) ? nombre : 'perfil';
    document.querySelectorAll('main section[data-seccion]').forEach((s) => { s.hidden = s.dataset.seccion !== valida; });
    document.querySelectorAll('.menu a[data-seccion]').forEach((a) => {
      if (a.dataset.seccion === valida) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (valida === 'editar') llenarFormulario();
    const extra = extras.find((x) => x[0] === valida);
    if (extra) extra[2]();
  }

  /* ---------- Mostrar datos ---------- */
  function pintarPerfil() {
    const u = perfil;
    const nombreCompleto = [u.nombre, u.apellidoPaterno, u.apellidoMaterno].filter(Boolean).join(' ');
    $('usuarioNombre').textContent = `${u.nombre} ${u.apellidoPaterno}`;
    $('usuarioRol').textContent = u.rol;
    $('usuarioIniciales').textContent = iniciales(`${u.nombre} ${u.apellidoPaterno}`);
    $('perfilIniciales').textContent = iniciales(`${u.nombre} ${u.apellidoPaterno}`);
    $('perfilNombre').textContent = nombreCompleto;
    $('perfilCorreo').textContent = u.correo;
    $('perfilEtiquetas').replaceChildren(
      h('span', { class: 'etiqueta etiqueta--oscuro' }, u.rol),
      h('span', { class: `etiqueta ${u.estado === 'Activo' ? 'etiqueta--verde' : 'etiqueta--rojo'}` }, u.estado),
      h('span', { class: 'etiqueta etiqueta--verde' }, 'MFA activo'));

    const dato = (t, v) => h('div', null, h('dt', null, t), h('dd', null, v || '—'));
    $('perfilDatos').replaceChildren(
      dato('Nombre(s)', u.nombre),
      dato('Apellido paterno', u.apellidoPaterno),
      dato('Apellido materno', u.apellidoMaterno),
      dato('Correo', u.correo),
      dato('Teléfono', u.telefono),
      dato('Género', u.genero),
      dato('Rol', u.rol),
      dato('Estado de la cuenta', u.estado),
      dato('Último acceso', fechaHora(u.ultimoAcceso)));

    $('enlaceAdmin').hidden = u.nivel !== 'Administrador';
    for (const [clave, [, enlace]] of Object.entries(EXTRAS)) $(enlace).hidden = !funciones().includes(clave);
  }

  function llenarFormulario() {
    if (!perfil) return;
    const el = formPerfil.elements;
    limpiarErrores(formPerfil);
    el.nombre.value = perfil.nombre || '';
    el.apellidoPaterno.value = perfil.apellidoPaterno || '';
    el.apellidoMaterno.value = perfil.apellidoMaterno || '';
    el.telefono.value = String(perfil.telefono || '').replace(/\D/g, '').slice(0, 10);
    el.correo.value = perfil.correo || '';
    el.idGenero.value = perfil.idGenero;
    $('pRol').value = perfil.rol;
    $('pEstado').value = perfil.estado;
  }

  async function cargar() {
    const r = await api('GET', '/api/perfil');
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    perfil = r.datos.usuario;
    $('pGenero').replaceChildren(...r.datos.generos.map((g) => h('option', { value: g.id }, g.nombre)));
    pintarPerfil();
    mostrarSeccion();
    // Insignia de partidos por responder aunque no esté abierta la sección
    if (funciones().includes('arbitro') && location.hash !== '#mis-partidos' && window.MisPartidos) window.MisPartidos.cargar();
  }

  /* ---------- Editar información (con MFA) ---------- */
  formPerfil.addEventListener('submit', (e) => {
    e.preventDefault();
    const datos = datosFormulario(formPerfil);
    // Validar primero los datos; el código se pide después
    const v = V.validarPerfil({ ...datos, codigo: '000000' });
    if (!v.ok) return mostrarErrores(formPerfil, v.errores, 'Revisa los campos marcados.');
    limpiarErrores(formPerfil);
    pedirCodigo({ tipo: 'perfil', datos: v.datos }, 'Confirmar y guardar');
  });

  function pedirCodigo(accion, textoBoton) {
    pendiente = accion;
    formMfa.reset();
    limpiarErrores(formMfa);
    formMfa.querySelector('[type=submit]').textContent = textoBoton;
    $('dlgMfa').showModal();
    $('mCodigo').focus();
  }

  /* ---------- [OWASP A07] Cerrar sesión en los demás equipos ---------- */
  $('btnCerrarSesiones').addEventListener('click', () => pedirCodigo({ tipo: 'sesiones' }, 'Cerrar sesiones'));

  async function cerrarOtrasSesiones(codigo) {
    const boton = formMfa.querySelector('[type=submit]');
    ocupado(boton, true, 'Cerrando…');
    const r = await api('POST', '/api/perfil/cerrar-sesiones', { codigo });
    ocupado(boton, false);
    if (!r.ok) {
      $('mCodigo').value = '';
      return mostrarErrores(formMfa, r.datos.errores || {}, r.datos.mensaje);
    }
    $('dlgMfa').close();
    aviso(r.datos.mensaje);
  }

  formMfa.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = V.validarCodigo({ codigo: $('mCodigo').value });
    if (!v.ok) return mostrarErrores(formMfa, v.errores);
    if (!pendiente) return;
    if (pendiente.tipo === 'sesiones') return cerrarOtrasSesiones(v.datos.codigo);
    const boton = formMfa.querySelector('[type=submit]');
    ocupado(boton, true, 'Guardando…');
    const r = await api('PUT', '/api/perfil', { ...pendiente.datos, codigo: v.datos.codigo });
    ocupado(boton, false);

    if (!r.ok) {
      const errores = r.datos.errores || {};
      if (errores.codigo || r.estado === 422) {
        $('mCodigo').value = '';
        return mostrarErrores(formMfa, errores, r.datos.mensaje);
      }
      $('dlgMfa').close();
      return mostrarErrores(formPerfil, errores, r.datos.mensaje);
    }
    $('dlgMfa').close();
    perfil = r.datos.usuario;
    pintarPerfil();
    aviso(r.datos.mensaje);
    location.hash = '#perfil';
  });

  $('btnDeshacer').addEventListener('click', llenarFormulario);

  /* ---------- Cambiar contraseña ---------- */
  formClave.addEventListener('submit', async (e) => {
    e.preventDefault();
    const datos = datosFormulario(formClave);
    const v = V.validarCambioContrasena(datos);
    if (!v.ok) return mostrarErrores(formClave, v.errores, 'Revisa los campos marcados.');
    const boton = formClave.querySelector('[type=submit]');
    ocupado(boton, true, 'Guardando…');
    const r = await api('PUT', '/api/perfil/contrasena', { ...v.datos, confirmar: datos.confirmar });
    ocupado(boton, false);
    if (!r.ok) {
      formClave.elements.codigo.value = '';
      return mostrarErrores(formClave, r.datos.errores || {}, r.datos.mensaje);
    }
    formClave.reset();
    limpiarErrores(formClave);
    aviso(r.datos.mensaje);
  });

  $('btnSalir').addEventListener('click', cerrarSesion);
  window.addEventListener('hashchange', mostrarSeccion);
  cargar();
})();
