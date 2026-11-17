/* =====================================================================
   Reglas de validación compartidas
   Las usa el navegador (formularios) y también el servidor (Node),
   así las dos validaciones son exactamente iguales.
   ===================================================================== */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Validacion = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LETRAS = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]+$/;
  const NOMBRE_ROL = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .-]+$/;
  const CORREO = /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/;
  const TELEFONO = /^\d{10}$/;
  const CODIGO = /^\d{6}$/;

  const NIVELES = ['Administrador', 'Usuario'];
  const ESTADOS = ['Activo', 'Inactivo'];

  const texto = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

  function nombrePropio(valor, campo, min, max, obligatorio, errores) {
    const v = texto(valor);
    if (!v) {
      if (obligatorio) errores[campo] = 'Este campo es obligatorio.';
      return v || null;
    }
    if (v.length < min || v.length > max) errores[campo] = `Debe tener entre ${min} y ${max} caracteres.`;
    else if (!LETRAS.test(v)) errores[campo] = 'Solo se permiten letras y espacios.';
    return v;
  }

  function correo(valor, errores, campo = 'correo') {
    const v = texto(valor).toLowerCase();
    if (!v) errores[campo] = 'El correo es obligatorio.';
    else if (v.length > 50) errores[campo] = 'Máximo 50 caracteres.';
    else if (!CORREO.test(v)) errores[campo] = 'Escribe un correo válido, por ejemplo nombre@correo.com.';
    return v;
  }

  function contrasena(valor, errores, campo = 'contrasena') {
    const v = typeof valor === 'string' ? valor : '';
    if (!v) errores[campo] = 'La contraseña es obligatoria.';
    else if (v.length < 8) errores[campo] = 'Debe tener al menos 8 caracteres.';
    else if (v.length > 72) errores[campo] = 'Máximo 72 caracteres.';
    else if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(v) || !/\d/.test(v)) errores[campo] = 'Debe incluir letras y números.';
    return v;
  }

  function telefono(valor, errores) {
    const v = texto(String(valor ?? '')).replace(/[\s-]/g, '');
    if (!v) return null;
    if (!TELEFONO.test(v)) errores.telefono = 'El teléfono debe tener exactamente 10 dígitos.';
    return v;
  }

  function entero(valor, campo, errores, max = 255) {
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      errores[campo] = 'Selecciona una opción válida.';
      return null;
    }
    return n;
  }

  function codigoMfa(valor, errores, campo = 'codigo') {
    const v = texto(String(valor ?? '')).replace(/\s/g, '');
    if (!CODIGO.test(v)) errores[campo] = 'El código debe tener 6 dígitos.';
    return v;
  }

  const resultado = (errores, datos) => ({ ok: Object.keys(errores).length === 0, errores, datos });

  /* ------------------------------------------------------------------ */

  function validarLogin(d = {}) {
    const e = {};
    const datos = { correo: correo(d.correo, e), contrasena: typeof d.contrasena === 'string' ? d.contrasena : '' };
    if (!datos.contrasena) e.contrasena = 'La contraseña es obligatoria.';
    return resultado(e, datos);
  }

  function validarCodigo(d = {}) {
    const e = {};
    return resultado(e, { codigo: codigoMfa(d.codigo, e) });
  }

  function validarDatosPersonales(d = {}, e = {}) {
    return {
      nombre: nombrePropio(d.nombre, 'nombre', 2, 45, true, e),
      apellidoPaterno: nombrePropio(d.apellidoPaterno, 'apellidoPaterno', 2, 20, true, e),
      apellidoMaterno: nombrePropio(d.apellidoMaterno, 'apellidoMaterno', 2, 20, false, e),
      telefono: telefono(d.telefono, e),
      correo: correo(d.correo, e),
      idGenero: entero(d.idGenero, 'idGenero', e)
    };
  }

  /** Perfil: datos personales + código MFA para confirmar. */
  function validarPerfil(d = {}) {
    const e = {};
    const datos = validarDatosPersonales(d, e);
    datos.codigo = codigoMfa(d.codigo, e);
    return resultado(e, datos);
  }

  /** Administrador creando (nuevo = true) o editando un usuario. */
  function validarUsuarioAdmin(d = {}, { nuevo = false } = {}) {
    const e = {};
    const datos = validarDatosPersonales(d, e);
    datos.idRol = entero(d.idRol, 'idRol', e);
    datos.estado = ESTADOS.includes(d.estado) ? d.estado : (e.estado = 'Estado no válido.', null);
    if (nuevo) {
      datos.contrasena = contrasena(d.contrasena, e);
      if (datos.contrasena && d.confirmar !== undefined && d.confirmar !== datos.contrasena)
        e.confirmar = 'Las contraseñas no coinciden.';
    }
    return resultado(e, datos);
  }

  function validarRol(d = {}) {
    const e = {};
    const rol = texto(d.rol);
    if (!rol) e.rol = 'El nombre del rol es obligatorio.';
    else if (rol.length < 3 || rol.length > 30) e.rol = 'Debe tener entre 3 y 30 caracteres.';
    else if (!NOMBRE_ROL.test(rol)) e.rol = 'Solo letras, números y espacios.';
    const nivel = NIVELES.includes(d.nivel) ? d.nivel : (e.nivel = 'Nivel de acceso no válido.', null);
    return resultado(e, { rol, nivel });
  }

  function validarNuevaContrasena(d = {}) {
    const e = {};
    const datos = { nueva: contrasena(d.nueva, e, 'nueva') };
    if (!e.nueva && d.confirmar !== d.nueva) e.confirmar = 'Las contraseñas no coinciden.';
    return resultado(e, datos);
  }

  function validarCambioContrasena(d = {}) {
    const e = {};
    const actual = typeof d.actual === 'string' ? d.actual : '';
    if (!actual) e.actual = 'Escribe tu contraseña actual.';
    const nueva = contrasena(d.nueva, e, 'nueva');
    if (!e.nueva && d.confirmar !== nueva) e.confirmar = 'Las contraseñas no coinciden.';
    if (!e.nueva && actual && actual === nueva) e.nueva = 'La nueva contraseña debe ser distinta a la actual.';
    const codigo = codigoMfa(d.codigo, e);
    return resultado(e, { actual, nueva, codigo });
  }


  /* ---------------- Canchas y reservas ---------------- */
  const ESTADOS_CANCHA = ['Activa', 'Inactiva'];
  const NOMBRE_CANCHA = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .#-]+$/;
  const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
  const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const HORA_APERTURA = '07:00';
  const HORA_CIERRE = '23:00';
  const MONTO = /^\d{1,6}(\.\d{1,2})?$/;

  const aMinutos = (h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
  const dosDigitos = (n) => String(n).padStart(2, '0');
  const fechaLocal = (f = new Date()) => `${f.getFullYear()}-${dosDigitos(f.getMonth() + 1)}-${dosDigitos(f.getDate())}`;

  function fechaReal(v) {
    if (!FECHA_ISO.test(v)) return false;
    const [a, m, d] = v.split('-').map(Number);
    const f = new Date(a, m - 1, d);
    return f.getFullYear() === a && f.getMonth() === m - 1 && f.getDate() === d;
  }

  /** Horarios de una hora entre la apertura y el cierre: [{inicio, fin}] */
  function horarios() {
    const lista = [];
    for (let m = aMinutos(HORA_APERTURA); m + 60 <= aMinutos(HORA_CIERRE); m += 60) {
      lista.push({ inicio: `${dosDigitos(m / 60)}:00`, fin: `${dosDigitos(m / 60 + 1)}:00` });
    }
    return lista;
  }

  function validarCancha(d = {}) {
    const e = {};
    const nombre = texto(d.nombre);
    if (!nombre) e.nombre = 'El nombre de la cancha es obligatorio.';
    else if (nombre.length < 3 || nombre.length > 20) e.nombre = 'Debe tener entre 3 y 20 caracteres.';
    else if (!NOMBRE_CANCHA.test(nombre)) e.nombre = 'Solo letras, números, espacios y los signos . # -';
    const idTipo = entero(d.idTipo, 'idTipo', e);
    const estado = ESTADOS_CANCHA.includes(d.estado) ? d.estado : (e.estado = 'Elige si la cancha está activa o inactiva.', null);
    return resultado(e, { nombre, idTipo, estado });
  }

  function descripcionLibre(valor, e) {
    const v = texto(String(valor ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));
    if (v.length > 255) e.descripcion = 'Máximo 255 caracteres.';
    return v || null;
  }

  /** Monto y método. Si obligatorio = false y no hay monto, no hay pago. */
  function datosPago(d, e, obligatorio) {
    const crudo = String(d.monto ?? '').replace(/[\s,$]/g, '');
    if (!crudo) {
      if (obligatorio) e.monto = 'Escribe el monto del pago.';
      return null;
    }
    if (!MONTO.test(crudo)) { e.monto = 'Monto no válido (máximo 2 decimales).'; return null; }
    const monto = Number(crudo);
    if (monto <= 0) e.monto = 'El monto debe ser mayor a cero.';
    else if (monto > 100000) e.monto = 'El monto no puede ser mayor a $100,000.';
    const idMetodoPago = entero(d.idMetodoPago, 'idMetodoPago', e);
    if (e.idMetodoPago) e.idMetodoPago = 'Elige el método de pago.';
    return { monto, idMetodoPago };
  }

  /**
   * Reserva nueva. Acepta d.horario = "09:00-10:00" o d.horaInicio / d.horaFin.
   * @param {Date} ahora  para revisar que la fecha y la hora no hayan pasado
   */
  function validarReserva(d = {}, { ahora = new Date() } = {}) {
    const e = {};
    const datos = {};
    datos.idUsuario = entero(d.idUsuario, 'idUsuario', e, 4294967295);
    if (e.idUsuario) e.idUsuario = 'Elige al cliente.';
    datos.idEquipo = d.idEquipo === '' || d.idEquipo === null || d.idEquipo === undefined
      ? null : entero(d.idEquipo, 'idEquipo', e, 4294967295);
    datos.idCancha = entero(d.idCancha, 'idCancha', e);
    if (e.idCancha) e.idCancha = 'Elige la cancha.';

    const fecha = texto(d.fecha);
    const hoy = fechaLocal(ahora);
    const limite = fechaLocal(new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 365));
    if (!fechaReal(fecha)) e.fecha = 'Elige una fecha válida.';
    else if (fecha < hoy) e.fecha = 'La fecha ya pasó.';
    else if (fecha > limite) e.fecha = 'Solo se puede reservar con un año de anticipación como máximo.';
    datos.fecha = fecha;

    let inicio = texto(d.horaInicio), fin = texto(d.horaFin);
    if (d.horario) [inicio, fin] = String(d.horario).split('-').map((x) => x.trim());
    if (!HORA.test(inicio || '') || !HORA.test(fin || '')) e.horario = 'Elige un horario.';
    else if (aMinutos(fin) <= aMinutos(inicio)) e.horario = 'La hora de fin debe ser mayor que la de inicio.';
    else if (aMinutos(inicio) < aMinutos(HORA_APERTURA) || aMinutos(fin) > aMinutos(HORA_CIERRE))
      e.horario = `El horario debe estar entre ${HORA_APERTURA} y ${HORA_CIERRE}.`;
    else if (aMinutos(fin) - aMinutos(inicio) > 180) e.horario = 'Una reserva puede durar máximo 3 horas.';
    else if (fecha === hoy && aMinutos(inicio) <= ahora.getHours() * 60 + ahora.getMinutes())
      e.horario = 'Ese horario ya pasó.';
    datos.horaInicio = inicio;
    datos.horaFin = fin;

    datos.descripcion = descripcionLibre(d.descripcion, e);
    datos.pago = datosPago(d, e, false);
    return resultado(e, datos);
  }

  /** Pago de una reserva que ya existe. */
  function validarPago(d = {}) {
    const e = {};
    const pago = datosPago(d, e, true);
    return resultado(e, { ...(pago || {}), descripcion: descripcionLibre(d.descripcion, e) });
  }

  return {
    NIVELES, ESTADOS,
    validarLogin, validarCodigo, validarPerfil, validarUsuarioAdmin,
    validarRol, validarNuevaContrasena, validarCambioContrasena,
    ESTADOS_CANCHA, HORA_APERTURA, HORA_CIERRE, horarios, fechaLocal,
    validarCancha, validarReserva, validarPago
  };
});
