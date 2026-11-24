-- =====================================================================
--  Gestor Deportivo Rancho Seco  (SQL Server / Azure SQL)
--  05 - Módulos deportivos: Equipos, Árbitros, Pagos, Limpieza y Reportes
-- ---------------------------------------------------------------------
--  * Abre este archivo en SSMS, elige la base del proyecto (en Azure:
--    clic derecho en la base → Nueva consulta) y ejecútalo completo con F5.
--  * Requiere haber ejecutado antes 02, 03 y 04.
--  * Se puede ejecutar más de una vez. NO borra datos.
-- =====================================================================
SET NOCOUNT ON;
GO

-- ---------------------------------------------------------------------
-- 1. Roles que usan los módulos nuevos (solo agrega los que falten)
--    Cliente              → responsable de un equipo (Equipos)
--    Árbitro              → recibe partidos y los confirma o rechaza (Árbitros)
--    Personal de limpieza → tareas y reportes de condición de canchas (Limpieza)
-- ---------------------------------------------------------------------
INSERT INTO dbo.Rol (Rol, Nivel_Acceso)
SELECT v.nombre, 'Usuario'
  FROM (VALUES (N'Cliente'), (N'Árbitro'), (N'Personal de limpieza')) v(nombre)
 WHERE NOT EXISTS (SELECT 1 FROM dbo.Rol x WHERE x.Rol = v.nombre);
GO

-- ---------------------------------------------------------------------
-- 2. Equipo: nombre único (solo si todavía no hay nombres repetidos)
-- ---------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_equipo_nombre' AND object_id = OBJECT_ID('dbo.Equipo'))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dbo.Equipo GROUP BY Equipo HAVING COUNT(*) > 1)
  BEGIN
    CREATE UNIQUE INDEX uq_equipo_nombre ON dbo.Equipo (Equipo);
    PRINT 'Índice único de nombre de equipo creado.';
  END
  ELSE PRINT 'OJO: hay nombres de equipo repetidos; no se creó el índice único.';
END
ELSE PRINT 'El índice uq_equipo_nombre ya existe.';
GO

-- ---------------------------------------------------------------------
-- 3. Pago: estado, referencia y revisión del comprobante
--    Pagado            = efectivo, se cobra al momento
--    Pendiente         = transferencia o tarjeta esperando validación
--    Validado          = transferencia o tarjeta revisada por un administrador
--    Con discrepancia  = el comprobante o el monto no coinciden
-- ---------------------------------------------------------------------
IF COL_LENGTH('dbo.Pago', 'Estado_Pago') IS NULL
BEGIN
  ALTER TABLE dbo.Pago ADD
    Estado_Pago    VARCHAR(20)   NULL,
    Referencia     NVARCHAR(60)  NULL,
    Nota_Revision  NVARCHAR(255) NULL,
    Fecha_Revision DATETIME      NULL;
  PRINT 'Columnas nuevas de Pago agregadas.';
END
ELSE PRINT 'Las columnas nuevas de Pago ya existen.';
GO

-- Estado de los pagos que ya existían (solo los que aún no tienen estado)
UPDATE p
   SET p.Estado_Pago = CASE
         WHEN m.Metodo_Pago LIKE '%efectivo%' THEN 'Pagado'
         WHEN r.idReserva IS NULL THEN 'Validado'
         WHEN e.Estado_Reserva IN ('Confirmada', 'Finalizada') THEN 'Validado'
         ELSE 'Pendiente' END
  FROM dbo.Pago p
  JOIN dbo.Metodo_Pago m ON m.idMetodo_Pago = p.idMetodo_Pago
  LEFT JOIN dbo.Reserva r ON r.idPago = p.idPago
  LEFT JOIN dbo.Estado_Reserva e ON e.idEstado_Reserva = r.idEstado_Reserva
 WHERE p.Estado_Pago IS NULL;
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Pago') AND name = 'Estado_Pago' AND is_nullable = 1)
  ALTER TABLE dbo.Pago ALTER COLUMN Estado_Pago VARCHAR(20) NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE parent_object_id = OBJECT_ID('dbo.Pago')
                  AND parent_column_id = COLUMNPROPERTY(OBJECT_ID('dbo.Pago'), 'Estado_Pago', 'ColumnId'))
  ALTER TABLE dbo.Pago ADD CONSTRAINT df_pago_estado DEFAULT ('Pendiente') FOR Estado_Pago;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'ck_pago_estado')
   AND NOT EXISTS (SELECT 1 FROM dbo.Pago WHERE Estado_Pago NOT IN ('Pagado', 'Pendiente', 'Validado', 'Con discrepancia'))
  ALTER TABLE dbo.Pago ADD CONSTRAINT ck_pago_estado CHECK (Estado_Pago IN ('Pagado', 'Pendiente', 'Validado', 'Con discrepancia'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_pago_fecha' AND object_id = OBJECT_ID('dbo.Pago'))
  CREATE INDEX ix_pago_fecha ON dbo.Pago (Fecha_Pago);
GO

-- Comprobantes de pago (PNG, JPG o PDF). Se guardan en la base y no en disco
-- para que funcionen igual en la computadora y en Vercel.
IF OBJECT_ID('dbo.Comprobante_Archivo', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Comprobante_Archivo (
    Nombre    VARCHAR(40)    NOT NULL,           -- el mismo que Pago.Comprobante (32 letras + extensión)
    Contenido VARBINARY(MAX) NOT NULL,
    Tamano    INT            NOT NULL,
    Fecha     DATETIME       NOT NULL CONSTRAINT df_comprobante_fecha DEFAULT (GETDATE()),
    CONSTRAINT pk_comprobante_archivo PRIMARY KEY (Nombre)
  );
  PRINT 'Tabla Comprobante_Archivo creada.';
END
ELSE PRINT 'La tabla Comprobante_Archivo ya existe.';
GO

-- ---------------------------------------------------------------------
-- 4. Juego: cada partido aparta su cancha con una reserva (folio RES-xxxxx)
--    Así Reservas, Pagos, Limpieza y Reportes ven el mismo horario ocupado.
-- ---------------------------------------------------------------------
IF COL_LENGTH('dbo.Juego', 'idReserva') IS NULL
BEGIN
  -- Mismo tipo de dato que Reserva.idReserva
  DECLARE @tipo NVARCHAR(30) = (SELECT TYPE_NAME(user_type_id) FROM sys.columns
                                 WHERE object_id = OBJECT_ID('dbo.Reserva') AND name = 'idReserva');
  EXEC('ALTER TABLE dbo.Juego ADD idReserva ' + @tipo + ' NULL');
  EXEC('ALTER TABLE dbo.Juego ADD CONSTRAINT fk_juego_reserva FOREIGN KEY (idReserva) REFERENCES dbo.Reserva (idReserva)');
  PRINT 'Juego.idReserva agregada.';
END
ELSE PRINT 'Juego.idReserva ya existe.';
GO

-- Una reserva solo puede ser de un partido (los partidos sin reserva no cuentan)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_juego_reserva' AND object_id = OBJECT_ID('dbo.Juego'))
  CREATE UNIQUE INDEX uq_juego_reserva ON dbo.Juego (idReserva) WHERE idReserva IS NOT NULL;
GO

-- Partidos que ya existían y todavía no tienen reserva: se les crea una
-- (1 hora en Fútbol 7, 2 horas en Fútbol 11) con el siguiente folio libre.
IF EXISTS (SELECT 1 FROM dbo.Juego WHERE idReserva IS NULL)
BEGIN
  DECLARE @base INT = (SELECT ISNULL(MAX(TRY_CAST(SUBSTRING(Folio, 5, 20) AS INT)), 0)
                         FROM dbo.Reserva WHERE Folio LIKE 'RES-%');

  CREATE TABLE #juego_reserva (idJuego INT NOT NULL PRIMARY KEY, Folio VARCHAR(20) NOT NULL);
  INSERT INTO #juego_reserva (idJuego, Folio)
  SELECT j.idJuego, 'RES-' + FORMAT(@base + ROW_NUMBER() OVER (ORDER BY j.idJuego), '00000')
    FROM dbo.Juego j
   WHERE j.idReserva IS NULL;

  INSERT INTO dbo.Reserva (idUsuario, idEquipo, idPago, idCancha, idEstado_Reserva, Folio,
                           Fecha_Reserva, Hora_Inicio, Hora_Fin, Descripcion)
  SELECT el.idUsuario, j.idEquipo_Local, NULL, j.idCancha,
         (SELECT TOP (1) er.idEstado_Reserva FROM dbo.Estado_Reserva er
           WHERE er.Estado_Reserva = CASE WHEN j.Estado_Juego = 'Cancelado' THEN 'Cancelada'
                                          WHEN j.Fecha_Juego < GETDATE() THEN 'Finalizada'
                                          ELSE 'Pendiente' END),
         t.Folio, CAST(j.Fecha_Juego AS DATE), CAST(j.Fecha_Juego AS TIME(0)),
         CAST(CASE WHEN DATEADD(MINUTE, CASE WHEN tc.Tipo_Cancha LIKE '%11%' THEN 120 ELSE 60 END, j.Fecha_Juego)
                        < DATEADD(MINUTE, 1439, CAST(CAST(j.Fecha_Juego AS DATE) AS DATETIME))
                   THEN DATEADD(MINUTE, CASE WHEN tc.Tipo_Cancha LIKE '%11%' THEN 120 ELSE 60 END, j.Fecha_Juego)
                   ELSE DATEADD(MINUTE, 1439, CAST(CAST(j.Fecha_Juego AS DATE) AS DATETIME)) END AS TIME(0)),
         LEFT(tor.Torneo + N' · Jornada ' + CAST(j.Jornada AS NVARCHAR(10)) + N' · ' + el.Equipo + N' vs ' + ev.Equipo, 255)
    FROM #juego_reserva t
    JOIN dbo.Juego j        ON j.idJuego = t.idJuego
    JOIN dbo.Equipo el      ON el.idEquipo = j.idEquipo_Local
    JOIN dbo.Equipo ev      ON ev.idEquipo = j.idEquipo_Visitante
    JOIN dbo.Torneo tor     ON tor.idTorneo = j.idTorneo
    JOIN dbo.Cancha c       ON c.idCancha = j.idCancha
    JOIN dbo.Tipo_Cancha tc ON tc.idTipo_Cancha = c.idTipo_Cancha;

  UPDATE j SET j.idReserva = r.idReserva
    FROM dbo.Juego j
    JOIN #juego_reserva t ON t.idJuego = j.idJuego
    JOIN dbo.Reserva r ON r.Folio = t.Folio
   WHERE j.idReserva IS NULL;

  DROP TABLE #juego_reserva;
  PRINT 'Se crearon las reservas de los partidos que no tenían.';
END
GO

-- ---------------------------------------------------------------------
-- 5. Asignacion_Arbitro: confirmación o rechazo de cada árbitro
--    Rol_Arbitro:       Central | Lateral | Contralateral | Cuarto
--    Estado_Asignacion: Pendiente | Confirmado | Rechazado
-- ---------------------------------------------------------------------
IF COL_LENGTH('dbo.Asignacion_Arbitro', 'Fecha_Asignacion') IS NULL
BEGIN
  ALTER TABLE dbo.Asignacion_Arbitro ADD
    Motivo_Rechazo   NVARCHAR(255) NULL,
    Fecha_Asignacion DATETIME      NOT NULL CONSTRAINT df_asignacion_fecha DEFAULT (GETDATE()),
    Fecha_Respuesta  DATETIME      NULL;
  PRINT 'Columnas nuevas de Asignacion_Arbitro agregadas.';
END
ELSE PRINT 'Las columnas nuevas de Asignacion_Arbitro ya existen.';
GO

-- Las reglas anteriores de Estado_Asignacion y Rol_Arbitro (si las había) no conocen los
-- valores nuevos: se quitan las reglas CHECK y el valor por defecto de esas dos columnas,
-- y si son muy cortas para "Contralateral" se hacen de 20 letras.
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'ALTER TABLE dbo.Asignacion_Arbitro DROP CONSTRAINT ' + QUOTENAME(cc.name) + N'; '
  FROM sys.check_constraints cc
 WHERE cc.parent_object_id = OBJECT_ID('dbo.Asignacion_Arbitro')
   AND cc.name NOT IN ('ck_asignacion_estado', 'ck_asignacion_puesto')
   AND (cc.definition LIKE '%Estado_Asignacion%' OR cc.definition LIKE '%Rol_Arbitro%');
SELECT @sql += N'ALTER TABLE dbo.Asignacion_Arbitro DROP CONSTRAINT ' + QUOTENAME(dc.name) + N'; '
  FROM sys.default_constraints dc
  JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
 WHERE dc.parent_object_id = OBJECT_ID('dbo.Asignacion_Arbitro') AND c.name = 'Estado_Asignacion';
SELECT @sql += N'ALTER TABLE dbo.Asignacion_Arbitro ALTER COLUMN ' + QUOTENAME(c.name)
             + CASE WHEN TYPE_NAME(c.user_type_id) LIKE 'n%' THEN N' NVARCHAR(20) ' ELSE N' VARCHAR(20) ' END
             + CASE WHEN c.is_nullable = 1 THEN N'NULL' ELSE N'NOT NULL' END + N'; '
  FROM sys.columns c
 WHERE c.object_id = OBJECT_ID('dbo.Asignacion_Arbitro') AND c.name IN ('Estado_Asignacion', 'Rol_Arbitro')
   AND c.max_length <> -1
   AND CASE WHEN TYPE_NAME(c.user_type_id) LIKE 'n%' THEN c.max_length / 2 ELSE c.max_length END < 20;
IF @sql <> N'' EXEC sp_executesql @sql;
GO

UPDATE dbo.Asignacion_Arbitro SET Estado_Asignacion = 'Pendiente' WHERE Estado_Asignacion = 'Asignado';
UPDATE dbo.Asignacion_Arbitro SET Rol_Arbitro = 'Lateral' WHERE Rol_Arbitro = 'Asistente';
GO

ALTER TABLE dbo.Asignacion_Arbitro ADD CONSTRAINT df_asignacion_estado DEFAULT ('Pendiente') FOR Estado_Asignacion;
GO

-- Un partido no puede tener dos árbitros en el mismo puesto
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_asignacion_puesto' AND object_id = OBJECT_ID('dbo.Asignacion_Arbitro'))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dbo.Asignacion_Arbitro GROUP BY idJuego, Rol_Arbitro HAVING COUNT(*) > 1)
    CREATE UNIQUE INDEX uq_asignacion_puesto ON dbo.Asignacion_Arbitro (idJuego, Rol_Arbitro);
  ELSE PRINT 'OJO: hay partidos con dos árbitros en el mismo puesto; no se creó uq_asignacion_puesto.';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'ck_asignacion_estado')
   AND NOT EXISTS (SELECT 1 FROM dbo.Asignacion_Arbitro WHERE Estado_Asignacion NOT IN ('Pendiente', 'Confirmado', 'Rechazado'))
  ALTER TABLE dbo.Asignacion_Arbitro ADD CONSTRAINT ck_asignacion_estado
    CHECK (Estado_Asignacion IN ('Pendiente', 'Confirmado', 'Rechazado'));
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'ck_asignacion_puesto')
   AND NOT EXISTS (SELECT 1 FROM dbo.Asignacion_Arbitro WHERE Rol_Arbitro NOT IN ('Central', 'Lateral', 'Contralateral', 'Cuarto'))
  ALTER TABLE dbo.Asignacion_Arbitro ADD CONSTRAINT ck_asignacion_puesto
    CHECK (Rol_Arbitro IN ('Central', 'Lateral', 'Contralateral', 'Cuarto'));
GO

-- ---------------------------------------------------------------------
-- 6. Limpieza: tareas y reportes de condición de las canchas
--    (idCancha usa el mismo tipo de dato que Cancha.idCancha)
-- ---------------------------------------------------------------------
IF OBJECT_ID('dbo.Tarea_Limpieza', 'U') IS NULL
BEGIN
  DECLARE @tipoCancha NVARCHAR(30) = (SELECT TYPE_NAME(user_type_id) FROM sys.columns
                                       WHERE object_id = OBJECT_ID('dbo.Cancha') AND name = 'idCancha');
  EXEC(N'
  CREATE TABLE dbo.Tarea_Limpieza (
    idTarea_Limpieza   INT IDENTITY(1,1) NOT NULL,
    Tipo_Tarea         VARCHAR(20)   NOT NULL CONSTRAINT df_tarea_tipo DEFAULT (''General''),
    Tarea              NVARCHAR(80)  NOT NULL,
    idCancha           ' + @tipoCancha + N' NULL,          -- la cancha, o bien...
    Lugar              NVARCHAR(60)  NULL,                -- ...otro lugar: Áreas comunes, Gradas norte
    Fecha              DATE          NOT NULL,
    Hora               TIME(0)       NOT NULL,
    idUsuario_Asignado INT           NULL,                -- personal de limpieza responsable
    Estado_Tarea       VARCHAR(15)   NOT NULL CONSTRAINT df_tarea_estado DEFAULT (''Pendiente''),
    Notas              NVARCHAR(255) NULL,
    idUsuario_Registro INT           NULL,
    Fecha_Registro     DATETIME      NOT NULL CONSTRAINT df_tarea_registro DEFAULT (GETDATE()),
    Fecha_Completada   DATETIME      NULL,
    CONSTRAINT pk_tarea_limpieza PRIMARY KEY (idTarea_Limpieza),
    CONSTRAINT fk_tarea_cancha   FOREIGN KEY (idCancha)           REFERENCES dbo.Cancha (idCancha),
    CONSTRAINT fk_tarea_asignado FOREIGN KEY (idUsuario_Asignado) REFERENCES dbo.Usuario (idUsuario),
    CONSTRAINT fk_tarea_registro FOREIGN KEY (idUsuario_Registro) REFERENCES dbo.Usuario (idUsuario),
    CONSTRAINT ck_tarea_estado CHECK (Estado_Tarea IN (''Pendiente'', ''En progreso'', ''Completada'')),
    CONSTRAINT ck_tarea_tipo   CHECK (Tipo_Tarea IN (''General'', ''Basura'', ''Barrido'', ''Gradas'', ''Riego'', ''Otro'')),
    CONSTRAINT ck_tarea_lugar  CHECK (idCancha IS NOT NULL OR Lugar IS NOT NULL)
  );
  CREATE INDEX ix_tarea_fecha ON dbo.Tarea_Limpieza (Fecha, Hora);');
  PRINT 'Tabla Tarea_Limpieza creada.';
END
ELSE PRINT 'La tabla Tarea_Limpieza ya existe.';
GO

IF OBJECT_ID('dbo.Reporte_Condicion', 'U') IS NULL
BEGIN
  DECLARE @tipoCancha NVARCHAR(30) = (SELECT TYPE_NAME(user_type_id) FROM sys.columns
                                       WHERE object_id = OBJECT_ID('dbo.Cancha') AND name = 'idCancha');
  EXEC(N'
  CREATE TABLE dbo.Reporte_Condicion (
    idReporte_Condicion INT IDENTITY(1,1) NOT NULL,
    idCancha            ' + @tipoCancha + N' NOT NULL,
    Tipo_Problema       NVARCHAR(80)  NOT NULL,
    Descripcion         NVARCHAR(500) NOT NULL,
    Urgencia            VARCHAR(5)    NOT NULL CONSTRAINT df_reporte_urgencia DEFAULT (''Media''),
    Estado_Reporte      VARCHAR(15)   NOT NULL CONSTRAINT df_reporte_estado DEFAULT (''Sin resolver''),
    idUsuario_Reporta   INT           NULL,
    Fecha_Reporte       DATETIME      NOT NULL CONSTRAINT df_reporte_fecha DEFAULT (GETDATE()),
    idUsuario_Atiende   INT           NULL,
    Fecha_Atencion      DATETIME      NULL,
    Nota_Atencion       NVARCHAR(255) NULL,
    CONSTRAINT pk_reporte_condicion PRIMARY KEY (idReporte_Condicion),
    CONSTRAINT fk_reporte_cancha  FOREIGN KEY (idCancha)          REFERENCES dbo.Cancha (idCancha),
    CONSTRAINT fk_reporte_reporta FOREIGN KEY (idUsuario_Reporta) REFERENCES dbo.Usuario (idUsuario),
    CONSTRAINT fk_reporte_atiende FOREIGN KEY (idUsuario_Atiende) REFERENCES dbo.Usuario (idUsuario),
    CONSTRAINT ck_reporte_urgencia CHECK (Urgencia IN (''Baja'', ''Media'', ''Alta'')),
    CONSTRAINT ck_reporte_estado   CHECK (Estado_Reporte IN (''Sin resolver'', ''En proceso'', ''Resuelto''))
  );
  CREATE INDEX ix_reporte_estado ON dbo.Reporte_Condicion (Estado_Reporte, Urgencia, Fecha_Reporte);');
  PRINT 'Tabla Reporte_Condicion creada.';
END
ELSE PRINT 'La tabla Reporte_Condicion ya existe.';
GO

-- ---------------------------------------------------------------------
-- 7. Triggers de auditoría (cambios hechos por FUERA de la aplicación)
--    Se recrean los de Pago, Juego y Asignacion_Arbitro con sus columnas
--    nuevas y se agregan los de las dos tablas de Limpieza.
--    La aplicación se identifica como 'RanchoSecoApp' (APP_NAME()).
-- ---------------------------------------------------------------------
-- ---------- Pago (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_pago_ins ON dbo.Pago AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Pago',
         LEFT(CAST(i.idPago AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Pago (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago, x.Comprobante AS Comprobante, x.Estado_Pago AS Estado_Pago, x.Referencia AS Referencia, x.Nota_Revision AS Nota_Revision, x.Fecha_Revision AS Fecha_Revision FROM inserted x WHERE x.idPago = i.idPago
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
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Pago',
         LEFT(CAST(i.idPago AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Pago (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago, x.Comprobante AS Comprobante, x.Estado_Pago AS Estado_Pago, x.Referencia AS Referencia, x.Nota_Revision AS Nota_Revision, x.Fecha_Revision AS Fecha_Revision FROM deleted x WHERE x.idPago = i.idPago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago, x.Comprobante AS Comprobante, x.Estado_Pago AS Estado_Pago, x.Referencia AS Referencia, x.Nota_Revision AS Nota_Revision, x.Fecha_Revision AS Fecha_Revision FROM inserted x WHERE x.idPago = i.idPago
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
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Pago',
         LEFT(CAST(d.idPago AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Pago (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago, x.Comprobante AS Comprobante, x.Estado_Pago AS Estado_Pago, x.Referencia AS Referencia, x.Nota_Revision AS Nota_Revision, x.Fecha_Revision AS Fecha_Revision FROM deleted x WHERE x.idPago = d.idPago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Juego (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_juego_ins ON dbo.Juego AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Juego',
         LEFT(CAST(i.idJuego AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Juego (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idJuego AS idJuego, x.idCancha AS idCancha, x.idEquipo_Visitante AS idEquipo_Visitante, x.idEquipo_Local AS idEquipo_Local, x.idTorneo AS idTorneo, x.idReserva AS idReserva, x.Jornada AS Jornada, x.Goles_Local AS Goles_Local, x.Goles_Visitante AS Goles_Visitante, x.Estado_Juego AS Estado_Juego, x.Fecha_Juego AS Fecha_Juego FROM inserted x WHERE x.idJuego = i.idJuego
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Juego (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_juego_upd ON dbo.Juego AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Juego',
         LEFT(CAST(i.idJuego AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Juego (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idJuego AS idJuego, x.idCancha AS idCancha, x.idEquipo_Visitante AS idEquipo_Visitante, x.idEquipo_Local AS idEquipo_Local, x.idTorneo AS idTorneo, x.idReserva AS idReserva, x.Jornada AS Jornada, x.Goles_Local AS Goles_Local, x.Goles_Visitante AS Goles_Visitante, x.Estado_Juego AS Estado_Juego, x.Fecha_Juego AS Fecha_Juego FROM deleted x WHERE x.idJuego = i.idJuego
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idJuego AS idJuego, x.idCancha AS idCancha, x.idEquipo_Visitante AS idEquipo_Visitante, x.idEquipo_Local AS idEquipo_Local, x.idTorneo AS idTorneo, x.idReserva AS idReserva, x.Jornada AS Jornada, x.Goles_Local AS Goles_Local, x.Goles_Visitante AS Goles_Visitante, x.Estado_Juego AS Estado_Juego, x.Fecha_Juego AS Fecha_Juego FROM inserted x WHERE x.idJuego = i.idJuego
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idJuego = i.idJuego;
END
GO

-- ---------- Juego (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_juego_del ON dbo.Juego AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Juego',
         LEFT(CAST(d.idJuego AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Juego (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idJuego AS idJuego, x.idCancha AS idCancha, x.idEquipo_Visitante AS idEquipo_Visitante, x.idEquipo_Local AS idEquipo_Local, x.idTorneo AS idTorneo, x.idReserva AS idReserva, x.Jornada AS Jornada, x.Goles_Local AS Goles_Local, x.Goles_Visitante AS Goles_Visitante, x.Estado_Juego AS Estado_Juego, x.Fecha_Juego AS Fecha_Juego FROM deleted x WHERE x.idJuego = d.idJuego
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Asignacion_Arbitro (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_asignacion_arbitro_ins ON dbo.Asignacion_Arbitro AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Asignacion_Arbitro',
         LEFT(CAST(i.idAsignacion_Arbitro AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Asignacion_Arbitro (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idAsignacion_Arbitro AS idAsignacion_Arbitro, x.idJuego AS idJuego, x.idUsuario AS idUsuario, x.Rol_Arbitro AS Rol_Arbitro, x.Estado_Asignacion AS Estado_Asignacion, x.Motivo_Rechazo AS Motivo_Rechazo, x.Fecha_Asignacion AS Fecha_Asignacion, x.Fecha_Respuesta AS Fecha_Respuesta FROM inserted x WHERE x.idAsignacion_Arbitro = i.idAsignacion_Arbitro
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Asignacion_Arbitro (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_asignacion_arbitro_upd ON dbo.Asignacion_Arbitro AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Asignacion_Arbitro',
         LEFT(CAST(i.idAsignacion_Arbitro AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Asignacion_Arbitro (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idAsignacion_Arbitro AS idAsignacion_Arbitro, x.idJuego AS idJuego, x.idUsuario AS idUsuario, x.Rol_Arbitro AS Rol_Arbitro, x.Estado_Asignacion AS Estado_Asignacion, x.Motivo_Rechazo AS Motivo_Rechazo, x.Fecha_Asignacion AS Fecha_Asignacion, x.Fecha_Respuesta AS Fecha_Respuesta FROM deleted x WHERE x.idAsignacion_Arbitro = i.idAsignacion_Arbitro
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idAsignacion_Arbitro AS idAsignacion_Arbitro, x.idJuego AS idJuego, x.idUsuario AS idUsuario, x.Rol_Arbitro AS Rol_Arbitro, x.Estado_Asignacion AS Estado_Asignacion, x.Motivo_Rechazo AS Motivo_Rechazo, x.Fecha_Asignacion AS Fecha_Asignacion, x.Fecha_Respuesta AS Fecha_Respuesta FROM inserted x WHERE x.idAsignacion_Arbitro = i.idAsignacion_Arbitro
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idAsignacion_Arbitro = i.idAsignacion_Arbitro;
END
GO

-- ---------- Asignacion_Arbitro (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_asignacion_arbitro_del ON dbo.Asignacion_Arbitro AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Asignacion_Arbitro',
         LEFT(CAST(d.idAsignacion_Arbitro AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Asignacion_Arbitro (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idAsignacion_Arbitro AS idAsignacion_Arbitro, x.idJuego AS idJuego, x.idUsuario AS idUsuario, x.Rol_Arbitro AS Rol_Arbitro, x.Estado_Asignacion AS Estado_Asignacion, x.Motivo_Rechazo AS Motivo_Rechazo, x.Fecha_Asignacion AS Fecha_Asignacion, x.Fecha_Respuesta AS Fecha_Respuesta FROM deleted x WHERE x.idAsignacion_Arbitro = d.idAsignacion_Arbitro
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Tarea_Limpieza (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_tarea_limpieza_ins ON dbo.Tarea_Limpieza AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Tarea_Limpieza',
         LEFT(CAST(i.idTarea_Limpieza AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Tarea_Limpieza (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idTarea_Limpieza AS idTarea_Limpieza, x.Tipo_Tarea AS Tipo_Tarea, x.Tarea AS Tarea, x.idCancha AS idCancha, x.Lugar AS Lugar, x.Fecha AS Fecha, x.Hora AS Hora, x.idUsuario_Asignado AS idUsuario_Asignado, x.Estado_Tarea AS Estado_Tarea, x.Notas AS Notas, x.idUsuario_Registro AS idUsuario_Registro, x.Fecha_Completada AS Fecha_Completada FROM inserted x WHERE x.idTarea_Limpieza = i.idTarea_Limpieza
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Tarea_Limpieza (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_tarea_limpieza_upd ON dbo.Tarea_Limpieza AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Tarea_Limpieza',
         LEFT(CAST(i.idTarea_Limpieza AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Tarea_Limpieza (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idTarea_Limpieza AS idTarea_Limpieza, x.Tipo_Tarea AS Tipo_Tarea, x.Tarea AS Tarea, x.idCancha AS idCancha, x.Lugar AS Lugar, x.Fecha AS Fecha, x.Hora AS Hora, x.idUsuario_Asignado AS idUsuario_Asignado, x.Estado_Tarea AS Estado_Tarea, x.Notas AS Notas, x.idUsuario_Registro AS idUsuario_Registro, x.Fecha_Completada AS Fecha_Completada FROM deleted x WHERE x.idTarea_Limpieza = i.idTarea_Limpieza
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idTarea_Limpieza AS idTarea_Limpieza, x.Tipo_Tarea AS Tipo_Tarea, x.Tarea AS Tarea, x.idCancha AS idCancha, x.Lugar AS Lugar, x.Fecha AS Fecha, x.Hora AS Hora, x.idUsuario_Asignado AS idUsuario_Asignado, x.Estado_Tarea AS Estado_Tarea, x.Notas AS Notas, x.idUsuario_Registro AS idUsuario_Registro, x.Fecha_Completada AS Fecha_Completada FROM inserted x WHERE x.idTarea_Limpieza = i.idTarea_Limpieza
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idTarea_Limpieza = i.idTarea_Limpieza;
END
GO

-- ---------- Tarea_Limpieza (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_tarea_limpieza_del ON dbo.Tarea_Limpieza AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Tarea_Limpieza',
         LEFT(CAST(d.idTarea_Limpieza AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Tarea_Limpieza (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idTarea_Limpieza AS idTarea_Limpieza, x.Tipo_Tarea AS Tipo_Tarea, x.Tarea AS Tarea, x.idCancha AS idCancha, x.Lugar AS Lugar, x.Fecha AS Fecha, x.Hora AS Hora, x.idUsuario_Asignado AS idUsuario_Asignado, x.Estado_Tarea AS Estado_Tarea, x.Notas AS Notas, x.idUsuario_Registro AS idUsuario_Registro, x.Fecha_Completada AS Fecha_Completada FROM deleted x WHERE x.idTarea_Limpieza = d.idTarea_Limpieza
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Reporte_Condicion (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_reporte_condicion_ins ON dbo.Reporte_Condicion AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Reporte_Condicion',
         LEFT(CAST(i.idReporte_Condicion AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Reporte_Condicion (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idReporte_Condicion AS idReporte_Condicion, x.idCancha AS idCancha, x.Tipo_Problema AS Tipo_Problema, x.Descripcion AS Descripcion, x.Urgencia AS Urgencia, x.Estado_Reporte AS Estado_Reporte, x.idUsuario_Reporta AS idUsuario_Reporta, x.Fecha_Reporte AS Fecha_Reporte, x.idUsuario_Atiende AS idUsuario_Atiende, x.Fecha_Atencion AS Fecha_Atencion, x.Nota_Atencion AS Nota_Atencion FROM inserted x WHERE x.idReporte_Condicion = i.idReporte_Condicion
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Reporte_Condicion (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_reporte_condicion_upd ON dbo.Reporte_Condicion AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Reporte_Condicion',
         LEFT(CAST(i.idReporte_Condicion AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Reporte_Condicion (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idReporte_Condicion AS idReporte_Condicion, x.idCancha AS idCancha, x.Tipo_Problema AS Tipo_Problema, x.Descripcion AS Descripcion, x.Urgencia AS Urgencia, x.Estado_Reporte AS Estado_Reporte, x.idUsuario_Reporta AS idUsuario_Reporta, x.Fecha_Reporte AS Fecha_Reporte, x.idUsuario_Atiende AS idUsuario_Atiende, x.Fecha_Atencion AS Fecha_Atencion, x.Nota_Atencion AS Nota_Atencion FROM deleted x WHERE x.idReporte_Condicion = i.idReporte_Condicion
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idReporte_Condicion AS idReporte_Condicion, x.idCancha AS idCancha, x.Tipo_Problema AS Tipo_Problema, x.Descripcion AS Descripcion, x.Urgencia AS Urgencia, x.Estado_Reporte AS Estado_Reporte, x.idUsuario_Reporta AS idUsuario_Reporta, x.Fecha_Reporte AS Fecha_Reporte, x.idUsuario_Atiende AS idUsuario_Atiende, x.Fecha_Atencion AS Fecha_Atencion, x.Nota_Atencion AS Nota_Atencion FROM inserted x WHERE x.idReporte_Condicion = i.idReporte_Condicion
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idReporte_Condicion = i.idReporte_Condicion;
END
GO

-- ---------- Reporte_Condicion (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_reporte_condicion_del ON dbo.Reporte_Condicion AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Reporte_Condicion',
         LEFT(CAST(d.idReporte_Condicion AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Reporte_Condicion (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idReporte_Condicion AS idReporte_Condicion, x.idCancha AS idCancha, x.Tipo_Problema AS Tipo_Problema, x.Descripcion AS Descripcion, x.Urgencia AS Urgencia, x.Estado_Reporte AS Estado_Reporte, x.idUsuario_Reporta AS idUsuario_Reporta, x.Fecha_Reporte AS Fecha_Reporte, x.idUsuario_Atiende AS idUsuario_Atiende, x.Fecha_Atencion AS Fecha_Atencion, x.Nota_Atencion AS Nota_Atencion FROM deleted x WHERE x.idReporte_Condicion = d.idReporte_Condicion
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- =====================================================================
-- 8. VERIFICACIÓN
-- =====================================================================
SELECT idRol, Rol, Nivel_Acceso FROM dbo.Rol ORDER BY Rol;
SELECT Estado_Pago, COUNT(*) AS Pagos FROM dbo.Pago GROUP BY Estado_Pago;
SELECT j.idJuego, r.Folio, CONVERT(CHAR(16), j.Fecha_Juego, 120) AS Fecha, j.Estado_Juego
  FROM dbo.Juego j LEFT JOIN dbo.Reserva r ON r.idReserva = j.idReserva ORDER BY j.idJuego;
SELECT COUNT(*) AS Tablas_Nuevas FROM INFORMATION_SCHEMA.TABLES
 WHERE LOWER(TABLE_NAME) IN ('tarea_limpieza', 'reporte_condicion', 'comprobante_archivo');
SELECT N'Listo: módulos de Equipos, Árbitros, Pagos, Limpieza y Reportes' AS resultado;
GO
