/* =====================================================================
   Panel de administración · Reportes y auditoría
   Gráficas en SVG propio (sin librerías externas: la CSP no permite CDN).
   ===================================================================== */
(function () {
  'use strict';
  const { api, h, aviso, dinero, numero } = window.App;
  const { icono, paginacion, abrirEmergente, cerrarEmergente, F } = window.UI;
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const s = (tipo, attrs = {}, ...hijos) => {
    const el = document.createElementNS(SVG, tipo);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
    hijos.forEach((c) => el.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return el;
  };

  // Colores de la dona: las canchas por orden de ingreso; Torneos y Otros siempre con el suyo
  const COLORES_CANCHA = ['#0b3b1e', '#15803d', '#22c55e'];
  const COLOR_TORNEOS = '#86efac';
  const COLOR_OTROS = '#94a3b8';
  const TITULOS = { dia: 'Ingresos diarios', semana: 'Ingresos semanales', mes: 'Ingresos mensuales' };
  const TEMPORADAS = [
    { nombre: 'Primavera', color: '#4ade80', ini: [2, 20], fin: [5, 20], texto: '20 mar — 20 jun' },
    { nombre: 'Verano', color: '#facc15', ini: [5, 21], fin: [8, 21], texto: '21 jun — 21 sep' },
    { nombre: 'Otoño', color: '#f97316', ini: [8, 22], fin: [11, 20], texto: '22 sep — 20 dic' },
    { nombre: 'Invierno', color: '#60a5fa', ini: [11, 21], fin: [2, 19], texto: '21 dic — 19 mar', cruzaAnio: true }
  ];

  const estado = {
    desde: null, hasta: null, metodo: null, vista: 'semanal', datos: null, movPagina: 1, bitPagina: 1,
    ciclo: { anio: new Date().getFullYear(), desde: null, hasta: null }
  };

  const consulta = (extra = {}) => {
    const p = new URLSearchParams({ desde: estado.desde, hasta: estado.hasta, ...extra });
    if (estado.metodo) p.set('metodo', estado.metodo);
    return p;
  };

  function rangoDeVista(vista) {
    const hoy = F.hoy();
    if (vista === 'mensual') return [F.sumarDias(hoy, -29), hoy];
    if (vista === 'anual') { const f = new Date(); return [F.iso(new Date(f.getFullYear(), f.getMonth() - 11, 1)), hoy]; }
    return [F.sumarDias(hoy, -6), hoy];
  }

  /* -------------------------------------------------------------- */
  /*  Carga                                                          */
  /* -------------------------------------------------------------- */
  async function cargar() {
    if (!estado.desde) [estado.desde, estado.hasta] = rangoDeVista(estado.vista);
    const r = await api('GET', `/api/admin/reportes?${consulta()}`);
    if (!r.ok) return aviso(r.datos.mensaje, 'error');
    const d = r.datos;
    estado.datos = d;
    estado.movPagina = 1;
    estado.bitPagina = 1;
    const act = new Date(d.actualizado);
    $('rpActualizado').textContent = `${act.getDate()} ${F.MESES[act.getMonth()]} ${act.getFullYear()} · ${F.hora(act)}`;
    $('rpRangoTexto').textContent = `${F.corta(d.filtros.desde)} — ${F.corta(d.filtros.hasta)}`;
    $('rpMetodoTexto').textContent = d.filtros.nombreMetodo;
    $('rpVista').value = estado.vista;
    $('rpTituloGrafica').textContent = TITULOS[d.filtros.agrupacion];
    graficaLinea(d.serie, d.filtros.agrupacion);
    pintarKpis(d.indicadores);
    dona(d.distribucion, d.totalDistribucion);
    pintarMovimientos(d.movimientos);
    pintarBitacora(d.bitacora);
    const prot = $('rpProtegido');
    prot.classList.toggle('alterado', !d.integridad.protegida);
    prot.querySelector('span').textContent = d.integridad.protegida ? 'Registro protegido' : 'Revisar integridad';
    prot.title = d.integridad.protegida
      ? `Bitácora encadenada sin alteraciones (${numero(d.integridad.firmados)} registros firmados · OWASP A09)`
      : 'La bitácora tiene alteraciones sin revisar: ve a Seguridad OWASP → A09.';
  }

  /* -------------------------------------------------------------- */
  /*  Gráfica de línea (curva monótona, halo, puntos y tooltip)      */
  /* -------------------------------------------------------------- */
  function pasoBonito(max) {
    if (max <= 0) return 1000;
    const crudo = max / 5;
    const mag = 10 ** Math.floor(Math.log10(crudo));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= crudo);
  }

  function rutaMonotona(p) {
    if (p.length === 1) return `M${p[0].x},${p[0].y}`;
    const n = p.length;
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push((p[i + 1].y - p[i].y) / (p[i + 1].x - p[i].x || 1));
    const m = new Array(n).fill(0);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] > 0 ? (d[i - 1] + d[i]) / 2 : 0;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], t = a * a + b * b;
      if (t > 9) { const k = 3 / Math.sqrt(t); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
    }
    let ruta = `M${p[0].x},${p[0].y}`;
    for (let i = 0; i < n - 1; i++) {
      const hx = (p[i + 1].x - p[i].x) / 3;
      ruta += ` C${p[i].x + hx},${p[i].y + m[i] * hx} ${p[i + 1].x - hx},${p[i + 1].y - m[i + 1] * hx} ${p[i + 1].x},${p[i + 1].y}`;
    }
    return ruta;
  }

  function graficaLinea(serie, agrupacion) {
    const caja = $('rpGrafica');
    // Se dibuja al tamaño real del contenedor: los textos del eje no se encogen y la gráfica
    // ocupa todo el alto de la tarjeta (sin hueco entre la gráfica y los indicadores)
    caja.replaceChildren();
    const estilo = getComputedStyle(caja);
    const disponible = caja.clientWidth - parseFloat(estilo.paddingLeft) - parseFloat(estilo.paddingRight);
    const altoLibre = caja.clientHeight - parseFloat(estilo.paddingTop) - parseFloat(estilo.paddingBottom);
    const W = Math.max(320, Math.round(disponible) || 820);
    const H = Math.round(Math.min(420, Math.max(280, altoLibre || 300)));
    const M = { izq: 66, der: 24, arr: 22, abj: 40 };
    const ancho = W - M.izq - M.der, alto = H - M.arr - M.abj;
    const max = Math.max(0, ...serie.map((x) => x.total));
    const paso = pasoBonito(max);
    const tope = paso * 5;
    const n = serie.length;
    const xDe = (i) => M.izq + (n === 1 ? ancho / 2 : (ancho * i) / (n - 1));
    const yDe = (v) => M.arr + alto - (alto * v) / tope;
    const puntos = serie.map((x, i) => ({ x: Math.round(xDe(i) * 10) / 10, y: Math.round(yDe(x.total) * 10) / 10 }));

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: '0', 'aria-label': `${TITULOS[agrupacion]}: ${serie.map((x) => `${x.detalle} ${dinero(x.total)}`).join(', ')}` });
    for (let i = 0; i <= 5; i++) {
      const y = yDe(paso * i);
      svg.append(s('line', { class: 'rejilla', x1: M.izq, x2: W - M.der, y1: y, y2: y }),
        s('text', { class: 'eje', x: M.izq - 14, y: y + 4, 'text-anchor': 'end' }, `$${numero(paso * i)}`));
    }
    const cada = Math.max(1, Math.ceil(n / 12));
    serie.forEach((x, i) => {
      // Se rotula cada "cada" puntos y siempre el último, sin encimar el penúltimo rótulo
      if ((i % cada === 0 && (i === n - 1 || n - 1 - i >= cada)) || i === n - 1) svg.append(s('text', { class: 'eje', x: puntos[i].x, y: H - 12, 'text-anchor': 'middle' }, x.etiqueta));
    });
    const d = rutaMonotona(puntos);
    const guia = s('line', { class: 'guia', y1: M.arr, y2: M.arr + alto, x1: -10, x2: -10 });
    svg.append(guia, s('path', { class: 'halo', d }), s('path', { class: 'linea', d }));
    const circulos = puntos.map((p) => s('circle', { class: 'punto', cx: p.x, cy: p.y, r: n > 40 ? 0 : 6 }));
    circulos.forEach((c) => svg.append(c));
    const area = s('rect', { x: M.izq - 10, y: M.arr, width: ancho + 20, height: alto + 10, fill: 'transparent' });
    svg.append(area);

    const tooltip = h('div', { class: 'grafica-tooltip', hidden: true, 'aria-hidden': 'true' }, h('small'), h('strong'));
    const tabla = h('table', { class: 'solo-lector' }, h('caption', null, TITULOS[agrupacion]),
      h('tbody', null, ...serie.map((x) => h('tr', null, h('th', null, x.detalle), h('td', null, dinero(x.total))))));
    caja.replaceChildren(svg, tooltip, tabla);

    let activo = null;
    function mostrar(i) {
      if (i === null || i === undefined || !serie[i]) return;
      if (activo !== null && circulos[activo]) { circulos[activo].classList.remove('activo'); circulos[activo].setAttribute('r', n > 40 ? 0 : 6); }
      activo = i;
      circulos[i].classList.add('activo');
      circulos[i].setAttribute('r', 8);
      guia.setAttribute('x1', puntos[i].x); guia.setAttribute('x2', puntos[i].x);
      const escala = svg.getBoundingClientRect().width / W || 1;
      tooltip.hidden = false;
      tooltip.querySelector('small').textContent = serie[i].detalle;
      tooltip.querySelector('strong').textContent = dinero(serie[i].total);
      const rs = svg.getBoundingClientRect(), rc = caja.getBoundingClientRect();
      const x = puntos[i].x * escala + rs.left - rc.left, y = puntos[i].y * escala + rs.top - rc.top;
      // Si el punto está muy arriba, el globo va debajo; si está en una orilla, se recorre sin tapar la flecha
      tooltip.classList.toggle('grafica-tooltip--abajo', y < tooltip.offsetHeight + 24);
      const mitad = tooltip.offsetWidth / 2;
      const izquierda = Math.min(Math.max(x, mitad + 4), rc.width - mitad - 4);
      tooltip.style.left = `${izquierda}px`;
      tooltip.style.top = `${y}px`;
      tooltip.style.setProperty('--flecha', `${x - izquierda}px`);
    }
    area.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      let mejor = 0;
      puntos.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(puntos[mejor].x - x)) mejor = i; });
      mostrar(mejor);
    });
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); mostrar(Math.min(n - 1, (activo ?? -1) + 1)); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); mostrar(Math.max(0, (activo ?? n) - 1)); }
    });
    // Al inicio se señala el punto más alto (como en el diseño)
    requestAnimationFrame(() => {
      const iMax = serie.reduce((m, x, i) => (x.total > serie[m].total ? i : m), 0);
      if (max > 0) mostrar(iMax);
    });
  }
  window.addEventListener('resize', () => { if (estado.datos && !$('seccion-reportes').hidden) graficaLinea(estado.datos.serie, estado.datos.filtros.agrupacion); });

  function pintarKpis(k) {
    const celda = (titulo, valor, vari) => h('div', null, h('span', null, titulo), h('strong', null, valor),
      vari === null ? h('small', null, `Sin datos ${k.comparacion}`)
        : h('small', null, h('b', { class: vari < 0 ? 'baja' : null }, `${vari >= 0 ? '↑' : '↓'} ${Math.abs(vari)}%`), ` ${k.comparacion}`));
    $('rpKpis').replaceChildren(
      celda('Total ingresos', dinero(k.ingresos), k.ingresosVariacion),
      celda('Pago promedio por reserva', dinero(k.promedio), k.promedioVariacion),
      celda('Número de reservas', numero(k.reservas), k.reservasVariacion));
  }

  /* -------------------------------------------------------------- */
  /*  Dona                                                           */
  /* -------------------------------------------------------------- */
  function colorDe(item, i) {
    if (item.tipo === 'torneos') return COLOR_TORNEOS;
    if (item.tipo === 'otros') return COLOR_OTROS;
    return COLORES_CANCHA[i] || COLOR_OTROS;
  }

  function dona(lista, total) {
    const R = 92, G = 36, C = 2 * Math.PI * R, ESPACIO = 2.5;
    const svg = s('svg', { viewBox: '0 0 240 240', role: 'img', 'aria-label': `Ingresos por cancha, total ${dinero(total)}` });
    const grupo = s('g', { transform: 'rotate(-90 120 120)' });
    svg.append(grupo);
    const centro = h('div', { class: 'dona__centro' }, h('strong', null, dinero(total).replace(/\.00$/, '')), h('small', null, 'Total'));
    const restaurar = () => { centro.firstChild.textContent = dinero(total).replace(/\.00$/, ''); centro.lastChild.textContent = 'Total'; grupo.querySelectorAll('circle').forEach((c) => c.classList.remove('atenuado')); };
    if (total <= 0) {
      grupo.append(s('circle', { cx: 120, cy: 120, r: R, fill: 'none', stroke: '#e8ece9', 'stroke-width': G }));
    } else {
      let acumulado = 0;
      const conValor = lista.map((x, i) => ({ ...x, color: colorDe(x, i) })).filter((x) => x.total > 0);
      conValor.forEach((x) => {
        const largo = (x.total / total) * C;
        const visible = conValor.length > 1 ? Math.max(0.5, largo - ESPACIO) : largo;
        const c = s('circle', {
          cx: 120, cy: 120, r: R, fill: 'none', stroke: x.color, 'stroke-width': G,
          'stroke-dasharray': `${visible} ${C - visible}`, 'stroke-dashoffset': -acumulado, tabindex: '0'
        }, s('title', {}, `${x.nombre}: ${dinero(x.total)} (${x.pct}%)`));
        const resaltar = () => {
          grupo.querySelectorAll('circle').forEach((o) => o.classList.toggle('atenuado', o !== c));
          centro.firstChild.textContent = dinero(x.total).replace(/\.00$/, '');
          centro.lastChild.textContent = `${x.nombre} · ${x.pct}%`;
        };
        c.addEventListener('mouseenter', resaltar); c.addEventListener('focus', resaltar);
        c.addEventListener('mouseleave', restaurar); c.addEventListener('blur', restaurar);
        grupo.append(c);
        acumulado += largo;
      });
    }
    $('rpDona').replaceChildren(svg, centro);
    $('rpDonaTabla').replaceChildren(...lista.map((x, i) => h('tr', null,
      h('td', null, h('span', { class: 'cuadrito', 'data-color': colorDe(x, i) }), x.nombre),
      h('td', null, dinero(x.total)), h('td', { class: 'texto-tenue' }, `${x.pct}%`))));
    $('rpDonaTabla').querySelectorAll('.cuadrito').forEach((el) => { el.style.background = el.dataset.color; });
    $('rpDonaTotal').replaceChildren(h('tr', null, h('td', null, 'Total'), h('td', null, dinero(total)), h('td', null, total ? '100%' : '0%')));
  }

  /* -------------------------------------------------------------- */
  /*  Movimientos y bitácora                                         */
  /* -------------------------------------------------------------- */
  const ESTADO_MOV = {
    Pagado: ['Pagado', 'pago--pagado'], Validado: ['Pagado', 'pago--pagado'],
    Pendiente: ['Pendiente', 'pago--pendiente'], 'Con discrepancia': ['Con discrepancia', 'pago--discrepancia']
  };
  function pintarMovimientos(m) {
    $('rpMovimientos').replaceChildren(...(m.registros.length ? m.registros.map((x) => {
      const [t, c] = ESTADO_MOV[x.estadoPago] || [x.estadoPago, ''];
      return h('tr', null,
        h('td', { class: 'sin-salto' }, F.numerica(x.fechaPago)),
        h('td', null, h('strong', null, x.cliente)),
        h('td', null, h('span', { class: 'sin-salto' }, x.cancha || x.concepto),
          h('small', { class: 'solo-compacto' }, x.inicio ? `${x.inicio} - ${x.fin}` : '')),
        h('td', { class: 'sin-salto col-horario' }, x.inicio ? `${x.inicio} - ${x.fin}` : '—'),
        h('td', null, x.metodo),
        h('td', null, h('strong', { class: 'monto' }, dinero(x.monto))),
        h('td', null, h('span', { class: `estado-mov ${c}` }, t)));
    }) : [h('tr', null, h('td', { colspan: 7, class: 'vacio' }, 'No hay movimientos en este periodo.'))]));
    const desde = m.total ? (m.pagina - 1) * 5 + 1 : 0;
    $('rpMovInfo').textContent = `Mostrando ${desde} a ${desde ? desde + m.registros.length - 1 : 0} de ${numero(m.total)} movimientos`;
    paginacion($('rpMovPaginas'), m.pagina, m.paginas, async (n) => {
      const r = await api('GET', `/api/admin/reportes/movimientos?${consulta({ pagina: n })}`);
      if (r.ok) pintarMovimientos(r.datos);
    });
  }

  function pintarBitacora(b) {
    $('rpBitacora').replaceChildren(...(b.registros.length ? b.registros.map((x) => {
      // Acción con su nombre corto (como en la Bitácora); la descripción completa aparece al pasar el mouse
      const [accion] = window.Panel && window.Panel.nombreAccion ? window.Panel.nombreAccion(x.Accion) : [x.Accion];
      const tr = h('tr', { class: 'fila-clic', tabIndex: 0, title: `${x.Descripcion}\n(Clic para ver el detalle)` },
        h('td', null, h('div', { class: 'usuario-icono' }, h('span', null, icono('persona')), x.usuario)),
        h('td', { class: 'sin-salto' }, F.numerica(x.Fecha), h('small', { class: 'solo-compacto' }, F.hora(x.Fecha, true))),
        h('td', { class: 'sin-salto col-hora' }, F.hora(x.Fecha, true)),
        h('td', null, h('span', { class: 'accion-corta' }, accion),
          h('span', { class: 'etiqueta-modulo solo-compacto' }, x.Modulo)),
        h('td', { class: 'col-modulo' }, h('span', { class: 'etiqueta-modulo' }, x.Modulo)));
      tr.addEventListener('click', () => window.Panel.verDetalleBitacora(x.idBitacora));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.Panel.verDetalleBitacora(x.idBitacora); });
      return tr;
    }) : [h('tr', null, h('td', { colspan: 5, class: 'vacio' }, 'Sin registros en la bitácora en este periodo.'))]));
    const desde = b.total ? (b.pagina - 1) * 5 + 1 : 0;
    $('rpBitInfo').textContent = `Mostrando ${desde} a ${desde ? desde + b.registros.length - 1 : 0} de ${numero(b.total)} registros`;
    paginacion($('rpBitPaginas'), b.pagina, b.paginas, async (n) => {
      const r = await api('GET', `/api/admin/reportes/bitacora?${consulta({ pagina: n })}`);
      if (r.ok) pintarBitacora(r.datos);
    });
  }

  /* -------------------------------------------------------------- */
  /*  Filtros: rango, ciclo, método y vista                          */
  /* -------------------------------------------------------------- */
  function aplicarRango(desde, hasta, vista = 'personalizada', textoCiclo = null) {
    estado.desde = desde;
    estado.hasta = hasta;
    estado.vista = vista;
    $('rpCicloTexto').textContent = textoCiclo || 'Elegir ciclo';
    cerrarEmergente();
    cargar();
  }

  $('rpRangoBoton').addEventListener('click', () => {
    $('rpDesde').value = estado.desde;
    $('rpHasta').value = estado.hasta;
    $('rpRangoError').textContent = '';
    abrirEmergente($('rpRango'), $('rpRangoBoton'));
  });
  $('rpAplicarRango').addEventListener('click', () => {
    const desde = $('rpDesde').value, hasta = $('rpHasta').value;
    const error = !desde || !hasta ? 'Elige las dos fechas.' : desde > hasta ? 'La fecha "desde" debe ser anterior a "hasta".'
      : (F.aFecha(hasta) - F.aFecha(desde)) / 86400000 > 731 ? 'El rango no puede ser mayor a 2 años.' : '';
    $('rpRangoError').textContent = error;
    if (!error) aplicarRango(desde, hasta);
  });

  $('rpVista').addEventListener('change', () => {
    const [desde, hasta] = rangoDeVista($('rpVista').value);
    aplicarRango(desde, hasta, $('rpVista').value);
  });

  $('rpMetodoBoton').addEventListener('click', () => {
    const metodos = estado.datos ? estado.datos.metodos : [];
    const opcion = (id, nombre) => h('button', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(String(estado.metodo || '') === String(id || '')),
      onclick: () => { estado.metodo = id; cerrarEmergente(); cargar(); }
    }, nombre);
    $('rpMetodos').replaceChildren(opcion(null, 'Todos los métodos'), ...metodos.map((m) => opcion(m.id, m.nombre)));
    abrirEmergente($('rpMetodos'), $('rpMetodoBoton'));
  });

  /* ---------- Ciclo: calendario anual ---------- */
  function pintarCiclo() {
    const c = estado.ciclo;
    const anio = c.anio;
    const hoy = F.hoy();
    const enRango = (iso) => c.desde && c.hasta && iso > c.desde && iso < c.hasta;
    const meses = [];
    for (let m = 0; m < 12; m++) {
      const primero = new Date(anio, m, 1);
      const vacios = (primero.getDay() + 6) % 7;
      const dias = new Date(anio, m + 1, 0).getDate();
      const celdas = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => h('span', null, d));
      for (let i = 0; i < vacios; i++) celdas.push(h('i'));
      for (let d = 1; d <= dias; d++) {
        const iso = F.iso(new Date(anio, m, d));
        const clases = [enRango(iso) && 'en-rango', (iso === c.desde || iso === c.hasta) && 'extremo', iso === hoy && 'hoy'].filter(Boolean).join(' ');
        celdas.push(h('button', { type: 'button', class: clases || null, 'aria-label': F.media(iso), 'aria-pressed': String(iso === c.desde || iso === c.hasta),
          onclick: () => elegirDia(iso) }, String(d)));
      }
      meses.push(h('div', { class: 'mes' }, h('h4', null, F.MESES[m].toUpperCase()), h('div', { class: 'mes__dias' }, ...celdas)));
    }
    const listo = Boolean(c.desde && c.hasta);
    const dias = listo ? Math.round((F.aFecha(c.hasta) - F.aFecha(c.desde)) / 86400000) + 1 : 0;
    $('rpCiclo').replaceChildren(
      h('div', { class: 'ciclo__cabeza' },
        h('div', null, h('small', null, 'CICLO DE REPORTES'),
          h('h3', null, h('button', { type: 'button', 'aria-label': 'Año anterior', onclick: () => { c.anio -= 1; pintarCiclo(); } }, '‹'),
            `Calendario anual ${anio}`,
            h('button', { type: 'button', 'aria-label': 'Año siguiente', onclick: () => { c.anio += 1; pintarCiclo(); } }, '›'))),
        h('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', onclick: cerrarEmergente }, '×')),
      h('div', { class: 'temporadas' }, ...TEMPORADAS.map((t) => {
        const b = h('button', { type: 'button', title: `Usar ${t.nombre} ${anio}${t.cruzaAnio ? `-${anio + 1}` : ''} como ciclo`, onclick: () => elegirTemporada(t) },
          h('i'), h('div', null, h('b', null, t.nombre), h('span', null, t.texto)));
        b.querySelector('i').style.background = t.color;
        return b;
      })),
      h('div', { class: 'ciclo__seleccion' },
        h('div', null, h('small', null, 'DESDE'), h('strong', null, c.desde ? F.media(c.desde) : 'Seleccionar fecha')),
        h('span', { class: 'flecha' }, '→'),
        h('div', null, h('small', null, 'HASTA'), h('strong', null, c.hasta ? F.media(c.hasta) : 'Seleccionar fecha')),
        h('span', { class: 'ciclo__estado' }, listo ? `${dias} día${dias === 1 ? '' : 's'}` : c.desde ? 'Selecciona el último día' : 'Selecciona un día')),
      h('div', { class: 'ciclo__meses' }, ...meses),
      h('div', { class: 'ciclo__pie' }, h('span', null, 'Selecciona el primer y último día del ciclo.'),
        h('button', { class: 'boton boton--primario', type: 'button', disabled: !listo || dias > 732, onclick: aplicarCiclo }, 'Aplicar ciclo')));
  }

  function elegirDia(iso) {
    const c = estado.ciclo;
    if (!c.desde || c.hasta) { c.desde = iso; c.hasta = null; }
    else if (iso < c.desde) { c.hasta = c.desde; c.desde = iso; }
    else c.hasta = iso;
    c.nombre = null;
    pintarCiclo();
  }
  function elegirTemporada(t) {
    const c = estado.ciclo;
    c.desde = F.iso(new Date(c.anio, t.ini[0], t.ini[1]));
    c.hasta = F.iso(new Date(t.cruzaAnio ? c.anio + 1 : c.anio, t.fin[0], t.fin[1]));
    c.nombre = `${t.nombre} ${c.anio}${t.cruzaAnio ? `-${String(c.anio + 1).slice(2)}` : ''}`;
    pintarCiclo();
  }
  function aplicarCiclo() {
    const c = estado.ciclo;
    aplicarRango(c.desde, c.hasta, 'personalizada', c.nombre || `${F.corta(c.desde)} – ${F.corta(c.hasta)}`);
  }
  $('rpCicloBoton').addEventListener('click', () => {
    if (!estado.ciclo.desde) estado.ciclo.anio = F.aFecha(estado.hasta || F.hoy()).getFullYear();
    pintarCiclo();
    abrirEmergente($('rpCiclo'), $('rpCicloBoton'));
  });

  /* -------------------------------------------------------------- */
  /*  Exportar y accesos                                             */
  /* -------------------------------------------------------------- */
  const exportar = (formato) => {
    window.location.href = `/api/admin/reportes/exportar?${consulta({ formato })}`;
    aviso(`Generando el ${formato === 'pdf' ? 'PDF' : 'Excel'}… La descarga queda registrada en la bitácora.`);
    setTimeout(async () => {
      const r = await api('GET', `/api/admin/reportes/bitacora?${consulta({ pagina: 1 })}`);
      if (r.ok) pintarBitacora(r.datos);
    }, 2500);
  };
  $('rpPdf').addEventListener('click', () => exportar('pdf'));
  $('rpExcel').addEventListener('click', () => exportar('xlsx'));
  $('rpVerTodos').addEventListener('click', () => { if (window.Pagos) window.Pagos.verTodos(); });
  $('rpDonaMenuBoton').addEventListener('click', () => {
    $('rpDonaMenu').replaceChildren(
      h('button', { type: 'button', role: 'menuitem', onclick: () => { cerrarEmergente(); exportar('pdf'); } }, icono('documento'), 'Exportar PDF'),
      h('button', { type: 'button', role: 'menuitem', onclick: () => { cerrarEmergente(); exportar('xlsx'); } }, icono('hoja'), 'Exportar Excel'),
      h('button', { type: 'button', role: 'menuitem', onclick: () => { cerrarEmergente(); if (window.Pagos) window.Pagos.verTodos(); location.hash = '#pagos'; } }, icono('cartera'), 'Ver los pagos'));
    abrirEmergente($('rpDonaMenu'), $('rpDonaMenuBoton'));
  });

  window.Panel.registrar('reportes', 'Reportes', cargar);
})();
