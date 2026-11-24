/* =====================================================================
   Piezas de interfaz compartidas por los módulos nuevos
   (íconos, paginación, ventanas emergentes, formatos de fecha y colores)
   Todo se crea con elementos del DOM (sin innerHTML).
   ===================================================================== */
(function () {
  'use strict';
  const { h, svgIcono } = window.App;

  /* ---------- Íconos (trazos SVG de 24×24) ---------- */
  const T = {
    calendario: [['rect', { x: '3', y: '4.5', width: '18', height: '16', rx: '2' }], ['path', { d: 'M16 2.5v4M8 2.5v4M3 10h18' }]],
    calendarioDias: [['rect', { x: '3', y: '4.5', width: '18', height: '16', rx: '2' }], ['path', { d: 'M16 2.5v4M8 2.5v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01' }]],
    chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
    mas: [['path', { d: 'M12 5v14M5 12h14' }]],
    lupa: [['circle', { cx: '11', cy: '11', r: '7' }], ['path', { d: 'm20 20-3.5-3.5' }]],
    editar: [['path', { d: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4' }]],
    borrar: [['path', { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' }]],
    usuarios: [['circle', { cx: '9', cy: '8', r: '3.5' }], ['path', { d: 'M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6' }], ['path', { d: 'M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5c1.9.8 3 2.7 3 5.5' }]],
    escudoOk: [['path', { d: 'M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
    reloj: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 7v5l3 2' }]],
    check: [['path', { d: 'M20 6 9 17l-5-5' }]],
    checkCirculo: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'm8.5 12 2.5 2.5 4.5-5' }]],
    x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
    alerta: [['path', { d: 'M12 3 2 20h20L12 3z' }], ['path', { d: 'M12 10v4M12 17h.01' }]],
    exclamacion: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 7.5v5M12 16h.01' }]],
    info: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 8h.01M11 12h1v5h1' }]],
    silbato: [['path', { d: 'M3 13a6 6 0 1 0 11.4-2.6L21 8V5h-9.5A6 6 0 0 0 3 13z' }], ['circle', { cx: '9', cy: '13', r: '1.6' }]],
    balanza: [['path', { d: 'M12 3v18M7 21h10M5 7h14M5 7l-3 6a3 3 0 0 0 6 0L5 7zM19 7l-3 6a3 3 0 0 0 6 0l-3-6z' }]],
    cancha: [['rect', { x: '2.5', y: '5', width: '19', height: '14', rx: '1.5' }], ['line', { x1: '12', y1: '5', x2: '12', y2: '19' }], ['circle', { cx: '12', cy: '12', r: '2.6' }], ['path', { d: 'M2.5 9.5h2.5v5H2.5M21.5 9.5H19v5h2.5' }]],
    bandera: [['path', { d: 'M5 21V4M5 4h11l-2 4 2 4H5' }]],
    historial: [['path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }], ['path', { d: 'M3 3v5h5M12 7v5l3 2' }]],
    flecha: [['path', { d: 'm9 6 6 6-6 6' }]],
    recibo: [['path', { d: 'M6 2.5h12v19l-3-2-3 2-3-2-3 2v-19z' }], ['path', { d: 'M9 7.5h6M9 11h6M9 14.5h4' }]],
    billete: [['rect', { x: '2.5', y: '6', width: '19', height: '12', rx: '2' }], ['circle', { cx: '12', cy: '12', r: '2.5' }], ['path', { d: 'M6 9.5v5M18 9.5v5' }]],
    cartera: [['path', { d: 'M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3' }], ['path', { d: 'M21 10h-5a2 2 0 0 0 0 4h5z' }]],
    tarjeta: [['rect', { x: '2.5', y: '5', width: '19', height: '14', rx: '2' }], ['path', { d: 'M2.5 10h19M6 15h4' }]],
    descargar: [['path', { d: 'M12 3v12M7 10l5 5 5-5M5 21h14' }]],
    subir: [['path', { d: 'M12 16V4M7 9l5-5 5 5M5 20h14' }]],
    documento: [['path', { d: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z' }], ['path', { d: 'M14 3v6h6M9 14h6M9 17h4' }]],
    hoja: [['path', { d: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z' }], ['path', { d: 'M14 3v6h6M8 13h8M8 17h8M12 13v8' }]],
    ojo: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: '12', cy: '12', r: '3' }]],
    enviar: [['path', { d: 'M22 2 11 13' }], ['path', { d: 'M22 2 15 22l-4-9-9-4 20-7z' }]],
    portapapeles: [['rect', { x: '6', y: '4', width: '12', height: '17', rx: '2' }], ['path', { d: 'M9 4V3h6v1M9 10h6M9 14h6M9 18h3' }]],
    escoba: [['path', { d: 'M19 3 11 11' }], ['path', { d: 'M8.5 9.5 4 14c-1 1-1.5 3.5-1 6.5 3 .5 5.5 0 6.5-1l4.5-4.5z' }], ['path', { d: 'm6 18 2-2M9.5 18.5l2-2' }]],
    balon: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'm12 7 4 3-1.5 4.5h-5L8 10z' }], ['path', { d: 'M12 3v4M16 10l4.5-1.5M14.5 14.5l2.5 4M9.5 14.5 7 18.5M8 10 3.5 8.5' }]],
    basura: [['path', { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' }]],
    hojaArbol: [['path', { d: 'M20 4C10 4 5 9 5 16c0 1 0 2 .5 3.5C7 13 11 10 15 9c-4 2-7.5 6-8.5 10.5C15 19 20 13 20 4z' }]],
    gradas: [['path', { d: 'M4 6v14M20 6v14M4 10h16M4 15h16' }]],
    gota: [['path', { d: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z' }]],
    herramienta: [['path', { d: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.5-.6-.6-2.5z' }]],
    puntos: [['circle', { cx: '5', cy: '12', r: '1.3' }], ['circle', { cx: '12', cy: '12', r: '1.3' }], ['circle', { cx: '19', cy: '12', r: '1.3' }]],
    puntosV: [['circle', { cx: '12', cy: '5', r: '1.3' }], ['circle', { cx: '12', cy: '12', r: '1.3' }], ['circle', { cx: '12', cy: '19', r: '1.3' }]],
    persona: [['circle', { cx: '12', cy: '8', r: '4' }], ['path', { d: 'M4 21c0-4 3.6-7 8-7s8 3 8 7' }]],
    filtro: [['path', { d: 'M3 5h18l-7 8v6l-4 2v-8z' }]],
    progreso: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 7v5l3 2' }]],
    enlace: [['path', { d: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7' }], ['path', { d: 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7' }]]
  };
  const icono = (nombre, clase) => {
    const svg = svgIcono(T[nombre] || T.info);
    if (clase) svg.setAttribute('class', clase);
    return svg;
  };

  /* ---------- Paginación: ‹ 1 2 3 … 9 › ---------- */
  function paginacion(contenedor, pagina, paginas, alCambiar) {
    const boton = (texto, destino, opciones = {}) => h('button', {
      type: 'button', disabled: opciones.deshabilitado, 'aria-current': opciones.actual ? 'page' : null,
      'aria-label': opciones.etiqueta || `Página ${destino}`, onclick: () => alCambiar(destino)
    }, texto);
    const numeros = [];
    const agregar = (n) => { if (!numeros.includes(n) && n >= 1 && n <= paginas) numeros.push(n); };
    agregar(1); for (let i = pagina - 1; i <= pagina + 1; i++) agregar(i); agregar(paginas);
    numeros.sort((a, b) => a - b);
    const partes = [boton('‹', pagina - 1, { deshabilitado: pagina <= 1, etiqueta: 'Página anterior' })];
    numeros.forEach((n, i) => {
      if (i && n - numeros[i - 1] > 1) partes.push(h('span', { class: 'puntos' }, '…'));
      partes.push(boton(String(n), n, { actual: n === pagina }));
    });
    partes.push(boton('›', pagina + 1, { deshabilitado: pagina >= paginas, etiqueta: 'Página siguiente' }));
    contenedor.replaceChildren(...partes);
  }

  /* ---------- Ventanas emergentes (menús, selectores) ---------- */
  let abierta = null;
  function cerrarEmergente() {
    if (!abierta) return;
    abierta.panel.hidden = true;
    if (abierta.boton) abierta.boton.setAttribute('aria-expanded', 'false');
    const cb = abierta.alCerrar;
    abierta = null;
    if (cb) cb();
  }
  /** Abre `panel` junto a `boton`. Con `posicion` (para menús de fila) se coloca debajo del botón. */
  function abrirEmergente(panel, boton, { posicion = false, alCerrar = null } = {}) {
    if (abierta && abierta.panel === panel) { cerrarEmergente(); return false; }
    cerrarEmergente();
    panel.hidden = false;
    if (boton) boton.setAttribute('aria-expanded', 'true');
    if (posicion && boton) {
      const r = boton.getBoundingClientRect();
      const ancho = panel.offsetWidth || 220;
      panel.style.position = 'fixed';
      panel.style.left = `${Math.max(8, Math.min(window.innerWidth - ancho - 8, r.right - ancho))}px`;
      const alto = panel.offsetHeight || 200;
      panel.style.top = `${r.bottom + alto + 8 > window.innerHeight ? Math.max(8, r.top - alto - 6) : r.bottom + 6}px`;
    }
    abierta = { panel, boton, alCerrar };
    return true;
  }
  document.addEventListener('mousedown', (e) => {
    if (!abierta) return;
    if (abierta.panel.contains(e.target) || (abierta.boton && abierta.boton.contains(e.target))) return;
    cerrarEmergente();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarEmergente(); });
  window.addEventListener('scroll', () => { if (abierta && abierta.panel.style.position === 'fixed') cerrarEmergente(); }, true);

  /* ---------- Fechas ---------- */
  const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const dos = (n) => String(n).padStart(2, '0');
  const aFecha = (iso) => { const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number); return new Date(a, m - 1, d); };
  const iso = (f) => `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`;
  const sumarDias = (valor, n) => { const f = aFecha(valor); f.setDate(f.getDate() + n); return iso(f); };
  const F = {
    iso, aFecha, sumarDias, DIAS, DIAS_CORTOS, MESES, MESES_CORTOS,
    hoy: () => iso(new Date()),
    /** Domingo 19 de mayo de 2026 */
    larga: (v) => { const f = aFecha(v); return `${DIAS[f.getDay()]} ${f.getDate()} de ${MESES[f.getMonth()]} de ${f.getFullYear()}`; },
    /** 19 de mayo de 2026 */
    media: (v) => { const f = aFecha(v); return `${f.getDate()} de ${MESES[f.getMonth()]} de ${f.getFullYear()}`; },
    /** 19 mayo, 2026 */
    chip: (v) => { const f = aFecha(v); return `${f.getDate()} ${MESES[f.getMonth()]}, ${f.getFullYear()}`; },
    /** 19 may 2026 */
    corta: (v) => { const f = aFecha(v); return `${f.getDate()} ${MESES_CORTOS[f.getMonth()]} ${f.getFullYear()}`; },
    /** Mié 19 */
    diaCorto: (v) => { const f = aFecha(v); return `${DIAS_CORTOS[f.getDay()]} ${f.getDate()}`; },
    /** dd/mm/aaaa y hh:mm de un DATETIME */
    numerica: (v) => { const f = v instanceof Date ? v : new Date(v); return `${dos(f.getDate())}/${dos(f.getMonth() + 1)}/${f.getFullYear()}`; },
    hora: (v, segundos) => { const f = v instanceof Date ? v : new Date(v); return `${dos(f.getHours())}:${dos(f.getMinutes())}${segundos ? `:${dos(f.getSeconds())}` : ''}`; }
  };

  /* ---------- Colores ---------- */
  const TONOS = ['tono-1', 'tono-2', 'tono-3', 'tono-4', 'tono-5', 'tono-6'];
  const hash = (t) => [...String(t || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const tonoDe = (texto) => TONOS[hash(texto) % TONOS.length];
  /** Color de una cancha: por su nombre (Azul, Roja, Verde…) o uno fijo según el nombre. */
  function colorCancha(nombre) {
    const n = String(nombre || '').toLowerCase();
    if (/azul/.test(n)) return 'color-azul';
    if (/roj/.test(n)) return 'color-rojo';
    if (/verde/.test(n)) return 'color-verde';
    if (/amarill|naranj/.test(n)) return 'color-ambar';
    if (/morad/.test(n)) return 'color-morado';
    return ['color-azul', 'color-rojo', 'color-verde', 'color-ambar', 'color-morado'][hash(n) % 5];
  }

  /** Llena un <select> con opciones { valor, texto, deshabilitada }. */
  function opciones(select, lista, { vacio, valor } = {}) {
    select.replaceChildren(
      ...(vacio !== undefined ? [h('option', { value: '' }, vacio)] : []),
      ...lista.map((o) => h('option', { value: o.valor, disabled: o.deshabilitada || null }, o.texto)));
    if (valor !== undefined && valor !== null) select.value = String(valor);
  }

  /** Cierra un <dialog> al dar clic afuera o en un botón [data-cerrar]. */
  function dialogos(raiz = document) {
    raiz.querySelectorAll('dialog').forEach((d) => {
      if (d.dataset.listo) return;
      d.dataset.listo = '1';
      d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-cerrar]')) d.close(); });
    });
  }

  /** Confirmación con un <dialog> propio (no depende del panel). */
  function confirmar(dlg, titulo, texto, textoBoton = 'Confirmar') {
    return new Promise((resolver) => {
      dlg.querySelector('[data-titulo]').textContent = titulo;
      dlg.querySelector('[data-texto]').textContent = texto;
      const btn = dlg.querySelector('[data-aceptar]');
      btn.textContent = textoBoton;
      const aceptar = () => dlg.close('si');
      btn.addEventListener('click', aceptar, { once: true });
      dlg.addEventListener('close', () => { btn.removeEventListener('click', aceptar); resolver(dlg.returnValue === 'si'); dlg.returnValue = ''; }, { once: true });
      dlg.showModal();
    });
  }

  /** Consulta que no cuenta como actividad del usuario (para sondeos automáticos). */
  async function sondeo(url) {
    try {
      const r = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', 'X-Sin-Renovar': '1', Accept: 'application/json' } });
      return r.ok ? r.json() : null;
    } catch { return null; }
  }

  window.UI = { icono, paginacion, abrirEmergente, cerrarEmergente, F, tonoDe, colorCancha, opciones, dialogos, confirmar, sondeo };
})();
