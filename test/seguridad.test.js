// Pruebas de los módulos de seguridad:  npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.MFA_CLAVE = crypto.randomBytes(32).toString('hex');

const totp = require('../src/seguridad/totp');
const contrasena = require('../src/seguridad/contrasena');
const cifrado = require('../src/seguridad/cifrado');
const V = require('../public/js/validacion');

test('TOTP coincide con los vectores oficiales del RFC 6238', () => {
  // Secreto del RFC: "12345678901234567890" (ASCII)
  const secreto = Buffer.from('12345678901234567890');
  const casos = [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']];
  for (const [segundos, esperado] of casos) {
    assert.equal(totp._codigoParaPaso(secreto, Math.floor(segundos / 30)), esperado);
  }
});

test('Base32 ida y vuelta', () => {
  const datos = crypto.randomBytes(20);
  assert.deepEqual(totp._base32Decodificar(totp._base32Codificar(datos)), datos);
  assert.equal(totp._base32Codificar(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('TOTP acepta el código actual, rechaza uno reutilizado y uno inventado', () => {
  const s = totp.generarSecreto();
  assert.equal(s.length, 32);
  const ahora = Date.now();
  const paso = Math.floor(ahora / 30000);
  const codigo = totp._codigoParaPaso(totp._base32Decodificar(s), paso);

  const usado = totp.verificarCodigo(s, codigo, null, ahora);
  assert.equal(usado, paso);
  assert.equal(totp.verificarCodigo(s, codigo, usado, ahora), null, 'no debe aceptar el mismo código dos veces');
  assert.equal(totp.verificarCodigo(s, '12345', null, ahora), null);
  assert.equal(totp.verificarCodigo(s, 'abcdef', null, ahora), null);
  const otro = String((Number(codigo) + 1) % 1e6).padStart(6, '0');
  assert.equal(totp.verificarCodigo(s, otro, null, ahora) === null || otro === codigo, true);
});

test('TOTP tolera 30 s de desfase pero no 90 s', () => {
  const s = totp.generarSecreto();
  const ahora = Date.now();
  const paso = Math.floor(ahora / 30000);
  const anterior = totp._codigoParaPaso(totp._base32Decodificar(s), paso - 1);
  const viejo = totp._codigoParaPaso(totp._base32Decodificar(s), paso - 3);
  assert.equal(totp.verificarCodigo(s, anterior, null, ahora), paso - 1);
  assert.equal(totp.verificarCodigo(s, viejo, null, ahora), null);
});

test('URI otpauth para el QR', () => {
  const uri = totp.uriOtpauth('JBSWY3DPEHPK3PXP', 'admin@ranchoseco.com', 'Rancho Seco');
  assert.match(uri, /^otpauth:\/\/totp\/Rancho%20Seco%3Aadmin%40ranchoseco\.com\?secret=JBSWY3DPEHPK3PXP&issuer=Rancho\+Seco/);
});

test('scrypt: hashea, verifica y cada hash usa sal distinta', async () => {
  const h1 = await contrasena.hashear('RanchoSeco2026');
  const h2 = await contrasena.hashear('RanchoSeco2026');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(h1, h2);
  assert.ok(h1.length <= 255);
  assert.deepEqual(await contrasena.verificar('RanchoSeco2026', h1), { valida: true, requiereMigracion: false });
  assert.equal((await contrasena.verificar('ranchoseco2026', h1)).valida, false);
});

test('Compatibilidad con los hash SHA-256 que ya están en la base', async () => {
  const viejo = '30bd833682c5f5f172884d947520d45f25f448970451ec060d54689a515a8850'; // RanchoSeco2026
  assert.deepEqual(await contrasena.verificar('RanchoSeco2026', viejo), { valida: true, requiereMigracion: true });
  assert.deepEqual(await contrasena.verificar('Otra1234', viejo), { valida: false, requiereMigracion: false });
  assert.deepEqual(await contrasena.verificar('RanchoSeco2026', 'basura'), { valida: false, requiereMigracion: false });
});

test('AES-256-GCM: cifra, descifra y detecta alteraciones', () => {
  const c = cifrado.cifrar('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  assert.ok(c.length < 200);
  assert.equal(cifrado.descifrar(c), 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  const partes = c.split(':');
  partes[3] = Buffer.from('XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX').toString('base64');
  assert.throws(() => cifrado.descifrar(partes.join(':')));
});

test('Validación de formularios', () => {
  assert.equal(V.validarLogin({ correo: 'ADMIN@RanchoSeco.com ', contrasena: 'x' }).datos.correo, 'admin@ranchoseco.com');
  assert.ok(V.validarLogin({ correo: 'no-es-correo', contrasena: 'x' }).errores.correo);

  const ok = V.validarUsuarioAdmin({
    nombre: ' Damián ', apellidoPaterno: 'García', apellidoMaterno: '', telefono: '844 602 7156',
    correo: 'd@x.com', idGenero: '1', idRol: '2', estado: 'Activo', contrasena: 'Abcdefg1', confirmar: 'Abcdefg1'
  }, { nuevo: true });
  assert.equal(ok.ok, true, JSON.stringify(ok.errores));
  assert.equal(ok.datos.nombre, 'Damián');
  assert.equal(ok.datos.telefono, '8446027156');
  assert.equal(ok.datos.apellidoMaterno, null);

  const mal = V.validarUsuarioAdmin({
    nombre: '<script>', apellidoPaterno: 'G', telefono: '123', correo: 'x', idGenero: 'a', idRol: 0,
    estado: 'Jefe', contrasena: 'solo-letras', confirmar: 'otra'
  }, { nuevo: true });
  for (const campo of ['nombre', 'apellidoPaterno', 'telefono', 'correo', 'idGenero', 'idRol', 'estado', 'contrasena']) {
    assert.ok(mal.errores[campo], `falta error en ${campo}`);
  }

  assert.ok(V.validarRol({ rol: 'Ad', nivel: 'Administrador' }).errores.rol);
  assert.ok(V.validarRol({ rol: 'Cajero', nivel: 'SuperAdmin' }).errores.nivel);
  assert.equal(V.validarRol({ rol: 'Coordinador de Árbitros', nivel: 'Usuario' }).ok, true);

  const cambio = V.validarCambioContrasena({ actual: 'Abc12345', nueva: 'Abc12345', confirmar: 'Abc12345', codigo: '123456' });
  assert.ok(cambio.errores.nueva);
  assert.ok(V.validarCodigo({ codigo: '12a456' }).errores.codigo);
  assert.equal(V.validarCodigo({ codigo: ' 123 456 ' }).datos.codigo, '123456');
});

test('Validación de canchas', () => {
  const ok = V.validarCancha({ nombre: '  Cancha   Azul ', idTipo: '1', estado: 'Activa' });
  assert.equal(ok.ok, true);
  assert.equal(ok.datos.nombre, 'Cancha Azul');
  const mal = V.validarCancha({ nombre: '<script>', idTipo: 'x', estado: 'Rota' });
  assert.ok(mal.errores.nombre && mal.errores.idTipo && mal.errores.estado);
  assert.ok(V.validarCancha({ nombre: 'Una cancha con nombre largo', idTipo: 1, estado: 'Activa' }).errores.nombre);
});

test('Validación de reservas: fechas, horarios y pago', () => {
  const ahora = new Date(2026, 10, 11, 11, 5); // 11 nov 2026, 11:05
  const base = { idUsuario: '2', idCancha: '1', fecha: '2026-11-11', horario: '12:00-13:00' };
  const ok = V.validarReserva({ ...base, monto: '850', idMetodoPago: '2' }, { ahora });
  assert.equal(ok.ok, true, JSON.stringify(ok.errores));
  assert.deepEqual(ok.datos.pago, { monto: 850, idMetodoPago: 2 });
  assert.equal(V.validarReserva(base, { ahora }).datos.pago, null, 'sin monto no hay pago');

  assert.ok(V.validarReserva({ ...base, horario: '10:00-11:00' }, { ahora }).errores.horario, 'horario que ya pasó');
  assert.ok(V.validarReserva({ ...base, fecha: '2026-11-10' }, { ahora }).errores.fecha, 'fecha pasada');
  assert.ok(V.validarReserva({ ...base, fecha: '2026-02-30' }, { ahora }).errores.fecha, 'fecha inexistente');
  assert.ok(V.validarReserva({ ...base, fecha: '2027-12-01' }, { ahora }).errores.fecha, 'más de un año');
  assert.ok(V.validarReserva({ ...base, horario: '06:00-07:00', fecha: '2026-11-12' }, { ahora }).errores.horario, 'antes de abrir');
  assert.ok(V.validarReserva({ ...base, horaInicio: '15:00', horaFin: '19:00', horario: undefined }, { ahora }).errores.horario, 'más de 3 h');
  assert.ok(V.validarReserva({ ...base, monto: '-5' }, { ahora }).errores.monto);
  assert.ok(V.validarReserva({ ...base, monto: '200000', idMetodoPago: '1' }, { ahora }).errores.monto);
  assert.ok(V.validarReserva({ ...base, monto: '100', idMetodoPago: '' }, { ahora }).errores.idMetodoPago);
  assert.ok(V.validarReserva({ ...base, descripcion: 'x'.repeat(300) }, { ahora }).errores.descripcion);
  assert.equal(V.horarios().length, 16);

  assert.ok(V.validarPago({ monto: '', idMetodoPago: '1' }).errores.monto, 'el pago de una reserva existente exige monto');
  assert.equal(V.validarPago({ monto: '1,200.50', idMetodoPago: '1' }).datos.monto, 1200.5);
});
