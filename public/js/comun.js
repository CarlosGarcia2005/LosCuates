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
    if (resp.status === 401 && !url.startsWith('/api/auth/')) {
      window.location.href = '/';
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
  function aviso(mensaje, tipo = 'exito') {
    let zona = document.getElementById('avisos');
    if (!zona) {
      zona = h('div', { id: 'avisos', class: 'avisos', 'aria-live': 'polite' });
      document.body.append(zona);
    }
    const el = h('div', { class: `aviso aviso--${tipo}`, role: tipo === 'error' ? 'alert' : 'status' }, mensaje);
    zona.append(el);
    setTimeout(() => el.classList.add('aviso--saliendo'), 4200);
    setTimeout(() => el.remove(), 4600);
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

  window.App = {
    api, h, aviso, limpiarErrores, mostrarErrores, limpiarAlEscribir, datosFormulario, ocupado,
    fechaHora, fecha, dinero: (v) => fmtDinero.format(Number(v) || 0), numero: (v) => fmtNumero.format(Number(v) || 0),
    iniciales, cerrarSesion, soloDigitos
  };
})();
