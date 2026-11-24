// =====================================================================
//  API de la sección "Seguridad (OWASP Top 10)" del panel de administración
//  Resume, para cada riesgo, los intentos de ataque y el estado de sus controles.
//    A01 Control de acceso roto        A05 Configuración defectuosa
//    A02 Fallas criptográficas         A06 Componentes vulnerables
//    A03 Inyección SQL / XSS           A07 Fallas de identificación y autenticación
//    A04 Diseño inseguro               A08 Fallas de integridad
//                                      A09 Fallas de registro y monitoreo
//                                      A10 SSRF
// =====================================================================
const express = require('express');
const { consulta, transaccion } = require('../../config/db');
const bitacora = require('../bitacora');
const { contexto } = require('../autenticacion');
const { soloCampos } = require('../seguridad/campos');
const { revisarConfiguracion } = require('../seguridad/configuracion');
const { revisarComponentes, ejecutarAuditoria } = require('../seguridad/componentes');
const { verificarManifiesto, verificarDependencias } = require('../seguridad/integridad-codigo');
const { dominiosPermitidos } = require('../seguridad/ssrf');
const monitor = require('../seguridad/monitor');
const vigilancia = require('../seguridad/vigilancia');
const { ErrorApp, asincrono, errorValidacion } = require('../errores');

const router = express.Router();

const ACCIONES = {
  A01: ['SESION_EXPULSADA', 'TOKEN_MANIPULADO', 'TOKEN_REVOCADO', 'SOLICITUD_MANIPULADA', 'ACCESO_DENEGADO'],
  A02: ['HASH_ACTUALIZADO'],
  A03: ['INTENTO_INYECCION'],
  A04: ['VALIDACION_EVADIDA', 'LIMITE_EXCEDIDO', 'REGLA_NEGOCIO'],
  A05: ['METODO_NO_PERMITIDO'],
  A06: ['AUDITORIA_DEPENDENCIAS'],
  A07: ['LOGIN_FALLIDO', 'MFA_FALLIDO', 'CUENTA_BLOQUEADA', 'FUERZA_BRUTA', 'CONTRASENA_DEBIL', 'SESION_INACTIVA', 'SESIONES_CERRADAS'],
  A08: ['DATOS_MANIPULADOS', 'INTEGRIDAD_CODIGO'],
  A09: ['ALERTA_SEGURIDAD', 'ALERTA_ATENDIDA', 'INTEGRIDAD_BITACORA', 'INTEGRIDAD_REVISADA'],
  A10: ['INTENTO_SSRF']
};
const TODAS = Object.values(ACCIONES).flat();
// En la tabla de "recientes" no se listan los fallos normales de contraseña (están en la bitácora)
const RECIENTES = TODAS.filter((a) => !['LOGIN_FALLIDO', 'MFA_FALLIDO', 'HASH_ACTUALIZADO'].includes(a));

const control = (estado, nombre, detalle, arreglo) => ({
  estado: estado === true ? 'activo' : estado === false ? 'atencion' : estado, nombre, detalle, ...(arreglo ? { arreglo } : {})
});
const pendientes = (lista) => lista.filter((c) => c.estado === 'atencion').length;

/** [A09] ¿Siguen activos los triggers que impiden editar o borrar la bitácora?
    Se prueba de verdad, cada intento dentro de su propia transacción que siempre se revierte
    (en SQL Server el error del trigger cancela la transacción completa). */
const REVERTIR = new Error('revertir');
async function intentoRevertido(textoSql, parametros, esperado) {
  try {
    await transaccion(async (cx) => {
      await consulta(textoSql, parametros, cx);
      throw REVERTIR;                        // si el cambio sí pasó, se deshace
    });
  } catch (err) {
    return err !== REVERTIR && esperado.test(err.message);
  }
  return false;
}

async function bitacoraProtegida() {
  const [fila] = await consulta('SELECT MAX(idBitacora) AS id FROM Bitacora');
  if (!fila || !fila.id) return { editar: true, borrar: true };
  return {
    editar: await intentoRevertido('UPDATE Bitacora SET Accion = Accion WHERE idBitacora = @id', { id: fila.id }, /no se puede modificar/i),
    borrar: await intentoRevertido('DELETE FROM Bitacora WHERE idBitacora = @id', { id: fila.id }, /no se puede borrar/i)
  };
}

/** Ejecuta una revisión; si falla, el panel sigue funcionando y muestra qué no se pudo revisar. */
async function seguro(nombre, fn, respaldo) {
  try { return await fn(); } catch (err) {
    console.error(`[Seguridad] No se pudo revisar "${nombre}":`, err.message);
    return typeof respaldo === 'function' ? respaldo(err) : respaldo;
  }
}

router.get('/', asincrono(async (req, res) => {
  const dias = [1, 7, 30].includes(Number(req.query.dias)) ? Number(req.query.dias) : 7;

  const [conteos, estado, recientes] = await consulta(`
    SELECT Accion, COUNT(*) AS total FROM Bitacora
     WHERE Fecha >= DATEADD(DAY, -@dias, GETDATE()) AND Accion IN (@acciones)
     GROUP BY Accion;
    SELECT
      (SELECT COUNT(*) FROM Usuario) AS usuarios,
      (SELECT COUNT(*) FROM Usuario WHERE Contrasena NOT LIKE 'scrypt$%') AS hashesHeredados,
      (SELECT COUNT(*) FROM Usuario WHERE MFA_Activo = 0) AS sinMfa,
      (SELECT COUNT(*) FROM Usuario WHERE MFA_Secreto IS NOT NULL AND MFA_Secreto NOT LIKE 'v1%') AS secretosSinCifrar,
      (SELECT COUNT(*) FROM Usuario WHERE Bloqueado_Hasta > GETDATE()) AS bloqueados;
    SELECT TOP (25) idBitacora, Fecha, Correo_Usuario, Rol_Usuario, Accion, Descripcion, IP
      FROM Bitacora WHERE Accion IN (@recientes)
     ORDER BY idBitacora DESC;`, { dias, acciones: TODAS, recientes: RECIENTES });

  const n = Object.fromEntries(conteos.map((c) => [c.Accion, Number(c.total)]));
  const c = (a) => n[a] || 0;
  const suma = (lista) => lista.reduce((t, a) => t + c(a), 0);
  const e = Object.fromEntries(Object.entries(estado[0]).map(([k, v]) => [k, Number(v)]));
  const produccion = process.env.NODE_ENV === 'production';
  const bdCifrada = process.env.DB_CIFRADO === '1';

  const fallo = (nombre) => (err) => ({ revisiones: [control('atencion', `No se pudo revisar: ${nombre}`, String(err.message).slice(0, 160))] });
  const configuracion = await seguro('configuración', () => revisarConfiguracion(consulta), fallo('configuración'));
  const componentes = await seguro('componentes', () => revisarComponentes(configuracion.baseDatos || {}), fallo('componentes'));
  const codigo = await seguro('código', () => verificarManifiesto(),
    { estado: 'firma_invalida', total: 0, modificados: [], nuevos: [], faltantes: [], fecha: null });
  const dependencias = await seguro('dependencias', () => verificarDependencias(),
    { estado: 'sin_lock', total: 0, conHash: 0, distintos: [], faltantes: [] });
  const cadena = await seguro('cadena de la bitácora', () => vigilancia.revisarBitacora(),
    (err) => ({ ok: false, error: err.message, problemas: [], pendientes: 0 }));
  const protegida = await seguro('triggers de la bitácora', () => bitacoraProtegida(), { editar: false, borrar: false, error: true });
  const registro = bitacora.resumenRegistro();
  const alertas = await seguro('alertas', () => monitor.alertasActivas(), []);
  const permitidos = dominiosPermitidos();

  const a02 = [
    control(e.hashesHeredados === 0, 'Contraseñas con scrypt + sal',
      e.hashesHeredados ? `${e.hashesHeredados} cuenta(s) aún con SHA-256; se migran solas al iniciar sesión.` : 'Todas las contraseñas usan scrypt.'),
    control(e.secretosSinCifrar === 0, 'Secreto MFA cifrado (AES-256-GCM)',
      e.secretosSinCifrar ? `${e.secretosSinCifrar} secreto(s) sin cifrar.` : 'Ningún secreto MFA está en texto plano.'),
    control(true, 'JWT firmado HS256', 'Se rechazan tokens con algoritmo "none" o con una firma distinta.'),
    control(produccion ? 'activo' : 'info', 'Cookies Secure + HSTS (HTTPS)',
      produccion ? 'Activo: solo viajan por HTTPS.' : 'En tu PC es normal que esté apagado; se activa con NODE_ENV=production en AWS.'),
    control(bdCifrada ? 'activo' : 'info', 'Conexión cifrada a la base de datos',
      bdCifrada ? 'TLS activo (DB_CIFRADO=1).' : 'En tu PC la base es local; con Azure SQL pon DB_CIFRADO=1.'),
    control(true, 'Datos sensibles fuera de las respuestas', 'Hash, secreto MFA y tokens nunca se envían al navegador ni a la bitácora.')
  ];

  const a05 = configuracion.revisiones;
  const a06 = componentes.revisiones;
  const a07 = [
    control(e.sinMfa === 0 ? 'activo' : 'info', 'MFA obligatorio (TOTP)',
      e.sinMfa ? `${e.sinMfa} cuenta(s) aún no vinculan su Authenticator; se les pide en su primer inicio de sesión.`
        : 'Todas las cuentas tienen su app Authenticator vinculada.'),
    control(true, 'Bloqueo por intentos fallidos', '5 intentos de contraseña o código → cuenta bloqueada 15 minutos.'),
    control(true, 'Freno de fuerza bruta por IP', 'Más de 20 intentos de login en 15 min desde la misma IP se bloquean, aunque sean a cuentas distintas.'),
    control(true, 'Mensajes que no revelan cuentas', 'Correo inexistente y contraseña incorrecta responden igual y tardan lo mismo.'),
    control(true, 'Código MFA de un solo uso', 'Un código ya usado no sirve otra vez, aunque siga dentro de sus 30 segundos.'),
    control(true, 'Sesión por inactividad', 'El token vence a los 15 min sin actividad y la sesión dura máximo 8 h.'),
    control(true, 'Contraseñas débiles detectadas', 'Al entrar con una contraseña corta o común se avisa y se registra para que la cambie.'),
    control(true, 'Cerrar sesión en otros equipos', 'Cada usuario puede cerrar sus sesiones abiertas desde Mi perfil → Seguridad.')
  ];

  const listaCodigo = [...codigo.modificados.map((x) => `${x} (modificado)`), ...codigo.nuevos.map((x) => `${x} (nuevo)`),
    ...codigo.faltantes.map((x) => `${x} (borrado)`)];
  const a08 = [
    codigo.estado === 'ok'
      ? control('activo', 'Código firmado sin cambios', `${codigo.total} archivos coinciden con su huella SHA-256 (firmado el ${new Date(codigo.fecha).toLocaleString('es-MX')}).`)
      : codigo.estado === 'sin_manifiesto'
        ? control('atencion', 'El código aún no está firmado', 'No existe integridad.json, así que no se puede saber si alguien cambia un archivo.', 'En la terminal: npm run firmar-codigo')
        : codigo.estado === 'firma_invalida'
          ? control('atencion', 'Firma del código inválida', 'integridad.json fue alterado o se firmó con otra MFA_CLAVE.', 'Si tú cambiaste el código a propósito: npm run firmar-codigo')
          : control('atencion', 'El código cambió desde que se firmó', listaCodigo.slice(0, 6).join(' · ') + (listaCodigo.length > 6 ? ` y ${listaCodigo.length - 6} más` : ''),
            'Si fuiste tú: npm run firmar-codigo. Si no, restaura esos archivos del zip original.'),
    dependencias.estado === 'ok'
      ? control('activo', 'Paquetes idénticos a package-lock.json', `${dependencias.total} paquetes instalados con la versión exacta registrada.`)
      : dependencias.estado === 'sin_lock'
        ? control('atencion', 'Falta package-lock.json', 'Sin él no hay forma de verificar qué se instaló.', 'Ejecuta "npm install".')
        : control('atencion', 'Paquetes distintos a package-lock.json', [...dependencias.distintos, ...dependencias.faltantes.map((x) => `${x} (falta)`)].slice(0, 5).join(' · '),
          'Ejecuta "npm ci" para reinstalar exactamente lo del package-lock.json.'),
    control(dependencias.total > 0 && dependencias.conHash === dependencias.total, 'Huella sha512 de cada paquete',
      `${dependencias.conHash} de ${dependencias.total} paquetes tienen su hash "integrity" en package-lock.json; npm lo comprueba al instalar.`),
    control(true, 'Bloqueo de JSON manipulado (__proto__)', 'Se rechazan claves "__proto__", "constructor" y "prototype" y JSON de más de 8 niveles.'),
    control(true, 'Sin JavaScript de otros sitios', 'La página no carga scripts de CDN; la CSP solo permite scripts propios.'),
    control(true, 'Datos firmados', 'Sesiones (JWT HS256), bitácora (HMAC en cadena) y código (HMAC) llevan firma: si se alteran, se nota.'),
    control(true, 'Comprobantes revisados por contenido', 'Se acepta PNG/JPG/PDF por sus primeros bytes, y su huella SHA-256 queda en la bitácora.')
  ];

  const pendientesCadena = (cadena.problemas || []).filter((p) => !p.revisado);
  const revisadosCadena = (cadena.problemas || []).filter((p) => p.revisado);
  const a09 = [
    cadena.error
      ? control('atencion', 'No se pudo revisar la cadena de la bitácora', cadena.error)
      : pendientesCadena.length
        ? control('atencion', `Bitácora alterada (${pendientesCadena.length})`, pendientesCadena.slice(0, 3).map((p) => p.detalle).join(' '),
          'Revisa en SQL Server qué pasó; cuando esté atendido, da clic en "Marcar alteraciones como revisadas".')
        : control('activo', 'Bitácora encadenada y sin alteraciones',
          `${cadena.firmados} registro(s) firmados en cadena; ninguno fue modificado, borrado ni insertado a mano` +
          (revisadosCadena.length ? ` (${revisadosCadena.length} alteración(es) antiguas ya revisadas).` : '.')),
    control(protegida.editar && protegida.borrar, 'Bitácora de solo escritura',
      protegida.editar && protegida.borrar ? 'SQL Server rechaza cualquier UPDATE o DELETE sobre la bitácora (probado ahora mismo).'
        : `Falta el trigger que impide ${[!protegida.editar && 'editar', !protegida.borrar && 'borrar'].filter(Boolean).join(' y ')} la bitácora.`,
      protegida.editar && protegida.borrar ? null : 'En SSMS (conectado a la base del proyecto): ejecuta sql/04_integridad_y_monitoreo.sql.'),
    alertas.length
      ? control('atencion', `${alertas.length} alerta(s) sin atender`, 'Están arriba de esta página. Revísalas y márcalas como atendidas.')
      : control('activo', 'Alertas automáticas', `Se alerta con 5 eventos sospechosos de una IP en 10 min, fuerza bruta, bloqueo de un admin, SSRF o alteraciones. ${monitor.resumen().alertasEmitidas} emitida(s) desde que arrancó el servidor.`),
    control(registro.fallosArchivo === 0, 'Respaldo diario en archivo',
      `almacen/registros/bitacora-AAAA-MM-DD.log · ${registro.lineasHoy} línea(s) hoy · ${registro.archivos} archivo(s) · se guardan ${registro.retencionDias} días.`),
    control(registro.fallosBase === 0, 'Sin registros perdidos',
      registro.fallosBase ? `${registro.fallosBase} registro(s) no se pudieron guardar en SQL Server (sí quedaron en el archivo). Último error: ${registro.ultimoError}`
        : 'Todos los registros desde que arrancó el servidor se guardaron en SQL Server.'),
    control(true, 'Anti "log injection"', `Saltos de línea y caracteres de control se neutralizan antes de guardar (${registro.neutralizados} texto(s) limpiados desde el arranque).`),
    control(true, 'Sin datos sensibles en la bitácora', 'Contraseñas, hashes, secretos MFA, tokens y códigos nunca se escriben.'),
    control(true, 'Eventos que se registran', 'Inicios y cierres de sesión, fallos, MFA, cambios de datos, accesos denegados, ataques, cambios directos en SQL Server (triggers) y alertas.')
  ];

  const a10 = [
    control(true, 'Solo https públicos', 'Se rechazan http, ftp, file, gopher..., puertos distintos de 443 y enlaces con usuario:contraseña.'),
    control(true, 'Direcciones internas bloqueadas', '127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x (metadatos de AWS), 0.0.0.0, ::1, fc00::/7, fe80::/10 y nombres como localhost o *.local.'),
    control(true, 'Revisión del DNS', 'Se resuelve el dominio y, si CUALQUIER IP es interna, se rechaza (por ejemplo localtest.me → 127.0.0.1).'),
    control(true, 'Conexión a la IP revisada', 'La descarga se conecta a la IP ya validada: un cambio de DNS a última hora ("DNS rebinding") no sirve.'),
    control(true, 'Redirecciones revisadas', 'Cada redirección se valida como un enlace nuevo (máximo 3): no se puede "rebotar" hacia una IP interna.'),
    control(true, 'Límites de la descarga', 'Máximo 8 segundos y 5 MB; solo se guarda si el contenido es realmente PNG, JPG o PDF.'),
    permitidos.length
      ? control('activo', 'Lista de dominios permitidos', `Solo: ${permitidos.join(', ')} (SSRF_DOMINIOS en .env).`)
      : control('info', 'Lista de dominios permitidos', 'Se acepta cualquier dominio público. Para restringirlo, pon SSRF_DOMINIOS=dominio1.com,dominio2.com en .env.'),
    control(true, 'Una sola función descarga enlaces', 'Solo Reservas → "Comprobante desde enlace", y solo para administradores.')
  ];

  res.json({
    dias,
    porAccion: n,
    riesgos: [
      {
        id: 'A01', nombre: 'Control de acceso roto', tipo: 'eventos', numero: suma(ACCIONES.A01),
        detalle: `${c('SESION_EXPULSADA')} sesión(es) expulsada(s), ${c('TOKEN_MANIPULADO')} token(s) alterado(s), ` +
          `${c('SOLICITUD_MANIPULADA')} JSON con campos de más`,
        controles: [
          control(true, 'Permisos revisados en el servidor', 'Cada ruta /api/admin exige sesión y rol con nivel Administrador.'),
          control(true, 'Expulsión por manipulación', 'Pedir datos de administrador, alterar el token o mandar campos de permisos cierra la sesión.'),
          control(true, 'Lista blanca de campos', 'Cada formulario solo acepta sus campos; un "idRol" agregado a mano se rechaza.'),
          control(true, 'Sesiones revocables', 'Cerrar sesión o cambiar contraseña invalida los tokens anteriores (Token_Version).'),
          control(true, 'Sin referencias directas', 'El perfil usa el id de la sesión, nunca un id enviado por el navegador.')
        ]
      },
      {
        id: 'A02', nombre: 'Fallas criptográficas', tipo: 'pendientes', numero: pendientes(a02),
        detalle: `${e.usuarios - e.hashesHeredados} de ${e.usuarios} contraseña(s) con scrypt · ${e.hashesHeredados} pendiente(s) de migrar`,
        controles: a02
      },
      {
        id: 'A03', nombre: 'Inyección (SQL / XSS)', tipo: 'eventos', numero: suma(ACCIONES.A03),
        detalle: `${c('INTENTO_INYECCION')} intento(s) detectado(s) y neutralizado(s)`,
        controles: [
          control(true, 'Consultas parametrizadas', 'El texto del usuario viaja como parámetro (@correo), nunca pegado en el SQL.'),
          control(true, 'Validación con listas blancas', 'Correo, nombres, teléfonos, fechas y montos se validan en navegador y servidor.'),
          control(true, 'Salida segura (anti-XSS)', 'La página muestra los datos con textContent: el HTML se ve como texto, no se ejecuta.'),
          control(true, 'Content-Security-Policy', "Solo se ejecutan scripts del propio sitio (script-src 'self', sin inline)."),
          control(true, 'Detector de intentos', 'Registra en la bitácora cada intento de inyección SQL o XSS.')
        ]
      },
      {
        id: 'A04', nombre: 'Diseño inseguro', tipo: 'eventos', numero: suma(ACCIONES.A04),
        detalle: `${c('VALIDACION_EVADIDA')} validación(es) evadida(s), ${c('REGLA_NEGOCIO')} regla(s) de negocio aplicada(s), ` +
          `${c('LIMITE_EXCEDIDO')} exceso(s) de peticiones`,
        controles: [
          control(true, 'Reglas del negocio en el servidor', 'Sin fechas pasadas, máximo 3 h por reserva, dentro del horario y sin choques (aunque se salten la página).'),
          control(true, 'Límite anti-acaparamiento', 'Un cliente puede tener máximo 3 reservas pendientes de pago.'),
          control(true, 'Detección de validación evadida', 'Navegador y servidor usan las mismas reglas: si el servidor encuentra un error, alguien se saltó la página.'),
          control(true, 'Límites de uso', '300 peticiones por minuto por IP, 20 KB por petición, 5 MB por comprobante, máximo 50 renglones por página.'),
          control(true, 'Operaciones sensibles con MFA', 'Cambiar datos, contraseña o cerrar sesiones pide el código de 6 dígitos.'),
          control(true, 'Modelo de amenazas documentado', 'GUIA_OWASP.md explica cada amenaza del sistema y su protección.')
        ]
      },
      {
        id: 'A05', nombre: 'Configuración defectuosa', tipo: 'pendientes', numero: pendientes(a05),
        detalle: `${a05.length - pendientes(a05) - a05.filter((x) => x.estado === 'info').length} de ${a05.length} revisión(es) correcta(s) · ` +
          `${c('METODO_NO_PERMITIDO')} método(s) HTTP bloqueado(s)`,
        controles: a05
      },
      {
        id: 'A06', nombre: 'Componentes vulnerables y desactualizados', tipo: 'pendientes', numero: pendientes(a06),
        detalle: componentes.auditoria
          ? `npm audit: ${componentes.auditoria.conteo.total} vulnerabilidad(es) · revisado ${new Date(componentes.auditoria.fecha).toLocaleString('es-MX')}`
          : 'Aún no se revisan las dependencias con npm audit',
        boton: { accion: 'auditoria', texto: 'Revisar dependencias' },
        controles: a06
      },
      {
        id: 'A07', nombre: 'Fallas de identificación y autenticación', tipo: 'eventos',
        numero: c('LOGIN_FALLIDO') + c('MFA_FALLIDO') + c('CUENTA_BLOQUEADA') + c('FUERZA_BRUTA'),
        detalle: `${c('LOGIN_FALLIDO') + c('MFA_FALLIDO')} intento(s) fallido(s), ${c('CUENTA_BLOQUEADA')} bloqueo(s), ` +
          `${c('FUERZA_BRUTA')} ataque(s) de fuerza bruta, ${c('SESION_INACTIVA')} sesión(es) cerrada(s) por inactividad`,
        controles: a07
      },
      {
        id: 'A08', nombre: 'Fallas de integridad de software y datos', tipo: 'pendientes', numero: pendientes(a08),
        detalle: `Código: ${codigo.total} archivo(s) firmados, ${listaCodigo.length} con cambios · ` +
          `${c('DATOS_MANIPULADOS')} JSON manipulado(s) bloqueado(s)`,
        controles: a08
      },
      {
        id: 'A09', nombre: 'Fallas de registro y monitoreo', tipo: 'pendientes', numero: pendientes(a09),
        detalle: `${cadena.firmados || 0} registro(s) firmados · ${pendientesCadena.length} alteración(es) sin revisar · ` +
          `${alertas.length} alerta(s) activa(s)`,
        boton: pendientesCadena.length ? { accion: 'revisar-integridad', texto: 'Marcar alteraciones como revisadas' } : null,
        controles: a09
      },
      {
        id: 'A10', nombre: 'Server-Side Request Forgery (SSRF)', tipo: 'eventos', numero: suma(ACCIONES.A10),
        detalle: `${c('INTENTO_SSRF')} intento(s) de SSRF bloqueado(s)`,
        controles: a10
      }
    ],
    alertas,
    estado: e,
    recientes
  });
}));

/* [OWASP A09] Alertas activas (el panel las consulta cada minuto) */
router.get('/alertas', asincrono(async (req, res) => {
  res.json({ alertas: await monitor.alertasActivas() });
}));

/* [OWASP A09] Marcar una alerta como atendida (queda registrado quién y cuándo) */
router.post('/alertas/:id/atender', contexto('ALERTA_ATENDIDA', 'Seguridad', null), soloCampos([]), asincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw errorValidacion({ id: 'Alerta inválida.' });
  const [alerta] = await consulta(`SELECT idBitacora, Descripcion FROM Bitacora WHERE idBitacora = @id AND Accion = 'ALERTA_SEGURIDAD'`, { id });
  if (!alerta) throw new ErrorApp(404, 'Esa alerta no existe.');
  await bitacora.registrar(req, {
    accion: 'ALERTA_ATENDIDA', modulo: 'Seguridad', tabla: 'Bitacora', idRegistro: id,
    descripcion: `[A09] Marcó como atendida la alerta #${id}: ${String(alerta.Descripcion).replace(/^\[A09\]\s*/, '').slice(0, 300)}`
  });
  res.json({ mensaje: 'Alerta marcada como atendida.' });
}));

/* [OWASP A09] Marcar las alteraciones de la bitácora como revisadas */
router.post('/integridad/revisar', contexto('INTEGRIDAD_REVISADA', 'Seguridad', null), soloCampos([]), asincrono(async (req, res) => {
  const r = await vigilancia.revisarBitacora();
  const pendientes = r.problemas.filter((p) => !p.revisado);
  for (const p of pendientes) {
    await bitacora.registrar(req, {
      accion: 'INTEGRIDAD_REVISADA', modulo: 'Seguridad', tabla: 'Bitacora', idRegistro: p.clave,
      descripcion: `[A09] Revisó la alteración de la bitácora: ${p.detalle}`
    });
  }
  res.json({ mensaje: pendientes.length ? `${pendientes.length} alteración(es) marcadas como revisadas. Siguen visibles en la bitácora como evidencia.`
    : 'No había alteraciones pendientes.' });
}));

/* [OWASP A06] Revisar las dependencias con npm audit (necesita internet) */
router.post('/auditoria', contexto('AUDITORIA_DEPENDENCIAS', 'Seguridad', null), soloCampos([]), asincrono(async (req, res) => {
  let resultado;
  try {
    resultado = await ejecutarAuditoria();
  } catch (err) {
    await bitacora.registrar(req, {
      accion: 'AUDITORIA_DEPENDENCIAS', modulo: 'Seguridad', resultado: 'Fallo',
      descripcion: `[A06] No se pudo revisar las dependencias: ${String(err.message).slice(0, 200)}`
    });
    throw new ErrorApp(502, String(err.message).slice(0, 220));
  }
  const k = resultado.conteo;
  await bitacora.registrar(req, {
    accion: 'AUDITORIA_DEPENDENCIAS', modulo: 'Seguridad', resultado: k.critical + k.high > 0 ? 'Fallo' : 'Éxito',
    descripcion: `[A06] Revisó las dependencias con npm audit: ${k.total} vulnerabilidad(es) ` +
      `(${k.critical} crítica(s), ${k.high} alta(s), ${k.moderate} moderada(s), ${k.low} baja(s)); ` +
      `${resultado.desactualizados.length} paquete(s) con versión más nueva`,
    despues: { conteo: k, desactualizados: resultado.desactualizados }
  });
  res.json({
    mensaje: k.total === 0 ? 'Revisión terminada: 0 vulnerabilidades conocidas.'
      : `Revisión terminada: ${k.total} vulnerabilidad(es). Ejecuta "npm audit fix".`,
    resultado
  });
}));

module.exports = router;
