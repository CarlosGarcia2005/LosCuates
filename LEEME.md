# Gestor Deportivo Rancho Seco — v6

Login con **MFA (JWT)**, **panel de Administrador** (dashboard, reservas, pagos, canchas, equipos,
árbitros, limpieza, usuarios, roles, reportes, Seguridad OWASP y bitácora) y **Mi perfil** para
cada usuario (datos, seguridad personal y, según su rol, *Mis partidos* o *Limpieza*).

## Estructura

```
rancho-seco-app/
├── server.js                    ← arranque, cabeceras, rutas y manejo de errores (en Vercel solo exporta la app)
├── api/index.js, vercel.json    ← publicación en Vercel (toda petición que no sea de public/ va a Express)
├── config/db.js                 ← conexión a SQL Server / Azure SQL (paquete mssql, parámetros @nombre)
├── sql/02_seguridad_y_bitacora.sql  ← columnas MFA, tabla Bitacora y triggers
├── sql/03_canchas_y_reservas.sql    ← catálogos, equipo en Reserva, comprobante en Pago, canchas de ejemplo
├── sql/04_integridad_y_monitoreo.sql← bitácora encadenada y monitoreo (OWASP A08/A09)
├── sql/05_modulos_deportivos.sql    ← Equipos, Árbitros, Pagos, Limpieza, Reportes y comprobantes en la base (NUEVO)
├── src/
│   ├── seguridad/               ← scrypt, TOTP, AES-256-GCM, JWT, cabeceras, límites, monitoreo…
│   ├── servicios/pagos.js       ← reglas de pago compartidas por Reservas y Pagos
│   ├── reportes/pdf.js, xlsx.js ← generadores de PDF y Excel (sin librerías externas)
│   ├── funciones.js             ← qué puede hacer cada rol (Árbitro, Personal de limpieza, Cliente)
│   ├── rutas/auth.js            ← /api/auth  (login, mfa, sesion, logout)
│   ├── rutas/admin.js           ← /api/admin (dashboard, usuarios, roles, bitácora)
│   ├── rutas/canchas.js         ← /api/admin/canchas
│   ├── rutas/reservas.js        ← /api/admin/reservas (reservas, pagos, comprobantes, CSV)
│   ├── rutas/pagos.js           ← /api/admin/pagos (pagos de partidos, validación, discrepancias, CSV)
│   ├── rutas/equipos.js         ← /api/admin/equipos
│   ├── rutas/arbitros.js        ← /api/admin/arbitros (partidos, torneos, asignación, historial, reasignar)
│   ├── rutas/arbitraje.js       ← /api/arbitraje (el árbitro confirma o rechaza sus partidos)
│   ├── rutas/limpieza.js        ← /api/limpieza (tareas y reportes de condición)
│   ├── rutas/reportes.js        ← /api/admin/reportes (gráficas, movimientos, auditoría, PDF/Excel)
│   ├── rutas/seguridad.js       ← /api/admin/seguridad (panel Seguridad OWASP)
│   ├── rutas/perfil.js          ← /api/perfil (ver/editar datos, cambiar contraseña)
│   ├── autenticacion.js         ← requiereSesion / requiereAdmin / requiereFuncion
│   ├── bitacora.js              ← registro de movimientos (firmado en cadena)
│   └── errores.js               ← manejo controlado de errores
├── public/
│   ├── js/validacion.js         ← reglas de validación (las usan navegador Y servidor)
│   ├── js/ui.js                 ← piezas comunes de los módulos nuevos (iconos, fechas, paginación)
│   ├── js/equipos.js, arbitros.js, pagos.js, limpieza.js, reportes.js, mis-partidos.js
│   └── css/app.css, modulos.css
├── views/                       ← admin.html, perfil.html, 404.html, 500.html
└── test/                        ← pruebas: npm test
```

## Arranque rápido (instalación nueva)

1. En SSMS, conectado a la base del proyecto (en Azure: clic derecho en la base → *Nueva consulta*),
   ejecutar en orden `02`, `03`, `04` y `05` de la carpeta `sql`. Los que ya se ejecutaron se pueden saltar
   (o volver a correr: no borran datos).
2. `npm install`
3. `copy .env.example .env` y llenar los datos (`npm run generar-claves` para JWT_SECRET y MFA_CLAVE).
   Con Azure SQL: `DB_HOST=tuservidor.database.windows.net`, `DB_PORT=1433` y `DB_CIFRADO=1`.
4. `npm run firmar-codigo`
5. `npm start` → http://localhost:3000

## Publicar en Vercel

- Framework Preset: **Other**. Node 24 (lo fija `package.json`).
- Variables de entorno: las mismas del `.env` con `NODE_ENV=production`, `TRUST_PROXY=1` y `DB_CIFRADO=1` (sin `PORT`).
- Cada `git push` a `main` publica solo. Los comprobantes de pago se guardan en la tabla `Comprobante_Archivo`
  (Vercel no conserva archivos en disco).

## Módulos nuevos (v6)

| Módulo | Quién lo usa | Qué hace |
|---|---|---|
| **Equipos** | Administrador | Alta, edición y eliminación de equipos con su usuario responsable (rol Cliente). No deja borrar equipos con historial. |
| **Árbitros** | Administrador | Programar partidos (aparta la cancha con una reserva y folio automático), crear torneos, asignar el cuerpo arbitral (Fútbol 7: 1 central; Fútbol 11: central, 2 abanderados y cuarto árbitro), **Editar/Eliminar** partidos, **Ver historial** y **Reasignar árbitro** cuando alguien rechaza. |
| **Mis partidos** | Rol *Árbitro* (Mi perfil) | Confirmar o rechazar (con motivo) cada partido asignado. |
| **Pagos** | Administrador | Pagos del día, indicadores, validación de comprobantes, discrepancias y exportación CSV. **Registrar pago** abre una ventana para cobrar partidos de torneo (la reserva del partido se toma sola). |
| **Limpieza** | Administrador y rol *Personal de limpieza* (Mi perfil) | Partidos del día, tareas de limpieza (ventana *Nueva tarea*), reportes de condición de cancha (el tipo de problema es texto libre) y alertas urgentes. |
| **Reportes** | Administrador | Ingresos por día/semana/mes, ingresos por cancha, movimientos y bitácora de auditoría; exporta PDF y Excel. |

Todo sale de los mismos datos: un pago cuenta como ingreso si está *Pagado* o *Validado* y su reserva no está
cancelada, y esa regla es la misma en Dashboard, Reservas, Pagos y Reportes.

## Las dos "Seguridad"

- **Panel → Seguridad OWASP** (solo administradores): estado de los 10 riesgos del OWASP Top 10 para **todo el sistema** y alertas de ataques.
- **Mi perfil → Seguridad** (todos): **tu** contraseña y tus sesiones abiertas.

## Seguridad OWASP Top 10 (A01 a A10)

- `npm run prueba-owasp` ataca tu servidor y comprueba que todo se rechace.
- `npm run auditoria` revisa los paquetes con npm audit.
- `npm run firmar-codigo` firma el código (A08); `npm run verificar-bitacora` revisa la cadena de la bitácora (A09).
- Explicación completa, modelo de amenazas y pruebas a mano: **GUIA_OWASP.md**.
