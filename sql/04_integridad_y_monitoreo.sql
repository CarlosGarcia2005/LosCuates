-- =====================================================================
--  Gestor Deportivo Rancho Seco  (SQL Server / Azure SQL)
--  04 - Integridad de la bitácora (OWASP A08 / A09)
-- ---------------------------------------------------------------------
--  * Abre este archivo en SSMS, elige la base del proyecto (en Azure:
--    clic derecho en la base → Nueva consulta) y ejecútalo completo con F5.
--  * Requiere 02 y 03. Se puede ejecutar más de una vez. NO borra datos.
--
--  Qué agrega:
--   1. Bitacora.Hash_Integridad: cada registro nuevo lleva una firma
--      HMAC-SHA256 que incluye la firma del registro anterior (cadena).
--      Si alguien cambia o borra un registro directamente en la base,
--      la cadena se rompe y el sistema lo detecta.
--   2. Bitacora_Cadena: guarda la última firma y cuántos registros
--      firmados hay (así también se detecta si borran los últimos).
--   3. Vuelve a crear los triggers que impiden editar o borrar la
--      bitácora (por si alguien los quitó).
-- =====================================================================
SET NOCOUNT ON;
GO

-- ---------------------------------------------------------------------
-- 1. Columna de firma en la bitácora
-- ---------------------------------------------------------------------
IF COL_LENGTH('dbo.Bitacora', 'Hash_Integridad') IS NULL
BEGIN
  ALTER TABLE dbo.Bitacora ADD Hash_Integridad CHAR(64) NULL;
  PRINT 'Bitacora.Hash_Integridad agregada.';
END
ELSE PRINT 'Bitacora.Hash_Integridad ya existe.';
GO

-- ---------------------------------------------------------------------
-- 2. Estado de la cadena (una sola fila)
-- ---------------------------------------------------------------------
IF OBJECT_ID('dbo.Bitacora_Cadena', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Bitacora_Cadena (
    id           TINYINT  NOT NULL,
    Ultimo_Hash  CHAR(64) NOT NULL,
    Total        BIGINT   NOT NULL CONSTRAINT df_bitacora_cadena_total DEFAULT (0),
    Ultimo_id    BIGINT   NULL,
    Actualizado  DATETIME NOT NULL CONSTRAINT df_bitacora_cadena_fecha DEFAULT (GETDATE()),
    CONSTRAINT pk_bitacora_cadena PRIMARY KEY (id),
    CONSTRAINT ck_bitacora_cadena_unica CHECK (id = 1)
  );
  PRINT 'Tabla Bitacora_Cadena creada.';
END
ELSE PRINT 'La tabla Bitacora_Cadena ya existe.';
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Bitacora_Cadena WHERE id = 1)
  INSERT INTO dbo.Bitacora_Cadena (id, Ultimo_Hash, Total) VALUES (1, REPLICATE('0', 64), 0);
GO

CREATE OR ALTER TRIGGER tr_bitacora_cadena_no_borrar ON dbo.Bitacora_Cadena INSTEAD OF DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 50001, 'El estado de la cadena de la bitacora no se puede borrar', 1;
END
GO

-- ---------------------------------------------------------------------
-- 3. La bitácora no se puede modificar ni borrar (se vuelven a crear)
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

INSERT INTO dbo.Bitacora (Correo_Usuario, Accion, Modulo, Descripcion, Origen)
VALUES (LEFT(SUSER_SNAME(), 100), N'SISTEMA', N'Sistema',
        N'Se activó la cadena de integridad de la bitácora (OWASP A08/A09)', N'Base de datos');
GO

-- =====================================================================
-- VERIFICACIÓN
-- =====================================================================
SELECT id, Ultimo_Hash, Total, Ultimo_id, Actualizado FROM dbo.Bitacora_Cadena;
SELECT name AS trigger_activo FROM sys.triggers
 WHERE name IN ('tr_bitacora_no_editar', 'tr_bitacora_no_borrar', 'tr_bitacora_cadena_no_borrar') AND is_disabled = 0;
SELECT N'Listo: bitácora con cadena de integridad' AS resultado;
GO
