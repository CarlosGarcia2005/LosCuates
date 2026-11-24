# Guía de seguridad OWASP — Gestor Deportivo Rancho Seco

| ID | Riesgo | OWASP Top 10 (2021) |
|---|---|---|
| R1 | Control de acceso roto | **A01** Broken Access Control |
| R2 | Falla criptográfica | **A02** Cryptographic Failures |
| R3 | Inyección SQL / XSS | **A03** Injection |
| R4 | Diseño inseguro | **A04** Insecure Design |
| R5 | Configuración defectuosa | **A05** Security Misconfiguration |
| R6 | Componentes vulnerables | **A06** Vulnerable and Outdated Components |
| R7 | Fallas de identificación y autenticación | **A07** Identification and Authentication Failures |
| R8 | Fallas de integridad de software y datos | **A08** Software and Data Integrity Failures |
| R9 | Fallas de registro y monitoreo | **A09** Security Logging and Monitoring Failures |
| R10 | Falsificación de peticiones del lado del servidor | **A10** Server-Side Request Forgery (SSRF) |

Todo lo que se describe aquí queda registrado en la **Bitácora** y se resume en
**Panel de administración → Seguridad OWASP** (una tarjeta por riesgo).

> No confundir con **Mi perfil → Seguridad**: esa sección es solo para *tu* contraseña y *tus* sesiones.
> **Seguridad OWASP** es el estado de seguridad de todo el sistema y solo la ven los administradores.

En las tarjetas: ✓ verde = protegido · **!** amarillo = hay que corregirlo · **i** azul = normal en tu PC, cambia al publicar (Vercel + Azure SQL).

---

## Prueba automática (lo más rápido)

Con el servidor prendido (`npm start`), abre **otra** terminal en la carpeta del proyecto:

```
npm run prueba-owasp
```

El script ataca tu propio servidor (inyección SQL, XSS, tokens falsos, JSON alterado,
CSRF, archivos secretos, métodos HTTP raros, peticiones gigantes…), revisa la versión de
Node.js y corre `npm audit`. Dice `✔ PASA` o `✘ FALLA` en cada prueba. Al final pregunta
si quieres probar con un **usuario normal** (Cliente o Árbitro con MFA configurado):
con eso comprueba que no puede hacerse administrador, que la sesión vence por inactividad
y que un código MFA no se puede reusar. Después pregunta si quieres probar **A10 con el
administrador** (necesita una reserva con pago registrado): manda 15 enlaces "maliciosos" y
comprueba que todos se bloqueen. Son alrededor de **75 pruebas** en total.

> Una de las pruebas manda una contraseña falsa a `admin@ranchoseco.com`, así que cuenta
> como 1 intento fallido de esa cuenta (se reinicia al entrar bien). En la parte con usuario
> normal, la prueba de "reusar el código MFA" cuenta como 1 intento fallido de ese usuario. Para usar otro correo:
> `npm run prueba-owasp -- --correo otro@correo.com`

---

## A01 · Control de acceso roto

**Qué es:** que alguien haga cosas que su rol no le permite (ver usuarios siendo cliente,
cambiarse el rol, usar la sesión de otro).

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| Cada ruta `/api/admin/...` revisa en el **servidor** que el rol sea Administrador | `src/autenticacion.js` → `requiereAdmin` |
| Si un usuario normal pide algo de administrador, **se le cierra la sesión** en todos sus equipos | `src/seguridad/expulsion.js` |
| Si alguien **altera su token** (cookie `rs_token`), se detecta y se le saca | `src/seguridad/diagnostico-token.js` |
| Cada formulario acepta **solo sus campos**; si llega `"idRol"` o `"estado"` al perfil, se expulsa | `src/seguridad/campos.js`, `src/rutas/perfil.js` |
| El perfil usa el id de la **sesión**, nunca un id que mande el navegador | `src/rutas/perfil.js` |
| Cerrar sesión o cambiar contraseña **invalida los tokens viejos** (`Token_Version`) | `src/rutas/auth.js` |
| Protección **CSRF**: solo se aceptan peticiones hechas por nuestra página | `src/seguridad/cabeceras.js` |

**Cómo probarlo a mano** (inicia sesión con un usuario **normal**, no admin)

1. **Pedir datos de administrador desde la consola.** Presiona `F12` → pestaña **Consola**
   (en Chrome, si no te deja pegar, escribe primero `allow pasting`) y escribe:
   ```js
   App.api('GET', '/api/admin/usuarios')
   ```
   ✅ Debe sacarte al login con el mensaje rojo *"Cerramos tu sesión porque detectamos una
   modificación no permitida…"*. En **Seguridad** aparece *Sesión expulsada*.

2. **Modificar el JSON para hacerse admin.** Vuelve a entrar y en la consola escribe
   (cambia los datos por los tuyos):
   ```js
   App.api('PUT', '/api/perfil', { nombre: 'Carlos', apellidoPaterno: 'Garcia', correo: 'carlos.garcia@correo.com',
     idGenero: 1, codigo: '000000', idRol: 1 })
   ```
   ✅ Te expulsa y tu rol **no cambia** (revísalo como admin en Usuarios).

3. **Alterar el token.** `F12` → **Aplicación** (Application) → **Cookies** →
   `http://localhost:3000` → doble clic en el valor de `rs_token` y cambia **una letra
   de en medio** → `F5`.
   ✅ Te saca al login con el mensaje rojo. En **Seguridad** aparece *Token alterado*.

4. **Escribir la dirección del panel.** Con el usuario normal escribe `localhost:3000/admin`.
   ✅ Te regresa a tu perfil y queda *Acceso denegado* en la bitácora.

---

## A02 · Fallas criptográficas

**Qué es:** guardar o mandar datos sensibles sin protección (contraseñas en texto,
secretos sin cifrar, sesiones que se pueden robar).

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| Contraseñas con **scrypt + sal única** (los SHA-256 viejos se convierten solos al entrar) | `src/seguridad/contrasena.js` |
| Comparaciones en **tiempo constante** (no se puede adivinar midiendo tiempos) | `src/seguridad/contrasena.js`, `totp.js` |
| Secreto del MFA **cifrado con AES-256-GCM** (la llave está en `.env`, no en la base) | `src/seguridad/cifrado.js` |
| Sesión en **JWT firmado HS256**; se rechazan tokens con algoritmo `none` | `src/seguridad/jwt.js` |
| Cookies **HttpOnly** (JavaScript no las lee) y **SameSite=Strict**; **Secure + HSTS** en producción | `src/seguridad/jwt.js`, `cabeceras.js` |
| Contraseñas **demasiado comunes** se rechazan (`Password1`, `12345678a`…) | `public/js/validacion.js` |
| Conexión a SQL Server **cifrada con TLS** en Azure SQL (`DB_CIFRADO=1`, certificado verificado) | `config/db.js` |
| Hash, secreto MFA y tokens **nunca** se mandan al navegador ni a la bitácora | `src/usuarios.js`, `src/bitacora.js` |
| `.env`, `server.js` y el código del servidor **no se pueden descargar** | `server.js` (solo se publica `public/`) |

**Cómo probarlo a mano**

1. En SSMS, conectado a la base del proyecto:
   ```sql
   SELECT Correo, LEFT(Contrasena, 25) AS Hash, LEFT(MFA_Secreto, 12) AS SecretoMFA FROM Usuario;
   ```
   ✅ Las contraseñas empiezan con `scrypt$16384$...` y los secretos con `v1:` (cifrados).
   Ninguna se puede leer.
2. `F12` → **Aplicación** → **Cookies**: `rs_token` tiene ✓ en **HttpOnly** y **SameSite = Strict**.
   En la **Consola** escribe `document.cookie`. ✅ `rs_token` **no** aparece.
3. `F12` → **Red** (Network) → abre tu perfil → clic en la petición `perfil` → **Respuesta**.
   ✅ No vienen ni la contraseña ni el secreto MFA.
4. Abre `localhost:3000/.env` y `localhost:3000/server.js`. ✅ No se descargan.
5. En **Mi perfil → Seguridad** intenta poner la contraseña `Password1`.
   ✅ *"Esa contraseña es demasiado común."*

---

## A03 · Inyección SQL / XSS

**Qué es:** escribir código en un campo para que la base de datos lo ejecute
(inyección SQL) o para que el navegador de otra persona lo ejecute (XSS).

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| **Consultas parametrizadas**: el texto viaja como `:correo`, nunca pegado al SQL | todas las rutas en `src/rutas/` |
| **Validación con listas blancas** en navegador y servidor (correo, nombres solo con letras, números…) | `public/js/validacion.js` |
| La página muestra los datos con **textContent**: el HTML se ve como texto, no se ejecuta | `public/js/comun.js` → `h()` |
| **Content-Security-Policy**: solo se ejecutan scripts del propio sitio, nunca en línea | `src/seguridad/cabeceras.js` |
| **Detector**: registra en la bitácora cada intento de inyección SQL o XSS | `src/seguridad/detector.js` |
| El CSV exportado está protegido contra **inyección de fórmulas** de Excel | `src/rutas/admin.js`, `reservas.js` |

**Por qué `' OR '1'='1` no funciona:** el servidor nunca arma el SQL juntando textos.
Siempre manda la consulta y el dato **por separado**:

```js
consulta('SELECT ... FROM Usuario u WHERE u.Correo = :correo', { correo })
```

Así SQL Server busca un correo que literalmente se llame `' OR '1'='1`, que no existe.

**Cómo probarlo a mano**

1. **Login con inyección en el correo:** escribe `' OR '1'='1' -- ` como usuario y cualquier contraseña.
   ✅ *"Escribe un correo válido"* (lo frena el navegador).
2. **Saltarse la validación del navegador:** en la consola del login escribe
   ```js
   App.api('POST', '/api/auth/login', { correo: "' OR '1'='1' -- ", contrasena: 'x' })
   ```
   ✅ El servidor responde 400 y en **Seguridad** aparece *Intento de inyección (SQL)*.
3. **Inyección en la contraseña:** correo real (`admin@ranchoseco.com`) y contraseña `' OR '1'='1`.
   ✅ *"Usuario o contraseña incorrectos."*
4. **XSS en un nombre:** como admin, edita un usuario y pon de nombre `<script>alert(1)</script>`.
   ✅ *"Solo se permiten letras y espacios."*
5. **XSS guardado:** registra una reserva con la descripción `<img src=x onerror=alert('XSS')>`.
   ✅ Se guarda, pero **no aparece ninguna alerta**: en la bitácora se ve como texto.

---

## A04 · Diseño inseguro

**Qué es:** fallas que vienen de **cómo se pensó** el sistema, no de un error de código.
Por ejemplo: confiar en que el navegador ya validó, permitir que alguien aparte todas
las canchas sin pagar, o no poner límites a cuántas veces se puede intentar algo.

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| Las reglas del negocio se revisan **en el servidor** (sin fechas pasadas, máx. 3 h por reserva, dentro del horario, sin choques de cancha) | `public/js/validacion.js` + `src/rutas/reservas.js` |
| **Detección de validación evadida**: navegador y servidor usan el **mismo** archivo de reglas; si el servidor encuentra un error, alguien se saltó la página → se registra | `src/errores.js` → `validacionEvadida` |
| **Anti-acaparamiento**: un cliente puede tener máximo **3 reservas pendientes de pago** | `src/rutas/reservas.js` |
| **Límites de uso**: 300 peticiones/min por IP, 20 KB por petición, 5 MB por comprobante | `server.js`, `src/seguridad/limitador.js` |
| Operaciones sensibles (datos, contraseña, sesiones) piden **código MFA** | `src/rutas/perfil.js` |
| **Modelo de amenazas** del sistema (tabla de abajo) | este archivo |

### Modelo de amenazas (resumen)

| Amenaza | Quién / cómo | Protección |
|---|---|---|
| Hacerse administrador | Usuario normal edita el JSON o el token | A01: expulsión + lista blanca de campos |
| Robar la sesión | XSS o red insegura | A02/A03: cookie HttpOnly + CSP + HTTPS en Vercel |
| Leer la base de datos | Inyección SQL | A03: consultas parametrizadas |
| Adivinar contraseñas | Bot con miles de intentos | A07: bloqueo de cuenta + freno por IP + MFA |
| Dejar sin canchas a los demás | Apartar todo sin pagar | A04: máx. 3 pendientes por cliente |
| Saturar el servidor | Script o petición gigante | A04: 300 peticiones/min, 20 KB por petición |
| Aprovechar un error de configuración | Contraseña débil de SQL Server, permisos de más | A05: revisión automática al arrancar y en el panel |
| Usar una falla conocida de una librería | Paquete o Node.js viejo | A06: npm audit + versiones con soporte |
| Usar una computadora olvidada | Sesión abierta en el laboratorio | A07: cierre por inactividad (15 min) y máximo 8 h |

**Cómo probarlo a mano**

1. **Saltarse la validación del navegador.** Como admin, abre `F12 → Console` y escribe:
   ```js
   App.api('POST', '/api/admin/reservas', { idUsuario: 1, idCancha: 1, fecha: '2020-01-01', horario: '18:00-19:00' })
   ```
   ✅ Responde *"Revisa los campos marcados"* (la fecha ya pasó) y en **Seguridad** aparece
   *Validación evadida*: la página nunca habría mandado eso.
2. **Acaparar canchas.** Registra 3 reservas **sin pago** para el mismo cliente y luego una cuarta.
   ✅ *"Este cliente ya tiene 3 reservas pendientes de pago…"* y queda como *Regla de negocio*.

---

## A05 · Configuración defectuosa

**Qué es:** el código puede estar bien, pero si el servidor o la base están mal
configurados (contraseñas por defecto, permisos de más, errores que muestran el código,
métodos HTTP que no se usan…) se abre una puerta.

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| **Revisión automática** del `.env` y de SQL Server al arrancar (`npm start` avisa en la consola) y en el panel | `src/seguridad/configuracion.js` |
| Revisa: clave JWT larga, claves distintas, app **no** entra como `sa`, contraseña de SQL Server de 12+ caracteres, `.env` en `.gitignore` | `configuracion.js` → `revisarEntorno` |
| Revisa la cuenta de SQL Server: **mínimo privilegio** (solo `db_datareader` + `db_datawriter`, sin `db_owner` ni `sysadmin`), conexión cifrada (`DB_CIFRADO=1`) y `ANSI_WARNINGS` (textos largos se rechazan) | `configuracion.js` → `revisarBaseDatos` |
| Errores con mensaje genérico + código de referencia (sin SQL ni rutas) | `src/errores.js` |
| Cabeceras de seguridad y **sin** `X-Powered-By` | `src/seguridad/cabeceras.js` |
| Solo métodos HTTP necesarios: `TRACE`, `PROPFIND`, etc. → **405** y se registra | `server.js` |
| Sin listado de carpetas; solo se publica `public/` | `server.js` |

**Lo que probablemente te salga en amarillo (y cómo arreglarlo)**

- **Contraseña de SQL Server débil** (menos de 12 caracteres). En Azure se cambia desde el portal
  (servidor SQL → *Restablecer contraseña*) o en SSMS con `ALTER LOGIN ... WITH PASSWORD = '...'`,
  y pones **esa misma** en `DB_PASSWORD` de tu `.env` y en Vercel.
- **Privilegios de más en la base de datos** (la app entra con el administrador del servidor). En SSMS,
  conectado a la base del proyecto, crea una cuenta solo para la app:
  ```sql
  CREATE USER rancho_app WITH PASSWORD = 'Rancho-Seco_App2026!';
  ALTER ROLE db_datareader ADD MEMBER rancho_app;
  ALTER ROLE db_datawriter ADD MEMBER rancho_app;
  ```
  y usa `DB_USER=rancho_app`. La app sigue funcionando igual, pero si alguien roba su contraseña ya no puede
  borrar tablas ni crear usuarios. (Los scripts de `sql/` se siguen ejecutando con la cuenta de administrador.)

**Cómo probarlo a mano**

1. Al correr `npm start` mira la consola: dice `✔ Configuración de seguridad sin pendientes`
   o lista lo que falta.
2. Abre `localhost:3000/api/nada` → ✅ *"Recurso no encontrado."* sin detalles técnicos.
3. Abre `localhost:3000/js/` → ✅ no muestra la lista de archivos.
4. El método `TRACE` lo prueba `npm run prueba-owasp` (el navegador no deja mandarlo).

---

## A06 · Componentes vulnerables y desactualizados

**Qué es:** usar librerías, Node.js o SQL Server con fallas de seguridad **ya conocidas y
publicadas**, o versiones que ya no reciben parches.

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| **Node.js** con soporte (22, 24 o 26). El 20 dejó de recibir parches el 30 abr 2026 | `src/seguridad/componentes.js` |
| **SQL Server** con soporte (2019, 2022 o 2025). SQL Server **2016 dejó de recibir parches el 14 jul 2026**. **Azure SQL** siempre está al día | `componentes.js` |
| **npm audit** desde el panel (botón *Revisar dependencias*) o con `npm run auditoria` | `componentes.js`, `package.json` |
| `package-lock.json`: todos instalan exactamente las mismas versiones | raíz del proyecto |
| Pocas dependencias (5) y **ningún JavaScript de otros sitios** en el navegador | `package.json`, `public/js` |

**Cómo probarlo a mano**

1. **Panel → Seguridad OWASP → tarjeta A06 → Revisar dependencias** (necesita internet).
   ✅ Dice cuántas vulnerabilidades hay. Si sale alguna, en la terminal:
   ```
   npm audit fix
   ```
   y vuelve a dar clic.
2. En la terminal: `node -v` → debe ser 22, 24 o 26.
3. Si la tarjeta dice **SQL Server … sin soporte**, es un hallazgo real: la solución es actualizar a
   SQL Server 2022 o usar Azure SQL. Si no se puede en este semestre, documéntalo como **riesgo aceptado**.

---

## A07 · Fallas de identificación y autenticación

**Qué es:** que alguien pueda entrar como otra persona: adivinando contraseñas,
reusando una sesión olvidada, probando miles de combinaciones o averiguando qué correos existen.

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| **MFA obligatorio** (contraseña + código de 6 dígitos) | `src/rutas/auth.js` |
| **Bloqueo de cuenta**: 5 intentos fallidos → 15 minutos | `src/rutas/auth.js` |
| **Freno de fuerza bruta por IP**: más de 20 intentos en 15 min → se bloquea la IP y se registra *Fuerza bruta* | `src/seguridad/limitador.js` |
| **No revela qué correos existen**: misma respuesta y mismo tiempo para correo real o inventado | `src/rutas/auth.js` |
| **Código MFA de un solo uso**: un código ya usado no sirve otra vez | `src/seguridad/totp.js` |
| **Cierre por inactividad**: el token vence a los **15 min** sin actividad (se renueva solo mientras usas el sistema); máximo **8 h** por sesión | `src/seguridad/jwt.js`, `public/js/comun.js` |
| Aviso **1 minuto antes** con botón *Seguir conectado* | `public/js/comun.js` |
| **Contraseña débil detectada** al entrar (cuentas viejas o de prueba) → aviso para cambiarla | `src/rutas/auth.js` |
| **Cerrar sesión en los demás equipos** desde Mi perfil → Seguridad (con MFA) | `src/rutas/perfil.js` |

**Cómo probarlo a mano**

1. **Inactividad.** Inicia sesión y no toques nada **14 minutos**.
   ✅ Abajo aparece *"Por seguridad, tu sesión se cerrará en 60 s por inactividad"*.
   Si no das clic, te saca al login con *"Cerramos tu sesión porque pasaron 15 minutos sin actividad"*.
2. **Correo que no existe.** En el login escribe `noexiste@correo.com` y cualquier contraseña.
   ✅ Sale lo mismo que con un correo real: *"Usuario o contraseña incorrectos."*
3. **Cerrar sesiones.** Entra con el mismo usuario en **dos navegadores** (por ejemplo Brave y Edge;
   para el segundo espera a que cambie el código, porque cada código sirve una sola vez).
   En uno: **Mi perfil → Seguridad → Cerrar en los demás equipos** → código MFA.
   ✅ En el otro navegador, al recargar, te manda al login.
4. **Contraseña débil.** Si alguna cuenta de prueba todavía tiene una contraseña como `admin123`
   (de cuando se insertaron los datos), al entrar con ella sale un aviso rojo para cambiarla y
   queda *Contraseña débil* en **Seguridad**. Las contraseñas nuevas ya no pueden ser así.

---

## A08 · Fallas de integridad de software y datos

**Qué es:** que el sistema ejecute o confíe en código o datos que alguien alteró sin que nadie
se dé cuenta: un archivo `.js` modificado para robar contraseñas, un paquete de npm cambiado,
o un JSON "envenenado" que cambia el comportamiento del servidor.

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| **Código firmado**: `npm run firmar-codigo` guarda la huella SHA-256 de cada archivo en `integridad.json`, firmada con HMAC (llave derivada de `MFA_CLAVE`) | `src/seguridad/integridad-codigo.js`, `scripts/firmar-codigo.js` |
| Al arrancar y **cada 10 minutos** se comparan los archivos con su firma; si algo cambió → aviso en la consola, registro *Código modificado* y **alerta** | `src/seguridad/vigilancia.js` |
| Si alguien edita `integridad.json` para "tapar" su cambio, la firma deja de valer | `integridad-codigo.js` |
| Paquetes instalados = versión exacta de `package-lock.json`, que guarda el hash **sha512** de cada paquete (npm lo verifica al instalar) | `integridad-codigo.js` → `verificarDependencias` |
| **JSON envenenado**: se rechazan claves `__proto__`, `constructor`, `prototype` (contaminación de prototipo) y JSON de más de 8 niveles | `src/seguridad/datos-seguros.js` |
| Sesiones, bitácora y código llevan **firma**; los comprobantes se aceptan por su contenido y su SHA-256 queda en la bitácora | `jwt.js`, `cadena-bitacora.js`, `reservas.js` |

**Cómo probarlo a mano**

1. **Modificar un archivo del sistema.** Abre `C:\rancho\rancho-seco-app\public\js\login.js` con el Bloc de notas,
   agrega al final la línea `// prueba de integridad` y guarda. Reinicia el servidor (`Ctrl + C`, `npm start`).
   ✅ La consola dice *"⚠ El código cambió desde que se firmó (OWASP A08): public/js/login.js"*, la tarjeta **A08**
   muestra *El código cambió desde que se firmó* y aparece una **alerta** arriba en Seguridad.
   Para terminar: borra la línea que agregaste y guarda. Si al reiniciar todavía marca cambio (el Bloc de notas a veces
   cambia los saltos de línea), ejecuta `npm run firmar-codigo` → vuelve a *Código sin cambios*.
2. **JSON envenenado.** En el login, **F12 → Console**:
   ```js
   (await App.api('POST', '/api/auth/login', JSON.parse('{"correo":"a@x.com","contrasena":"x","__proto__":{"esAdmin":true}}'))).datos
   ```
   ✅ `{mensaje: 'La solicitud contiene datos no permitidos.'}` y en Seguridad: *JSON envenenado*.

> Si cambias el código **a propósito** (por ejemplo, una actualización), vuelve a firmarlo con `npm run firmar-codigo`.

---

## A09 · Fallas de registro y monitoreo

> La cadena protege los registros creados **desde que se ejecutó `sql/04`**. Los anteriores siguen protegidos por
> los triggers de solo escritura, pero no tienen firma.

**Qué es:** no registrar lo que pasa, que los registros se puedan borrar o falsificar, o que
nadie se entere a tiempo de un ataque.

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| **Bitácora encadenada**: cada registro lleva `Hash_Integridad = HMAC(firma del anterior + datos)`. Si alguien cambia, borra o inserta un registro directamente en la base de datos, la cadena se rompe y se detecta | `src/seguridad/cadena-bitacora.js`, `src/bitacora.js`, `sql/04_integridad_y_monitoreo.sql` |
| La llave de la firma sale de `MFA_CLAVE` (.env): quien tenga acceso a la base de datos **no** puede fabricar firmas válidas | `src/seguridad/llaves.js` |
| **Solo escritura**: triggers de SQL Server impiden `UPDATE` y `DELETE` sobre la bitácora (el panel lo **prueba** de verdad) | `sql/04…`, `src/rutas/seguridad.js` |
| **Alertas automáticas**: 5 eventos sospechosos de una IP en 10 min, fuerza bruta, bloqueo de un admin, SSRF, código modificado o bitácora alterada → alerta en la consola y en el panel (con número rojo en el menú) hasta que alguien la marca como atendida | `src/seguridad/monitor.js` |
| **Respaldo en archivo**: cada registro también va a `almacen/registros/bitacora-AAAA-MM-DD.log` (90 días), aunque falle la base de datos (en Vercel ese archivo es temporal) | `src/seguridad/archivo-registro.js` |
| **Anti "log injection"**: saltos de línea y caracteres de control se neutralizan, así nadie puede "fabricar" renglones falsos | `src/bitacora.js` → `texto()` |
| Sin datos sensibles (contraseñas, hashes, secretos, tokens, códigos) | `src/bitacora.js` |

**Cómo probarlo a mano**

1. **Revisar la cadena desde la terminal.** En otra terminal: `npm run verificar-bitacora`.
   ✅ *"✔ La bitácora está íntegra: ningún registro fue modificado, borrado ni insertado a mano."*
2. **Alterar la bitácora como lo haría un atacante con acceso a la base.** En SSMS (con la cuenta de administrador):
   ```sql
   UPDATE Bitacora SET Descripcion = 'nada' WHERE idBitacora = (SELECT MAX(idBitacora) FROM Bitacora);
   ```
   ✅ SQL Server responde *Msg 50001: La bitacora no se puede modificar* (el trigger lo impide).
3. **Si el atacante quita el trigger:**
   ```sql
   DROP TRIGGER tr_bitacora_no_editar;
   UPDATE Bitacora SET Descripcion = N'Inicio de sesión normal'
    WHERE idBitacora = (SELECT MAX(idBitacora) FROM Bitacora WHERE Hash_Integridad IS NOT NULL);
   ```
   Ahora en Panel → Seguridad OWASP da clic en **Actualizar**.
   ✅ La tarjeta **A09** marca *Bitácora alterada: El registro #N no coincide con su firma* y *Falta el trigger que impide editar*,
   y aparece una **alerta**. `npm run verificar-bitacora` también lo dice.
   Para terminar: vuelve a crear el trigger ejecutando `sql/04_integridad_y_monitoreo.sql` en SSMS
   y da clic en **Marcar alteraciones como revisadas** (la evidencia queda en la bitácora).
4. **Alertas.** Corre `npm run prueba-owasp`: con tantos ataques desde tu IP se crea la alerta
   *"Posible ataque: 5 eventos de seguridad desde la IP…"*. Aparece arriba en Seguridad y con un número rojo en el menú.
   Da clic en **Marcar como atendida**.
5. **Respaldo en archivo.** Abre `C:\rancho\rancho-seco-app\almacen\registros\` → hay un `bitacora-AAAA-MM-DD.log`
   con una línea por registro.

---

## A10 · Server-Side Request Forgery (SSRF)

**Qué es:** cuando el **servidor** descarga algo de un enlace que escribió un usuario, un atacante
puede darle un enlace **interno** que solo el servidor puede ver: la propia app (`localhost`), el
router (`192.168.1.1`), otra base de datos o las **credenciales de AWS** (`169.254.169.254`).

**Dónde aplica en el sistema:** Reservas → botón de **cadena** (🔗) *Comprobante desde enlace*. El
administrador pega el enlace del comprobante y el servidor lo descarga. Es la única función que hace eso.

**Cómo lo evitamos**

| Control | Dónde está |
|---|---|
| Solo `https://`, puerto 443, sin `usuario:contraseña@` | `src/seguridad/ssrf.js` → `revisarUrl` |
| Bloquea IPs internas aunque vengan "disfrazadas" (`0x7f000001`, `2130706433`, `127.1`, `[::ffff:127.0.0.1]`) y nombres como `localhost`, `*.local`, `*.internal` | `ssrf.js` (usa `net.BlockList`) |
| **Revisa el DNS**: si el dominio apunta a una IP interna (ej. `localtest.me` → 127.0.0.1), se rechaza | `ssrf.js` → `resolverSeguro` |
| **Se conecta a la IP ya revisada** (evita *DNS rebinding*) | `ssrf.js` → `pedir` |
| Cada **redirección** se revisa como un enlace nuevo (máximo 3) | `ssrf.js` → `descargarSeguro` |
| Máximo **8 s** y **5 MB**; solo se guarda si el contenido es PNG, JPG o PDF | `ssrf.js`, `reservas.js` |
| Cada intento bloqueado queda como *Intento de SSRF* y crea una **alerta** | `reservas.js`, `monitor.js` |
| Opcional: lista de dominios permitidos `SSRF_DOMINIOS` en `.env` | `ssrf.js` |

**Cómo probarlo a mano**

1. Como **admin** → **Reservas**. En una reserva **con pago**, da clic en el botón de la **cadena** (🔗).
2. Pega cada enlace y da clic en **Descargar comprobante**:

| Enlace | Qué debe decir |
|---|---|
| `http://localhost:3000/.env` | *Solo se permiten enlaces https://* |
| `https://127.0.0.1/` | *Ese enlace apunta a una dirección interna…* |
| `https://0x7f000001/` (127.0.0.1 en hexadecimal) | *Ese enlace apunta a una dirección interna…* |
| `https://169.254.169.254/latest/meta-data/` (AWS) | *Ese enlace apunta a una dirección interna…* |
| `https://192.168.1.1/` | *Ese enlace apunta a una dirección interna…* |
| `https://localtest.me/` | *Ese dominio apunta a una dirección interna…* |
| `https://servidor.local/` | *Ese enlace apunta a un nombre interno de la red.* |

3. Ahora un enlace **público** de una imagen, por ejemplo
   `https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png`.
   ✅ *"Comprobante descargado y guardado."* y el botón cambia a **Ver comprobante**.
4. En **Seguridad** → tarjeta **A10** cuenta los intentos, y arriba aparece la alerta *Intento de SSRF*.

---

## Módulos deportivos (v6): cómo se protegen

| Riesgo | Equipos · Árbitros · Pagos · Limpieza · Reportes |
|---|---|
| **A01** | Cada ruta exige sesión. Las del panel exigen **Administrador**; `/api/arbitraje` solo el rol **Árbitro** y `/api/limpieza` solo **Personal de limpieza** (o administrador). Si un árbitro intenta responder una asignación que no es suya, o el personal de limpieza intenta "atender" un reporte (función de administrador), **se cierra su sesión** y queda la alerta. |
| **A03** | Todas las consultas usan parámetros (`:nombre`); los textos libres (tipo de problema, motivo de rechazo, notas) se muestran con `textContent`, nunca como HTML. |
| **A04** | Reglas en el servidor: no se programan dos partidos en la misma cancha/hora, un equipo no juega dos partidos a la vez, un árbitro no queda en dos partidos al mismo tiempo, la cancha debe ser de la modalidad del torneo, no se paga dos veces la misma reserva, no se borra un equipo con historial. |
| **A08** | Los comprobantes se revisan por su contenido (PNG, JPG o PDF reales) y se guarda su huella SHA-256. |
| **A09** | Programar, editar, eliminar, asignar, confirmar, rechazar, reasignar, pagar, validar, marcar discrepancia, tareas, reportes y exportaciones quedan en la bitácora firmada. Reportes → *Bitácora de auditoría* lo muestra. |

### Corrección: "Ocurrió un error inesperado" en Seguridad OWASP

La conexión de la app usaba la intercalación `utf8mb4_general_ci` y las tablas `utf8mb4_0900_ai_ci`.
Al comparar las alertas atendidas MySQL respondía *Illegal mix of collations* y la sección no cargaba.
Ahora `config/db.js` usa la misma intercalación que las tablas, la comparación se hace sin mezclar
intercalaciones y cada revisión del panel está aislada: si una falla, las demás tarjetas se muestran igual.

---

## Dónde verlo todo

- **Panel → Seguridad OWASP:** 10 tarjetas (A01 a A10), las **alertas** sin atender arriba y los eventos recientes abajo.
- **Panel → Bitácora:** filtra por Módulo = *Seguridad* para ver cada intento con fecha, IP y detalle.
- **`npm start`:** avisa en la consola si algo de la configuración está mal (A05), si el código cambió (A08) o si la bitácora fue alterada (A09).
- **`npm run prueba-owasp`:** alrededor de 75 pruebas de ataque contra tu servidor.
- **`npm run verificar-bitacora`:** revisa la cadena de firmas de la bitácora.
- **`npm run firmar-codigo`:** vuelve a firmar el código después de un cambio hecho a propósito.
- **`npm test`:** 58 pruebas automáticas del código.
