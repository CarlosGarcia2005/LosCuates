// Pruebas de las protecciones OWASP (A01, A02, A03):  npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { diagnosticar } = require('../src/seguridad/diagnostico-token');
const { camposSobrantes } = require('../src/seguridad/campos');
const { analizar, revisarSolicitud } = require('../src/seguridad/detector');
const V = require('../public/js/validacion');

const SECRETO = 'x'.repeat(64);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function firmar(payload, { alg = 'HS256', clave = SECRETO } = {}) {
  const c = b64({ alg, typ: 'JWT' }), d = b64(payload);
  const f = alg === 'none' ? '' : crypto.createHmac('sha256', clave).update(`${c}.${d}`).digest('base64url');
  return `${c}.${d}.${f}`;
}
const ahora = Math.floor(Date.now() / 1000);
const base = { sub: '5', ver: 0, tipo: 'acceso', iss: 'rancho-seco', exp: ahora + 600 };

test('[A01] Token auténtico se reconoce como válido', () => {
  assert.equal(diagnosticar(firmar(base), SECRETO, 'acceso').motivo, 'valido');
});

test('[A01] Tokens alterados se detectan como manipulación (no como "sesión expirada")', () => {
  const real = firmar(base);
  const [c, , f] = real.split('.');
  const cambiado = `${c}.${b64({ ...base, sub: '1' })}.${f}`;       // cambié mi id por el del admin
  assert.equal(diagnosticar(cambiado, SECRETO, 'acceso').motivo, 'firma');
  assert.equal(diagnosticar(firmar(base, { clave: 'otra-clave' }), SECRETO, 'acceso').motivo, 'firma');
  assert.equal(diagnosticar(firmar(base, { alg: 'none' }), SECRETO, 'acceso').motivo, 'algoritmo');
  assert.equal(diagnosticar('basura', SECRETO, 'acceso').motivo, 'formato');
  assert.equal(diagnosticar(firmar({ ...base, iss: 'otro' }), SECRETO, 'acceso').motivo, 'emisor');
  assert.equal(diagnosticar(firmar({ ...base, tipo: 'mfa' }), SECRETO, 'acceso').motivo, 'tipo');
  assert.equal(diagnosticar(firmar({ ...base, exp: ahora - 5 }), SECRETO, 'acceso').motivo, 'expirado');
  assert.equal(diagnosticar(undefined, SECRETO, 'acceso').motivo, 'vacio');
});

test('[A01] Lista blanca de campos detecta los que sobran', () => {
  const permitidos = ['nombre', 'correo', 'codigo'];
  assert.deepEqual(camposSobrantes({ nombre: 'a', correo: 'b' }, permitidos), []);
  assert.deepEqual(camposSobrantes({ nombre: 'a', idRol: 1, estado: 'Activo' }, permitidos), ['idRol', 'estado']);
  assert.equal(camposSobrantes([1, 2], permitidos), null, 'un arreglo no es un formulario');
  assert.equal(camposSobrantes('texto', permitidos), null);
  assert.deepEqual(camposSobrantes(undefined, permitidos), []);
});

test('[A03] El detector reconoce inyección SQL', () => {
  for (const ataque of ["' OR '1'='1' -- ", "admin@x.com' --", "1' UNION SELECT correo FROM Usuario --",
    "x'; DROP TABLE Usuario; --", "' OR SLEEP(5) --", "\" or \"\"=\""]) {
    assert.ok(analizar(ataque).some((h) => h.tipo === 'SQL'), ataque);
  }
});

test('[A03] El detector reconoce XSS', () => {
  for (const ataque of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)',
    '<svg/onload=alert(1)>', '&#x3C;script&#x3E;']) {
    assert.ok(analizar(ataque).some((h) => h.tipo === 'XSS'), ataque);
  }
});

test('[A03] El detector no molesta con texto normal', () => {
  for (const normal of ['Cancha Azul', 'admin@ranchoseco.com', 'Partido amistoso de los Halcones', "O'Connor",
    'Reserva para el torneo, traer balones', 'García Dávila', '8446027156', 'RES-00012']) {
    assert.deepEqual(analizar(normal), [], normal);
  }
});

test('[A03] El detector nunca guarda lo escrito en campos de contraseña', () => {
  const h = revisarSolicitud({ query: {}, body: { correo: "' OR 1=1 --", contrasena: "' OR '1'='1" } });
  assert.equal(h.length, 2);
  const enContrasena = h.find((x) => x.campo === 'body.contrasena');
  assert.equal(enContrasena.valor, '(oculto: campo sensible)');
});

test('[A03] Validación: los nombres no aceptan HTML ni comillas SQL', () => {
  assert.ok(V.validarCancha({ nombre: '<img src=x>', idTipo: 1, estado: 'Activa' }).errores.nombre);
  assert.ok(V.validarRol({ rol: "x' OR 1=1", nivel: 'Usuario' }).errores.rol);
  assert.ok(V.validarLogin({ correo: "' OR '1'='1' -- ", contrasena: 'x' }).errores.correo);
  assert.ok(V.validarLogin({ correo: 'a@b.com', contrasena: { $ne: null } }).errores.contrasena);
  const u = V.validarUsuarioAdmin({ nombre: '<script>', apellidoPaterno: 'Pérez', correo: 'a@b.com', idGenero: 1, idRol: 1, estado: 'Activo' });
  assert.ok(u.errores.nombre);
});

test('[A02] Contraseñas comunes o repetidas se rechazan', () => {
  assert.ok(V.validarNuevaContrasena({ nueva: 'Password1', confirmar: 'Password1' }).errores.nueva);
  assert.ok(V.validarNuevaContrasena({ nueva: 'aaaaaaa1', confirmar: 'aaaaaaa1' }).errores.nueva);
  assert.equal(V.validarNuevaContrasena({ nueva: 'Cancha#Verde27', confirmar: 'Cancha#Verde27' }).ok, true);
});
