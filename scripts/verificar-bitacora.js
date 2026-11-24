#!/usr/bin/env node
// =====================================================================
//  npm run verificar-bitacora   [OWASP A09]
//  Revisa la cadena de firmas de la bitácora directamente en SQL Server y
//  dice si algún registro fue modificado, borrado o insertado a mano.
// =====================================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../config/db');
const { verificarIntegridad } = require('../src/bitacora');

(async () => {
  try {
    const r = await verificarIntegridad();
    console.log(`\nRegistros firmados: ${r.firmados} (desde el #${r.inicio ?? '—'} hasta el #${r.ultimoId ?? '—'})`);
    console.log(`Cambios directos en SQL Server registrados por los triggers: ${r.sinFirmaBD}`);
    if (!r.problemas.length) {
      console.log('\n✔ La bitácora está íntegra: ningún registro fue modificado, borrado ni insertado a mano.\n');
    } else {
      console.log('');
      for (const p of r.problemas) console.log(`${p.revisado ? '• REVISADO' : '✘ ALTERADO'}  ${p.detalle}`);
      console.log(r.pendientes ? `\n✘ ${r.pendientes} alteración(es) sin revisar.\n` : '\n✔ Todas las alteraciones ya fueron revisadas.\n');
      process.exitCode = r.pendientes ? 2 : 0;
    }
  } catch (err) {
    console.error(`✘ No se pudo revisar la bitácora: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.close().catch(() => {});
  }
})();
