-- =============================================================================
-- ESQUEMA COMPLETO DE BASE DE DATOS: MASTERDRINKS POS & ADMIN
-- Motor: SQLite (compatible con SQLite 3 / PostgreSQL / MySQL adaptando tipos)
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. CONFIGURACIÓN E IDENTIDAD DEL EVENTO
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evento (
    id_evento INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_evento TEXT,
    fecha_evento TEXT,
    lugar TEXT,
    descripcion TEXT,
    hora_inicio TEXT,
    hora_fin TEXT,
    activo INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS configuracion (
    id_configuracion INTEGER PRIMARY KEY CHECK (id_configuracion = 1),
    evento TEXT,
    fecha TEXT,
    lugar TEXT,
    barra TEXT,
    responsable TEXT,
    logo_ticket TEXT
);

CREATE TABLE IF NOT EXISTS instancia (
    clave TEXT PRIMARY KEY,
    valor TEXT
);

CREATE TABLE IF NOT EXISTS barra (
    id_barra INTEGER PRIMARY KEY AUTOINCREMENT,
    id_evento INTEGER,
    nombre_barra TEXT,
    descripcion TEXT,
    ubicacion TEXT,
    activo INTEGER DEFAULT 1,
    FOREIGN KEY (id_evento) REFERENCES evento(id_evento)
);

-- -----------------------------------------------------------------------------
-- 2. USUARIOS, ROLES Y AUDITORÍA
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS administrador_evento (
    id_admin INTEGER PRIMARY KEY AUTOINCREMENT,
    id_evento INTEGER,
    nombre TEXT,
    usuario TEXT UNIQUE,
    password TEXT,
    rol TEXT,
    activo INTEGER DEFAULT 1,
    FOREIGN KEY (id_evento) REFERENCES evento(id_evento)
);

CREATE TABLE IF NOT EXISTS cajero (
    id_cajero INTEGER PRIMARY KEY AUTOINCREMENT,
    id_barra INTEGER,
    nombre TEXT,
    usuario TEXT UNIQUE,
    password TEXT,
    activo INTEGER DEFAULT 1,
    FOREIGN KEY (id_barra) REFERENCES barra(id_barra)
);

CREATE TABLE IF NOT EXISTS mesero (
    id_mesero INTEGER PRIMARY KEY AUTOINCREMENT,
    id_evento INTEGER,
    id_cajero INTEGER,
    nombre TEXT,
    usuario TEXT UNIQUE,
    password TEXT,
    activo INTEGER DEFAULT 1,
    FOREIGN KEY (id_evento) REFERENCES evento(id_evento),
    FOREIGN KEY (id_cajero) REFERENCES cajero(id_cajero)
);

CREATE TABLE IF NOT EXISTS auditoria_admin (
    id_auditoria INTEGER PRIMARY KEY AUTOINCREMENT,
    id_admin INTEGER,
    id_evento INTEGER,
    accion TEXT,
    entidad TEXT,
    id_registro INTEGER,
    detalle TEXT,
    fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_admin) REFERENCES administrador_evento(id_admin),
    FOREIGN KEY (id_evento) REFERENCES evento(id_evento)
);

-- -----------------------------------------------------------------------------
-- 3. CATÁLOGO DE PRODUCTOS, COMBOS Y CONTROL DE STOCK
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categoria_producto (
    id_categoria INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE,
    descripcion TEXT,
    tipo TEXT,
    activo INTEGER DEFAULT 1,
    creado_por_admin INTEGER,
    fecha_creacion TEXT,
    orden INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS producto (
    id_producto INTEGER PRIMARY KEY AUTOINCREMENT,
    id_categoria INTEGER,
    nombre TEXT,
    descripcion TEXT,
    tipo_producto TEXT,
    precio_venta REAL,
    stock_actual INTEGER,
    activo INTEGER DEFAULT 1,
    creado_por_admin INTEGER,
    fecha_creacion TEXT,
    foto TEXT,
    requiere_acompanante INTEGER DEFAULT 0,
    es_acompanante INTEGER DEFAULT 0,
    orden INTEGER DEFAULT 0,
    FOREIGN KEY (id_categoria) REFERENCES categoria_producto(id_categoria)
);

CREATE TABLE IF NOT EXISTS movimiento_stock (
    id_movimiento INTEGER PRIMARY KEY AUTOINCREMENT,
    id_producto INTEGER,
    id_admin INTEGER,
    tipo_movimiento TEXT,
    cantidad INTEGER,
    stock_anterior INTEGER,
    stock_nuevo INTEGER,
    motivo TEXT,
    fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_producto) REFERENCES producto(id_producto),
    FOREIGN KEY (id_admin) REFERENCES administrador_evento(id_admin)
);

CREATE TABLE IF NOT EXISTS traspaso (
    id_traspaso INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT,             -- 'SALIDA' | 'ENTRADA'
    motivo TEXT,           -- 'TRASPASO' | 'COMPRA'
    contraparte TEXT,      -- destino / origen / proveedor
    observaciones TEXT,
    id_cajero INTEGER,
    id_admin INTEGER,
    fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS traspaso_detalle (
    id_detalle_traspaso INTEGER PRIMARY KEY AUTOINCREMENT,
    id_traspaso INTEGER,
    id_producto INTEGER,
    cantidad INTEGER,
    FOREIGN KEY (id_traspaso) REFERENCES traspaso(id_traspaso) ON DELETE CASCADE,
    FOREIGN KEY (id_producto) REFERENCES producto(id_producto)
);

CREATE TABLE IF NOT EXISTS promocion (
    id_promocion INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    descripcion TEXT,
    precio REAL,
    activa INTEGER DEFAULT 1,
    creada_por_admin INTEGER,
    fecha_creacion TEXT DEFAULT CURRENT_TIMESTAMP,
    foto TEXT,
    eliminada INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promocion_detalle (
    id_detalle_promocion INTEGER PRIMARY KEY AUTOINCREMENT,
    id_promocion INTEGER,
    id_producto INTEGER,
    cantidad INTEGER,
    FOREIGN KEY (id_promocion) REFERENCES promocion(id_promocion) ON DELETE CASCADE,
    FOREIGN KEY (id_producto) REFERENCES producto(id_producto)
);

-- -----------------------------------------------------------------------------
-- 4. COMANDAS, DETALLES Y REGISTRO DE PAGOS
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS metodo_pago (
    id_metodo_pago INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE,
    descripcion TEXT,
    activo INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS comanda (
    id_comanda INTEGER PRIMARY KEY AUTOINCREMENT,
    id_evento INTEGER,
    id_barra INTEGER,
    id_cajero INTEGER,
    id_mesero INTEGER,
    fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
    total REAL,
    estado_pago TEXT,
    estatus TEXT,
    observaciones TEXT,
    anulada_por_admin INTEGER NULL,
    fecha_anulacion TEXT NULL,
    motivo_anulacion TEXT NULL,
    clave_idempotencia TEXT,
    FOREIGN KEY (id_evento) REFERENCES evento(id_evento),
    FOREIGN KEY (id_barra) REFERENCES barra(id_barra),
    FOREIGN KEY (id_cajero) REFERENCES cajero(id_cajero),
    FOREIGN KEY (id_mesero) REFERENCES mesero(id_mesero)
);

CREATE TABLE IF NOT EXISTS detalle_comanda (
    id_detalle INTEGER PRIMARY KEY AUTOINCREMENT,
    id_comanda INTEGER,
    id_producto INTEGER,
    cantidad INTEGER,
    precio_unitario REAL,
    subtotal REAL,
    id_detalle_padre INTEGER,
    id_promocion INTEGER,
    FOREIGN KEY (id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE,
    FOREIGN KEY (id_producto) REFERENCES producto(id_producto)
);

CREATE TABLE IF NOT EXISTS pago_comanda (
    id_pago INTEGER PRIMARY KEY AUTOINCREMENT,
    id_comanda INTEGER,
    id_metodo_pago INTEGER,
    monto REAL,
    fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
    referencia TEXT,
    estado TEXT,
    FOREIGN KEY (id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE,
    FOREIGN KEY (id_metodo_pago) REFERENCES metodo_pago(id_metodo_pago)
);

CREATE TABLE IF NOT EXISTS impresion_comanda_cajero (
    id_impresion_cajero INTEGER PRIMARY KEY AUTOINCREMENT,
    id_comanda INTEGER,
    fecha_hora_impresion TEXT DEFAULT CURRENT_TIMESTAMP,
    numero_copia INTEGER,
    id_cajero INTEGER,
    id_mesero INTEGER,
    FOREIGN KEY (id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS impresion_comanda_mesero (
    id_impresion_mesero INTEGER PRIMARY KEY AUTOINCREMENT,
    id_comanda INTEGER,
    fecha_hora_impresion TEXT DEFAULT CURRENT_TIMESTAMP,
    numero_copia INTEGER,
    id_cajero INTEGER,
    id_mesero INTEGER,
    FOREIGN KEY (id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- 5. ÍNDICES DE RENDIMIENTO E INTEGRIDAD
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_admin_login ON administrador_evento(usuario, password, activo);
CREATE INDEX IF NOT EXISTS idx_cajero_login ON cajero(usuario, password, activo);
CREATE INDEX IF NOT EXISTS idx_mesero_cajero_activo ON mesero(id_cajero, activo);

CREATE INDEX IF NOT EXISTS idx_producto_categoria_activo ON producto(id_categoria, activo);
CREATE INDEX IF NOT EXISTS idx_movimiento_stock_producto ON movimiento_stock(id_producto);

CREATE INDEX IF NOT EXISTS idx_comanda_evento_fecha ON comanda(id_evento, fecha_hora);
CREATE INDEX IF NOT EXISTS idx_comanda_barra ON comanda(id_barra);
CREATE INDEX IF NOT EXISTS idx_comanda_cajero ON comanda(id_cajero);
CREATE INDEX IF NOT EXISTS idx_comanda_estatus ON comanda(estatus, fecha_hora);
CREATE INDEX IF NOT EXISTS idx_comanda_anulada ON comanda(anulada_por_admin);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comanda_idempotencia 
    ON comanda(clave_idempotencia) 
    WHERE clave_idempotencia IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_detalle_comanda_comanda ON detalle_comanda(id_comanda);
CREATE INDEX IF NOT EXISTS idx_detalle_comanda_producto ON detalle_comanda(id_producto);

CREATE INDEX IF NOT EXISTS idx_pago_comanda_comanda ON pago_comanda(id_comanda);
CREATE INDEX IF NOT EXISTS idx_pago_comanda_metodo ON pago_comanda(id_metodo_pago);
