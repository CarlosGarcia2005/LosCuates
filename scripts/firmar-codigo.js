#!/usr/bin/env node
// =====================================================================
//  npm run firmar-codigo   [OWASP A08]
//  Calcula la huella SHA-256 de cada archivo del sistema y la guarda,
//  firmada, en integridad.json. Ejecútalo después de instalar o de
//  cambiar el código A PROPÓSITO. Si alguien más cambia un archivo,
//  el servidor lo detecta al arrancar y en Panel → Seguridad OWASP.
// =====================================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { generarManifiesto } = require('../src/seguridad/integridad-codigo');

try {
  const m = generarManifiesto();
  console.log(`✔ Código firmado: ${m.total} archivos registrados en integridad.json`);
  console.log('  Si alguien modifica uno de esos archivos, el servidor lo avisará (OWASP A08).');
} catch (err) {
  console.error(`✘ No se pudo firmar el código: ${err.message}`);
  process.exit(1);
}
