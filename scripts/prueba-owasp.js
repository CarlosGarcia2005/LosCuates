#!/usr/bin/env node
// =====================================================================
//  Pruebas de seguridad OWASP contra TU servidor (que debe estar prendido)
//
//    npm run prueba-owasp
//    npm run prueba-owasp -- --url http://localhost:3000 --correo admin@ranchoseco.com
//
//  Hace ataques reales (inyección SQL/XSS, tokens falsos, JSON alterado,
//  CSRF, métodos HTTP raros, peticiones gigantes...) y revisa que el
//  servidor los rechace. También revisa las versiones de Node.js y de los
//  paquetes (npm audit). Cada ataque queda en la Bitácora y en la sección
//  Seguridad del panel.  Cubre OWASP A01 a A10.
// =====================================================================
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const readline = require('readline');
const componentes = require('../src/seguridad/componentes');
const integridad = require('../src/seguridad/integridad-codigo');
const archivoRegistro = require('../src/seguridad/archivo-registro');

const args = process.argv.slice(2);
const opcion = (nombre, porDefecto) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};
const BASE = opcion('url', 'http://localhost:3000').replace(/\/$/, '');
const CORREO_REAL = opcion('correo', 'admin@ranchoseco.com');

const color = (c, t) => (process.stdout.isTTY ? `\x1b[${c}m${t}\x1b[0m` : t);
const resultados = [];

function avisar(id, nombre, detalle) {
  console.log(`${color(33, '• AVISO')} [${id}] ${nombre}`);
  if (detalle) console.log(`         ${color(90, detalle)}`);
}

/** Petición con cualquier método (fetch no deja mandar TRACE). */
function metodoCrudo(metodo, ruta) {
  return new Promise((resolver) => {
    const url = new URL(BASE + ruta);
    const cliente = url.protocol === 'https:' ? https : http;
    const req = cliente.request({ method: metodo, hostname: url.hostname, port: url.port, path: url.pathname }, (resp) => {
      let texto = '';
      resp.on('data', (d) => { texto += d; });
      resp.on('end', () => resolver({ estado: resp.statusCode, texto }));
    });
    req.on('error', (e) => resolver({ estado: 0, texto: e.message }));
    req.end();
  });
}

const FUGA_TECNICA = /SyntaxError|at [\w.<>]+ \(|node_modules|[A-Z]:\\|\/home\/|ER_[A-Z_]+|stack/;

function registrar(id, nombre, paso, detalle) {
  resultados.push({ id, nombre, paso });
  console.log(`${paso ? color(32, '✔ PASA ') : color(31, '✘ FALLA')} [${id}] ${nombre}`);
  if (detalle) console.log(`         ${color(90, detalle)}`);
}

async function pedir(ruta, { metodo = 'GET', cuerpo, cookie, csrf = true, origen, extra = {} } = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (csrf) headers['X-Requested-With'] = 'fetch';
  if (origen) headers.Origin = origen;
  if (cookie) headers.Cookie = cookie;
  let body;
  if (cuerpo !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo);
  }
  const resp = await fetch(BASE + ruta, { method: metodo, headers, body, redirect: 'manual' });
  const texto = await resp.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* no es JSON */ }
  const cookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  return { estado: resp.status, json, texto, headers: resp.headers, cookies };
}

const tieneSesion = (r) => r.cookies.some((c) => /^rs_(token|mfa)=[^;]+/.test(c) && !/^rs_(token|mfa)=;/.test(c));
const valorCookie = (r, nombre) => {
  const c = r.cookies.find((x) => x.startsWith(`${nombre}=`));
  return c ? c.split(';')[0].slice(nombre.length + 1) : null;
};

// ---------- JWT falsificados (como los haría un atacante) ----------
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function jwtFalso({ alg = 'HS256', clave = 'clave-que-adivino-el-atacante', payload }) {
  const cabecera = b64({ alg, typ: 'JWT' });
  const cuerpo = b64(payload);
  const firma = alg === 'none' ? '' : crypto.createHmac('sha256', clave).update(`${cabecera}.${cuerpo}`).digest('base64url');
  return `${cabecera}.${cuerpo}.${firma}`;
}
const ahora = () => Math.floor(Date.now() / 1000);
const payloadAdmin = () => ({ sub: '1', ver: 0, tipo: 'acceso', iss: 'rancho-seco', iat: ahora(), exp: ahora() + 3600 });

// =====================================================================
let respuestaCorreoReal = null;

async function pruebasSinSesion() {
  console.log(color(1, '\n── OWASP A03 · Inyección SQL y XSS ──────────────────────────'));

  const ataquesLogin = [
    ['Inyección SQL clásica en el correo', { correo: "' OR '1'='1' -- ", contrasena: 'cualquiera' }],
    ['Inyección SQL con comentario después del correo', { correo: `${CORREO_REAL}' -- `, contrasena: 'cualquiera' }],
    ['UNION SELECT en el correo', { correo: "x@x.com' UNION SELECT 1,2,3 -- ", contrasena: 'x' }],
    ['Inyección SQL en la contraseña de un correo real', { correo: CORREO_REAL, contrasena: "' OR '1'='1" }],
    ['Tipo de dato alterado (objeto en vez de texto)', { correo: CORREO_REAL, contrasena: { $ne: null } }],
    ['XSS en el campo correo', { correo: '<script>alert(1)</script>@x.com', contrasena: 'x' }]
  ];
  for (const [nombre, cuerpo] of ataquesLogin) {
    const inicio = Date.now();
    const r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo });
    if (cuerpo.contrasena === "' OR '1'='1") respuestaCorreoReal = { ...r, ms: Date.now() - inicio };
    registrar('A03', `${nombre} → no entra`, [400, 401, 423, 429].includes(r.estado) && !tieneSesion(r),
      `HTTP ${r.estado}: ${r.json ? r.json.mensaje : r.texto.slice(0, 80)}`);
  }

  const r1 = await pedir('/');
  const csp = r1.headers.get('content-security-policy') || '';
  registrar('A03', "Content-Security-Policy solo permite scripts propios (sin 'unsafe-inline')",
    /script-src 'self'/.test(csp) && !/unsafe-inline/.test(csp.split(';').find((d) => d.includes('script-src')) || ''), csp.slice(0, 90));
  registrar('A03', 'X-Content-Type-Options: nosniff', r1.headers.get('x-content-type-options') === 'nosniff');

  console.log(color(1, '\n── OWASP A01 · Control de acceso ────────────────────────────'));

  let r = await pedir('/api/admin/usuarios');
  registrar('A01', 'Pedir la lista de usuarios sin iniciar sesión → 401', r.estado === 401, `HTTP ${r.estado}`);

  r = await pedir('/admin', { csrf: false, extra: { Accept: 'text/html' } });
  registrar('A01', 'Abrir /admin sin sesión → regresa al login', [301, 302, 303].includes(r.estado), `HTTP ${r.estado} → ${r.headers.get('location')}`);

  r = await pedir('/api/auth/sesion', { cookie: `rs_token=${jwtFalso({ payload: payloadAdmin() })}` });
  registrar('A01', 'Token JWT inventado (firmado con otra clave) que dice ser el admin → rechazado y expulsado',
    r.estado === 401 && r.json && r.json.expulsado === true, `HTTP ${r.estado}: ${r.json && r.json.mensaje}`);

  r = await pedir('/api/auth/sesion', { cookie: `rs_token=${jwtFalso({ alg: 'none', payload: payloadAdmin() })}` });
  registrar('A01', 'Token JWT con algoritmo "none" (sin firma) → rechazado y expulsado',
    r.estado === 401 && r.json && r.json.expulsado === true, `HTTP ${r.estado}`);

  r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { correo: 'x@x.com', contrasena: 'x', idRol: 1 } });
  registrar('A01', 'JSON con un campo de más ("idRol": 1) → rechazado', [400, 429].includes(r.estado) && !tieneSesion(r), `HTTP ${r.estado}: ${r.json && r.json.mensaje}`);

  r = await pedir('/api/auth/logout', { metodo: 'POST', csrf: false });
  registrar('A01', 'Petición sin la cabecera de la página (CSRF) → 403', r.estado === 403, `HTTP ${r.estado}`);

  r = await pedir('/api/auth/logout', { metodo: 'POST', origen: 'https://sitio-malicioso.com' });
  registrar('A01', 'Petición que viene de otro sitio (CSRF) → 403', r.estado === 403, `HTTP ${r.estado}`);

  console.log(color(1, '\n── OWASP A02 · Fallas criptográficas / datos expuestos ──────'));

  registrar('A02', 'El servidor no revela su tecnología (sin X-Powered-By)', !r1.headers.get('x-powered-by'));
  r = await pedir('/api/auth/sesion');
  registrar('A02', 'Las respuestas de la API no se guardan en caché (no-store)', /no-store/.test(r.headers.get('cache-control') || ''));

  for (const ruta of ['/.env', '/server.js', '/config/db.js', '/package.json', '/%2e%2e/.env', '/..%2f.env']) {
    r = await pedir(ruta, { csrf: false });
    const expone = /JWT_SECRET|MFA_CLAVE|DB_PASSWORD|createPool|require\(/.test(r.texto);
    registrar('A02', `No se puede descargar ${decodeURIComponent(ruta)}`, r.estado >= 400 && !expone, `HTTP ${r.estado}`);
  }

  // ------------------------------------------------------------------
  console.log(color(1, '\n── OWASP A04 · Diseño inseguro ──────────────────────────────'));

  r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { correo: 'a@x.com', contrasena: 'x'.repeat(30 * 1024) } });
  registrar('A04', 'Petición gigante (30 KB, el límite es 20 KB) → rechazada', r.estado === 413, `HTTP ${r.estado}: ${r.json && r.json.mensaje}`);

  r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { correo: `${'a'.repeat(300)}@x.com`, contrasena: 'x' } });
  registrar('A04', 'Saltarse la validación del navegador (correo de 300 letras) → el servidor la aplica igual', r.estado === 400 && !tieneSesion(r),
    `HTTP ${r.estado}: ${r.json && r.json.mensaje} (queda como "Validación evadida")`);

  registrar('A04', 'La API tiene límite de peticiones por IP (RateLimit-Limit)', Boolean(r.headers.get('ratelimit-limit')),
    `Límite: ${r.headers.get('ratelimit-limit') || '—'} por ventana`);

  // ------------------------------------------------------------------
  console.log(color(1, '\n── OWASP A05 · Configuración defectuosa ─────────────────────'));

  for (const metodo of ['TRACE', 'PROPFIND']) {
    const m = await metodoCrudo(metodo, '/');
    registrar('A05', `Método HTTP ${metodo} → 405 (no permitido)`, m.estado === 405, `HTTP ${m.estado}`);
  }

  r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: '{"correo": "a@x.com", ' });
  registrar('A05', 'JSON mal formado → error controlado, sin detalles técnicos', r.estado === 400 && !FUGA_TECNICA.test(r.texto),
    `HTTP ${r.estado}: ${(r.json && r.json.mensaje) || r.texto.slice(0, 60)}`);

  r = await pedir('/api/no-existe');
  registrar('A05', 'Ruta inexistente → 404 genérico', r.estado === 404 && !FUGA_TECNICA.test(r.texto), `HTTP ${r.estado}`);

  r = await pedir('/js/', { csrf: false, extra: { Accept: 'text/html' } });
  registrar('A05', 'No se pueden listar las carpetas (/js/)', r.estado >= 400 || !/comun\.js|validacion\.js/.test(r.texto), `HTTP ${r.estado}`);

  registrar('A05', 'X-Frame-Options: DENY (nadie puede meter la página en un iframe)', r1.headers.get('x-frame-options') === 'DENY');
  registrar('A05', 'Referrer-Policy y Permissions-Policy configuradas',
    Boolean(r1.headers.get('referrer-policy') && r1.headers.get('permissions-policy')));

  // ------------------------------------------------------------------
  console.log(color(1, '\n── OWASP A06 · Componentes vulnerables y desactualizados ────'));

  const node = componentes.soporteNode(process.version);
  registrar('A06', `Node.js ${node.version} recibe parches de seguridad`, node.soportado,
    node.soportado ? `Soporte hasta ${node.fin || 'fecha por anunciar'}` : `Sin soporte desde ${node.fin}: instala la LTS de nodejs.org`);

  const faltan = componentes.dependenciasInstaladas().filter((d) => !d.instalada);
  registrar('A06', 'Todos los paquetes de package.json están instalados', !faltan.length, faltan.map((d) => d.nombre).join(', '));

  console.log(color(90, '  Revisando paquetes con npm audit (necesita internet)…'));
  try {
    const a = await componentes.ejecutarAuditoria();
    registrar('A06', 'npm audit: sin vulnerabilidades graves (critical/high)', a.conteo.critical + a.conteo.high === 0,
      `${a.conteo.total} en total · ${a.conteo.critical} crítica(s), ${a.conteo.high} alta(s), ${a.conteo.moderate} moderada(s)`);
    if (a.desactualizados.length) {
      avisar('A06', `${a.desactualizados.length} paquete(s) tienen versión más nueva (no es falla)`,
        a.desactualizados.map((d) => `${d.nombre} ${d.instalada} → ${d.ultima}`).join(' · '));
    }
  } catch (err) {
    avisar('A06', 'No se pudo correr npm audit', err.message);
  }

  // ------------------------------------------------------------------
  console.log(color(1, '\n── OWASP A07 · Identificación y autenticación ───────────────'));

  const inicio = Date.now();
  r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { correo: 'no-existe-7731@ranchoseco.com', contrasena: "' OR '1'='1" } });
  const ms = Date.now() - inicio;
  if (respuestaCorreoReal) {
    const mismo = r.estado === respuestaCorreoReal.estado && r.json && respuestaCorreoReal.json &&
      r.json.mensaje === respuestaCorreoReal.json.mensaje;
    registrar('A07', 'No se puede saber si un correo existe (misma respuesta para correo real e inventado)', mismo,
      `Real: "${respuestaCorreoReal.json && respuestaCorreoReal.json.mensaje}" (${respuestaCorreoReal.ms} ms) · ` +
      `Inventado: "${r.json && r.json.mensaje}" (${ms} ms)`);
  }
  registrar('A07', 'Sin contraseña correcta no se entrega ninguna sesión', !tieneSesion(r), `HTTP ${r.estado}`);

  // ------------------------------------------------------------------
  console.log(color(1, '\n── OWASP A08 · Integridad de software y datos ───────────────'));

  r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: '{"correo":"a@x.com","contrasena":"x","__proto__":{"esAdmin":true}}' });
  registrar('A08', 'JSON con "__proto__" (contaminación de prototipo) → rechazado', r.estado === 400 && !tieneSesion(r),
    `HTTP ${r.estado}: ${r.json && r.json.mensaje}`);
  r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: '{"correo":"a@x.com","contrasena":"x","datos":{"constructor":{"prototype":{"rol":"Administrador"}}}}' });
  registrar('A08', 'JSON con "constructor.prototype" escondido → rechazado', r.estado === 400, `HTTP ${r.estado}: ${r.json && r.json.mensaje}`);

  const firma = integridad.verificarManifiesto();
  const cambios = [...firma.modificados, ...firma.nuevos, ...firma.faltantes];
  registrar('A08', 'El código coincide con su firma (integridad.json)', firma.estado === 'ok',
    firma.estado === 'ok' ? `${firma.total} archivos sin cambios`
      : firma.estado === 'sin_manifiesto' ? 'Aún no se firma: ejecuta "npm run firmar-codigo"'
        : firma.estado === 'firma_invalida' ? 'La firma de integridad.json no es válida'
          : `Cambiaron: ${cambios.slice(0, 4).join(', ')}${cambios.length > 4 ? '…' : ''}`);
  const deps = integridad.verificarDependencias();
  registrar('A08', 'Paquetes instalados = package-lock.json (con hash sha512)', deps.estado === 'ok' && deps.conHash === deps.total,
    `${deps.total} paquetes, ${deps.conHash} con hash${deps.distintos.length ? ` · distintos: ${deps.distintos.slice(0, 3).join(', ')}` : ''}`);

  // ------------------------------------------------------------------
  console.log(color(1, '\n── OWASP A09 · Registro y monitoreo ─────────────────────────'));
  await new Promise((ok) => setTimeout(ok, 1500));    // el respaldo en archivo se escribe en segundo plano

  let lineas = [];
  try { lineas = fs.readFileSync(archivoRegistro.rutaDelDia(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { lineas = []; }
  registrar('A09', 'Respaldo en archivo de hoy (almacen/registros)', lineas.length > 0, `${lineas.length} línea(s) en ${archivoRegistro.rutaDelDia().split(/[\\/]/).slice(-3).join('/')}`);
  const reciente = (accion, minutos = 10) => lineas.some((l) => l.Accion === accion && Date.now() - new Date(l.Fecha.replace(' ', 'T')).getTime() < minutos * 60 * 1000);
  registrar('A09', 'Los ataques de esta prueba quedaron registrados', reciente('INTENTO_INYECCION') && reciente('TOKEN_MANIPULADO') && reciente('DATOS_MANIPULADOS'),
    'Intento de inyección, token alterado y JSON envenenado aparecen en el registro');
  registrar('A09', 'Se generó una ALERTA automática por los ataques de esta IP', reciente('ALERTA_SEGURIDAD', 24 * 60),
    'Aparece arriba en Panel → Seguridad OWASP hasta que la marques como atendida (si ya había una sin atender, no se repite)');
  const firmados = lineas.filter((l) => l.enBase && /^[0-9a-f]{64}$/.test(l.Hash_Integridad || ''));
  registrar('A09', 'Cada registro se guardó en SQL Server con su firma en cadena', firmados.length > 0 && firmados.length === lineas.filter((l) => l.enBase).length,
    `${firmados.length} registro(s) firmados hoy`);
  try {
    const { verificarIntegridad } = require('../src/bitacora');
    const cadena = await verificarIntegridad();
    registrar('A09', 'La cadena de firmas de la bitácora está completa (nadie la alteró)', cadena.ok,
      cadena.ok ? `${cadena.firmados} registro(s) revisados` : cadena.problemas.filter((p) => !p.revisado).slice(0, 2).map((p) => p.detalle).join(' '));
    const { pool } = require('../config/db');
    if (pool && typeof pool.close === 'function') await pool.close().catch(() => {});
  } catch (err) {
    avisar('A09', 'No se pudo revisar la cadena desde aquí', err.message);
  }
}

// =====================================================================
function preguntar(rl, texto, oculto = false) {
  return new Promise((resolver) => {
    if (!oculto) return rl.question(texto, (v) => resolver(v.trim()));
    const original = rl._writeToOutput;
    rl._writeToOutput = (s) => { if (s.includes(texto)) original.call(rl, s); else original.call(rl, '*'); };
    rl.question(texto, (v) => { rl._writeToOutput = original; console.log(''); resolver(v); });
  });
}

async function pasoContrasena(correo, contrasena) {
  const p1 = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { correo, contrasena } });
  if (p1.estado !== 200) throw new Error(`No se pudo iniciar sesión: ${p1.json && p1.json.mensaje}`);
  if (p1.json.paso === 'configurar') throw new Error('Ese usuario aún no configura su MFA. Entra una vez desde el navegador y vuelve a intentar.');
  return p1;
}

async function iniciarSesion(rl, correo, contrasena) {
  const p1 = await pasoContrasena(correo, contrasena);
  const mfa = valorCookie(p1, 'rs_mfa');
  const codigo = await preguntar(rl, '  Código de 6 dígitos de la app Authenticator: ');
  const p2 = await pedir('/api/auth/mfa', { metodo: 'POST', cuerpo: { codigo }, cookie: `rs_mfa=${mfa}` });
  if (p2.estado !== 200) throw new Error(`Código rechazado: ${p2.json && p2.json.mensaje}`);
  return { p1, p2, codigo };
}

async function pruebasConSesion(rl) {
  if (!rl) return;
  try {
    console.log(color(1, '\n── Pruebas con un usuario NORMAL (opcional) ─────────────────'));
    console.log('  Usa una cuenta que NO sea administrador (por ejemplo un Cliente o Árbitro) con su MFA ya configurado.');
    if ((await preguntar(rl, '  ¿Hacer estas pruebas? (s/n): ')).toLowerCase() !== 's') return;

    const correo = await preguntar(rl, '  Correo: ');
    const contrasena = await preguntar(rl, '  Contraseña: ', true);
    const { p1, p2: login, codigo: codigoUsado } = await iniciarSesion(rl, correo, contrasena);
    const token = valorCookie(login, 'rs_token');
    const cookieToken = login.cookies.find((c) => c.startsWith('rs_token=')) || '';

    console.log(color(1, '\n── OWASP A07 · Inicio de sesión y sesión ────────────────────'));
    registrar('A07', 'Con la contraseña correcta todavía NO hay sesión: falta el MFA',
      !valorCookie(p1, 'rs_token') && Boolean(valorCookie(p1, 'rs_mfa')), 'Solo se entregó la cookie temporal rs_mfa (5 min)');
    const datosToken = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    registrar('A07', 'La sesión vence tras 15 minutos sin actividad', datosToken.exp - datosToken.iat <= 15 * 60,
      `El token dura ${Math.round((datosToken.exp - datosToken.iat) / 60)} min y se renueva solo mientras se usa (máximo 8 h)`);
    const repetido = await pedir('/api/auth/mfa', {
      metodo: 'POST', cuerpo: { codigo: codigoUsado },
      cookie: `rs_mfa=${valorCookie(await pasoContrasena(correo, contrasena), 'rs_mfa')}`
    });
    registrar('A07', 'Reusar el mismo código MFA (robado o visto por encima del hombro) → rechazado',
      repetido.estado === 401 && !valorCookie(repetido, 'rs_token'), `HTTP ${repetido.estado}: ${repetido.json && repetido.json.mensaje}`);

    console.log(color(1, '\n── OWASP A02 · Sesión y datos expuestos ─────────────────────'));
    registrar('A02', 'La cookie de sesión es HttpOnly (JavaScript no la puede leer)', /HttpOnly/i.test(cookieToken));
    registrar('A02', 'La cookie de sesión es SameSite=Strict', /SameSite=Strict/i.test(cookieToken));
    let r = await pedir('/api/perfil', { cookie: `rs_token=${token}` });
    registrar('A02', 'El perfil no envía hash, secreto MFA ni tokens al navegador',
      r.estado === 200 && !/scrypt\$|MFA_Secreto|Contrase|Token_Version|v1:/.test(r.texto), `HTTP ${r.estado}`);

    console.log(color(1, '\n── OWASP A01 · Manipulación con sesión iniciada ─────────────'));
    if (login.json.destino === '/admin') {
      console.log(color(33, '  Esta cuenta es administrador: se omiten las pruebas de escalamiento.'));
      return;
    }

    const [cab, cuerpo, firma] = token.split('.');
    const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
    const alterado = `${cab}.${b64({ ...datos, sub: '1' })}.${firma}`;
    r = await pedir('/api/auth/sesion', { cookie: `rs_token=${alterado}` });
    registrar('A01', 'Cambiar dentro del token mi id por el del admin → rechazado y expulsado',
      r.estado === 401 && r.json && r.json.expulsado === true, `HTTP ${r.estado}`);

    r = await pedir('/api/admin/usuarios', { cookie: `rs_token=${token}` });
    registrar('A01', 'Usuario normal pide /api/admin/usuarios (desde la consola) → expulsado',
      r.estado === 401 && r.json && r.json.expulsado === true, `HTTP ${r.estado}: ${r.json && r.json.mensaje}`);

    r = await pedir('/api/perfil', { cookie: `rs_token=${token}` });
    registrar('A01', 'Después de la expulsión el token ya no sirve', r.estado === 401, `HTTP ${r.estado}`);

    if ((await preguntar(rl, '\n  ¿Probar también "modificar el JSON" del perfil para hacerse admin? Pide otro código (s/n): ')).toLowerCase() === 's') {
      console.log('  Espera a que cambie el código en tu app (cada 30 segundos).');
      const { p2: login2 } = await iniciarSesion(rl, correo, contrasena);
      const token2 = valorCookie(login2, 'rs_token');
      const perfil = (await pedir('/api/perfil', { cookie: `rs_token=${token2}` })).json.usuario;
      r = await pedir('/api/perfil', {
        metodo: 'PUT', cookie: `rs_token=${token2}`,
        cuerpo: {
          nombre: perfil.nombre, apellidoPaterno: perfil.apellidoPaterno, apellidoMaterno: perfil.apellidoMaterno || '',
          telefono: perfil.telefono || '', correo: perfil.correo, idGenero: perfil.idGenero, codigo: '000000',
          idRol: 1, estado: 'Activo'
        }
      });
      registrar('A01', 'Agregar "idRol": 1 al JSON del perfil → expulsado y sin cambiar el rol',
        r.estado === 401 && r.json && r.json.expulsado === true, `HTTP ${r.estado}: ${r.json && r.json.mensaje}`);
    }
  } catch (err) {
    console.log(color(33, `  ${err.message}`));
  }
}

// =====================================================================
//  A10: con un ADMINISTRADOR (la única función que descarga enlaces)
// =====================================================================
async function pruebasSsrf(rl) {
  if (!rl) return;
  try {
    console.log(color(1, '\n── OWASP A10 · SSRF con el ADMINISTRADOR (opcional) ─────────'));
    console.log('  Necesita al menos una reserva con pago registrado. No cambia nada: todos los enlaces se rechazan.');
    if ((await preguntar(rl, '  ¿Hacer estas pruebas? (s/n): ')).toLowerCase() !== 's') return;
    const correo = (await preguntar(rl, `  Correo del administrador [${CORREO_REAL}]: `)) || CORREO_REAL;
    const contrasena = await preguntar(rl, '  Contraseña: ', true);
    console.log('  Si acabas de usar un código, espera a que cambie en tu app.');
    const { p2: login } = await iniciarSesion(rl, correo, contrasena);
    const cookie = `rs_token=${valorCookie(login, 'rs_token')}`;

    const lista = await pedir('/api/admin/reservas?pagina=1&porPagina=50', { cookie });
    const reserva = lista.json && (lista.json.registros || []).find((x) => x.idPago);
    if (!reserva) {
      avisar('A10', 'No hay reservas con pago', 'Registra una reserva con monto en Reservas y vuelve a correr la prueba.');
      return;
    }
    const ruta = `/api/admin/reservas/${reserva.idReserva}/comprobante-url`;
    const ataques = [
      ['La propia aplicación (http://localhost:3000/.env)', 'http://localhost:3000/.env'],
      ['localhost con https', 'https://localhost/'],
      ['Loopback 127.0.0.1', 'https://127.0.0.1/'],
      ['127.0.0.1 escrito en hexadecimal (0x7f000001)', 'https://0x7f000001/'],
      ['127.0.0.1 escrito como número (2130706433)', 'https://2130706433/'],
      ['IPv6 local [::1]', 'https://[::1]/'],
      ['Metadatos de AWS (169.254.169.254)', 'https://169.254.169.254/latest/meta-data/iam/security-credentials/'],
      ['Router de la red (192.168.1.1)', 'https://192.168.1.1/'],
      ['Red privada 10.x', 'https://10.0.0.1/'],
      ['Dominio público que apunta a 127.0.0.1 (localtest.me)', 'https://localtest.me/'],
      ['Puerto interno (MySQL 3306)', 'https://sitio-publico.com:3306/'],
      ['Usuario y contraseña en el enlace', 'https://admin:admin@sitio-publico.com/x.png'],
      ['Protocolo file://', 'file:///C:/rancho/rancho-seco-app/.env'],
      ['Protocolo gopher:// (atacar Redis/MySQL)', 'gopher://127.0.0.1:3306/_'],
      ['Nombre interno (*.local)', 'https://servidor.local/']
    ];
    for (const [nombre, url] of ataques) {
      const r = await pedir(ruta, { metodo: 'POST', cookie, cuerpo: { url } });
      if (url === 'https://localtest.me/' && r.json && /No se encontró ese dominio/.test(r.json.mensaje)) {
        // Algunos routers ya bloquean dominios públicos que responden con IPs internas: no se puede probar aquí
        avisar('A10', `${nombre}: tu red no resolvió ese dominio`, 'Tu router ya filtra este truco; el bloqueo por DNS se comprueba en "npm test".');
        continue;
      }
      registrar('A10', `${nombre} → bloqueado`, r.estado === 400 && r.json && r.json.ssrf === true, `HTTP ${r.estado}: ${r.json && r.json.mensaje}`);
    }
    const publico = await pedir(ruta, { metodo: 'POST', cookie, cuerpo: { url: 'https://example.com/' } });
    registrar('A10', 'Un enlace público normal SÍ se intenta (example.com no es imagen → se rechaza por contenido, no por SSRF)',
      publico.json && publico.json.ssrf !== true && publico.estado !== 401, `HTTP ${publico.estado}: ${publico.json && publico.json.mensaje}`);

    const alertas = await pedir('/api/admin/seguridad/alertas', { cookie });
    registrar('A09', 'Los intentos de SSRF generaron una alerta automática',
      Boolean(alertas.json && alertas.json.alertas.some((a) => /SSRF/.test(a.descripcion))), 'Panel → Seguridad OWASP, arriba');
  } catch (err) {
    console.log(color(33, `  ${err.message}`));
  }
}

// =====================================================================
(async () => {
  console.log(color(1, `Pruebas OWASP contra ${BASE}`));
  try {
    await pedir('/');
  } catch {
    console.log(color(31, '\nNo hay conexión con el servidor. Abre otra terminal, corre "npm start" y vuelve a intentar.'));
    process.exit(1);
  }
  await pruebasSinSesion();
  const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  await pruebasConSesion(rl);
  await pruebasSsrf(rl);
  if (rl) rl.close();

  const fallas = resultados.filter((r) => !r.paso);
  console.log(color(1, `\nResultado: ${resultados.length - fallas.length} de ${resultados.length} pruebas pasaron.`));
  if (fallas.length) console.log(color(31, 'Revisa las que dicen FALLA.'));
  console.log('Abre el panel → Seguridad OWASP para ver cómo quedaron registrados los ataques.\n');
  process.exit(fallas.length ? 1 : 0);
})();
