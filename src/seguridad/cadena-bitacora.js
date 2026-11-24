// =====================================================================
//  [OWASP A09] Bitácora a prueba de alteraciones (cadena de firmas)
//  Cada registro guarda:  firma = HMAC( firma_del_anterior | datos )
//  - Si alguien cambia un registro en SQL Server, su firma ya no coincide.
//  - Si alguien borra un registro, el siguiente ya no "encadena".
//  - Si alguien inserta un registro falso, no puede firmarlo: la llave
//    sale de MFA_CLAVE (.env), que no está en la base de datos.
// =====================================================================
const { firmar, iguales } = require('./llaves');

const GENESIS = '0'.repeat(64);

// Columnas firmadas, en este orden exacto
const CAMPOS = ['Fecha', 'idUsuario', 'Correo_Usuario', 'Rol_Usuario', 'Accion', 'Modulo', 'Tabla_Afectada',
  'idRegistro', 'Descripcion', 'Datos_Anteriores', 'Datos_Nuevos', 'IP', 'Navegador', 'Resultado', 'Origen'];

/** Texto canónico de una fila: mismo resultado al guardar y al leer de SQL Server. */
const canonico = (fila) => JSON.stringify(CAMPOS.map((c) => (fila[c] === null || fila[c] === undefined ? null : String(fila[c]))));

const firmaDe = (anterior, fila) => firmar('bitacora', `${anterior}\n${canonico(fila)}`);

/**
 * Revisa la cadena completa.
 * @param {Iterable<object>} filas  en orden de idBitacora, con las columnas de CAMPOS, idBitacora y Hash_Integridad
 * @param {{Ultimo_Hash:string, Total:number}} estado  fila de Bitacora_Cadena
 * @param {Set<string>} revisados  claves de problemas que un administrador ya marcó como revisados
 */
function verificarCadena(filas, estado, revisados = new Set()) {
  const problemas = [];
  const agregar = (tipo, id, detalle) => {
    const clave = `${tipo}:${id}`;
    problemas.push({ tipo, id, clave, detalle, revisado: revisados.has(clave) });
  };

  let inicio = null;           // primer registro firmado
  let anteriorGuardado = GENESIS;
  let ultimoValido = GENESIS;
  let firmados = 0;
  let sinFirmaBD = 0;
  let ultimoId = null;

  for (const fila of filas) {
    const id = Number(fila.idBitacora);
    const hash = fila.Hash_Integridad;
    if (!hash) {
      if (inicio !== null) {
        if (fila.Origen === 'Aplicación') {
          agregar('sin_firma', id, `El registro #${id} dice venir de la aplicación pero no tiene firma: lo insertaron directamente en SQL Server.`);
        } else {
          sinFirmaBD += 1;   // cambios directos registrados por los triggers de auditoría: es normal
        }
      }
      continue;
    }
    if (inicio === null) inicio = id;
    firmados += 1;
    ultimoId = id;

    if (iguales(hash, firmaDe(anteriorGuardado, fila)) || iguales(hash, firmaDe(ultimoValido, fila))) {
      ultimoValido = hash;
    } else {
      agregar('alterado', id, `El registro #${id} no coincide con su firma: fue modificado, o se borró un registro justo antes.`);
    }
    anteriorGuardado = hash;
  }

  if (estado) {
    const total = Number(estado.Total) || 0;
    if (firmados < total) {
      agregar('faltan', total - firmados, `Faltan ${total - firmados} registro(s) firmados: la bitácora tenía ${total} y ahora hay ${firmados}.`);
    } else if (!iguales(estado.Ultimo_Hash, anteriorGuardado) && total > 0) {
      agregar('final', Number(estado.Ultimo_id) || total, 'El último registro firmado no es el que la aplicación guardó por última vez (borraron o cambiaron los más recientes).');
    }
  }

  const pendientes = problemas.filter((p) => !p.revisado);
  return { ok: pendientes.length === 0, inicio, firmados, sinFirmaBD, ultimoId, problemas, pendientes: pendientes.length };
}

module.exports = { GENESIS, CAMPOS, canonico, firmaDe, verificarCadena };
