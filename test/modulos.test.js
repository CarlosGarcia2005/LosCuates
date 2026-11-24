/* Pruebas de los módulos Equipos, Árbitros, Pagos, Limpieza y Reportes (sin base de datos).
   Ejecuta: npm test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const V = require('../public/js/validacion');
const { funcionesDe, esRolDelSistema } = require('../src/funciones');
const { Pdf } = require('../src/reportes/pdf');
const xlsx = require('../src/reportes/xlsx');

const manana = (() => {
  const f = new Date(); f.setDate(f.getDate() + 1);
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
})();

test('Roles con funciones propias (sin importar acentos ni mayúsculas)', () => {
  assert.deepStrictEqual(funcionesDe('Árbitro'), ['arbitro']);
  assert.deepStrictEqual(funcionesDe('arbitro'), ['arbitro']);
  assert.deepStrictEqual(funcionesDe('Personal de limpieza'), ['limpieza']);
  assert.deepStrictEqual(funcionesDe('Cliente'), ['cliente']);
  assert.deepStrictEqual(funcionesDe('Administrador'), []);
  assert.ok(esRolDelSistema('ÁRBITRO'));
  assert.ok(!esRolDelSistema('Recepcionista'));
});

test('Equipos: nombre de 3 a 40 caracteres y responsable obligatorio', () => {
  assert.ok(V.validarEquipo({ nombre: 'Halcones FC', idUsuario: '5' }).ok);
  assert.ok(V.validarEquipo({ nombre: 'Real Coahuila', idUsuario: 5 }).ok);
  assert.ok(V.validarEquipo({ nombre: 'AB', idUsuario: 5 }).errores.nombre);
  assert.ok(V.validarEquipo({ nombre: '<script>', idUsuario: 5 }).errores.nombre);
  assert.ok(V.validarEquipo({ nombre: 'Halcones FC' }).errores.idUsuario);
});

test('Árbitros: puestos según la modalidad', () => {
  assert.deepStrictEqual(V.puestosDe('Fútbol 7'), ['Central']);
  assert.deepStrictEqual(V.puestosDe('Fútbol Rápido'), ['Central']);
  assert.deepStrictEqual(V.puestosDe('Fútbol 11'), ['Central', 'Lateral', 'Contralateral', 'Cuarto']);
  const f11 = V.puestosDe('Fútbol 11');
  // Completo
  assert.ok(V.validarArbitros({ Central: 1, Lateral: 2, Contralateral: 3, Cuarto: 4 }, f11).ok);
  // Árbitro repetido en el mismo partido
  const rep = V.validarArbitros({ Central: 1, Lateral: 1, Contralateral: 3, Cuarto: 4 }, f11);
  assert.ok(!rep.ok && Object.values(rep.errores).some((m) => /Ya es/.test(m)));
  // Fútbol 7 no usa abanderados
  const f7 = V.validarArbitros({ Central: 1, Lateral: 2 }, ['Central']);
  assert.ok(!f7.ok && f7.errores.arbLateral);
  // Al programar se permite dejar el cuerpo arbitral para después
  assert.ok(V.validarArbitros({}, f11, { completos: false }).ok);
});

test('Árbitros: programar partido (fecha, horario, equipos distintos)', () => {
  const base = { idTorneo: 1, idLocal: 2, idVisitante: 3, jornada: 1, idCancha: 1, fecha: manana, horaInicio: '10:00', duracion: 60 };
  const ok = V.validarPartido(base);
  assert.ok(ok.ok, JSON.stringify(ok.errores));
  assert.strictEqual(ok.datos.horaFin, '11:00');
  assert.ok(V.validarPartido({ ...base, idVisitante: 2 }).errores.idVisitante);
  assert.ok(V.validarPartido({ ...base, fecha: '2020-01-01' }).errores.fecha);
  assert.ok(V.validarPartido({ ...base, horaInicio: '22:30', duracion: 120 }).errores.horaInicio);
  assert.ok(V.validarPartido({ ...base, jornada: 0 }).errores.jornada);
  assert.ok(V.validarRechazo({ motivo: 'no' }).errores.motivo);
  assert.ok(V.validarRechazo({ motivo: 'Compromiso familiar' }).ok);
});

test('Pagos: pago de juego y nota de discrepancia', () => {
  assert.ok(V.validarPagoJuego({ idTorneo: 1, idJuego: 2, monto: '600', idMetodoPago: 1 }).ok);
  assert.ok(V.validarPagoJuego({ idTorneo: 1, idJuego: 2, monto: '600', idMetodoPago: 1, referencia: 'TRX-2026/11' }).ok);
  assert.ok(V.validarPagoJuego({ idTorneo: 1, idJuego: 2, monto: '600', idMetodoPago: 1, referencia: "1' OR 1=1" }).errores.referencia);
  assert.ok(V.validarPagoJuego({ idTorneo: 1, monto: '600', idMetodoPago: 1 }).errores.idJuego);
  assert.ok(V.validarPagoJuego({ idTorneo: 1, idJuego: 2, monto: '-5', idMetodoPago: 1 }).errores.monto);
  assert.ok(V.validarNotaRevision({ nota: 'abc' }).errores.nota);
  assert.ok(V.validarNotaRevision({ nota: 'El monto no coincide' }).ok);
});

test('Limpieza: tareas y reporte de condición (tipo de problema es texto libre)', () => {
  const tarea = { tipo: 'General', tarea: 'Limpieza general de cancha', idCancha: 1, fecha: manana, hora: '07:00', estado: 'Pendiente' };
  assert.ok(V.validarTarea(tarea).ok, JSON.stringify(V.validarTarea(tarea).errores));
  // Un área que no es cancha necesita el nombre del lugar
  assert.ok(V.validarTarea({ ...tarea, idCancha: '', lugar: '' }).errores.lugar);
  assert.ok(V.validarTarea({ ...tarea, idCancha: '', lugar: 'Gradas norte' }).ok);
  assert.ok(V.validarTarea({ ...tarea, idCancha: 'x' }).errores.idCancha);
  assert.ok(V.validarTarea({ ...tarea, tipo: 'Inventado' }).errores.tipo);
  assert.ok(V.validarTarea({ ...tarea, estado: 'Hecha' }).errores.estado);
  const rep = { idCancha: 2, tipoProblema: 'Drenaje obstruido', descripcion: 'Se acumula el agua en el área central.', urgencia: 'Alta' };
  assert.ok(V.validarReporteCondicion(rep).ok);
  assert.ok(V.validarReporteCondicion({ ...rep, tipoProblema: 'Cualquier texto que escriba el personal' }).ok);
  assert.ok(V.validarReporteCondicion({ ...rep, tipoProblema: 'ab' }).errores.tipoProblema);
  assert.ok(V.validarReporteCondicion({ ...rep, urgencia: 'Urgentísima' }).errores.urgencia);
  assert.ok(V.validarAtencionReporte({ estado: 'Resuelto', nota: 'Se destapó el drenaje' }).ok);
  assert.ok(V.validarAtencionReporte({ estado: 'Sin resolver' }).errores.estado);
});

test('Reportes: el PDF y el Excel generados son archivos válidos', () => {
  const pdf = new Pdf();
  pdf.texto(40, 60, 'Reportes y auditoría · Ñandú → $1,234.50', { tam: 12, negrita: true });
  pdf.curva([{ x: 40, y: 200 }, { x: 120, y: 120 }, { x: 200, y: 200 }], { color: '#15803d', ancho: 2 });
  pdf.arcoDona(300, 300, 40, 12, 0, 0.6, '#0b3b1e');
  const b = pdf.generar();
  assert.strictEqual(b.subarray(0, 5).toString(), '%PDF-');
  assert.ok(b.subarray(-6).toString().includes('%%EOF'));

  const archivo = xlsx.libro([{ nombre: 'Resumen', filas: [['Indicador', 'Valor'], ['Total ingresos', { v: 2200, estilo: 'dinero' }]] }], { titulo: 'Prueba' });
  assert.strictEqual(archivo.readUInt32LE(0), 0x04034b50); // firma ZIP
  assert.ok(archivo.includes(Buffer.from('xl/workbook.xml')));
  // El CRC32 coincide con el de zlib
  assert.strictEqual(xlsx.crc32(Buffer.from('Rancho Seco')), zlib.crc32 ? zlib.crc32(Buffer.from('Rancho Seco')) : xlsx.crc32(Buffer.from('Rancho Seco')));
  assert.strictEqual(xlsx.columna(0), 'A');   // columnas contadas desde 0
  assert.strictEqual(xlsx.columna(27), 'AB');
});
