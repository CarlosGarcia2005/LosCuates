// =====================================================================
//  Carpeta donde el servidor guarda sus archivos de trabajo
//  (respaldo diario de la bitácora y resultado de "npm audit").
//  En Vercel el disco del proyecto es de solo lectura: ahí se usa la
//  carpeta temporal del sistema (se vacía cuando Vercel reinicia la función).
// =====================================================================
const os = require('os');
const path = require('path');

const CARPETA_ALMACEN = process.env.VERCEL
  ? path.join(os.tmpdir(), 'almacen')
  : path.join(__dirname, '..', 'almacen');

module.exports = { CARPETA_ALMACEN };
