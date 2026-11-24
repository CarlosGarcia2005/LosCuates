// Pruebas de las protecciones OWASP A04, A05, A06 y A07:  npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'p'.repeat(64);

const { revisarEntorno, privilegiosSobrantes, revisarBaseDatos } = require('../src/seguridad/configuracion');
const { soporteNode, soporteSqlServer, resumirAudit, resumirOutdated } = require('../src/seguridad/componentes');
const { crearLimitador } = require('../src/seguridad/limitador');
const { validacionEvadida, reglaNegocio } = require('../src/errores');
const jwt = require('../src/seguridad/jwt');
const V = require('../public/js/validacion');

const estadoDe = (lista, nombre) => (lista.find((r) => r.nombre.includes(nombre)) || {}).estado;
const HOY = new Date('2026-11-17T12:00:00Z');

/* ------------------------------- A04 ------------------------------- */
test('[A04] Un error de las reglas compartidas se marca como validación evadida', () => {
  const e = validacionEvadida({ fecha: 'La fecha ya pasó.' });
  assert.equal(e.estado, 400);
  assert.equal(e.evadida, true);
  assert.deepEqual(e.extra.errores, { fecha: 'La fecha ya pasó.' });
});

test('[A04] Las reglas del negocio se registran como REGLA_NEGOCIO (409)', () => {
  const e = reglaNegocio('Ya tiene 3 reservas pendientes', { idUsuario: 'x' });
  assert.equal(e.estado, 409);
  assert.equal(e.accion, 'REGLA_NEGOCIO');
});

test('[A04] Las mismas reglas del navegador se aplican en el servidor (reserva en el pasado o de más de 3 h)', () => {
  const ahora = new Date(2026, 10, 17, 12, 0);
  const base = { idUsuario: 1, idCancha: 1, horaInicio: '18:00', horaFin: '19:00' };
  assert.equal(V.validarReserva({ ...base, fecha: '2026-11-16' }, { ahora }).ok, false);
  assert.equal(V.validarReserva({ ...base, fecha: '2026-11-20', horaInicio: '08:00', horaFin: '12:00' }, { ahora }).ok, false);
  assert.equal(V.validarReserva({ ...base, fecha: '2026-11-20' }, { ahora }).ok, true);
});

test('[A04/A07] El limitador frena después del máximo y avisa UNA sola vez por ventana', async () => {
  let avisos = 0;
  const limitador = crearLimitador({ ventanaMs: 60000, maximo: 3, alExceder: () => { avisos += 1; } });
  const req = { ip: '10.0.0.9' };
  const estados = [];
  for (let i = 0; i < 6; i++) {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(s) { estados.push(s); return this; }, json() { return this; } };
    let paso = false;
    limitador(req, res, () => { paso = true; estados.push(200); });
    if (!paso && !estados.length) estados.push('?');
  }
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(estados, [200, 200, 200, 429, 429, 429]);
  assert.equal(avisos, 1);
});

/* ------------------------------- A05 ------------------------------- */
const envBueno = {
  JWT_SECRET: 'a1'.repeat(48), MFA_CLAVE: 'b2'.repeat(32), DB_USER: 'rancho_app', DB_PASSWORD: 'Rancho-Seco_BD-2026', NODE_ENV: 'development'
};

test('[A05] Configuración correcta no deja pendientes (modo desarrollo es solo informativo)', () => {
  const r = revisarEntorno(envBueno, { gitignore: 'node_modules/\n.env\n' });
  assert.equal(r.filter((x) => x.estado === 'atencion').length, 0);
  assert.equal(estadoDe(r, 'Modo desarrollo'), 'info');
});

test('[A05] Detecta sa, contraseña de SQL Server corta, clave JWT corta y claves repetidas', () => {
  const r = revisarEntorno({ ...envBueno, DB_USER: 'sa', DB_PASSWORD: 'rsbd0', JWT_SECRET: 'z'.repeat(40), MFA_CLAVE: 'z'.repeat(40) },
    { gitignore: 'node_modules/' });
  assert.equal(estadoDe(r, 'como sa'), 'atencion');
  assert.equal(estadoDe(r, 'Contraseña de SQL Server'), 'atencion');
  assert.equal(estadoDe(r, 'Clave JWT'), 'atencion');
  assert.equal(estadoDe(r, 'Claves repetidas'), 'atencion');
  assert.equal(estadoDe(r, '.env podría'), 'atencion');
});

test('[A05] Privilegios de SQL Server: detecta db_owner/sysadmin y acepta solo lectura y escritura', () => {
  assert.deepEqual(privilegiosSobrantes({ sysadmin: 0, dbOwner: 1, control: 1, alterar: 1, crearTablas: 1, usuarios: 1 }), ['db_owner']);
  assert.deepEqual(privilegiosSobrantes({ sysadmin: 1, dbOwner: 1 }), ['sysadmin', 'db_owner']);
  assert.deepEqual(privilegiosSobrantes({ sysadmin: 0, dbOwner: 0, control: 0, alterar: 0, crearTablas: 0, usuarios: 0 }), []);
  assert.deepEqual(privilegiosSobrantes({ dbOwner: 0, control: 0, alterar: 0, crearTablas: 1, usuarios: 1 }).sort(),
    ['ALTER ANY USER', 'CREATE TABLE']);
});

test('[A05] Revisión de la cuenta de SQL Server con una base simulada', async () => {
  const anterior = process.env.DB_CIFRADO;
  process.env.DB_CIFRADO = '1';
  const consulta = async () => [{
    cuenta: 'rancho_app', usuarioBd: 'rancho_app', base: 'GestorDeportivoRanchoSeco', version: '12.0.2000.8',
    comentario: 'SQL Azure', motor: 5, sysadmin: 0, dbOwner: 0, control: 0, alterar: 0, crearTablas: 0, usuarios: 0, avisosAnsi: 1
  }];
  const { revisiones, info } = await revisarBaseDatos(consulta);
  if (anterior === undefined) delete process.env.DB_CIFRADO; else process.env.DB_CIFRADO = anterior;
  assert.equal(info.version, '12.0.2000.8');
  assert.equal(revisiones.filter((x) => x.estado === 'atencion').length, 0);
});

/* ------------------------------- A06 ------------------------------- */
test('[A06] Node.js: 22/24/26 con soporte; 20 y 25 ya no reciben parches', () => {
  assert.equal(soporteNode('v24.20.0', HOY).soportado, true);
  assert.equal(soporteNode('v22.11.0', HOY).soportado, true);
  assert.equal(soporteNode('v20.18.0', HOY).soportado, false);
  assert.equal(soporteNode('v25.2.0', HOY).soportado, false);
  assert.equal(soporteNode('v16.20.0', HOY).soportado, false);
});

test('[A06] SQL Server: 2016 sin soporte desde julio 2026; 2019 y 2022 con soporte; Azure SQL siempre actualizado', () => {
  assert.equal(soporteSqlServer('13.0.6300.2', 'Express Edition', 4, HOY).soportado, false);
  assert.equal(soporteSqlServer('15.0.2000.5', 'Express Edition', 4, HOY).soportado, true);
  assert.equal(soporteSqlServer('16.0.1000.6', 'Developer Edition', 3, HOY).soportado, true);
  assert.equal(soporteSqlServer('12.0.2000.8', 'SQL Azure', 5, HOY).motor, 'Azure SQL');
  assert.equal(soporteSqlServer('12.0.2000.8', 'SQL Azure', 5, HOY).soportado, true);
});

test('[A06] Se entiende la salida de npm audit y npm outdated', () => {
  const r = resumirAudit({
    vulnerabilities: { semver: { name: 'semver', severity: 'high', fixAvailable: true, via: [{ title: 'ReDoS' }] } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } }
  });
  assert.equal(r.conteo.high, 1);
  assert.equal(r.detalle[0].titulo, 'ReDoS');
  assert.throws(() => resumirAudit({ error: { code: 'ENOTFOUND' } }), /internet/);
  assert.deepEqual(resumirOutdated({ express: { current: '4.21.2', wanted: '4.21.2', latest: '5.1.0' } }),
    [{ nombre: 'express', instalada: '4.21.2', compatible: '4.21.2', ultima: '5.1.0' }]);
});

/* ------------------------------- A07 ------------------------------- */
function respuestaFalsa() {
  return { cookies: {}, cookie(n, v, o) { this.cookies[n] = { v, o }; } };
}
const leer = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));

test('[A07] El token de sesión vence a los 15 min y guarda el inicio de la sesión', () => {
  const res = respuestaFalsa();
  jwt.emitirAcceso(res, { id: 7, tokenVersion: 2 });
  const d = leer(res.cookies.rs_token.v);
  assert.equal(d.exp - d.iat, 15 * 60);
  assert.equal(typeof d.ini, 'number');
  assert.equal(res.cookies.rs_token.o.httpOnly, true);
  assert.ok(res.cookies.rs_token.o.maxAge <= 8 * 3600 * 1000);
});

test('[A07] Al renovar se conserva el inicio: la sesión no puede pasar de 8 horas', () => {
  const ahora = Math.floor(Date.now() / 1000);
  const res = respuestaFalsa();
  jwt.renovarSiHaceFalta(res, { id: 7, tokenVersion: 2 }, { iat: ahora - 120, ini: ahora - 3600 });
  assert.equal(leer(res.cookies.rs_token.v).ini, ahora - 3600);

  const casiFin = respuestaFalsa();
  jwt.emitirAcceso(casiFin, { id: 7, tokenVersion: 2 }, ahora - (8 * 3600 - 300));   // quedan 5 min
  const d = leer(casiFin.cookies.rs_token.v);
  assert.ok(d.exp - d.iat <= 300);

  assert.equal(jwt.sesionAgotada({ ini: ahora - 8 * 3600 - 1 }), true);
  assert.equal(jwt.sesionAgotada({ ini: ahora - 60 }), false);
});

test('[A07] No se renueva en cada clic (máximo una vez por minuto)', () => {
  const ahora = Math.floor(Date.now() / 1000);
  const res = respuestaFalsa();
  jwt.renovarSiHaceFalta(res, { id: 7, tokenVersion: 2 }, { iat: ahora - 10, ini: ahora - 10 });
  assert.equal(res.cookies.rs_token, undefined);
});

test('[A07] Contraseñas que ya no cumplen las reglas se detectan al iniciar sesión', () => {
  const debil = (c) => !V.validarNuevaContrasena({ nueva: c, confirmar: c }).ok;
  assert.equal(debil('admin123'), true);
  assert.equal(debil('12345678a'), true);
  assert.equal(debil('abc'), true);
  assert.equal(debil('Cancha-Azul_2026'), false);
});
