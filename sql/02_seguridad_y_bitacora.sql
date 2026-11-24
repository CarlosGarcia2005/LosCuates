-- =====================================================================
--  Gestor Deportivo Rancho Seco  (SQL Server)
--  02 - Seguridad, MFA y Bitácora
-- ---------------------------------------------------------------------
--  * Abre este archivo en SSMS, elige la base del proyecto (en Azure:
--    clic derecho en la base → Nueva consulta) y ejecútalo completo con F5.
--  * Ejecútalo con una cuenta que pueda modificar tablas
--    (Autenticación de Windows o sa), NO con rancho_app.
--  * Se puede ejecutar más de una vez sin romper nada.
--  * NO borra datos: solo agrega columnas, una tabla y triggers.
-- =====================================================================
SET NOCOUNT ON;
GO

-- ---------------------------------------------------------------------
-- 1. Rol: nivel de acceso (Administrador / Usuario)
-- ---------------------------------------------------------------------
IF COL_LENGTH('dbo.Rol', 'Nivel_Acceso') IS NULL
BEGIN
  EXEC('ALTER TABLE dbo.Rol ADD Nivel_Acceso VARCHAR(15) NOT NULL
          CONSTRAINT df_rol_nivel_acceso DEFAULT (''Usuario'')');
  EXEC('ALTER TABLE dbo.Rol ADD CONSTRAINT ck_rol_nivel_acceso
          CHECK (Nivel_Acceso IN (''Administrador'', ''Usuario''))');
  PRINT 'Rol.Nivel_Acceso agregada.';
END
ELSE PRINT 'Rol.Nivel_Acceso ya existe.';
GO

UPDATE dbo.Rol SET Nivel_Acceso = 'Administrador'
 WHERE Rol = 'Administrador' AND Nivel_Acceso <> 'Administrador';
GO

-- ---------------------------------------------------------------------
-- 2. Usuario: MFA, bloqueo por intentos y control de sesiones (JWT)
-- ---------------------------------------------------------------------
IF COL_LENGTH('dbo.Usuario', 'Estado') IS NULL
  EXEC('ALTER TABLE dbo.Usuario ADD Estado VARCHAR(15) NOT NULL
          CONSTRAINT df_usuario_estado DEFAULT (''Activo'')');
GO

IF COL_LENGTH('dbo.Usuario', 'MFA_Activo') IS NULL
BEGIN
  EXEC('ALTER TABLE dbo.Usuario ADD
          MFA_Secreto       VARCHAR(200) NULL,
          MFA_Activo        TINYINT      NOT NULL CONSTRAINT df_usuario_mfa_activo DEFAULT (0),
          MFA_Ultimo_Paso   INT          NULL,
          Intentos_Fallidos TINYINT      NOT NULL CONSTRAINT df_usuario_intentos  DEFAULT (0),
          Bloqueado_Hasta   DATETIME     NULL,
          Ultimo_Acceso     DATETIME     NULL,
          Token_Version     INT          NOT NULL CONSTRAINT df_usuario_token     DEFAULT (0)');
  PRINT 'Columnas de seguridad agregadas a Usuario.';
END
ELSE PRINT 'Las columnas de seguridad de Usuario ya existen.';
GO

-- ---------------------------------------------------------------------
-- 3. Bitácora administrativa
-- ---------------------------------------------------------------------
IF OBJECT_ID('dbo.Bitacora', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Bitacora (
    idBitacora       BIGINT IDENTITY(1,1) NOT NULL,
    Fecha            DATETIME      NOT NULL CONSTRAINT df_bitacora_fecha     DEFAULT (GETDATE()),
    idUsuario        INT           NULL,            -- quién hizo la acción (NULL si no inició sesión)
    Correo_Usuario   NVARCHAR(100) NULL,
    Rol_Usuario      NVARCHAR(40)  NULL,
    Accion           NVARCHAR(40)  NOT NULL,        -- LOGIN_EXITOSO, USUARIO_EDITADO, etc.
    Modulo           NVARCHAR(40)  NOT NULL,
    Tabla_Afectada   NVARCHAR(40)  NULL,
    idRegistro       NVARCHAR(40)  NULL,
    Descripcion      NVARCHAR(500) NOT NULL,
    Datos_Anteriores NVARCHAR(MAX) NULL,            -- JSON con los valores antes del cambio
    Datos_Nuevos     NVARCHAR(MAX) NULL,            -- JSON con los valores después del cambio
    IP               NVARCHAR(45)  NULL,
    Navegador        NVARCHAR(300) NULL,
    Resultado        NVARCHAR(10)  NOT NULL CONSTRAINT df_bitacora_resultado DEFAULT (N'Éxito'),
    Origen           NVARCHAR(20)  NOT NULL CONSTRAINT df_bitacora_origen    DEFAULT (N'Aplicación'),
    CONSTRAINT pk_bitacora PRIMARY KEY (idBitacora),
    CONSTRAINT fk_bitacora_usuario FOREIGN KEY (idUsuario) REFERENCES dbo.Usuario (idUsuario),
    CONSTRAINT ck_bitacora_resultado CHECK (Resultado IN (N'Éxito', N'Fallo'))
  );
  CREATE INDEX ix_bitacora_fecha   ON dbo.Bitacora (Fecha);
  CREATE INDEX ix_bitacora_usuario ON dbo.Bitacora (idUsuario, Fecha);
  CREATE INDEX ix_bitacora_accion  ON dbo.Bitacora (Accion, Fecha);
  PRINT 'Tabla Bitacora creada.';
END
ELSE PRINT 'La tabla Bitacora ya existe.';
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Bitacora)
  INSERT INTO dbo.Bitacora (Correo_Usuario, Accion, Modulo, Descripcion, Origen)
  VALUES (LEFT(SUSER_SNAME(), 100), N'SISTEMA', N'Sistema',
          N'Se creó la bitácora administrativa', N'Base de datos');
GO

-- ---------------------------------------------------------------------
-- 4. La bitácora no se puede modificar ni borrar
--    (ni desde la aplicación ni desde SSMS)
-- ---------------------------------------------------------------------
CREATE OR ALTER TRIGGER tr_bitacora_no_editar ON dbo.Bitacora INSTEAD OF UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 50001, 'La bitacora no se puede modificar', 1;
END
GO

CREATE OR ALTER TRIGGER tr_bitacora_no_borrar ON dbo.Bitacora INSTEAD OF DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 50001, 'La bitacora no se puede borrar', 1;
END
GO

-- ---------------------------------------------------------------------
-- 5. Triggers de auditoría en TODAS las tablas
--    Registran los cambios hechos por FUERA de la aplicación (SSMS,
--    sqlcmd, Azure Data Studio...). La aplicación se identifica con el
--    nombre 'RanchoSecoApp' (APP_NAME()) y sus cambios ya se registran
--    desde Node con más detalle.
-- ---------------------------------------------------------------------

-- ---------- Rol (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_rol_ins ON dbo.Rol AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Rol',
         LEFT(CAST(i.idRol AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Rol (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idRol AS idRol, x.Rol AS Rol, x.Nivel_Acceso AS Nivel_Acceso FROM inserted x WHERE x.idRol = i.idRol
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Rol (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_rol_upd ON dbo.Rol AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Rol',
         LEFT(CAST(i.idRol AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Rol (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idRol AS idRol, x.Rol AS Rol, x.Nivel_Acceso AS Nivel_Acceso FROM deleted x WHERE x.idRol = i.idRol
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idRol AS idRol, x.Rol AS Rol, x.Nivel_Acceso AS Nivel_Acceso FROM inserted x WHERE x.idRol = i.idRol
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idRol = i.idRol;
END
GO

-- ---------- Rol (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_rol_del ON dbo.Rol AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Rol',
         LEFT(CAST(d.idRol AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Rol (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idRol AS idRol, x.Rol AS Rol, x.Nivel_Acceso AS Nivel_Acceso FROM deleted x WHERE x.idRol = d.idRol
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Genero (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_genero_ins ON dbo.Genero AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Genero',
         LEFT(CAST(i.idGenero AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Genero (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idGenero AS idGenero, x.Genero AS Genero FROM inserted x WHERE x.idGenero = i.idGenero
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Genero (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_genero_upd ON dbo.Genero AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Genero',
         LEFT(CAST(i.idGenero AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Genero (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idGenero AS idGenero, x.Genero AS Genero FROM deleted x WHERE x.idGenero = i.idGenero
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idGenero AS idGenero, x.Genero AS Genero FROM inserted x WHERE x.idGenero = i.idGenero
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idGenero = i.idGenero;
END
GO

-- ---------- Genero (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_genero_del ON dbo.Genero AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Genero',
         LEFT(CAST(d.idGenero AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Genero (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idGenero AS idGenero, x.Genero AS Genero FROM deleted x WHERE x.idGenero = d.idGenero
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Tipo_Cancha (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_tipo_cancha_ins ON dbo.Tipo_Cancha AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Tipo_Cancha',
         LEFT(CAST(i.idTipo_Cancha AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Tipo_Cancha (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idTipo_Cancha AS idTipo_Cancha, x.Tipo_Cancha AS Tipo_Cancha FROM inserted x WHERE x.idTipo_Cancha = i.idTipo_Cancha
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Tipo_Cancha (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_tipo_cancha_upd ON dbo.Tipo_Cancha AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Tipo_Cancha',
         LEFT(CAST(i.idTipo_Cancha AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Tipo_Cancha (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idTipo_Cancha AS idTipo_Cancha, x.Tipo_Cancha AS Tipo_Cancha FROM deleted x WHERE x.idTipo_Cancha = i.idTipo_Cancha
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idTipo_Cancha AS idTipo_Cancha, x.Tipo_Cancha AS Tipo_Cancha FROM inserted x WHERE x.idTipo_Cancha = i.idTipo_Cancha
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idTipo_Cancha = i.idTipo_Cancha;
END
GO

-- ---------- Tipo_Cancha (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_tipo_cancha_del ON dbo.Tipo_Cancha AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Tipo_Cancha',
         LEFT(CAST(d.idTipo_Cancha AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Tipo_Cancha (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idTipo_Cancha AS idTipo_Cancha, x.Tipo_Cancha AS Tipo_Cancha FROM deleted x WHERE x.idTipo_Cancha = d.idTipo_Cancha
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Metodo_Pago (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_metodo_pago_ins ON dbo.Metodo_Pago AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Metodo_Pago',
         LEFT(CAST(i.idMetodo_Pago AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Metodo_Pago (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idMetodo_Pago AS idMetodo_Pago, x.Metodo_Pago AS Metodo_Pago FROM inserted x WHERE x.idMetodo_Pago = i.idMetodo_Pago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Metodo_Pago (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_metodo_pago_upd ON dbo.Metodo_Pago AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Metodo_Pago',
         LEFT(CAST(i.idMetodo_Pago AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Metodo_Pago (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idMetodo_Pago AS idMetodo_Pago, x.Metodo_Pago AS Metodo_Pago FROM deleted x WHERE x.idMetodo_Pago = i.idMetodo_Pago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idMetodo_Pago AS idMetodo_Pago, x.Metodo_Pago AS Metodo_Pago FROM inserted x WHERE x.idMetodo_Pago = i.idMetodo_Pago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idMetodo_Pago = i.idMetodo_Pago;
END
GO

-- ---------- Metodo_Pago (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_metodo_pago_del ON dbo.Metodo_Pago AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Metodo_Pago',
         LEFT(CAST(d.idMetodo_Pago AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Metodo_Pago (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idMetodo_Pago AS idMetodo_Pago, x.Metodo_Pago AS Metodo_Pago FROM deleted x WHERE x.idMetodo_Pago = d.idMetodo_Pago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Estado_Reserva (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_estado_reserva_ins ON dbo.Estado_Reserva AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Estado_Reserva',
         LEFT(CAST(i.idEstado_Reserva AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Estado_Reserva (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idEstado_Reserva AS idEstado_Reserva, x.Estado_Reserva AS Estado_Reserva FROM inserted x WHERE x.idEstado_Reserva = i.idEstado_Reserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Estado_Reserva (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_estado_reserva_upd ON dbo.Estado_Reserva AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Estado_Reserva',
         LEFT(CAST(i.idEstado_Reserva AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Estado_Reserva (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idEstado_Reserva AS idEstado_Reserva, x.Estado_Reserva AS Estado_Reserva FROM deleted x WHERE x.idEstado_Reserva = i.idEstado_Reserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idEstado_Reserva AS idEstado_Reserva, x.Estado_Reserva AS Estado_Reserva FROM inserted x WHERE x.idEstado_Reserva = i.idEstado_Reserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idEstado_Reserva = i.idEstado_Reserva;
END
GO

-- ---------- Estado_Reserva (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_estado_reserva_del ON dbo.Estado_Reserva AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Estado_Reserva',
         LEFT(CAST(d.idEstado_Reserva AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Estado_Reserva (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idEstado_Reserva AS idEstado_Reserva, x.Estado_Reserva AS Estado_Reserva FROM deleted x WHERE x.idEstado_Reserva = d.idEstado_Reserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Usuario (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_usuario_ins ON dbo.Usuario AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Usuario',
         LEFT(CAST(i.idUsuario AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Usuario (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idUsuario AS idUsuario, x.idGenero AS idGenero, x.idRol AS idRol, x.Nombre AS Nombre, x.Apellido_Paterno AS Apellido_Paterno, x.Apellido_Materno AS Apellido_Materno, x.Telefono AS Telefono, x.Correo AS Correo, x.Estado AS Estado, x.MFA_Activo AS MFA_Activo, x.Intentos_Fallidos AS Intentos_Fallidos, x.Bloqueado_Hasta AS Bloqueado_Hasta, x.Ultimo_Acceso AS Ultimo_Acceso FROM inserted x WHERE x.idUsuario = i.idUsuario
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Usuario (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_usuario_upd ON dbo.Usuario AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Usuario',
         LEFT(CAST(i.idUsuario AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Usuario (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idUsuario AS idUsuario, x.idGenero AS idGenero, x.idRol AS idRol, x.Nombre AS Nombre, x.Apellido_Paterno AS Apellido_Paterno, x.Apellido_Materno AS Apellido_Materno, x.Telefono AS Telefono, x.Correo AS Correo, x.Estado AS Estado, x.MFA_Activo AS MFA_Activo, x.Intentos_Fallidos AS Intentos_Fallidos, x.Bloqueado_Hasta AS Bloqueado_Hasta, x.Ultimo_Acceso AS Ultimo_Acceso FROM deleted x WHERE x.idUsuario = i.idUsuario
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idUsuario AS idUsuario, x.idGenero AS idGenero, x.idRol AS idRol, x.Nombre AS Nombre, x.Apellido_Paterno AS Apellido_Paterno, x.Apellido_Materno AS Apellido_Materno, x.Telefono AS Telefono, x.Correo AS Correo, x.Estado AS Estado, x.MFA_Activo AS MFA_Activo, x.Intentos_Fallidos AS Intentos_Fallidos, x.Bloqueado_Hasta AS Bloqueado_Hasta, x.Ultimo_Acceso AS Ultimo_Acceso FROM inserted x WHERE x.idUsuario = i.idUsuario
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idUsuario = i.idUsuario;
END
GO

-- ---------- Usuario (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_usuario_del ON dbo.Usuario AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Usuario',
         LEFT(CAST(d.idUsuario AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Usuario (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idUsuario AS idUsuario, x.idGenero AS idGenero, x.idRol AS idRol, x.Nombre AS Nombre, x.Apellido_Paterno AS Apellido_Paterno, x.Apellido_Materno AS Apellido_Materno, x.Telefono AS Telefono, x.Correo AS Correo, x.Estado AS Estado, x.MFA_Activo AS MFA_Activo, x.Intentos_Fallidos AS Intentos_Fallidos, x.Bloqueado_Hasta AS Bloqueado_Hasta, x.Ultimo_Acceso AS Ultimo_Acceso FROM deleted x WHERE x.idUsuario = d.idUsuario
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Cancha (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_cancha_ins ON dbo.Cancha AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Cancha',
         LEFT(CAST(i.idCancha AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Cancha (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idCancha AS idCancha, x.idTipo_Cancha AS idTipo_Cancha, x.Cancha AS Cancha, x.Estado_Cancha AS Estado_Cancha FROM inserted x WHERE x.idCancha = i.idCancha
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Cancha (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_cancha_upd ON dbo.Cancha AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Cancha',
         LEFT(CAST(i.idCancha AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Cancha (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idCancha AS idCancha, x.idTipo_Cancha AS idTipo_Cancha, x.Cancha AS Cancha, x.Estado_Cancha AS Estado_Cancha FROM deleted x WHERE x.idCancha = i.idCancha
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idCancha AS idCancha, x.idTipo_Cancha AS idTipo_Cancha, x.Cancha AS Cancha, x.Estado_Cancha AS Estado_Cancha FROM inserted x WHERE x.idCancha = i.idCancha
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idCancha = i.idCancha;
END
GO

-- ---------- Cancha (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_cancha_del ON dbo.Cancha AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Cancha',
         LEFT(CAST(d.idCancha AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Cancha (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idCancha AS idCancha, x.idTipo_Cancha AS idTipo_Cancha, x.Cancha AS Cancha, x.Estado_Cancha AS Estado_Cancha FROM deleted x WHERE x.idCancha = d.idCancha
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

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
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago FROM inserted x WHERE x.idPago = i.idPago
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
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago FROM deleted x WHERE x.idPago = i.idPago
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago FROM inserted x WHERE x.idPago = i.idPago
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
         (SELECT x.idPago AS idPago, x.idMetodo_Pago AS idMetodo_Pago, x.Monto AS Monto, x.Fecha_Pago AS Fecha_Pago FROM deleted x WHERE x.idPago = d.idPago
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
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Reserva',
         LEFT(CAST(i.idReserva AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Reserva (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idReserva AS idReserva, x.idUsuario AS idUsuario, x.idPago AS idPago, x.idCancha AS idCancha, x.idEstado_Reserva AS idEstado_Reserva, x.Folio AS Folio, x.Fecha_Reserva AS Fecha_Reserva, x.Hora_Inicio AS Hora_Inicio, x.Hora_Fin AS Hora_Fin, x.Fecha_Registro AS Fecha_Registro, x.Descripcion AS Descripcion FROM inserted x WHERE x.idReserva = i.idReserva
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
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Reserva',
         LEFT(CAST(i.idReserva AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Reserva (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idReserva AS idReserva, x.idUsuario AS idUsuario, x.idPago AS idPago, x.idCancha AS idCancha, x.idEstado_Reserva AS idEstado_Reserva, x.Folio AS Folio, x.Fecha_Reserva AS Fecha_Reserva, x.Hora_Inicio AS Hora_Inicio, x.Hora_Fin AS Hora_Fin, x.Fecha_Registro AS Fecha_Registro, x.Descripcion AS Descripcion FROM deleted x WHERE x.idReserva = i.idReserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idReserva AS idReserva, x.idUsuario AS idUsuario, x.idPago AS idPago, x.idCancha AS idCancha, x.idEstado_Reserva AS idEstado_Reserva, x.Folio AS Folio, x.Fecha_Reserva AS Fecha_Reserva, x.Hora_Inicio AS Hora_Inicio, x.Hora_Fin AS Hora_Fin, x.Fecha_Registro AS Fecha_Registro, x.Descripcion AS Descripcion FROM inserted x WHERE x.idReserva = i.idReserva
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
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Reserva',
         LEFT(CAST(d.idReserva AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Reserva (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idReserva AS idReserva, x.idUsuario AS idUsuario, x.idPago AS idPago, x.idCancha AS idCancha, x.idEstado_Reserva AS idEstado_Reserva, x.Folio AS Folio, x.Fecha_Reserva AS Fecha_Reserva, x.Hora_Inicio AS Hora_Inicio, x.Hora_Fin AS Hora_Fin, x.Fecha_Registro AS Fecha_Registro, x.Descripcion AS Descripcion FROM deleted x WHERE x.idReserva = d.idReserva
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Torneo (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_torneo_ins ON dbo.Torneo AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Torneo',
         LEFT(CAST(i.idTorneo AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Torneo (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idTorneo AS idTorneo, x.idTipo_Cancha AS idTipo_Cancha, x.Torneo AS Torneo, x.Fecha_Inicio AS Fecha_Inicio, x.Fecha_Fin AS Fecha_Fin, x.Costo AS Costo, x.Estado_Torneo AS Estado_Torneo FROM inserted x WHERE x.idTorneo = i.idTorneo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Torneo (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_torneo_upd ON dbo.Torneo AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Torneo',
         LEFT(CAST(i.idTorneo AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Torneo (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idTorneo AS idTorneo, x.idTipo_Cancha AS idTipo_Cancha, x.Torneo AS Torneo, x.Fecha_Inicio AS Fecha_Inicio, x.Fecha_Fin AS Fecha_Fin, x.Costo AS Costo, x.Estado_Torneo AS Estado_Torneo FROM deleted x WHERE x.idTorneo = i.idTorneo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idTorneo AS idTorneo, x.idTipo_Cancha AS idTipo_Cancha, x.Torneo AS Torneo, x.Fecha_Inicio AS Fecha_Inicio, x.Fecha_Fin AS Fecha_Fin, x.Costo AS Costo, x.Estado_Torneo AS Estado_Torneo FROM inserted x WHERE x.idTorneo = i.idTorneo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idTorneo = i.idTorneo;
END
GO

-- ---------- Torneo (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_torneo_del ON dbo.Torneo AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Torneo',
         LEFT(CAST(d.idTorneo AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Torneo (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idTorneo AS idTorneo, x.idTipo_Cancha AS idTipo_Cancha, x.Torneo AS Torneo, x.Fecha_Inicio AS Fecha_Inicio, x.Fecha_Fin AS Fecha_Fin, x.Costo AS Costo, x.Estado_Torneo AS Estado_Torneo FROM deleted x WHERE x.idTorneo = d.idTorneo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Equipo (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_equipo_ins ON dbo.Equipo AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Equipo',
         LEFT(CAST(i.idEquipo AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Equipo (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idEquipo AS idEquipo, x.idUsuario AS idUsuario, x.Equipo AS Equipo FROM inserted x WHERE x.idEquipo = i.idEquipo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Equipo (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_equipo_upd ON dbo.Equipo AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Equipo',
         LEFT(CAST(i.idEquipo AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Equipo (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idEquipo AS idEquipo, x.idUsuario AS idUsuario, x.Equipo AS Equipo FROM deleted x WHERE x.idEquipo = i.idEquipo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idEquipo AS idEquipo, x.idUsuario AS idUsuario, x.Equipo AS Equipo FROM inserted x WHERE x.idEquipo = i.idEquipo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idEquipo = i.idEquipo;
END
GO

-- ---------- Equipo (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_equipo_del ON dbo.Equipo AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Equipo',
         LEFT(CAST(d.idEquipo AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Equipo (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idEquipo AS idEquipo, x.idUsuario AS idUsuario, x.Equipo AS Equipo FROM deleted x WHERE x.idEquipo = d.idEquipo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- ---------- Inscripcion_Torneo (INSERT) ----------
CREATE OR ALTER TRIGGER tr_auditoria_inscripcion_torneo_ins ON dbo.Inscripcion_Torneo AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_INSERCION', N'Base de datos', N'Inscripcion_Torneo',
         LEFT(CAST(i.idTorneo AS NVARCHAR(20)) + N'-' + CAST(i.idEquipo AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Inscripcion_Torneo (INSERT) hecho por ' + SUSER_SNAME(), 500),
         NULL,
         (SELECT x.idTorneo AS idTorneo, x.idEquipo AS idEquipo, x.idPago AS idPago, x.Fecha_Inscripcion AS Fecha_Inscripcion, x.Estado_Inscripcion AS Estado_Inscripcion FROM inserted x WHERE x.idTorneo = i.idTorneo AND x.idEquipo = i.idEquipo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i;
END
GO

-- ---------- Inscripcion_Torneo (UPDATE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_inscripcion_torneo_upd ON dbo.Inscripcion_Torneo AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ACTUALIZACION', N'Base de datos', N'Inscripcion_Torneo',
         LEFT(CAST(i.idTorneo AS NVARCHAR(20)) + N'-' + CAST(i.idEquipo AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Inscripcion_Torneo (UPDATE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idTorneo AS idTorneo, x.idEquipo AS idEquipo, x.idPago AS idPago, x.Fecha_Inscripcion AS Fecha_Inscripcion, x.Estado_Inscripcion AS Estado_Inscripcion FROM deleted x WHERE x.idTorneo = i.idTorneo AND x.idEquipo = i.idEquipo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idTorneo AS idTorneo, x.idEquipo AS idEquipo, x.idPago AS idPago, x.Fecha_Inscripcion AS Fecha_Inscripcion, x.Estado_Inscripcion AS Estado_Inscripcion FROM inserted x WHERE x.idTorneo = i.idTorneo AND x.idEquipo = i.idEquipo
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM inserted i JOIN deleted d ON d.idTorneo = i.idTorneo AND d.idEquipo = i.idEquipo;
END
GO

-- ---------- Inscripcion_Torneo (DELETE) ----------
CREATE OR ALTER TRIGGER tr_auditoria_inscripcion_torneo_del ON dbo.Inscripcion_Torneo AFTER DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF APP_NAME() = N'RanchoSecoApp' RETURN;   -- los cambios de la app ya se registran desde Node

  INSERT INTO dbo.Bitacora (Correo_Usuario, Rol_Usuario, Accion, Modulo, Tabla_Afectada, idRegistro,
                            Descripcion, Datos_Anteriores, Datos_Nuevos, IP, Navegador, Resultado, Origen)
  SELECT LEFT(SUSER_SNAME(), 100), N'Acceso directo a BD', N'BD_ELIMINACION', N'Base de datos', N'Inscripcion_Torneo',
         LEFT(CAST(d.idTorneo AS NVARCHAR(20)) + N'-' + CAST(d.idEquipo AS NVARCHAR(20)), 40),
         LEFT(N'Cambio directo en la tabla Inscripcion_Torneo (DELETE) hecho por ' + SUSER_SNAME(), 500),
         (SELECT x.idTorneo AS idTorneo, x.idEquipo AS idEquipo, x.idPago AS idPago, x.Fecha_Inscripcion AS Fecha_Inscripcion, x.Estado_Inscripcion AS Estado_Inscripcion FROM deleted x WHERE x.idTorneo = d.idTorneo AND x.idEquipo = d.idEquipo
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
         (SELECT x.idJuego AS idJuego, x.idCancha AS idCancha, x.idEquipo_Visitante AS idEquipo_Visitante, x.idEquipo_Local AS idEquipo_Local, x.idTorneo AS idTorneo, x.Jornada AS Jornada, x.Goles_Local AS Goles_Local, x.Goles_Visitante AS Goles_Visitante, x.Estado_Juego AS Estado_Juego, x.Fecha_Juego AS Fecha_Juego FROM inserted x WHERE x.idJuego = i.idJuego
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
         (SELECT x.idJuego AS idJuego, x.idCancha AS idCancha, x.idEquipo_Visitante AS idEquipo_Visitante, x.idEquipo_Local AS idEquipo_Local, x.idTorneo AS idTorneo, x.Jornada AS Jornada, x.Goles_Local AS Goles_Local, x.Goles_Visitante AS Goles_Visitante, x.Estado_Juego AS Estado_Juego, x.Fecha_Juego AS Fecha_Juego FROM deleted x WHERE x.idJuego = i.idJuego
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idJuego AS idJuego, x.idCancha AS idCancha, x.idEquipo_Visitante AS idEquipo_Visitante, x.idEquipo_Local AS idEquipo_Local, x.idTorneo AS idTorneo, x.Jornada AS Jornada, x.Goles_Local AS Goles_Local, x.Goles_Visitante AS Goles_Visitante, x.Estado_Juego AS Estado_Juego, x.Fecha_Juego AS Fecha_Juego FROM inserted x WHERE x.idJuego = i.idJuego
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
         (SELECT x.idJuego AS idJuego, x.idCancha AS idCancha, x.idEquipo_Visitante AS idEquipo_Visitante, x.idEquipo_Local AS idEquipo_Local, x.idTorneo AS idTorneo, x.Jornada AS Jornada, x.Goles_Local AS Goles_Local, x.Goles_Visitante AS Goles_Visitante, x.Estado_Juego AS Estado_Juego, x.Fecha_Juego AS Fecha_Juego FROM deleted x WHERE x.idJuego = d.idJuego
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
         (SELECT x.idAsignacion_Arbitro AS idAsignacion_Arbitro, x.idJuego AS idJuego, x.idUsuario AS idUsuario, x.Rol_Arbitro AS Rol_Arbitro, x.Estado_Asignacion AS Estado_Asignacion FROM inserted x WHERE x.idAsignacion_Arbitro = i.idAsignacion_Arbitro
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
         (SELECT x.idAsignacion_Arbitro AS idAsignacion_Arbitro, x.idJuego AS idJuego, x.idUsuario AS idUsuario, x.Rol_Arbitro AS Rol_Arbitro, x.Estado_Asignacion AS Estado_Asignacion FROM deleted x WHERE x.idAsignacion_Arbitro = i.idAsignacion_Arbitro
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         (SELECT x.idAsignacion_Arbitro AS idAsignacion_Arbitro, x.idJuego AS idJuego, x.idUsuario AS idUsuario, x.Rol_Arbitro AS Rol_Arbitro, x.Estado_Asignacion AS Estado_Asignacion FROM inserted x WHERE x.idAsignacion_Arbitro = i.idAsignacion_Arbitro
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
         (SELECT x.idAsignacion_Arbitro AS idAsignacion_Arbitro, x.idJuego AS idJuego, x.idUsuario AS idUsuario, x.Rol_Arbitro AS Rol_Arbitro, x.Estado_Asignacion AS Estado_Asignacion FROM deleted x WHERE x.idAsignacion_Arbitro = d.idAsignacion_Arbitro
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
         NULL,
         LEFT(ISNULL(CONVERT(NVARCHAR(45), CONNECTIONPROPERTY('client_net_address')), N'local'), 45),
         LEFT(N'SQL Server: ' + ISNULL(APP_NAME(), N'conexión directa'), 300),
         N'Éxito', N'Base de datos'
    FROM deleted d;
END
GO

-- =====================================================================
-- 6. VERIFICACIÓN
-- =====================================================================
SELECT idRol, Rol, Nivel_Acceso FROM dbo.Rol ORDER BY idRol;

SELECT idUsuario, Nombre, Correo, Estado, MFA_Activo, Intentos_Fallidos, Token_Version
  FROM dbo.Usuario ORDER BY idUsuario;

SELECT COUNT(*) AS Triggers_Auditoria
  FROM sys.triggers WHERE name LIKE 'tr[_]auditoria[_]%';

SELECT TOP (5) idBitacora, Fecha, Correo_Usuario, Accion, Descripcion
  FROM dbo.Bitacora ORDER BY idBitacora DESC;
GO
