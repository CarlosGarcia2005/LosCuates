-- =====================================================================
--  Gestor Deportivo Rancho Seco  (SQL Server)
--  03 - Canchas y Reservas
-- ---------------------------------------------------------------------
--  * Requiere haber ejecutado antes 02_seguridad_y_bitacora.sql
--  * Ejecútalo completo con F5 (sin seleccionar texto) y con una cuenta
--    que pueda modificar tablas (Autenticación de Windows o sa).
--  * Se puede ejecutar más de una vez. NO borra datos.
-- =====================================================================
SET NOCOUNT ON;
GO

-- ---------------------------------------------------------------------
-- 1. Catálogos que necesitan Canchas y Reservas (solo agrega los que falten)
-- ---------------------------------------------------------------------
INSERT INTO dbo.Tipo_Cancha (Tipo_Cancha)
SELECT v.nombre FROM (VALUES (N'Fútbol 7'), (N'Fútbol 11')) v(nombre)
 WHERE NOT EXISTS (SELECT 1 FROM dbo.Tipo_Cancha x WHERE x.Tipo_Cancha = v.nombre);

INSERT INTO dbo.Metodo_Pago (Metodo_Pago)
SELECT v.nombre FROM (VALUES (N'Efectivo'), (N'Transferencia'),
                             (N'Tarjeta de débito'), (N'Tarjeta de crédito')) v(nombre)
 WHERE NOT EXISTS (SELECT 1 FROM dbo.Metodo_Pago x WHERE x.Metodo_Pago = v.nombre);

INSERT INTO dbo.Estado_Reserva (Estado_Reserva)
SELECT v.nombre FROM (VALUES (N'Pendiente'), (N'Confirmada'),
                             (N'Cancelada'), (N'Finalizada')) v(nombre)
 WHERE NOT EXISTS (SELECT 1 FROM dbo.Estado_Reserva x WHERE x.Estado_Reserva = v.nombre);
GO

-- ---------------------------------------------------------------------
-- 2. Canchas: estados "Activa" / "Inactiva"
--    (las que decían "Disponible" pasan a "Activa")
-- ---------------------------------------------------------------------
UPDATE dbo.Cancha SET Estado_Cancha = 'Activa'   WHERE Estado_Cancha = 'Disponible';
UPDATE dbo.Cancha SET Estado_Cancha = 'Inactiva' WHERE Estado_Cancha IN ('Mantenimiento', 'Fuera de servicio');
GO

-- Valor por omisión: 'Activa' (quita el anterior, sea cual sea su nombre)
DECLARE @restriccion SYSNAME = (
  SELECT dc.name FROM sys.default_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
   WHERE dc.parent_object_id = OBJECT_ID('dbo.Cancha') AND c.name = 'Estado_Cancha');
IF @restriccion IS NOT NULL
  EXEC('ALTER TABLE dbo.Cancha DROP CONSTRAINT ' + @restriccion);
ALTER TABLE dbo.Cancha ADD CONSTRAINT df_cancha_estado DEFAULT ('Activa') FOR Estado_Cancha;
GO

-- Nombre de cancha único (solo si todavía no hay nombres repetidos)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_cancha_nombre' AND object_id = OBJECT_ID('dbo.Cancha'))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dbo.Cancha GROUP BY Cancha HAVING COUNT(*) > 1)
  BEGIN
    CREATE UNIQUE INDEX uq_cancha_nombre ON dbo.Cancha (Cancha);
    PRINT 'Índice único de nombre de cancha creado.';
  END
  ELSE PRINT 'OJO: hay nombres de cancha repetidos; no se creó el índice único.';
END
ELSE PRINT 'El índice uq_cancha_nombre ya existe.';
GO

-- ---------------------------------------------------------------------
-- 3. Reserva: equipo (opcional) para el que se aparta la cancha
-- ---------------------------------------------------------------------
IF COL_LENGTH('dbo.Reserva', 'idEquipo') IS NULL
BEGIN
  EXEC('ALTER TABLE dbo.Reserva ADD idEquipo INT NULL');
  EXEC('ALTER TABLE dbo.Reserva ADD CONSTRAINT fk_reserva_equipo
          FOREIGN KEY (idEquipo) REFERENCES dbo.Equipo (idEquipo)');
  PRINT 'Reserva.idEquipo agregada.';
END
ELSE PRINT 'Reserva.idEquipo ya existe.';
GO

-- Índice para buscar rápido los horarios ocupados de una cancha en un día
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_reserva_cancha_fecha' AND object_id = OBJECT_ID('dbo.Reserva'))
  CREATE INDEX ix_reserva_cancha_fecha ON dbo.Reserva (idCancha, Fecha_Reserva);
GO

-- ---------------------------------------------------------------------
-- 4. Pago: archivo del comprobante (se guarda en disco; aquí solo el nombre)
-- ---------------------------------------------------------------------
IF COL_LENGTH('dbo.Pago', 'Comprobante') IS NULL
BEGIN
  EXEC('ALTER TABLE dbo.Pago ADD Comprobante VARCHAR(100) NULL');
  PRINT 'Pago.Comprobante agregada.';
END
ELSE PRINT 'Pago.Comprobante ya existe.';
GO

-- ---------------------------------------------------------------------
-- 5. Canchas de ejemplo (solo si la tabla está vacía)
-- ---------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.Cancha)
  INSERT INTO dbo.Cancha (idTipo_Cancha, Cancha, Estado_Cancha)
  SELECT (SELECT TOP (1) idTipo_Cancha FROM dbo.Tipo_Cancha WHERE Tipo_Cancha = c.tipo), c.nombre, c.estado
    FROM (VALUES (N'Naranja',  N'Fútbol 7',  'Activa'),
                 (N'Amarilla', N'Fútbol 7',  'Activa'),
                 (N'Completa', N'Fútbol 11', 'Activa')) c(nombre, tipo, estado);
GO

-- ---------------------------------------------------------------------
-- 6. Triggers de auditoría de Reserva y Pago con las columnas nuevas
-- ---------------------------------------------------------------------

-- ---------- Pago (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_pago_ins ON dbo.Pago AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Pago',
         LEFT(CAST(i.idPago AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Pago (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago, x.Comprobante AS Comprobante FROM inserted x WHERE x.idPago = i.idPago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Pago (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_pago_upd ON dbo.Pago AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Pago',
         LEFT(CAST(i.idPago AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Pago (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago, x.Comprobante AS Comprobante FROM deleted x WHERE x.idPago = i.idPago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago, x.Comprobante AS Comprobante FROM inserted x WHERE x.idPago = i.idPago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idPago = i.idPago;
END
GO

-- ---------- Pago (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_pago_del ON dbo.Pago AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Pago',
         LEFT(CAST(d.idPago AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Pago (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago, x.Comprobante AS Comprobante FROM deleted x WHERE x.idPago = d.idPago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Reserva (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_reserva_ins ON dbo.Reserva AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Reserva',
         LEFT(CAST(i.idReserva AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Reserva (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idReserva AS idReserva, x.idUsuario AS idUsuario, x.idEquipo AS idEquipo, x.idPago AS idPago, x.idCancha AS idCancha, x.idEstado_Reserva AS idEstado_Reserva, x.Folio AS Folio, x.Fecha_Reserva AS Fecha_Reserva, x.Hora_Inicio AS Hora_Inicio, x.Hora_Fin AS Hora_Fin, x.Fecha_Registro AS Fecha_Registro, x.Descripcion AS Descripcion FROM inserted x WHERE x.idReserva = i.idReserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Reserva (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_reserva_upd ON dbo.Reserva AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Reserva',
         LEFT(CAST(i.idReserva AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Reserva (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idReserva AS idReserva, x.idUsuario AS idUsuario, x.idEquipo AS idEquipo, x.idPago AS idPago, x.idCancha AS idCancha, x.idEstado_Reserva AS idEstado_Reserva, x.Folio AS Folio, x.Fecha_Reserva AS Fecha_Reserva, x.Hora_Inicio AS Hora_Inicio, x.Hora_Fin AS Hora_Fin, x.Fecha_Registro AS Fecha_Registro, x.Descripcion AS Descripcion FROM deleted x WHERE x.idReserva = i.idReserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idReserva AS idReserva, x.idUsuario AS idUsuario, x.idEquipo AS idEquipo, x.idPago AS idPago, x.idCancha AS idCancha, x.idEstado_Reserva AS idEstado_Reserva, x.Folio AS Folio, x.Fecha_Reserva AS Fecha_Reserva, x.Hora_Inicio AS Hora_Inicio, x.Hora_Fin AS Hora_Fin, x.Fecha_Registro AS Fecha_Registro, x.Descripcion AS Descripcion FROM inserted x WHERE x.idReserva = i.idReserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idReserva = i.idReserva;
END
GO

-- ---------- Reserva (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_reserva_del ON dbo.Reserva AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Reserva',
         LEFT(CAST(d.idReserva AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Reserva (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idReserva AS idReserva, x.idUsuario AS idUsuario, x.idEquipo AS idEquipo, x.idPago AS idPago, x.idCancha AS idCancha, x.idEstado_Reserva AS idEstado_Reserva, x.Folio AS Folio, x.Fecha_Reserva AS Fecha_Reserva, x.Hora_Inicio AS Hora_Inicio, x.Hora_Fin AS Hora_Fin, x.Fecha_Registro AS Fecha_Registro, x.Descripcion AS Descripcion FROM deleted x WHERE x.idReserva = d.idReserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- =====================================================================
-- 7. VERIFICACIÓN
-- =====================================================================
SELECT idTipo_Cancha, Tipo_Cancha FROM dbo.Tipo_Cancha ORDER BY idTipo_Cancha;
SELECT idMetodo_Pago, Metodo_Pago FROM dbo.Metodo_Pago ORDER BY idMetodo_Pago;
SELECT idEstado_Reserva, Estado_Reserva FROM dbo.Estado_Reserva ORDER BY idEstado_Reserva;

SELECT c.idCancha, c.Cancha, t.Tipo_Cancha, c.Estado_Cancha
  FROM dbo.Cancha c JOIN dbo.Tipo_Cancha t ON t.idTipo_Cancha = c.idTipo_Cancha
 ORDER BY c.Cancha;

SELECT CASE WHEN COL_LENGTH('dbo.Reserva', 'idEquipo')   IS NULL THEN 0 ELSE 1 END
     + CASE WHEN COL_LENGTH('dbo.Pago',    'Comprobante') IS NULL THEN 0 ELSE 1 END AS Columnas_Nuevas;
GO
