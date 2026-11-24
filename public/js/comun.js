/* =====================================================================
   Utilidades compartidas por todas las pantallas
   ===================================================================== */
(function () {
  'use strict';

  /** Petición al backend. Siempre manda el encabezado anti-CSRF. */
  async function api(metodo, url, cuerpo) {
    const opciones = {
      method: metodo,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' }
    };
    if (cuerpo !== undefined) {
      opciones.headers['Content-Type'] = 'application/json';
      opciones.body = JSON.stringify(cuerpo);
    }

    let resp;
    try {
      resp = await fetch(url, opciones);
    } catch {
      return { ok: false, estado: 0, datos: { mensaje: 'No hay conexión con el servidor. Revisa que esté encendido.' } };
    }

    let datos = {};
    try { datos = await resp.json(); } catch { datos = {}; }
    if (!datos.mensaje && !resp.ok) datos.mensaje = 'Ocurrió un problema. Intenta de nuevo.';

    // Sesión vencida en una pantalla protegida → volver al login
    if (resp.status === 401 && (datos.expulsado || !url.startsWith('/api/auth/'))) {
      // [OWASP A01] Si el servidor detectó una manipulación, se sale con aviso
      // [OWASP A07] Si venció por inactividad o por el máximo de horas, también se avisa
      const motivo = datos.expulsado ? 'seguridad' : ['inactividad', 'maximo'].includes(datos.motivo) ? datos.motivo : '';
      window.location.href = motivo ? `/?motivo=${motivo}` : '/';
    }
    return { ok: resp.ok, estado: resp.status, datos };
  }

  /** Crea elementos sin usar innerHTML (evita XSS). */
  function h(etiqueta, props, ...hijos) {
    const el = document.createElement(etiqueta);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const hijo of hijos.flat()) {
      if (hijo === null || hijo === undefined || hijo === false) continue;
      el.append(hijo instanceof Node ? hijo : document.createTextNode(String(hijo)));
    }
    return el;
  }

  /* ---------- Notificaciones ---------- */
  function aviso(mensaje, tipo = 'exito', duracionMs = 4200) {
    let zona = document.getElementById('avisos');
    if (!zona) {
      zona = h('div', { id: 'avisos', class: 'avisos', 'aria-live': 'polite' });
      document.body.append(zona);
    }
    const el = h('div', { class: `aviso aviso--${tipo}`, role: tipo === 'error' ? 'alert' : 'status' }, mensaje);
    zona.append(el);
    setTimeout(() => el.classList.add('aviso--saliendo'), duracionMs);
    setTimeout(() => el.remove(), duracionMs + 400);
  }

  /* ---------- Errores en formularios ---------- */
  function limpiarErrores(form) {
    form.querySelectorAll('.invalido').forEach((c) => {
      c.classList.remove('invalido');
      c.removeAttribute('aria-invalid');
    });
    form.querySelectorAll('[data-error]').forEach((e) => { e.textContent = ''; });
    const general = form.querySelector('.form-error');
    if (general) { general.textContent = ''; general.hidden = true; }
  }

  function mostrarErrores(form, errores = {}, mensajeGeneral) {
    limpiarErrores(form);
    let primero = null;
    for (const [campo, msg] of Object.entries(errores)) {
      const input = form.elements[campo];
      const salida = form.querySelector(`[data-error="${campo}"]`);
      if (input && input.classList) {
        input.classList.add('invalido');
        input.setAttribute('aria-invalid', 'true');
        primero = primero || input;
      }
      if (salida) salida.textContent = msg;
    }
    const general = form.querySelector('.form-error');
    if (general && mensajeGeneral) { general.textContent = mensajeGeneral; general.hidden = false; }
    if (primero) primero.focus();
  }

  /** Limpia el error de un campo en cuanto el usuario lo corrige. */
  function limpiarAlEscribir(form) {
    form.addEventListener('input', (e) => {
      const campo = e.target.name;
      if (!campo) return;
      e.target.classList.remove('invalido');
      e.target.removeAttribute('aria-invalid');
      const salida = form.querySelector(`[data-error="${campo}"]`);
      if (salida) salida.textContent = '';
    });
  }

  function datosFormulario(form) {
    const datos = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled || el.type === 'file') continue;
      if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) continue;
      datos[el.name] = el.value;
    }
    return datos;
  }

  function ocupado(boton, activo, texto) {
    if (!boton) return;
    if (activo) {
      boton.dataset.textoOriginal = boton.dataset.textoOriginal || boton.textContent;
      boton.disabled = true;
      boton.textContent = texto || 'Procesando…';
    } else {
      boton.disabled = false;
      if (boton.dataset.textoOriginal) boton.textContent = boton.dataset.textoOriginal;
    }
  }

  /* ---------- Formatos ---------- */
  const fmtFechaHora = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtFecha = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' });
  const fmtDinero = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const fmtNumero = new Intl.NumberFormat('es-MX');

  const fechaHora = (v) => (v ? fmtFechaHora.format(new Date(v)) : '—');
  const fecha = (v) => {
    if (!v) return '—';
    const [a, m, d] = String(v).slice(0, 10).split('-').map(Number);
    return fmtFecha.format(new Date(a, m - 1, d));
  };

  function iniciales(nombre) {
    return String(nombre || '?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  }

  async function cerrarSesion() {
    await api('POST', '/api/auth/logout');
    window.location.href = '/';
  }

  /** Solo acepta dígitos en los campos de código MFA. */
  function soloDigitos(input) {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
    });
  }

  /**
   * Campo que SOLO acepta números (por ejemplo el teléfono).
   * Bloquea letras, espacios y guiones al teclear y limpia lo pegado o autollenado.
   */
  function soloNumeros(input, maximo = 10) {
    if (!input || input.dataset.soloNumeros) return;
    input.dataset.soloNumeros = '1';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('pattern', '[0-9]*');
    input.maxLength = maximo;
    input.addEventListener('beforeinput', (e) => {
      if (e.data && /\D/.test(e.data) && e.inputType.startsWith('insert')) e.preventDefault();
    });
    input.addEventListener('input', () => {
      const limpio = input.value.replace(/\D/g, '').slice(0, maximo);
      if (limpio !== input.value) input.value = limpio;
    });
  }

  /* ---------- Ojo para ver u ocultar la contraseña ---------- */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcono(trazos) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    for (const [tipo, attrs] of trazos) {
      const el = document.createElementNS(SVG_NS, tipo);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  }
  const OJO_ABIERTO = () => svgIcono([['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: '12', cy: '12', r: '3' }]]);
  const OJO_CERRADO = () => svgIcono([['path', { d: 'M3 3l18 18' }],
    ['path', { d: 'M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5' }],
    ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }]]);

  /**
   * Agrega un botón con un ojo a un campo de contraseña.
   * Ojo cerrado = la contraseña está oculta (••••). Ojo abierto = se ve el texto.
   */
  function ojoContrasena(input) {
    if (!input || input.dataset.ojo) return;
    input.dataset.ojo = '1';
    const caja = h('div', { class: 'campo-clave' });
    input.replaceWith(caja);
    const boton = h('button', { class: 'campo-clave__ojo', type: 'button', 'aria-label': 'Mostrar contraseña', title: 'Mostrar contraseña', 'aria-pressed': 'false' });
    caja.append(input, boton);

    const pintar = (visible) => {
      input.type = visible ? 'text' : 'password';
      boton.replaceChildren(visible ? OJO_ABIERTO() : OJO_CERRADO());
      const texto = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
      boton.setAttribute('aria-label', texto);
      boton.title = texto;
      boton.setAttribute('aria-pressed', String(visible));
      boton.classList.toggle('activo', visible);
    };
    pintar(false);
    boton.addEventListener('click', () => { pintar(input.type === 'password'); input.focus(); });
    // Al cerrar o limpiar el formulario la contraseña vuelve a ocultarse
    if (input.form) input.form.addEventListener('reset', () => pintar(false));
  }

  /* ---------- [OWASP A07] Cierre de sesión por inactividad ----------
     Si nadie mueve el mouse ni escribe en 15 minutos, la página cierra la
     sesión sola. 1 minuto antes aparece un aviso para seguir conectado.
     La actividad se comparte entre pestañas (localStorage) para que una
     pestaña olvidada no cierre la sesión de otra que sí se está usando.
     El servidor tiene el mismo límite: el token vence a los 15 minutos. */
  function vigilarInactividad() {
    if (!['/admin', '/perfil'].includes(window.location.pathname)) return;

    const LIMITE = 15 * 60 * 1000;
    const AVISO = 60 * 1000;
    const RENOVAR_CADA = 4 * 60 * 1000;
    const CLAVE = 'rs_actividad';

    let ultima = Date.now();
    let ultimoPing = Date.now();
    let huboActividad = false;
    let cerrando = false;
    let banner = null;

    const leerCompartida = () => { try { return Number(localStorage.getItem(CLAVE)) || 0; } catch { return 0; } };
    const guardarCompartida = (t) => { try { localStorage.setItem(CLAVE, String(t)); } catch { /* sin almacenamiento */ } };

    function actividad() {
      const ahora = Date.now();
      if (ahora - ultima < 2000) return;        // no escribir en cada movimiento del mouse
      ultima = ahora;
      huboActividad = true;
      guardarCompartida(ahora);
      if (banner) ocultarBanner();
    }

    function ocultarBanner() { if (banner) { banner.remove(); banner = null; } }

    function mostrarBanner(segundos) {
      if (!banner) {
        const texto = h('span', null);
        const boton = h('button', { class: 'boton boton--primario', type: 'button' }, 'Seguir conectado');
        boton.addEventListener('click', () => { ultima = 0; actividad(); renovar(); });
        banner = h('div', { class: 'aviso-inactividad', role: 'alertdialog', 'aria-live': 'assertive' }, texto, boton);
        banner.texto = texto;
        document.body.append(banner);
        boton.focus();
      }
      banner.texto.textContent = `Por seguridad, tu sesión se cerrará en ${segundos} s por inactividad.`;
    }

    async function renovar() {
      ultimoPing = Date.now();
      huboActividad = false;
      await api('GET', '/api/auth/sesion');
    }

    async function cerrarPorInactividad() {
      if (cerrando) return;
      cerrando = true;
      await api('POST', '/api/auth/logout', { motivo: 'inactividad' });
      window.location.href = '/?motivo=inactividad';
    }

    ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'].forEach((ev) =>
      window.addEventListener(ev, actividad, { passive: true, capture: true }));

    setInterval(() => {
      const referencia = Math.max(ultima, leerCompartida());
      const inactivo = Date.now() - referencia;
      if (inactivo >= LIMITE) return cerrarPorInactividad();
      if (inactivo >= LIMITE - AVISO) return mostrarBanner(Math.ceil((LIMITE - inactivo) / 1000));
      ocultarBanner();
      if (huboActividad && Date.now() - ultimoPing >= RENOVAR_CADA) renovar();
    }, 1000);
  }

  /** Mensaje que dejó otra pantalla antes de redirigir (por ejemplo, el login). */
  function avisoPendiente() {
    let texto = null;
    try { texto = sessionStorage.getItem('rs_aviso'); sessionStorage.removeItem('rs_aviso'); } catch { /* nada */ }
    if (texto) aviso(texto, 'error', 12000);
  }

  vigilarInactividad();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', avisoPendiente);
  else avisoPendiente();

  window.App = {
    api, h, aviso, limpiarErrores, mostrarErrores, limpiarAlEscribir, datosFormulario, ocupado,
    fechaHora, fecha, dinero: (v) => fmtDinero.format(Number(v) || 0), numero: (v) => fmtNumero.format(Number(v) || 0),
    iniciales, cerrarSesion, soloDigitos, soloNumeros, ojoContrasena, svgIcono
  };
})();
