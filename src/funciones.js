// =====================================================================
//  Funciones especiales de algunos roles
//  Los módulos nuevos reconocen tres roles por su nombre:
//    "Cliente"              → puede ser responsable de un equipo
//    "Árbitro"              → recibe partidos y los confirma o rechaza
//    "Personal de limpieza" → tareas y reportes de condición de canchas
//  El nombre se compara sin acentos ni mayúsculas ("Arbitro" = "Árbitro").
// =====================================================================

const sinAcentos = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const ROLES_DEL_SISTEMA = {
  cliente: 'Cliente',
  arbitro: 'Árbitro',
  'personal de limpieza': 'Personal de limpieza'
};

/** ['arbitro'] | ['limpieza'] | ['cliente'] | [] */
function funcionesDe(rol) {
  const r = sinAcentos(rol);
  const f = [];
  if (r === 'arbitro') f.push('arbitro');
  if (r === 'personal de limpieza') f.push('limpieza');
  if (r === 'cliente') f.push('cliente');
  return f;
}

/** ¿El rol lo usa el sistema? (no se puede renombrar) */
const esRolDelSistema = (rol) => Object.prototype.hasOwnProperty.call(ROLES_DEL_SISTEMA, sinAcentos(rol)) || sinAcentos(rol) === 'administrador';

/** Condición SQL para los usuarios de un rol especial (r = alias de Rol). */
const SQL_ROL = {
  cliente: "r.Rol IN ('Cliente')",
  arbitro: "r.Rol IN ('Árbitro', 'Arbitro')",
  limpieza: "r.Rol IN ('Personal de limpieza')"
};

module.exports = { funcionesDe, esRolDelSistema, sinAcentos, ROLES_DEL_SISTEMA, SQL_ROL };
