-- =====================================================================
-- Presupuesto — esquema inicial
-- MySQL 8+ / utf8mb4
--
-- CONVENIO DE SIGNOS: se guarda tal cual lo da el banco.
--   ingreso  -> importe positivo
--   gasto    -> importe negativo
-- El exportador a Sheets invierte los gastos para cuadrar con el libro.
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- categorias: jerarquia plana categoria > subcategoria
-- ---------------------------------------------------------------------
CREATE TABLE categorias (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  categoria       VARCHAR(80)  NOT NULL,   -- VIVIENDA, OCIO, INGRESOS...
  subcategoria    VARCHAR(80)  NOT NULL,   -- Hipoteca, Comunidad...
  tipo            ENUM('ingreso','gasto','ahorro','inversion','traspaso') NOT NULL,
  -- reparto 50/30/20; null para ingresos y traspasos
  reparto         ENUM('fijo','variable','ahorro_inversion') NULL,
  orden           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  activa          TINYINT(1)   NOT NULL DEFAULT 1,
  creada_en       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- clave natural unica: evita los 'Google' y 'Ropa' duplicados del Excel
  UNIQUE KEY uq_cat (categoria, subcategoria),
  KEY ix_tipo (tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- importaciones: una fila por fichero subido
-- ---------------------------------------------------------------------
CREATE TABLE importaciones (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  origen          ENUM('banco','paypal','manual') NOT NULL,
  fichero         VARCHAR(255) NOT NULL,
  hash_fichero    CHAR(64)     NOT NULL,   -- sha256 del contenido crudo
  filas_leidas    INT UNSIGNED NOT NULL DEFAULT 0,
  filas_nuevas    INT UNSIGNED NOT NULL DEFAULT 0,
  filas_repetidas INT UNSIGNED NOT NULL DEFAULT 0,
  desde           DATE NULL,
  hasta           DATE NULL,
  creada_en       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_fichero (hash_fichero)     -- mismo fichero dos veces: no
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- movimientos
-- ---------------------------------------------------------------------
CREATE TABLE movimientos (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fecha           DATE           NOT NULL,
  fecha_valor     DATE           NULL,
  concepto        VARCHAR(500)   NOT NULL,   -- literal del banco, sin tocar
  concepto_norm   VARCHAR(500)   NOT NULL,   -- minusculas y sin acentos, para el matching
  importe         DECIMAL(12,2)  NOT NULL,   -- DECIMAL, nunca FLOAT
  saldo           DECIMAL(14,2)  NULL,
  origen          ENUM('banco','paypal','manual') NOT NULL,
  cuenta          VARCHAR(60)    NULL,       -- ultimos digitos de tarjeta / IBAN

  categoria_id    INT UNSIGNED   NULL,
  -- de donde salio la clasificacion. 'manual' NUNCA se pisa al reclasificar.
  clasif_origen   ENUM('manual','regla','importador') NULL,
  regla_id        INT UNSIGNED   NULL,       -- que regla lo clasifico
  estado          ENUM('pendiente','ok','revisar','ignorado') NOT NULL DEFAULT 'pendiente',

  -- idempotencia. seq desempata movimientos legitimamente identicos
  -- el mismo dia (dos cafes de 1,50 EUR no son un duplicado).
  hash            CHAR(64)       NOT NULL,
  hash_seq        TINYINT UNSIGNED NOT NULL DEFAULT 0,

  ref_externa     VARCHAR(80)    NULL,       -- transaction id de PayPal
  importacion_id  INT UNSIGNED   NULL,
  notas           VARCHAR(500)   NULL,
  creado_en       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_mov (hash, hash_seq),
  KEY ix_fecha (fecha),
  KEY ix_estado (estado, fecha),
  KEY ix_cat_fecha (categoria_id, fecha),
  KEY ix_origen (origen, fecha),
  KEY ix_norm (concepto_norm(191)),

  CONSTRAINT fk_mov_cat FOREIGN KEY (categoria_id)
    REFERENCES categorias(id) ON DELETE SET NULL,
  CONSTRAINT fk_mov_imp FOREIGN KEY (importacion_id)
    REFERENCES importaciones(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- reglas: patron sobre concepto_norm -> categoria
-- ---------------------------------------------------------------------
CREATE TABLE reglas (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patron          VARCHAR(200)   NOT NULL,
  tipo_patron     ENUM('contiene','regex') NOT NULL DEFAULT 'contiene',
  categoria_id    INT UNSIGNED   NOT NULL,
  origen          ENUM('banco','paypal','todos') NOT NULL DEFAULT 'todos',
  prioridad       SMALLINT UNSIGNED NOT NULL DEFAULT 100,  -- menor = antes
  -- excluir=1 marca el movimiento como 'ignorado' en vez de clasificarlo.
  -- Para "Paypal Europe" (el cargo lo aporta el CSV de PayPal, no el banco)
  -- y para los traspasos entre cuentas propias.
  excluir         TINYINT(1)     NOT NULL DEFAULT 0,
  activa          TINYINT(1)     NOT NULL DEFAULT 1,
  aciertos        INT UNSIGNED   NOT NULL DEFAULT 0,
  ultima_vez      TIMESTAMP      NULL,
  creada_en       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_patron (patron, origen),
  KEY ix_orden (activa, prioridad),

  CONSTRAINT fk_regla_cat FOREIGN KEY (categoria_id)
    REFERENCES categorias(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- presupuesto: una fila por (anio, mes, categoria)
-- ---------------------------------------------------------------------
CREATE TABLE presupuesto (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  anio            SMALLINT UNSIGNED NOT NULL,
  mes             TINYINT UNSIGNED  NOT NULL,   -- 1..12
  categoria_id    INT UNSIGNED      NOT NULL,
  importe         DECIMAL(12,2)     NOT NULL DEFAULT 0.00,
  nota            VARCHAR(200)      NULL,
  actualizado_en  TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_ppto (anio, mes, categoria_id),
  KEY ix_periodo (anio, mes),

  CONSTRAINT fk_ppto_cat FOREIGN KEY (categoria_id)
    REFERENCES categorias(id) ON DELETE CASCADE,
  CONSTRAINT ck_mes CHECK (mes BETWEEN 1 AND 12)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
-- VISTAS
-- =====================================================================

-- Real por mes y categoria. Los traspasos y lo ignorado quedan fuera:
-- son movimiento de dinero propio, no ingreso ni gasto.
CREATE OR REPLACE VIEW v_real_mensual AS
SELECT
  YEAR(m.fecha)              AS anio,
  MONTH(m.fecha)             AS mes,
  m.categoria_id,
  c.categoria,
  c.subcategoria,
  c.tipo,
  c.reparto,
  SUM(m.importe)             AS importe_neto,
  COUNT(*)                   AS n_movimientos
FROM movimientos m
JOIN categorias c ON c.id = m.categoria_id
WHERE m.estado <> 'ignorado'
  AND c.tipo   <> 'traspaso'
GROUP BY 1,2,3,4,5,6,7;

-- Presupuesto vs real
CREATE OR REPLACE VIEW v_ppto_vs_real AS
SELECT
  p.anio, p.mes, p.categoria_id,
  c.categoria, c.subcategoria, c.tipo,
  p.importe                              AS presupuestado,
  COALESCE(r.importe_neto, 0)            AS real_neto,
  COALESCE(r.importe_neto, 0) - p.importe AS desviacion
FROM presupuesto p
JOIN categorias c      ON c.id = p.categoria_id
LEFT JOIN v_real_mensual r
       ON r.anio = p.anio AND r.mes = p.mes AND r.categoria_id = p.categoria_id;

-- La bandeja de entrada: lo que falta por clasificar, lo gordo primero
CREATE OR REPLACE VIEW v_pendientes AS
SELECT id, fecha, concepto, importe, origen, cuenta
FROM movimientos
WHERE estado = 'pendiente'
ORDER BY ABS(importe) DESC, fecha DESC;

-- Control de sanidad: un movimiento clasificado no deberia seguir pendiente,
-- ni uno sin categoria estar marcado como ok. Deberia devolver 0 filas.
CREATE OR REPLACE VIEW v_incoherencias AS
SELECT id, fecha, concepto, importe, estado, categoria_id
FROM movimientos
WHERE (categoria_id IS NULL     AND estado = 'ok')
   OR (categoria_id IS NOT NULL AND estado = 'pendiente');
