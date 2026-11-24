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

  // [OWASP A02/A07] Contraseñas demasiado comunes: son lo primero que prueba un atacante
  const COMUNES = ['12345678', '123456789', '1234567890', '12345678a', 'a1234567', 'abc12345', 'abcd1234', 'qwerty123',
    'password1', 'password123', 'contrasena1', 'contraseña1', 'admin123', 'admin1234', 'iloveyou1', 'welcome1',
    '11111111a', 'futbol123', 'rancho123', 'ranchoseco1', 'mexico123', 'saltillo1', 'usuario1', 'qwertyui1'];

  function contrasena(valor, errores, campo = 'contrasena') {
    const v = typeof valor === 'string' ? valor : '';
    if (!v) errores[campo] = 'La contraseña es obligatoria.';
    else if (v.length < 8) errores[campo] = 'Debe tener al menos 8 caracteres.';
    else if (v.length > 72) errores[campo] = 'Máximo 72 caracteres.';
    else if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(v) || !/\d/.test(v)) errores[campo] = 'Debe incluir letras y números.';
    else if (COMUNES.includes(v.toLowerCase())) errores[campo] = 'Esa contraseña es demasiado común. Elige otra.';
    else if (/^(.)\1+$/.test(v) || /(.)\1{5,}/.test(v)) errores[campo] = 'No uses el mismo carácter repetido tantas veces.';
    return v;
  }

  /** Teléfono: solo números (sin espacios, guiones ni letras) y exactamente 10 dígitos. */
  function telefono(valor, errores) {
    const v = texto(String(valor ?? ''));
    if (!v) return null;
    if (!/^\d+$/.test(v)) errores.telefono = 'Solo se permiten números (sin espacios, guiones ni letras).';
    else if (!TELEFONO.test(v)) errores.telefono = 'El teléfono debe tener exactamente 10 dígitos.';
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

  /**
   * Enlace de un comprobante (formato básico). Las reglas anti-SSRF
   * (solo https, sin direcciones internas...) las aplica el SERVIDOR:
   * así un intento de SSRF siempre llega a él y queda registrado.
   */
  function validarEnlace(d = {}) {
    const e = {};
    const url = texto(d.url);
    if (!url) e.url = 'Pega el enlace del comprobante.';
    else if (url.length > 500) e.url = 'El enlace es demasiado largo (máximo 500 caracteres).';
    else if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(url)) e.url = 'Escribe un enlace completo, por ejemplo https://sitio.com/comprobante.png';
    return resultado(e, { url });
  }

  /* ---------------- Módulos deportivos ---------------- */
  const NOMBRE_EQUIPO = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .'&-]+$/;
  const NOMBRE_TORNEO = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .,'#&()-]+$/;
  const REFERENCIA = /^[A-Za-z0-9 #./_-]+$/;
  const PUESTOS = ['Central', 'Lateral', 'Contralateral', 'Cuarto'];
  const NOMBRES_PUESTO = {
    Central: 'Árbitro Central', Lateral: 'Asistente Abanderado Lateral',
    Contralateral: 'Asistente Abanderado Contralateral', Cuarto: 'Cuarto Árbitro'
  };
  /** "Fútbol 11" usa 4 árbitros; "Fútbol 7" (y fútbol rápido) solo el central. */
  const esFutbol11 = (tipo) => /11/.test(String(tipo || ''));
  const puestosDe = (tipo) => (esFutbol11(tipo) ? PUESTOS.slice() : ['Central']);
  const DURACIONES = [60, 90, 120];
  const ESTADOS_PAGO = ['Pagado', 'Pendiente', 'Validado', 'Con discrepancia'];
  const TIPOS_TAREA = {
    General: 'Limpieza general', Basura: 'Recolección de basura', Barrido: 'Barrido y retiro de hojas',
    Gradas: 'Limpieza de gradas', Riego: 'Riego de cancha', Otro: 'Otra tarea'
  };
  const ESTADOS_TAREA = ['Pendiente', 'En progreso', 'Completada'];
  const URGENCIAS = ['Baja', 'Media', 'Alta'];
  const ESTADOS_REPORTE = ['Sin resolver', 'En proceso', 'Resuelto'];

  const vacio = (v) => v === undefined || v === null || v === '';
  const LIMPIAR_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

  /** Texto libre: sin caracteres de control, espacios normalizados y con límites. */
  function textoLibre(valor, campo, e, { min = 0, max = 255, obligatorio = false, etiqueta = 'Este campo' } = {}) {
    const v = texto(String(valor ?? '').replace(LIMPIAR_CONTROL, ''));
    if (!v) {
      if (obligatorio) e[campo] = `${etiqueta} es obligatorio.`;
      return null;
    }
    if (v.length < min) e[campo] = `Escribe al menos ${min} caracteres.`;
    else if (v.length > max) e[campo] = `Máximo ${max} caracteres.`;
    return v;
  }

  function validarEquipo(d = {}) {
    const e = {};
    const nombre = texto(d.nombre);
    if (!nombre) e.nombre = 'El nombre del equipo es obligatorio.';
    else if (nombre.length < 3 || nombre.length > 40) e.nombre = 'Debe tener entre 3 y 40 caracteres.';
    else if (!NOMBRE_EQUIPO.test(nombre)) e.nombre = "Solo letras, números, espacios y los signos . ' & -";
    const idUsuario = entero(d.idUsuario, 'idUsuario', e, 4294967295);
    if (e.idUsuario) e.idUsuario = 'Selecciona al usuario responsable del equipo.';
    return resultado(e, { nombre, idUsuario });
  }

  function validarTorneo(d = {}) {
    const e = {};
    const nombre = texto(d.nombre);
    if (!nombre) e.nombre = 'El nombre del torneo es obligatorio.';
    else if (nombre.length < 3 || nombre.length > 50) e.nombre = 'Debe tener entre 3 y 50 caracteres.';
    else if (!NOMBRE_TORNEO.test(nombre)) e.nombre = 'Solo letras, números, espacios y signos básicos.';
    const idTipo = entero(d.idTipo, 'idTipo', e);
    if (e.idTipo) e.idTipo = 'Elige la modalidad.';
    const fechaInicio = texto(d.fechaInicio), fechaFin = texto(d.fechaFin);
    if (!fechaReal(fechaInicio)) e.fechaInicio = 'Elige una fecha válida.';
    if (!fechaReal(fechaFin)) e.fechaFin = 'Elige una fecha válida.';
    else if (!e.fechaInicio && fechaFin < fechaInicio) e.fechaFin = 'Debe ser igual o posterior a la fecha de inicio.';
    const crudo = String(d.costo ?? '').replace(/[\s,$]/g, '');
    let costo = 0;
    if (crudo !== '') {
      if (!MONTO.test(crudo)) e.costo = 'Monto no válido (máximo 2 decimales).';
      else if ((costo = Number(crudo)) > 100000) e.costo = 'El costo no puede ser mayor a $100,000.';
    }
    return resultado(e, { nombre, idTipo, fechaInicio, fechaFin, costo });
  }

  /**
   * Partido nuevo (nuevo = true) o edición de uno existente.
   * La duración es 60, 90 o 120 minutos y debe terminar antes del cierre.
   */
  function validarPartido(d = {}, { nuevo = true, ahora = new Date() } = {}) {
    const e = {};
    const datos = {};
    if (nuevo) {
      datos.idTorneo = entero(d.idTorneo, 'idTorneo', e, 4294967295);
      if (e.idTorneo) e.idTorneo = 'Elige el torneo.';
      datos.idLocal = entero(d.idLocal, 'idLocal', e, 4294967295);
      if (e.idLocal) e.idLocal = 'Elige al equipo local.';
      datos.idVisitante = entero(d.idVisitante, 'idVisitante', e, 4294967295);
      if (e.idVisitante) e.idVisitante = 'Elige al equipo visitante.';
      if (!e.idLocal && !e.idVisitante && datos.idLocal === datos.idVisitante) e.idVisitante = 'Un equipo no puede jugar contra sí mismo.';
    }
    const jornada = Number(d.jornada);
    if (!Number.isInteger(jornada) || jornada < 1 || jornada > 99) e.jornada = 'Escribe la jornada (1 a 99).';
    datos.jornada = jornada;
    datos.idCancha = entero(d.idCancha, 'idCancha', e);
    if (e.idCancha) e.idCancha = 'Elige la cancha.';

    const fecha = texto(d.fecha);
    const hoy = fechaLocal(ahora);
    if (!fechaReal(fecha)) e.fecha = 'Elige una fecha válida.';
    else if (fecha < hoy) e.fecha = 'La fecha ya pasó.';
    datos.fecha = fecha;

    const inicio = texto(d.horaInicio);
    const duracion = Number(d.duracion);
    datos.horaInicio = inicio;
    datos.duracion = duracion;
    if (!HORA.test(inicio)) e.horaInicio = 'Elige la hora de inicio.';
    else if (!DURACIONES.includes(duracion)) e.duracion = 'Elige la duración.';
    else {
      const fin = aMinutos(inicio) + duracion;
      if (aMinutos(inicio) < aMinutos(HORA_APERTURA) || fin > aMinutos(HORA_CIERRE)) {
        e.horaInicio = `El partido debe jugarse entre ${HORA_APERTURA} y ${HORA_CIERRE}.`;
      } else if (fecha === hoy && aMinutos(inicio) <= ahora.getHours() * 60 + ahora.getMinutes()) {
        e.horaInicio = 'Esa hora ya pasó.';
      }
      datos.horaFin = `${dosDigitos(Math.floor(fin / 60))}:${dosDigitos(fin % 60)}`;
    }
    return resultado(e, datos);
  }

  /**
   * Cuerpo arbitral { Central: id, Lateral: id, ... } para los puestos que pide la modalidad.
   * completos = true exige todos los puestos. Un árbitro no puede ocupar dos puestos.
   */
  function validarArbitros(valor, puestos, { completos = true } = {}) {
    const e = {};
    const datos = {};
    const obj = valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
    for (const k of Object.keys(obj)) if (!PUESTOS.includes(k)) e.arbitros = 'Puesto de árbitro no válido.';
    const usados = new Map();
    for (const p of puestos) {
      const campo = `arb${p}`;
      if (vacio(obj[p])) {
        if (completos) e[campo] = `Elige al ${NOMBRES_PUESTO[p].toLowerCase()}.`;
        datos[p] = null;
        continue;
      }
      const id = Number(obj[p]);
      if (!Number.isInteger(id) || id < 1 || id > 4294967295) { e[campo] = 'Selecciona un árbitro válido.'; continue; }
      if (usados.has(id)) e[campo] = `Ya es ${NOMBRES_PUESTO[usados.get(id)]} en este partido.`;
      usados.set(id, p);
      datos[p] = id;
    }
    for (const p of PUESTOS) if (!puestos.includes(p) && !vacio(obj[p])) e[`arb${p}`] = 'Esta modalidad no usa ese puesto.';
    return resultado(e, datos);
  }

  /** Respuesta del árbitro: para rechazar debe explicar el motivo. */
  function validarRechazo(d = {}) {
    const e = {};
    const motivo = textoLibre(d.motivo, 'motivo', e, { min: 5, max: 255, obligatorio: true, etiqueta: 'El motivo' });
    return resultado(e, { motivo });
  }

  /** Pago de un partido de torneo (Pagos → Registrar pago). */
  function validarPagoJuego(d = {}) {
    const e = {};
    const idTorneo = entero(d.idTorneo, 'idTorneo', e, 4294967295);
    if (e.idTorneo) e.idTorneo = 'Selecciona un torneo.';
    const idJuego = entero(d.idJuego, 'idJuego', e, 4294967295);
    if (e.idJuego) e.idJuego = e.idTorneo ? 'Primero selecciona un torneo.' : 'Selecciona el juego.';
    const pago = datosPago(d, e, true) || {};
    const referencia = texto(d.referencia) || null;
    if (referencia && (referencia.length > 60 || !REFERENCIA.test(referencia))) {
      e.referencia = 'Solo letras, números y los signos - / # . (máximo 60).';
    }
    return resultado(e, { idTorneo, idJuego, monto: pago.monto, idMetodoPago: pago.idMetodoPago, referencia });
  }

  /** Motivo para marcar un pago con discrepancia. */
  function validarNotaRevision(d = {}) {
    const e = {};
    const nota = textoLibre(d.nota, 'nota', e, { min: 5, max: 255, obligatorio: true, etiqueta: 'El motivo' });
    return resultado(e, { nota });
  }

  function validarTarea(d = {}) {
    const e = {};
    const tipo = Object.prototype.hasOwnProperty.call(TIPOS_TAREA, d.tipo) ? d.tipo : (e.tipo = 'Elige el tipo de tarea.', null);
    const tarea = textoLibre(d.tarea, 'tarea', e, { min: 3, max: 80, obligatorio: true, etiqueta: 'El nombre de la tarea' });
    let idCancha = null, lugar = null;
    if (!vacio(d.idCancha)) {
      idCancha = entero(d.idCancha, 'idCancha', e);
      if (e.idCancha) e.idCancha = 'Elige el lugar.';
    } else {
      lugar = textoLibre(d.lugar, 'lugar', e, { min: 3, max: 60, obligatorio: true, etiqueta: 'El lugar' });
    }
    const fecha = texto(d.fecha);
    if (!fechaReal(fecha)) e.fecha = 'Elige una fecha válida.';
    const hora = texto(d.hora);
    if (!HORA.test(hora)) e.hora = 'Elige la hora.';
    let idUsuarioAsignado = null;
    if (!vacio(d.idUsuarioAsignado)) {
      idUsuarioAsignado = entero(d.idUsuarioAsignado, 'idUsuarioAsignado', e, 4294967295);
      if (e.idUsuarioAsignado) e.idUsuarioAsignado = 'Elige a una persona válida.';
    }
    const estado = ESTADOS_TAREA.includes(d.estado) ? d.estado : (e.estado = 'Elige el estado.', null);
    const notas = textoLibre(d.notas, 'notas', e, { max: 255 });
    return resultado(e, { tipo, tarea, idCancha, lugar, fecha, hora, idUsuarioAsignado, estado, notas });
  }

  /** Reporte de condición de una cancha (el tipo de problema se escribe libremente). */
  function validarReporteCondicion(d = {}) {
    const e = {};
    const idCancha = entero(d.idCancha, 'idCancha', e);
    if (e.idCancha) e.idCancha = 'Selecciona una cancha.';
    const tipoProblema = textoLibre(d.tipoProblema, 'tipoProblema', e, { min: 3, max: 80, obligatorio: true, etiqueta: 'El tipo de problema' });
    const descripcion = textoLibre(d.descripcion, 'descripcion', e, { min: 10, max: 500, obligatorio: true, etiqueta: 'La descripción' });
    const urgencia = URGENCIAS.includes(d.urgencia) ? d.urgencia : (e.urgencia = 'Elige la urgencia.', null);
    return resultado(e, { idCancha, tipoProblema, descripcion, urgencia });
  }

  function validarAtencionReporte(d = {}) {
    const e = {};
    const estado = ['En proceso', 'Resuelto'].includes(d.estado) ? d.estado : (e.estado = 'Elige el nuevo estado.', null);
    const nota = textoLibre(d.nota, 'nota', e, { max: 255 });
    return resultado(e, { estado, nota });
  }

  return {
    NIVELES, ESTADOS,
    validarLogin, validarCodigo, validarPerfil, validarUsuarioAdmin,
    validarRol, validarNuevaContrasena, validarCambioContrasena,
    ESTADOS_CANCHA, HORA_APERTURA, HORA_CIERRE, horarios, fechaLocal,
    validarCancha, validarReserva, validarPago, validarEnlace,
    PUESTOS, NOMBRES_PUESTO, DURACIONES, ESTADOS_PAGO, TIPOS_TAREA, ESTADOS_TAREA, URGENCIAS, ESTADOS_REPORTE,
    esFutbol11, puestosDe, aMinutos, fechaReal,
    validarEquipo, validarTorneo, validarPartido, validarArbitros, validarRechazo,
    validarPagoJuego, validarNotaRevision, validarTarea, validarReporteCondicion, validarAtencionReporte
  };
});
