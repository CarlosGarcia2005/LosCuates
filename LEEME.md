# Gestor Deportivo Rancho Seco — v2

Login con **MFA (JWT)**, **panel de Administrador** (dashboard, usuarios, roles y bitácora)
y **panel de Usuario** (perfil y edición de datos personales con MFA).

## Estructura

```
rancho-seco-app/
├── server.js                    ← arranque, cabeceras, rutas y manejo de errores
├── config/db.js                 ← conexión a SQL Server (paquete mssql)
├── sql/02_seguridad_y_bitacora.sql  ← columnas MFA, tabla Bitacora y triggers (correr 1 vez en SSMS)
├── sql/03_canchas_y_reservas.sql    ← catálogos, equipo en Reserva, comprobante en Pago, canchas de ejemplo
├── src/
│   ├── seguridad/
│   │   ├── contrasena.js        ← hash scrypt (+ migración automática de SHA-256)
│   │   ├── totp.js              ← códigos MFA (RFC 6238, Google/Microsoft Authenticator)
│   │   ├── cifrado.js           ← AES-256-GCM para guardar el secreto MFA
│   │   ├── jwt.js               ← tokens JWT en cookies httpOnly
│   │   ├── cabeceras.js         ← CSP, X-Frame-Options, nosniff, HSTS, anti-CSRF…
│   │   └── limitador.js         ← límite de intentos por IP
│   ├── rutas/auth.js            ← /api/auth  (login, mfa, sesion, logout)
│   ├── rutas/admin.js           ← /api/admin (dashboard, usuarios, roles, bitácora)
│   ├── rutas/canchas.js         ← /api/admin/canchas (alta, edición, eliminación)
│   ├── rutas/reservas.js        ← /api/admin/reservas (reservas, pagos, comprobantes, CSV)
│   ├── rutas/perfil.js          ← /api/perfil (ver/editar datos, cambiar contraseña)
│   ├── autenticacion.js         ← requiereSesion / requiereAdmin
│   ├── bitacora.js              ← registro de movimientos
│   ├── errores.js               ← manejo controlado de errores
│   └── usuarios.js              ← consultas reutilizables
├── public/                      ← login, estilos y JavaScript del navegador
│   └── js/validacion.js         ← reglas de validación (las usan navegador Y servidor)
├── views/                       ← admin.html, perfil.html, 404.html, 500.html
└── test/seguridad.test.js       ← pruebas: npm test
```

## Cómo se cumple cada requisito

| Requisito | Dónde |
|---|---|
| Validar formularios | `public/js/validacion.js` (mismo código en navegador y servidor) |
| MFA Login (JWT) | `src/rutas/auth.js`: contraseña → código TOTP → JWT en cookie httpOnly |
| Hash | `src/seguridad/contrasena.js` (scrypt con sal); secreto MFA cifrado con AES-256-GCM |
| Cabeceras de seguridad | `src/seguridad/cabeceras.js` |
| Manejo controlado de errores | `src/errores.js` + páginas `404.html` y `500.html` |
| Bitácora completa | `src/bitacora.js` (app) + triggers en las 14 tablas (cambios hechos desde SSMS u otra herramienta) |
| Usuario sin permisos administrativos | `requiereAdmin` en el servidor + bloqueo de campos rol/estado en `/api/perfil` |

## Arranque rápido (SQL Server)

1. Abrir `sql/02_seguridad_y_bitacora.sql` en **SSMS**, elegir la base
   `GestorDeportivoRanchoSeco` y ejecutarlo completo con **F5**.
   Hay que estar conectado con **Autenticación de Windows** o `sa`: el script
   agrega columnas y crea triggers, y `rancho_app` no tiene ese permiso.
2. `npm install`
3. `copy .env.example .env` y llenar los datos (`npm run generar-claves` para JWT_SECRET y MFA_CLAVE).
   - Instancia con nombre: `DB_HOST=LAPTOP-85A5C471\SQLCARLOS` y `DB_PORT` vacío
     (necesita el servicio **SQL Server Browser** encendido).
   - Instancia por defecto: `DB_HOST=localhost` y `DB_PORT=1433`.
   - El usuario de `.env` (`rancho_app`) necesita permisos de lectura y escritura
     sobre las tablas; no necesita permisos de administrador.
4. `npm start` → http://localhost:3000

## Canchas y Reservas (solo administradores)

1. Ejecutar `sql/03_canchas_y_reservas.sql` en SSMS (después del 02, con la misma cuenta).
2. Reiniciar el servidor (`npm start`).
3. En el menú del administrador aparecen **Reservas** y **Canchas**.

> El script 03 cambia el estado de las canchas de `Disponible` a **`Activa`**,
> que es el valor que usa la aplicación.

## Notas de SQL Server

- Necesita **SQL Server 2016 o más nuevo** (usa `FOR JSON` en los triggers,
  `CREATE OR ALTER` y `OFFSET … FETCH` para la paginación).
- Los parámetros de las consultas se escriben con `@nombre` (`config/db.js` los
  envía con su tipo; nunca se concatena texto en el SQL).
- La aplicación se conecta con el nombre `RanchoSecoApp`. Los triggers de
  auditoría lo leen con `APP_NAME()`: así solo registran los cambios hechos
  **fuera** de la aplicación (SSMS, sqlcmd…), porque los de la app ya se
  registran desde Node con más detalle.
- Las contraseñas viejas en SHA-256 (las que se insertaron con `HASHBYTES`)
  siguen funcionando: al iniciar sesión se convierten solas a scrypt.

Los comprobantes de pago se guardan en la carpeta `almacen/comprobantes` (no se sube al repositorio).
