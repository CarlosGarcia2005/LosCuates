// =====================================================================
//  Generador de PDF mínimo (sin librerías externas)
//  Páginas tamaño carta, fuentes Helvetica / Helvetica-Bold (WinAnsi, con
//  acentos y ñ), rectángulos, líneas, curvas y texto alineado.
//  Coordenadas en puntos, con el origen ARRIBA a la izquierda (y crece hacia abajo).
// =====================================================================

const ANCHO = 612;
const ALTO = 792;

// Anchos de Helvetica y Helvetica-Bold (1/1000 em) para los caracteres 32..126
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778,
  722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778,
  722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Caracteres fuera de ASCII → código WinAnsi
const WIN = { '–': 0x96, '—': 0x97, '•': 0x95, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '…': 0x85, '€': 0x80 };
// Letra base para medir caracteres acentuados
const BASE = { 'á': 'a', 'é': 'e', 'ó': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n', 'Á': 'A', 'É': 'E', 'Ó': 'O', 'Ú': 'U', 'Ü': 'U', 'Ñ': 'N', 'à': 'a', 'è': 'e', 'ò': 'o' };
const EXTRA = { 'í': 278, 'Í': 278, '¿': 611, '¡': 333, '·': 278, '–': 556, '—': 1000, '•': 350, '°': 400, '×': 584, '…': 1000 };

function codigo(ch) {
  if (WIN[ch]) return WIN[ch];
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  return 63; // ?
}

/** Ancho del texto en puntos. */
function medir(texto, tam, negrita) {
  const tabla = negrita ? HELV_B : HELV;
  let total = 0;
  for (const ch of adaptar(texto)) {
    const c = ch.codePointAt(0);
    let w;
    if (c >= 32 && c <= 126) w = tabla[c - 32];
    else if (EXTRA[ch]) w = EXTRA[ch];
    else if (BASE[ch]) w = tabla[BASE[ch].charCodeAt(0) - 32];
    else w = 556;
    total += w;
  }
  return (total * tam) / 1000;
}

/** Texto como cadena literal de PDF (bytes WinAnsi, con ( ) \ escapados). */
const SUSTITUTOS = { '→': '->', '←': '<-', '≠': '!=', '≤': '<=', '≥': '>=', '✓': 'v', '✔': 'v', '✘': 'x' };
const adaptar = (t) => String(t ?? '').replace(/[→←≠≤≥✓✔✘]/g, (c) => SUSTITUTOS[c]).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '');

function literal(texto) {
  let s = '';
  for (const ch of adaptar(texto)) {
    const c = codigo(ch);
    const car = String.fromCharCode(c);
    s += car === '(' || car === ')' || car === '\\' ? `\\${car}` : car;
  }
  return `(${s})`;
}

/** Pendientes de Fritsch-Carlson: la curva no se pasa de los puntos (no hay "valles" falsos). */
function tangentesMonotonas(p) {
  const n = p.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1].y - p[i].y) / ((p[i + 1].x - p[i].x) || 1));
  const m = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] > 0 ? (d[i - 1] + d[i]) / 2 : 0;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return m;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
function rgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [0, 2, 4].map((i) => num(parseInt(v.slice(i, i + 2), 16) / 255)).join(' ');
}

class Pdf {
  constructor({ titulo = 'Reporte' } = {}) {
    this.titulo = titulo;
    this.paginas = [];
    this.nuevaPagina();
  }

  nuevaPagina() {
    this.ops = [];
    this.paginas.push(this.ops);
    return this;
  }

  get numeroPaginas() { return this.paginas.length; }

  /** Ir a una página ya creada (para escribir pies de página al final). */
  irA(indice) { this.ops = this.paginas[indice]; return this; }

  rect(x, y, w, h, { relleno = null, borde = null, ancho = 1, radio = 0 } = {}) {
    const op = [];
    op.push('q');
    if (relleno) op.push(`${rgb(relleno)} rg`);
    if (borde) op.push(`${rgb(borde)} RG ${num(ancho)} w`);
    if (radio > 0) {
      op.push(this.#rutaRedondeada(x, ALTO - y - h, w, h, Math.min(radio, w / 2, h / 2)));
    } else {
      op.push(`${num(x)} ${num(ALTO - y - h)} ${num(w)} ${num(h)} re`);
    }
    op.push(relleno && borde ? 'B' : relleno ? 'f' : 'S');
    op.push('Q');
    this.ops.push(op.join(' '));
    return this;
  }

  #rutaRedondeada(x, y, w, h, r) {
    const k = 0.5523 * r;
    return [
      `${num(x + r)} ${num(y)} m`, `${num(x + w - r)} ${num(y)} l`,
      `${num(x + w - r + k)} ${num(y)} ${num(x + w)} ${num(y + r - k)} ${num(x + w)} ${num(y + r)} c`,
      `${num(x + w)} ${num(y + h - r)} l`,
      `${num(x + w)} ${num(y + h - r + k)} ${num(x + w - r + k)} ${num(y + h)} ${num(x + w - r)} ${num(y + h)} c`,
      `${num(x + r)} ${num(y + h)} l`,
      `${num(x + r - k)} ${num(y + h)} ${num(x)} ${num(y + h - r + k)} ${num(x)} ${num(y + h - r)} c`,
      `${num(x)} ${num(y + r)} l`,
      `${num(x)} ${num(y + r - k)} ${num(x + r - k)} ${num(y)} ${num(x + r)} ${num(y)} c`, 'h'
    ].join(' ');
  }

  linea(x1, y1, x2, y2, { color = '#cdd6d0', ancho = 1, guiones = null } = {}) {
    this.ops.push(`q ${rgb(color)} RG ${num(ancho)} w ${guiones ? `[${guiones.join(' ')}] 0 d ` : ''}` +
      `${num(x1)} ${num(ALTO - y1)} m ${num(x2)} ${num(ALTO - y2)} l S Q`);
    return this;
  }

  /** Curva suave y monótona que pasa por los puntos [{x, y}] (nunca baja de $0 ni sube de más). */
  curva(puntos, { color = '#15803d', ancho = 2 } = {}) {
    if (puntos.length < 2) return this;
    const p = puntos.map((q) => ({ x: q.x, y: ALTO - q.y }));
    const m = tangentesMonotonas(p);
    const partes = [`${num(p[0].x)} ${num(p[0].y)} m`];
    for (let i = 0; i < p.length - 1; i++) {
      const h = (p[i + 1].x - p[i].x) / 3;
      partes.push(`${num(p[i].x + h)} ${num(p[i].y + m[i] * h)} ${num(p[i + 1].x - h)} ${num(p[i + 1].y - m[i + 1] * h)} ` +
        `${num(p[i + 1].x)} ${num(p[i + 1].y)} c`);
    }
    this.ops.push(`q ${rgb(color)} RG ${num(ancho)} w 1 J 1 j ${partes.join(' ')} S Q`);
    return this;
  }

  circulo(cx, cy, r, { relleno = null, borde = null, ancho = 1 } = {}) {
    const k = 0.5523 * r;
    const y = ALTO - cy;
    const ruta = [`${num(cx + r)} ${num(y)} m`,
      `${num(cx + r)} ${num(y + k)} ${num(cx + k)} ${num(y + r)} ${num(cx)} ${num(y + r)} c`,
      `${num(cx - k)} ${num(y + r)} ${num(cx - r)} ${num(y + k)} ${num(cx - r)} ${num(y)} c`,
      `${num(cx - r)} ${num(y - k)} ${num(cx - k)} ${num(y - r)} ${num(cx)} ${num(y - r)} c`,
      `${num(cx + k)} ${num(y - r)} ${num(cx + r)} ${num(y - k)} ${num(cx + r)} ${num(y)} c`, 'h'].join(' ');
    this.ops.push(`q ${relleno ? `${rgb(relleno)} rg ` : ''}${borde ? `${rgb(borde)} RG ${num(ancho)} w ` : ''}${ruta} ${relleno && borde ? 'B' : relleno ? 'f' : 'S'} Q`);
    return this;
  }

  /** Segmento de dona: de la fracción f0 a f1 (0 = arriba, sentido horario). */
  arcoDona(cx, cy, radio, grosor, f0, f1, color) {
    if (f1 - f0 <= 0) return this;
    const y0 = ALTO - cy;
    const angulo = (f) => Math.PI / 2 - f * 2 * Math.PI;   // en radianes, matemático
    const piezas = Math.max(1, Math.ceil((f1 - f0) / 0.25));
    const partes = [];
    for (let i = 0; i < piezas; i++) {
      const a1 = angulo(f0 + ((f1 - f0) * i) / piezas);
      const a2 = angulo(f0 + ((f1 - f0) * (i + 1)) / piezas);
      const k = (4 / 3) * Math.tan((a2 - a1) / 4);
      const P0 = [cx + radio * Math.cos(a1), y0 + radio * Math.sin(a1)];
      const P3 = [cx + radio * Math.cos(a2), y0 + radio * Math.sin(a2)];
      const P1 = [P0[0] - k * radio * Math.sin(a1), P0[1] + k * radio * Math.cos(a1)];
      const P2 = [P3[0] + k * radio * Math.sin(a2), P3[1] - k * radio * Math.cos(a2)];
      if (i === 0) partes.push(`${num(P0[0])} ${num(P0[1])} m`);
      partes.push(`${num(P1[0])} ${num(P1[1])} ${num(P2[0])} ${num(P2[1])} ${num(P3[0])} ${num(P3[1])} c`);
    }
    this.ops.push(`q ${rgb(color)} RG ${num(grosor)} w 0 J ${partes.join(' ')} S Q`);
    return this;
  }

  /** Texto. alinear: 'izq' | 'der' | 'centro'. maxAncho recorta con "…". */
  texto(x, y, valor, { tam = 10, negrita = false, color = '#111827', alinear = 'izq', maxAncho = null } = {}) {
    let t = String(valor ?? '');
    if (maxAncho && medir(t, tam, negrita) > maxAncho) {
      while (t.length > 1 && medir(`${t}…`, tam, negrita) > maxAncho) t = t.slice(0, -1);
      t = `${t.trimEnd()}…`;
    }
    const w = medir(t, tam, negrita);
    const xx = alinear === 'der' ? x - w : alinear === 'centro' ? x - w / 2 : x;
    this.ops.push(`BT /${negrita ? 'F2' : 'F1'} ${num(tam)} Tf ${rgb(color)} rg ${num(xx)} ${num(ALTO - y)} Td ${literal(t)} Tj ET`);
    return this;
  }

  medir(t, tam = 10, negrita = false) { return medir(t, tam, negrita); }

  /** Arma el archivo PDF completo. */
  generar() {
    const objetos = [];
    const agregar = (contenido) => { objetos.push(contenido); return objetos.length; };
    const catalogo = agregar(null);
    const paginasObj = agregar(null);
    const f1 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const hijos = [];
    for (const ops of this.paginas) {
      const flujo = Buffer.from(ops.join('\n'), 'latin1');
      const contenido = agregar({ flujo });
      const pagina = agregar(`<< /Type /Page /Parent ${paginasObj} 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contenido} 0 R >>`);
      hijos.push(pagina);
    }
    objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${paginasObj} 0 R >>`;
    objetos[paginasObj - 1] = `<< /Type /Pages /Kids [${hijos.map((h) => `${h} 0 R`).join(' ')}] /Count ${hijos.length} >>`;
    const info = agregar(`<< /Title ${literal(this.titulo)} /Producer (Gestor Deportivo Rancho Seco) >>`);

    const partes = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let posicion = partes[0].length;
    const offsets = [];
    objetos.forEach((o, i) => {
      offsets.push(posicion);
      let buf;
      if (o && typeof o === 'object' && o.flujo) {
        buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${o.flujo.length} >>\nstream\n`, 'latin1'), o.flujo,
          Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      } else {
        buf = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
      }
      partes.push(buf);
      posicion += buf.length;
    });
    const xref = [`xref\n0 ${objetos.length + 1}\n`, '0000000000 65535 f \n',
      ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    partes.push(Buffer.from(`${xref}trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R /Info ${info} 0 R >>\nstartxref\n${posicion}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(partes);
  }
}

module.exports = { Pdf, ANCHO, ALTO, medir };
