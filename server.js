require('dotenv').config();
const express = require('express');
const path = require('path');
// SQLite incorporado en Node (>= 22.5). A diferencia del paquete `sqlite3`, no es
// un binario nativo: no hay que compilar nada, así que el mismo código corre en
// Windows y en la tablet Android con Termux, que es la que hace de servidor.
const { DatabaseSync } = require('node:sqlite');
// Generador de PDF propio, sin dependencias: ver el comentario de lib/pdf.js.
const { construirPdfCierre, nombreArchivoReporte } = require('./lib/reporte-cierre');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Dynamic route to serve Wallpaper.jpg from the project root directory
const fs = require('fs');
app.get('/Wallpaper.jpg', (req, res) => {
  const filePath = path.join(__dirname, 'Wallpaper.jpg');
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  const lowerPath = path.join(__dirname, 'wallpaper.jpg');
  if (fs.existsSync(lowerPath)) {
    return res.sendFile(lowerPath);
  }
  const publicPath = path.join(__dirname, 'public', 'wallpaper.png');
  if (fs.existsSync(publicPath)) {
    return res.sendFile(publicPath);
  }
  res.status(404).send('Wallpaper file not found in root.');
});

// Case insensitive aliases
app.get('/wallpaper.jpg', (req, res) => {
  res.redirect('/Wallpaper.jpg');
});
app.get('/wallpaper.png', (req, res) => {
  res.redirect('/Wallpaper.jpg');
});

// DB_FILE permite arrancar contra otra base sin tocar la del evento: es lo que
// usa la prueba de carga (tools/stress-test.js) para castigar una copia.
const dbFile = process.env.DB_FILE
  ? path.resolve(__dirname, process.env.DB_FILE)
  : path.join(__dirname, 'pos_evento.db');
const sqlite = new DatabaseSync(dbFile);

// ---------------------------------------------------------------------------
// Adaptador node:sqlite -> API estilo node-sqlite3
// ---------------------------------------------------------------------------
// node:sqlite es SÍNCRONO, pero el resto del archivo está escrito con callbacks.
// Este envoltorio mantiene las firmas run/all/get/serialize para no reescribir
// ninguna ruta. Ojo: como cada consulta se ejecuta al instante, la cola de
// transacciones (withTransaction) sigue siendo imprescindible, porque los
// `await` entre sentencias sí ceden el turno a otras peticiones.

const stmtCache = new Map();
function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = sqlite.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// node:sqlite solo admite null, number, bigint, string y Uint8Array. Un
// `undefined` (campo de formulario ausente) o un booleano lanzarían excepción.
function normalizeParams(params) {
  return (params || []).map(value => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
    return value;
  });
}

// Admite tanto (sql, params, cb) como (sql, cb).
function splitArgs(params, cb) {
  return typeof params === 'function' ? [[], params] : [params || [], cb];
}

function invoke(sql, params, cb, mode) {
  const [rawParams, callback] = splitArgs(params, cb);
  try {
    const stmt = prepare(sql);
    const args = normalizeParams(rawParams);

    if (mode === 'run') {
      const info = stmt.run(...args);
      // `this.lastID` / `this.changes`, igual que en node-sqlite3.
      if (callback) {
        callback.call({ lastID: Number(info.lastInsertRowid), changes: Number(info.changes) }, null);
      }
      return;
    }

    const rows = mode === 'get' ? stmt.get(...args) : stmt.all(...args);
    if (callback) callback.call({}, null, mode === 'get' ? (rows === undefined ? undefined : rows) : rows);
  } catch (err) {
    if (callback) callback.call({}, err, null);
    else console.error('SQLite error:', err.message, '| SQL:', sql);
  }
}

const db = {
  run: (sql, params, cb) => invoke(sql, params, cb, 'run'),
  all: (sql, params, cb) => invoke(sql, params, cb, 'all'),
  get: (sql, params, cb) => invoke(sql, params, cb, 'get'),
  exec: sql => sqlite.exec(sql),
  // node:sqlite ya es secuencial: no hay nada que serializar.
  serialize: fn => fn(),
  close: () => sqlite.close()
};

// SQLite runtime tuning:
// - foreign_keys is OFF by default in SQLite, so every FK/ON DELETE CASCADE in the
//   schema was purely decorative until now.
// - WAL keeps reads from blocking while a sale is being written.
// - busy_timeout avoids SQLITE_BUSY if two requests land at the same instant.
db.run('PRAGMA foreign_keys = ON');
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA busy_timeout = 5000');

// Promise wrappers used by the transactional routes below.
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve({ insertId: this.lastID, affectedRows: this.changes });
  });
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

// There is a single SQLite connection, so two overlapping BEGIN/COMMIT blocks would
// interleave and corrupt each other. This queue serialises whole transactions.
let txChain = Promise.resolve();
function withTransaction(work) {
  const run = txChain.then(async () => {
    await dbRun('BEGIN IMMEDIATE');
    try {
      const result = await work();
      await dbRun('COMMIT');
      return result;
    } catch (err) {
      try { await dbRun('ROLLBACK'); } catch (_) { /* nothing left to roll back */ }
      throw err;
    }
  });
  txChain = run.then(() => {}, () => {});
  return run;
}

// Error thrown for validation problems that should surface to the cashier as 400s.
class BusinessError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
// Money is stored as REAL; rounding every intermediate step keeps 0.1 + 0.2 artefacts
// out of the totals that end up printed on the ticket.
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Meseros authenticate with a short PIN only. 'servidor' (default) accepts any active
// waiter in this database: every cashier and every tablet hanging off this server is
// the same operation, so splitting them by till or by bar only locks out waiters who
// happen to be serving at another tablet. The narrower scopes are still available:
// 'barra' (waiters of the same bar as the logged-in cashier), 'cajero' (only the ones
// assigned to that cashier) and 'evento'. Note that a PIN must be unique inside
// whatever scope is chosen — /api/admin/meseros enforces exactly that same scope.
const MESERO_PIN_SCOPE = process.env.MESERO_PIN_SCOPE || 'servidor';

// Identidad de esta instancia. Cada barra levanta su propio servidor con su
// propia base, y las tres son iguales por fuera: sin esto habría tres comandas
// #1 circulando la misma noche y, al juntar las bases, nadie sabría cuál es
// cuál. El prefijo se antepone al número en tickets, pantalla e informes.
const INSTANCIA = (() => {
  const nombre = (process.env.INSTANCIA || '').trim() || 'Principal';
  // Si no se indica prefijo, se usa la primera letra del nombre: Norte -> N.
  const bruto = (process.env.PREFIJO || nombre.charAt(0)).trim().toUpperCase();
  // Sólo letras y dígitos, máximo 3: acaba impreso en papel de 32 columnas.
  const prefijo = (bruto.replace(/[^A-Z0-9]/g, '') || 'X').slice(0, 3);
  return { nombre, prefijo };
})();

/** Número de comanda tal como lo ve la gente: N-47 en vez de 47. */
const refComanda = id => INSTANCIA.prefijo + '-' + id;

// Turns raw SQLite errors into something a cashier can act on.
function friendlyDbError(err, entidad) {
  const msg = String(err && err.message ? err.message : err);
  if (msg.includes('UNIQUE constraint failed')) {
    if (msg.includes('.usuario')) return 'Ese usuario ya existe. Elige otro nombre de usuario.';
    if (msg.includes('.nombre')) return `Ya existe una ${entidad} con ese nombre.`;
    return `Ese registro de ${entidad} ya existe.`;
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return `La ${entidad} apunta a un registro que no existe (categoría, barra o cajero).`;
  }
  if (msg.includes('NOT NULL constraint failed')) return `Faltan datos obligatorios de la ${entidad}.`;
  console.error(`Error de base de datos al guardar ${entidad}:`, msg);
  return `No se pudo guardar la ${entidad}.`;
}

// Wrapper that mimics mysql pool and connection methods to support existing routes
const pool = {
  query: (sql, params, callback) => {
    let realParams = params;
    let realCallback = callback;
    if (typeof params === 'function') {
      realCallback = params;
      realParams = [];
    }

    // Convert MySQL queries to SQLite compatibility
    let sqliteSql = sql
      .replace(/NOW\(\)/gi, "datetime('now', 'localtime')")
      .replace(/GREATEST\(0,\s*stock_actual\s*-\s*\?\)/gi, "MAX(0, stock_actual - ?)");

    const isSelect = sqliteSql.trim().toUpperCase().startsWith('SELECT');
    
    if (isSelect) {
      db.all(sqliteSql, realParams, (err, rows) => {
        if (err) {
          console.error("SQLite Pool Query Error:", err, "SQL:", sqliteSql);
          realCallback(err, null);
        } else {
          realCallback(null, rows);
        }
      });
    } else {
      db.run(sqliteSql, realParams, function(err) {
        if (err) {
          console.error("SQLite Pool Run Error:", err, "SQL:", sqliteSql);
          realCallback(err, null);
        } else {
          realCallback(null, { insertId: this.lastID, affectedRows: this.changes });
        }
      });
    }
  },
  
  // ⚠ NO USAR para escribir. Este adaptador expone beginTransaction/commit tal
  // como los pedía el código de MySQL, pero aquí sólo hay UNA conexión SQLite:
  // abrir una transacción por fuera de withTransaction() la mete dentro de la
  // que esté corriendo, y el COMMIT de una acaba confirmando el trabajo a medias
  // de la otra. Para cualquier escritura transaccional usa withTransaction().
  getConnection: (callback) => {
    const conn = {
      query: (sql, params, cb) => {
        let realParams = params;
        let realCb = cb;
        if (typeof params === 'function') {
          realCb = params;
          realParams = [];
        }

        let sqliteSql = sql
          .replace(/NOW\(\)/gi, "datetime('now', 'localtime')")
          .replace(/GREATEST\(0,\s*stock_actual\s*-\s*\?\)/gi, "MAX(0, stock_actual - ?)");

        const isSelect = sqliteSql.trim().toUpperCase().startsWith('SELECT');
        if (isSelect) {
          db.all(sqliteSql, realParams, (err, rows) => {
            if (err) {
              console.error("SQLite Conn Query Error:", err, "SQL:", sqliteSql);
              realCb(err, null);
            } else {
              realCb(null, rows);
            }
          });
        } else {
          db.run(sqliteSql, realParams, function(err) {
            if (err) {
              console.error("SQLite Conn Run Error:", err, "SQL:", sqliteSql);
              realCb(err, null);
            } else {
              realCb(null, { insertId: this.lastID, affectedRows: this.changes });
            }
          });
        }
      },
      beginTransaction: (cb) => {
        db.run('BEGIN TRANSACTION', cb);
      },
      commit: (cb) => {
        db.run('COMMIT', cb);
      },
      rollback: (cb) => {
        db.run('ROLLBACK', cb);
      },
      release: () => {
        // No-op for SQLite
      }
    };
    callback(null, conn);
  }
};

let useMockDb = false;

// Pre-populate Mock Database with original SQL Dump data as a resilient fallback
const mockDb = {
  evento: [
    { id_evento: 1, nombre_evento: 'Festival Sonidos de Verano 2026', fecha_evento: '2026-09-12', lugar: 'Estadio Central', descripcion: 'Evento musical con sistema POS distribuido', hora_inicio: '17:00:00', hora_fin: '02:00:00', activo: 1 }
  ],
  barra: [
    { id_barra: 1, id_evento: 1, nombre_barra: 'Barra Norte', descripcion: 'Barra ubicada en la curva norte', ubicacion: 'Curva Norte', activo: 1 },
    { id_barra: 2, id_evento: 1, nombre_barra: 'Barra Sur', descripcion: 'Barra ubicada en la curva sur', ubicacion: 'Curva Sur', activo: 1 },
    { id_barra: 3, id_evento: 1, nombre_barra: 'Barra General', descripcion: 'Barra principal del sector general', ubicacion: 'General', activo: 1 }
  ],
  cajero: [
    { id_cajero: 1, id_barra: 1, nombre: 'Ana Torres', usuario: 'cajero_norte_1', password: 'demo123', activo: 1 },
    { id_cajero: 2, id_barra: 1, nombre: 'Luis Mendoza', usuario: 'cajero_norte_2', password: 'demo123', activo: 1 },
    { id_cajero: 3, id_barra: 1, nombre: 'Carla Rojas', usuario: 'cajero_norte_3', password: 'demo123', activo: 1 },
    { id_cajero: 4, id_barra: 2, nombre: 'Pedro Vargas', usuario: 'cajero_sur_1', password: 'demo123', activo: 1 },
    { id_cajero: 5, id_barra: 2, nombre: 'María Fernández', usuario: 'cajero_sur_2', password: 'demo123', activo: 1 },
    { id_cajero: 6, id_barra: 2, nombre: 'Diego López', usuario: 'cajero_sur_3', password: 'demo123', activo: 1 },
    { id_cajero: 7, id_barra: 3, nombre: 'Brisa Garcia', usuario: 'cajero_general_1', password: 'demo123', activo: 1 },
    { id_cajero: 8, id_barra: 3, nombre: 'Jorge Salinas', usuario: 'cajero_general_2', password: 'demo123', activo: 1 },
    { id_cajero: 9, id_barra: 3, nombre: 'Valeria Quiroga', usuario: 'cajero_general_3', password: 'demo123', activo: 1 }
  ],
  administrador_evento: [
    { id_admin: 1, id_evento: 1, nombre: 'Administrador Principal', usuario: 'admin_evento', password: 'demo123', rol: 'ADMINISTRADOR', activo: 1 },
    { id_admin: 2, id_evento: 1, nombre: 'Supervisor Operativo', usuario: 'supervisor_evento', password: 'demo123', rol: 'SUPERVISOR', activo: 1 }
  ],
  mesero: [],
  categoria_producto: [
    { id_categoria: 1, nombre: 'Cervezas', descripcion: 'Cervezas nacionales e importadas', tipo: 'BEBIDA', activo: 1, creado_por_admin: 1, fecha_creacion: '2026-08-15 11:53:57' },
    { id_categoria: 2, nombre: 'Whiskys', descripcion: 'Whiskys servidos por medida o vaso', tipo: 'BEBIDA', activo: 1, creado_por_admin: 1, fecha_creacion: '2026-08-15 11:53:57' },
    { id_categoria: 3, nombre: 'Comida', descripcion: 'Comidas rápidas para el evento', tipo: 'COMIDA', activo: 1, creado_por_admin: 1, fecha_creacion: '2026-08-15 11:53:57' }
  ],
  producto: [
    { id_producto: 1, id_categoria: 1, nombre: 'Cerveza Paceña 350 ml', descripcion: 'Lata individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 18.00, stock_actual: 120, activo: 1, creado_por_admin: 1 },
    { id_producto: 2, id_categoria: 1, nombre: 'Cerveza Huari 330 ml', descripcion: 'Botella individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 22.00, stock_actual: 95, activo: 1, creado_por_admin: 1 },
    { id_producto: 3, id_categoria: 1, nombre: 'Cerveza Corona 355 ml', descripcion: 'Botella individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 28.00, stock_actual: 70, activo: 1, creado_por_admin: 1 },
    { id_producto: 4, id_categoria: 1, nombre: 'Cerveza Stella Artois 330 ml', descripcion: 'Botella individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 30.00, stock_actual: 60, activo: 1, creado_por_admin: 1 },
    { id_producto: 5, id_categoria: 1, nombre: 'Cerveza Heineken 330 ml', descripcion: 'Botella individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 29.00, stock_actual: 85, activo: 1, creado_por_admin: 1 },
    { id_producto: 6, id_categoria: 1, nombre: 'Cerveza Budweiser 355 ml', descripcion: 'Lata individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 24.00, stock_actual: 90, activo: 1, creado_por_admin: 1 },
    { id_producto: 7, id_categoria: 1, nombre: 'Cerveza artesanal IPA', descripcion: 'Vaso 400 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 32.00, stock_actual: 45, activo: 1, creado_por_admin: 1 },
    { id_producto: 8, id_categoria: 2, nombre: 'Johnnie Walker Red Label', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 35.00, stock_actual: 38, activo: 1, creado_por_admin: 1 },
    { id_producto: 9, id_categoria: 2, nombre: 'Johnnie Walker Black Label', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 55.00, stock_actual: 30, activo: 1, creado_por_admin: 1 },
    { id_producto: 10, id_categoria: 2, nombre: 'Chivas Regal 12 años', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 52.00, stock_actual: 24, activo: 1, creado_por_admin: 1 },
    { id_producto: 11, id_categoria: 2, nombre: 'Jack Daniel\'s', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 48.00, stock_actual: 32, activo: 1, creado_por_admin: 1 },
    { id_producto: 12, id_categoria: 2, nombre: 'Ballantine\'s Finest', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 38.00, stock_actual: 36, activo: 1, creado_por_admin: 1 },
    { id_producto: 13, id_categoria: 2, nombre: 'Jameson Irish Whiskey', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 45.00, stock_actual: 28, activo: 1, creado_por_admin: 1 },
    { id_producto: 14, id_categoria: 3, nombre: 'Hamburguesa clásica', descripcion: 'Carne, queso, lechuga y tomate', tipo_producto: 'COMIDA', precio_venta: 38.00, stock_actual: 55, activo: 1, creado_por_admin: 1 },
    { id_producto: 15, id_categoria: 3, nombre: 'Hamburguesa doble', descripcion: 'Doble carne y doble queso', tipo_producto: 'COMIDA', precio_venta: 52.00, stock_actual: 42, activo: 1, creado_por_admin: 1 },
    { id_producto: 16, id_categoria: 3, nombre: 'Hot Dog', descripcion: 'Salchicha, papas y salsas', tipo_producto: 'COMIDA', precio_venta: 25.00, stock_actual: 65, activo: 1, creado_por_admin: 1 },
    { id_producto: 17, id_categoria: 3, nombre: 'Papas fritas', descripcion: 'Porción mediana', tipo_producto: 'COMIDA', precio_venta: 18.00, stock_actual: 80, activo: 1, creado_por_admin: 1 },
    { id_producto: 18, id_categoria: 3, nombre: 'Nachos con queso', descripcion: 'Nachos con salsa de queso', tipo_producto: 'COMIDA', precio_venta: 28.00, stock_actual: 50, activo: 1, creado_por_admin: 1 },
    { id_producto: 19, id_categoria: 3, nombre: 'Sándwich de pollo', descripcion: 'Pollo, lechuga y aderezos', tipo_producto: 'COMIDA', precio_venta: 32.00, stock_actual: 48, activo: 1, creado_por_admin: 1 },
    { id_producto: 20, id_categoria: 3, nombre: 'Pizza personal', descripcion: 'Pizza individual de queso y jamón', tipo_producto: 'COMIDA', precio_venta: 40.00, stock_actual: 40, activo: 1, creado_por_admin: 1 }
  ],
  comanda: [
    { id_comanda: 1, id_evento: 1, id_barra: 3, id_cajero: 7, id_mesero: 31, fecha_hora: '2026-08-15 11:53:58', total: 500.00, estado_pago: 'PAGADO', estatus: 'EN_PROCESO', observaciones: 'Comanda de demostración', anulada_por_admin: null, fecha_anulacion: null, motivo_anulacion: null }
  ],
  detalle_comanda: [
    { id_detalle: 1, id_comanda: 1, id_producto: 9, cantidad: 4, precio_unitario: 55.00, subtotal: 220.00 },
    { id_detalle: 2, id_comanda: 1, id_producto: 14, cantidad: 4, precio_unitario: 38.00, subtotal: 152.00 },
    { id_detalle: 3, id_comanda: 1, id_producto: 17, cantidad: 4, precio_unitario: 18.00, subtotal: 72.00 },
    { id_detalle: 4, id_comanda: 1, id_producto: 18, cantidad: 2, precio_unitario: 28.00, subtotal: 56.00 }
  ],
  pago_comanda: [
    { id_pago: 1, id_comanda: 1, id_metodo_pago: 1, monto: 200.00, fecha_hora: '2026-08-15 11:53:58', referencia: 'EFECTIVO-CAJA-001', estado: 'APROBADO' },
    { id_pago: 2, id_comanda: 1, id_metodo_pago: 2, monto: 300.00, fecha_hora: '2026-08-15 11:53:58', referencia: 'TARJETA-OPERACION-987654', estado: 'APROBADO' }
  ],
  metodo_pago: [
    { id_metodo_pago: 1, nombre: 'EFECTIVO', descripcion: 'Pago en efectivo', activo: 1 },
    { id_metodo_pago: 2, nombre: 'TARJETA', descripcion: 'Pago con tarjeta', activo: 1 },
    { id_metodo_pago: 3, nombre: 'QR', descripcion: 'Pago con código QR', activo: 1 },
    { id_metodo_pago: 4, nombre: 'TRANSFERENCIA', descripcion: 'Transferencia bancaria', activo: 1 }
  ],
  movimiento_stock: [
    { id_movimiento: 1, id_producto: 1, id_admin: 1, tipo_movimiento: 'ENTRADA', cantidad: 120, stock_anterior: 0, stock_nuevo: 120, motivo: 'Carga inicial de stock para el evento', fecha_hora: '2026-08-15 11:53:58' },
    { id_movimiento: 2, id_producto: 8, id_admin: 1, tipo_movimiento: 'ENTRADA', cantidad: 38, stock_anterior: 0, stock_nuevo: 38, motivo: 'Carga inicial de stock para el evento', fecha_hora: '2026-08-15 11:53:58' },
    { id_movimiento: 3, id_producto: 14, id_admin: 1, tipo_movimiento: 'ENTRADA', cantidad: 55, stock_anterior: 0, stock_nuevo: 55, motivo: 'Carga inicial de stock para el evento', fecha_hora: '2026-08-15 11:53:58' }
  ],
  auditoria_admin: [
    { id_auditoria: 1, id_admin: 1, id_evento: 1, accion: 'CREAR_CATEGORIA', entidad: 'categoria_producto', id_registro: 1, detalle: 'Se creó la categoría Cervezas', fecha_hora: '2026-08-15 11:53:58' },
    { id_auditoria: 2, id_admin: 1, id_evento: 1, accion: 'CREAR_PRODUCTO', entidad: 'producto', id_registro: 1, detalle: 'Se creó el producto Cerveza Paceña 350 ml', fecha_hora: '2026-08-15 11:53:58' },
    { id_auditoria: 3, id_admin: 1, id_evento: 1, accion: 'AGREGAR_STOCK', entidad: 'producto', id_registro: 1, detalle: 'Carga inicial de 120 unidades', fecha_hora: '2026-08-15 11:53:58' }
  ],
  impresion_comanda_cajero: [
    { id_impresion_cajero: 1, id_comanda: 1, fecha_hora_impresion: '2026-08-15 11:53:58', numero_copia: 1 }
  ],
  impresion_comanda_mesero: [
    { id_impresion_mesero: 1, id_comanda: 1, fecha_hora_impresion: '2026-08-15 11:53:58', numero_copia: 2 }
  ]
};

// Generate 45 waiters to match original SQL dump
for (let i = 1; i <= 45; i++) {
  const cajeroId = Math.ceil(i / 5); // 5 waiters per cashier
  const names = [
    'Juan Pérez', 'Miguel Flores', 'Sofía Álvarez', 'René Castro', 'Lucía Molina',
    'Mario Gutiérrez', 'Gabriela Soto', 'Andrés Vega', 'Paola Méndez', 'David Arce',
    'Fernando Paz', 'Daniela Cruz', 'Rodrigo Silva', 'Camila Romero', 'Nicolás Suárez',
    'Mateo Ríos', 'Andrea Villarroel', 'Óscar Paredes', 'Natalia León', 'Hugo Cabrera',
    'Marco Aguilar', 'Elena Zamora', 'Pablo Serrano', 'Rocío Chávez', 'Cristian Núñez',
    'Alejandro Ortiz', 'Verónica Lima', 'Martín Céspedes', 'Lorena Ponce', 'Samuel Rocha',
    'Kevin Miranda', 'Isabel Arias', 'Franco Velasco', 'Mónica Durán', 'Esteban Cuéllar',
    'Raúl Guzmán', 'Claudia Peña', 'Iván Mercado', 'Laura Terán', 'Álvaro Rivero',
    'Sergio Blanco', 'Mariana Prado', 'José Valdez', 'Tatiana Roca', 'Carlos Méndez'
  ];
  mockDb.mesero.push({
    id_mesero: i,
    id_evento: 1,
    id_cajero: cajeroId,
    nombre: names[i - 1],
    usuario: `mesero_${i < 10 ? '0' + i : i}`,
    password: (1000 + i).toString(),
    activo: 1
  });
}

// Adds a column to an existing table only when it is missing (idempotent migration).
function ensureColumn(table, column, definition) {
  db.all(`PRAGMA table_info(${table})`, (err, cols) => {
    if (err) return console.error(`Migration check failed for ${table}.${column}:`, err.message);
    if (cols.some(c => c.name === column)) return;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, errAlter => {
      if (errAlter) return console.error(`Migration failed for ${table}.${column}:`, errAlter.message);
      // Las sentencias ya preparadas apuntan al esquema anterior: se descartan.
      stmtCache.clear();
      console.log(`🛠️  Migración aplicada: ${table}.${column} añadida.`);
    });
  });
}

// Database Schema Initialization (SQLite)
function initializeDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS evento (
      id_evento INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre_evento TEXT,
      fecha_evento TEXT,
      lugar TEXT,
      descripcion TEXT,
      hora_inicio TEXT,
      hora_fin TEXT,
      activo INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS barra (
      id_barra INTEGER PRIMARY KEY AUTOINCREMENT,
      id_evento INTEGER,
      nombre_barra TEXT,
      descripcion TEXT,
      ubicacion TEXT,
      activo INTEGER DEFAULT 1,
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cajero (
      id_cajero INTEGER PRIMARY KEY AUTOINCREMENT,
      id_barra INTEGER,
      nombre TEXT,
      usuario TEXT UNIQUE,
      password TEXT,
      activo INTEGER DEFAULT 1,
      FOREIGN KEY(id_barra) REFERENCES barra(id_barra)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS administrador_evento (
      id_admin INTEGER PRIMARY KEY AUTOINCREMENT,
      id_evento INTEGER,
      nombre TEXT,
      usuario TEXT UNIQUE,
      password TEXT,
      rol TEXT,
      activo INTEGER DEFAULT 1,
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS mesero (
      id_mesero INTEGER PRIMARY KEY AUTOINCREMENT,
      id_evento INTEGER,
      id_cajero INTEGER,
      nombre TEXT,
      usuario TEXT UNIQUE,
      password TEXT,
      activo INTEGER DEFAULT 1,
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento),
      FOREIGN KEY(id_cajero) REFERENCES cajero(id_cajero)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS categoria_producto (
      id_categoria INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT UNIQUE,
      descripcion TEXT,
      tipo TEXT,
      activo INTEGER DEFAULT 1,
      creado_por_admin INTEGER,
      fecha_creacion TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS producto (
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
      FOREIGN KEY(id_categoria) REFERENCES categoria_producto(id_categoria)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS comanda (
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
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento),
      FOREIGN KEY(id_barra) REFERENCES barra(id_barra),
      FOREIGN KEY(id_cajero) REFERENCES cajero(id_cajero),
      FOREIGN KEY(id_mesero) REFERENCES mesero(id_mesero)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS detalle_comanda (
      id_detalle INTEGER PRIMARY KEY AUTOINCREMENT,
      id_comanda INTEGER,
      id_producto INTEGER,
      cantidad INTEGER,
      precio_unitario REAL,
      subtotal REAL,
      FOREIGN KEY(id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE,
      FOREIGN KEY(id_producto) REFERENCES producto(id_producto)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS metodo_pago (
      id_metodo_pago INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT UNIQUE,
      descripcion TEXT,
      activo INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pago_comanda (
      id_pago INTEGER PRIMARY KEY AUTOINCREMENT,
      id_comanda INTEGER,
      id_metodo_pago INTEGER,
      monto REAL,
      fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
      referencia TEXT,
      estado TEXT,
      FOREIGN KEY(id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE,
      FOREIGN KEY(id_metodo_pago) REFERENCES metodo_pago(id_metodo_pago)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS movimiento_stock (
      id_movimiento INTEGER PRIMARY KEY AUTOINCREMENT,
      id_producto INTEGER,
      id_admin INTEGER,
      tipo_movimiento TEXT,
      cantidad INTEGER,
      stock_anterior INTEGER,
      stock_nuevo INTEGER,
      motivo TEXT,
      fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(id_producto) REFERENCES producto(id_producto),
      FOREIGN KEY(id_admin) REFERENCES administrador_evento(id_admin)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS auditoria_admin (
      id_auditoria INTEGER PRIMARY KEY AUTOINCREMENT,
      id_admin INTEGER,
      id_evento INTEGER,
      accion TEXT,
      entidad TEXT,
      id_registro INTEGER,
      detalle TEXT,
      fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(id_admin) REFERENCES administrador_evento(id_admin),
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS impresion_comanda_cajero (
      id_impresion_cajero INTEGER PRIMARY KEY AUTOINCREMENT,
      id_comanda INTEGER,
      fecha_hora_impresion TEXT DEFAULT CURRENT_TIMESTAMP,
      numero_copia INTEGER,
      FOREIGN KEY(id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS impresion_comanda_mesero (
      id_impresion_mesero INTEGER PRIMARY KEY AUTOINCREMENT,
      id_comanda INTEGER,
      fecha_hora_impresion TEXT DEFAULT CURRENT_TIMESTAMP,
      numero_copia INTEGER,
      FOREIGN KEY(id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE
    )`);

    // Migration: databases created before this fix lack these two columns on `producto`,
    // which made every "Crear Producto" call fail with "no such column: creado_por_admin".
    ensureColumn('producto', 'creado_por_admin', 'INTEGER');
    ensureColumn('producto', 'fecha_creacion', 'TEXT');

    // Identidad de esta instancia, grabada DENTRO de la propia base.
    //
    // Cada barra corre su propio servidor con su propio archivo .db, y los tres
    // archivos son idénticos por fuera. Si al final de la noche se juntan sin
    // más, no habría forma de saber qué venta salió de qué barra: los números
    // de comanda empiezan en 1 en las tres. Guardando aquí el nombre y el
    // prefijo, el archivo se explica solo aunque se copie a otro equipo meses
    // después, y la herramienta de fusión puede etiquetar cada fila.
    db.run(`CREATE TABLE IF NOT EXISTS instancia (
      clave TEXT PRIMARY KEY,
      valor TEXT
    )`);
    db.run(`INSERT INTO instancia (clave, valor) VALUES ('nombre', ?)
            ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [INSTANCIA.nombre]);
    db.run(`INSERT INTO instancia (clave, valor) VALUES ('prefijo', ?)
            ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [INSTANCIA.prefijo]);
    db.run(`INSERT INTO instancia (clave, valor) VALUES ('primer_arranque', ?)
            ON CONFLICT(clave) DO NOTHING`, [nowSql()]);

    // Check if database is empty by querying events count
    db.get("SELECT COUNT(*) as count FROM evento", (err, row) => {
      if (err) {
        console.error("Error checking database initialization:", err);
        return;
      }

      if (row && row.count === 0) {
        console.log("💾 Seeding SQLite database with default musical event data...");
        
        // Seed Evento
        db.run(`INSERT INTO evento (id_evento, nombre_evento, fecha_evento, lugar, descripcion, hora_inicio, hora_fin, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [mockDb.evento[0].id_evento, mockDb.evento[0].nombre_evento, mockDb.evento[0].fecha_evento, mockDb.evento[0].lugar, mockDb.evento[0].descripcion, mockDb.evento[0].hora_inicio, mockDb.evento[0].hora_fin, mockDb.evento[0].activo]);

        // Seed Barras
        mockDb.barra.forEach(b => {
          db.run(`INSERT INTO barra (id_barra, id_evento, nombre_barra, descripcion, ubicacion, activo) VALUES (?, ?, ?, ?, ?, ?)`,
            [b.id_barra, b.id_evento, b.nombre_barra, b.descripcion, b.ubicacion, b.activo]);
        });

        // Seed Cajeros
        mockDb.cajero.forEach(c => {
          db.run(`INSERT INTO cajero (id_cajero, id_barra, nombre, usuario, password, activo) VALUES (?, ?, ?, ?, ?, ?)`,
            [c.id_cajero, c.id_barra, c.nombre, c.usuario, c.password, c.activo]);
        });

        // Seed Admins
        mockDb.administrador_evento.forEach(a => {
          db.run(`INSERT INTO administrador_evento (id_admin, id_evento, nombre, usuario, password, rol, activo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [a.id_admin, a.id_evento, a.nombre, a.usuario, a.password, a.rol, a.activo]);
        });

        // Seed Meseros
        mockDb.mesero.forEach(m => {
          db.run(`INSERT INTO mesero (id_mesero, id_evento, id_cajero, nombre, usuario, password, activo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [m.id_mesero, m.id_evento, m.id_cajero, m.nombre, m.usuario, m.password, m.activo]);
        });

        // Seed Categorias
        mockDb.categoria_producto.forEach(cat => {
          db.run(`INSERT INTO categoria_producto (id_categoria, nombre, descripcion, tipo, activo, creado_por_admin, fecha_creacion) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [cat.id_categoria, cat.nombre, cat.descripcion, cat.tipo, cat.activo, cat.creado_por_admin, cat.fecha_creacion]);
        });

        // Seed Productos
        mockDb.producto.forEach(p => {
          db.run(`INSERT INTO producto (id_producto, id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [p.id_producto, p.id_categoria, p.nombre, p.descripcion, p.tipo_producto, p.precio_venta, p.stock_actual, p.activo]);
        });

        // Seed Metodos Pago
        mockDb.metodo_pago.forEach(mp => {
          db.run(`INSERT INTO metodo_pago (id_metodo_pago, nombre, descripcion, activo) VALUES (?, ?, ?, ?)`,
            [mp.id_metodo_pago, mp.nombre, mp.descripcion, mp.activo]);
        });

        // Seed Comandas, Detalle, Pagos, Movs
        mockDb.comanda.forEach(c => {
          db.run(`INSERT INTO comanda (id_comanda, id_evento, id_barra, id_cajero, id_mesero, fecha_hora, total, estado_pago, estatus, observaciones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [c.id_comanda, c.id_evento, c.id_barra, c.id_cajero, c.id_mesero, c.fecha_hora, c.total, c.estado_pago, c.estatus, c.observaciones]);
        });

        mockDb.detalle_comanda.forEach(d => {
          db.run(`INSERT INTO detalle_comanda (id_detalle, id_comanda, id_producto, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?, ?)`,
            [d.id_detalle, d.id_comanda, d.id_producto, d.cantidad, d.precio_unitario, d.subtotal]);
        });

        mockDb.pago_comanda.forEach(p => {
          db.run(`INSERT INTO pago_comanda (id_pago, id_comanda, id_metodo_pago, monto, fecha_hora, referencia, estado) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [p.id_pago, p.id_comanda, p.id_metodo_pago, p.monto, p.fecha_hora, p.referencia, p.estado]);
        });

        mockDb.movimiento_stock.forEach(m => {
          db.run(`INSERT INTO movimiento_stock (id_movimiento, id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [m.id_movimiento, m.id_producto, m.id_admin, m.tipo_movimiento, m.cantidad, m.stock_anterior, m.stock_nuevo, m.motivo, m.fecha_hora]);
        });

        mockDb.auditoria_admin.forEach(a => {
          db.run(`INSERT INTO auditoria_admin (id_auditoria, id_admin, id_evento, accion, entidad, id_registro, detalle, fecha_hora) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [a.id_auditoria, a.id_admin, a.id_evento, a.accion, a.entidad, a.id_registro, a.detalle, a.fecha_hora]);
        });

        mockDb.impresion_comanda_cajero.forEach(i => {
          db.run(`INSERT INTO impresion_comanda_cajero (id_impresion_cajero, id_comanda, fecha_hora_impresion, numero_copia) VALUES (?, ?, ?, ?)`,
            [i.id_impresion_cajero, i.id_comanda, i.fecha_hora_impresion, i.numero_copia]);
        });

        mockDb.impresion_comanda_mesero.forEach(i => {
          db.run(`INSERT INTO impresion_comanda_mesero (id_impresion_mesero, id_comanda, fecha_hora_impresion, numero_copia) VALUES (?, ?, ?, ?)`,
            [i.id_impresion_mesero, i.id_comanda, i.fecha_hora_impresion, i.numero_copia]);
        });

        console.log("✅ SQLite database successfully seeded!");
      } else {
        console.log("💾 SQLite database already exists with data. Seeding skipped.");
      }
    });
  });
}

// Database Connection Attempt
function connectDatabase() {
  console.log(`🔌 Connecting to local SQLite database at: ${dbFile}...`);
  initializeDatabase();
  console.log(`✅ SUCCESS: Fully connected to SQLite database: pos_evento.db!\n`);
}
connectDatabase();

// Utility for executing query with automatic mock database fallback
function executeQuery(query, params, callback) {
  if (useMockDb) {
    // If mock DB is active, we bypass and let the specific router function handle logic locally.
    callback(new Error("MOCK_DB_ACTIVE"), null);
  } else {
    pool.query(query, params, (err, results) => {
      if (err) {
        console.error("Database Query Error:", err);
        callback(err, null);
      } else {
        callback(null, results);
      }
    });
  }
}

// ==========================================
// 1. API: AUTHENTICATION
// ==========================================
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;

  if (useMockDb) {
    // Check Cajeros
    const cajero = mockDb.cajero.find(c => c.usuario === usuario && c.password === password && c.activo === 1);
    if (cajero) {
      const barra = mockDb.barra.find(b => b.id_barra === cajero.id_barra);
      const evento = mockDb.evento.find(e => e.id_evento === barra.id_evento);
      return res.json({
        success: true,
        rol: 'CAJERO',
        user: {
          id_cajero: cajero.id_cajero,
          nombre: cajero.nombre,
          id_barra: cajero.id_barra,
          nombre_barra: barra.nombre_barra,
          id_evento: barra.id_evento,
          nombre_evento: evento.nombre_evento
        }
      });
    }

    // Check Admins
    const admin = mockDb.administrador_evento.find(a => a.usuario === usuario && a.password === password && a.activo === 1);
    if (admin) {
      const evento = mockDb.evento.find(e => e.id_evento === admin.id_evento);
      return res.json({
        success: true,
        rol: admin.rol, // ADMINISTRADOR or SUPERVISOR
        user: {
          id_admin: admin.id_admin,
          nombre: admin.nombre,
          id_evento: admin.id_evento,
          nombre_evento: evento.nombre_evento
        }
      });
    }

    return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
  } else {
    // Real MySQL Auth
    const queryCajero = `
      SELECT c.id_cajero, c.nombre, c.id_barra, b.nombre_barra, b.id_evento, e.nombre_evento
      FROM cajero c
      JOIN barra b ON c.id_barra = b.id_barra
      JOIN evento e ON b.id_evento = e.id_evento
      WHERE c.usuario = ? AND c.password = ? AND c.activo = 1
    `;
    pool.query(queryCajero, [usuario, password], (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.length > 0) {
        return res.json({ success: true, rol: 'CAJERO', user: results[0] });
      }

      // Check Admin
      const queryAdmin = `
        SELECT a.id_admin, a.nombre, a.id_evento, a.rol, e.nombre_evento
        FROM administrador_evento a
        JOIN evento e ON a.id_evento = e.id_evento
        WHERE a.usuario = ? AND a.password = ? AND a.activo = 1
      `;
      pool.query(queryAdmin, [usuario, password], (err2, results2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        if (results2.length > 0) {
          return res.json({
            success: true,
            rol: results2[0].rol,
            user: {
              id_admin: results2[0].id_admin,
              nombre: results2[0].nombre,
              id_evento: results2[0].id_evento,
              nombre_evento: results2[0].nombre_evento
            }
          });
        }
        return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
      });
    });
  }
});

app.post('/api/login/mesero', (req, res) => {
  const { password } = req.body;

  if (useMockDb) {
    const mesero = mockDb.mesero.find(m => m.password === password && m.activo === 1);
    if (mesero) {
      return res.json({ success: true, mesero: { id_mesero: mesero.id_mesero, nombre: mesero.nombre } });
    }
    return res.status(401).json({ success: false, message: 'Contraseña del mesero incorrecta' });
  } else {
    const { id_cajero, id_barra, id_evento } = req.body;

    // mesero has no id_barra of its own: the bar is the one of the cashier it reports to.
    let query = `
      SELECT m.id_mesero, m.nombre, m.id_cajero, c.id_barra
      FROM mesero m
      JOIN cajero c ON m.id_cajero = c.id_cajero
      WHERE m.password = ? AND m.activo = 1
    `;
    const params = [password];
    // Tells the failure branch below whether a rejection could mean "right PIN, wrong
    // tablet" (a scope was applied) or simply "no such PIN" (the default, unscoped).
    let fueraDeAlcance = null;

    if (MESERO_PIN_SCOPE === 'barra' && (id_barra || id_cajero)) {
      // Any tablet of this bar must open for any of its waiters, whichever till they
      // were assigned to. When the tablet only knows its cashier, derive the bar here.
      if (id_barra) {
        query += ` AND c.id_barra = ?`;
        params.push(id_barra);
      } else {
        query += ` AND c.id_barra = (SELECT id_barra FROM cajero WHERE id_cajero = ?)`;
        params.push(id_cajero);
      }
      fueraDeAlcance = 'Ese PIN es de un mesero de otra barra.';
    } else if (MESERO_PIN_SCOPE === 'cajero' && id_cajero) {
      // A waiter reports to one cashier (mesero.id_cajero); only their PINs open this till.
      query += ` AND m.id_cajero = ?`;
      params.push(id_cajero);
      fueraDeAlcance = 'Ese PIN es de un mesero de otra caja.';
    } else if (MESERO_PIN_SCOPE === 'evento' && id_evento) {
      query += ` AND m.id_evento = ?`;
      params.push(id_evento);
      fueraDeAlcance = 'Ese PIN es de un mesero de otro evento.';
    }

    pool.query(query, params, (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.length === 1) {
        return res.json({ success: true, mesero: results[0] });
      }
      if (results.length > 1) {
        // Two waiters share a PIN: refusing beats attributing the sale to the wrong person.
        return res.status(409).json({
          success: false,
          message: 'PIN duplicado entre meseros. Avisa al administrador.'
        });
      }

      // Nothing matched. Under the default scope that can only mean the PIN does not
      // exist; under a narrower one it may be a valid PIN typed on the wrong tablet,
      // and saying so saves the cashier from retyping a PIN that was never going to work.
      if (!fueraDeAlcance) {
        return res.status(401).json({ success: false, message: 'Contraseña del mesero incorrecta' });
      }
      pool.query(
        `SELECT m.id_mesero FROM mesero m WHERE m.password = ? AND m.activo = 1`,
        [password],
        (errAny, anyRows) => {
          if (!errAny && anyRows.length > 0) {
            return res.status(401).json({ success: false, message: fueraDeAlcance });
          }
          return res.status(401).json({ success: false, message: 'Contraseña del mesero incorrecta' });
        }
      );
    });
  }
});

// Quién es este servidor. Lo consulta la tablet nada más cargar para saber qué
// barra está atendiendo y cómo numerar sus comandas. Es público a propósito:
// lo necesita el POS antes de que nadie inicie sesión.
app.get('/api/instancia', (req, res) => {
  res.json({ nombre: INSTANCIA.nombre, prefijo: INSTANCIA.prefijo });
});

// ==========================================
// 2. API: GET PRODUCT DATA
// ==========================================
app.get('/api/productos', (req, res) => {
  if (useMockDb) {
    const activeCats = mockDb.categoria_producto.filter(c => c.activo === 1);
    const activeProds = mockDb.producto.filter(p => p.activo === 1);
    return res.json({ categorias: activeCats, productos: activeProds });
  } else {
    const queryCats = `SELECT * FROM categoria_producto WHERE activo = 1`;
    const queryProds = `SELECT * FROM producto WHERE activo = 1`;
    pool.query(queryCats, (err, cats) => {
      if (err) return res.status(500).json({ error: err.message });
      pool.query(queryProds, (err2, prods) => {
        if (err2) return res.status(500).json({ error: err2.message });
        return res.json({ categorias: cats, productos: prods });
      });
    });
  }
});

// ==========================================
// 3. API: TRANSACTIONAL (SAVE ORDER)
// ==========================================
app.post('/api/comanda', (req, res) => {
  const { id_evento, id_barra, id_cajero, id_mesero, total, items, metodos_pago, observaciones } = req.body;

  if (useMockDb) {
    const newComandaId = mockDb.comanda.length + 1;
    const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // 1. Create comanda
    mockDb.comanda.push({
      id_comanda: newComandaId,
      id_evento,
      id_barra,
      id_cajero,
      id_mesero,
      fecha_hora: nowStr,
      total: parseFloat(total),
      estado_pago: 'PAGADO',
      estatus: 'EN_PROCESO',
      observaciones: observaciones || '',
      anulada_por_admin: null,
      fecha_anulacion: null,
      motivo_anulacion: null
    });

    // 2. Detail comanda & Stock decrease
    items.forEach((item, idx) => {
      const dbProd = mockDb.producto.find(p => p.id_producto === item.id_producto);
      if (dbProd) {
        dbProd.stock_actual = Math.max(0, dbProd.stock_actual - item.cantidad);
      }
      mockDb.detalle_comanda.push({
        id_detalle: mockDb.detalle_comanda.length + 1,
        id_comanda: newComandaId,
        id_producto: item.id_producto,
        cantidad: item.cantidad,
        precio_unitario: parseFloat(item.precio_unitario),
        subtotal: parseFloat(item.subtotal)
      });
    });

    // 3. Payment details
    metodos_pago.forEach(pay => {
      mockDb.pago_comanda.push({
        id_pago: mockDb.pago_comanda.length + 1,
        id_comanda: newComandaId,
        id_metodo_pago: pay.id_metodo_pago,
        monto: parseFloat(pay.monto),
        fecha_hora: nowStr,
        referencia: pay.referencia || '',
        estado: 'APROBADO'
      });
    });

    // 4. Print entries
    mockDb.impresion_comanda_cajero.push({
      id_impresion_cajero: mockDb.impresion_comanda_cajero.length + 1,
      id_comanda: newComandaId,
      fecha_hora_impresion: nowStr,
      numero_copia: 1
    });

    mockDb.impresion_comanda_mesero.push({
      id_impresion_mesero: mockDb.impresion_comanda_mesero.length + 1,
      id_comanda: newComandaId,
      fecha_hora_impresion: nowStr,
      numero_copia: 2
    });

    return res.json({ success: true, id_comanda: newComandaId });
  } else {
    // Real transactional sale.
    //
    // Everything that decides money or stock is recomputed here from the database:
    // the browser only says *what* was ordered, never at which price. The whole thing
    // runs inside one serialised transaction, so a sale is all-or-nothing.
    withTransaction(async () => {
      if (!Array.isArray(items) || items.length === 0) {
        throw new BusinessError('La comanda no tiene productos.');
      }
      if (!Array.isArray(metodos_pago) || metodos_pago.length === 0) {
        throw new BusinessError('La comanda no tiene pagos registrados.');
      }
      if (!id_barra || !id_cajero || !id_mesero) {
        throw new BusinessError('Falta la barra, el cajero o el mesero de la comanda.');
      }

      // Collapse repeated lines for the same product and reject nonsense quantities.
      const wanted = new Map();
      for (const item of items) {
        const idProd = parseInt(item.id_producto, 10);
        // Number en vez de parseInt: parseInt('1.5') daba 1 y la comanda se
        // guardaba con una unidad menos sin avisar a nadie. Aquí no se vende
        // media cerveza: si la cantidad no es entera, la comanda no pasa.
        const qty = Number(item.cantidad);
        if (!idProd || !Number.isInteger(qty) || qty <= 0) {
          throw new BusinessError('Cantidad inválida en la comanda.');
        }
        wanted.set(idProd, (wanted.get(idProd) || 0) + qty);
      }

      // Cada pago se valida por separado ANTES de sumarlos. Sumar a ciegas dejaba
      // pasar dos cosas: un monto no numérico convertía el total pagado en NaN, y
      // como toda comparación con NaN es falsa, la comprobación de "los pagos
      // cubren el total" no saltaba y la venta se guardaba con un pago NaN; y un
      // monto negativo podía compensar a otro inflado para cuadrar la suma.
      const metodosValidos = new Set(
        (await dbAll('SELECT id_metodo_pago FROM metodo_pago WHERE activo = 1'))
          .map(m => m.id_metodo_pago)
      );
      const pagosLimpios = [];
      for (const pay of metodos_pago) {
        const idMetodo = parseInt(pay && pay.id_metodo_pago, 10);
        const monto = Number(pay && pay.monto);
        if (!metodosValidos.has(idMetodo)) {
          throw new BusinessError('Forma de pago desconocida en la comanda.');
        }
        if (!Number.isFinite(monto) || monto <= 0) {
          throw new BusinessError('Hay un monto de pago inválido en la comanda.');
        }
        pagosLimpios.push({
          id_metodo_pago: idMetodo,
          monto: round2(monto),
          referencia: pay.referencia ? String(pay.referencia).slice(0, 120) : ''
        });
      }

      const ids = [...wanted.keys()];
      const rows = await dbAll(
        `SELECT id_producto, nombre, precio_venta, stock_actual FROM producto
         WHERE activo = 1 AND id_producto IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      const byId = new Map(rows.map(r => [r.id_producto, r]));

      let total = 0;
      const lines = [];
      for (const [idProd, qty] of wanted) {
        const prod = byId.get(idProd);
        if (!prod) throw new BusinessError(`El producto #${idProd} ya no está disponible.`);
        const precio = Number(prod.precio_venta);
        const subtotal = round2(precio * qty);
        total = round2(total + subtotal);
        lines.push({ idProd, qty, precio, subtotal, nombre: prod.nombre });
      }

      const pagado = round2(pagosLimpios.reduce((sum, p) => sum + p.monto, 0));
      if (pagado + 0.001 < total) {
        throw new BusinessError(
          `Los pagos (${pagado.toFixed(2)} Bs.) no cubren el total (${total.toFixed(2)} Bs.).`
        );
      }

      const comanda = await dbRun(
        `INSERT INTO comanda (id_evento, id_barra, id_cajero, id_mesero, fecha_hora, total, estado_pago, estatus, observaciones)
         VALUES (?, ?, ?, ?, ?, ?, 'PAGADO', 'EN_PROCESO', ?)`,
        [id_evento, id_barra, id_cajero, id_mesero, nowSql(), total, observaciones || '']
      );
      const comId = comanda.insertId;

      for (const line of lines) {
        // Conditional update: if another till sold the last unit a moment earlier,
        // affectedRows is 0 and the sale rolls back instead of pushing stock negative.
        const upd = await dbRun(
          'UPDATE producto SET stock_actual = stock_actual - ? WHERE id_producto = ? AND stock_actual >= ?',
          [line.qty, line.idProd, line.qty]
        );
        if (upd.affectedRows === 0) {
          throw new BusinessError(
            `Stock insuficiente de ${line.nombre} (quedan ${byId.get(line.idProd).stock_actual}).`
          );
        }

        await dbRun(
          'INSERT INTO detalle_comanda (id_comanda, id_producto, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?)',
          [comId, line.idProd, line.qty, line.precio, line.subtotal]
        );

        const after = await dbGet('SELECT stock_actual FROM producto WHERE id_producto = ?', [line.idProd]);
        await dbRun(
          `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora)
           VALUES (?, NULL, 'SALIDA', ?, ?, ?, ?, ?)`,
          [line.idProd, line.qty, after.stock_actual + line.qty, after.stock_actual, `Venta comanda #${comId}`, nowSql()]
        );
      }

      for (const pay of pagosLimpios) {
        await dbRun(
          `INSERT INTO pago_comanda (id_comanda, id_metodo_pago, monto, fecha_hora, referencia, estado)
           VALUES (?, ?, ?, ?, ?, 'APROBADO')`,
          [comId, pay.id_metodo_pago, pay.monto, nowSql(), pay.referencia]
        );
      }

      await dbRun(
        'INSERT INTO impresion_comanda_cajero (id_comanda, fecha_hora_impresion, numero_copia) VALUES (?, ?, 1)',
        [comId, nowSql()]
      );
      await dbRun(
        'INSERT INTO impresion_comanda_mesero (id_comanda, fecha_hora_impresion, numero_copia) VALUES (?, ?, 1)',
        [comId, nowSql()]
      );

      return { id_comanda: comId, total, lines };
    })
      .then(result => {
        // The ticket is printed from these values, so it always matches what was stored.
        res.json({
          success: true,
          id_comanda: result.id_comanda,
          // Referencia que se canta en la barra y se imprime en el ticket.
          ref_comanda: refComanda(result.id_comanda),
          instancia: INSTANCIA.nombre,
          total: result.total,
          items: result.lines.map(l => ({
            id_producto: l.idProd,
            nombre: l.nombre,
            cantidad: l.qty,
            precio_unitario: l.precio,
            subtotal: l.subtotal
          }))
        });
      })
      .catch(err => {
        if (err instanceof BusinessError) {
          return res.status(err.status).json({ success: false, message: err.message });
        }
        console.error('Error al guardar comanda:', err);
        res.status(500).json({ success: false, message: 'Error al guardar la comanda.' });
      });
  }
});

// ==========================================
// 4. API: ADMIN OPERATIONS
// ==========================================

// GET ALL COMMANDAS (WITH JOIN DETAILS)
app.get('/api/admin/comandas', (req, res) => {
  if (useMockDb) {
    const result = mockDb.comanda.map(c => {
      const cajero = mockDb.cajero.find(cj => cj.id_cajero === c.id_cajero);
      const mesero = mockDb.mesero.find(m => m.id_mesero === c.id_mesero);
      const barra = mockDb.barra.find(b => b.id_barra === c.id_barra);
      const details = mockDb.detalle_comanda.filter(d => d.id_comanda === c.id_comanda).map(d => {
        const prod = mockDb.producto.find(p => p.id_producto === d.id_producto);
        return { ...d, nombre_producto: prod ? prod.nombre : 'Producto Eliminado' };
      });
      const payments = mockDb.pago_comanda.filter(p => p.id_comanda === c.id_comanda).map(p => {
        const met = mockDb.metodo_pago.find(m => m.id_metodo_pago === p.id_metodo_pago);
        return { ...p, nombre_metodo: met ? met.nombre : 'Método Desconocido' };
      });
      return {
        ...c,
        nombre_cajero: cajero ? cajero.nombre : 'Cajero Desconocido',
        nombre_mesero: mesero ? mesero.nombre : 'Mesero Desconocido',
        nombre_barra: barra ? barra.nombre_barra : 'Barra Desconocida',
        detalles: details,
        pagos: payments
      };
    });
    // Order newest first
    result.sort((a, b) => b.id_comanda - a.id_comanda);
    return res.json(result);
  } else {
    // LEFT JOIN: an inner join dropped the whole order from the history (and from the
    // sales totals) if its cashier, waiter or bar row was ever removed.
    const query = `
      SELECT c.*,
             COALESCE(cj.nombre, 'Cajero eliminado')  AS nombre_cajero,
             COALESCE(m.nombre,  'Mesero eliminado')  AS nombre_mesero,
             COALESCE(b.nombre_barra, 'Barra eliminada') AS nombre_barra
      FROM comanda c
      LEFT JOIN cajero cj ON c.id_cajero = cj.id_cajero
      LEFT JOIN mesero m ON c.id_mesero = m.id_mesero
      LEFT JOIN barra b ON c.id_barra = b.id_barra
      ORDER BY c.id_comanda DESC
    `;
    pool.query(query, (err, comandas) => {
      if (err) return res.status(500).json({ error: err.message });
      
      const queryDetails = `
        SELECT dc.*, COALESCE(p.nombre, 'Producto eliminado') AS nombre_producto
        FROM detalle_comanda dc
        LEFT JOIN producto p ON dc.id_producto = p.id_producto
      `;
      pool.query(queryDetails, (err2, details) => {
        if (err2) return res.status(500).json({ error: err2.message });

        const queryPayments = `
          SELECT pc.*, COALESCE(mp.nombre, 'Método desconocido') AS nombre_metodo
          FROM pago_comanda pc
          LEFT JOIN metodo_pago mp ON pc.id_metodo_pago = mp.id_metodo_pago
        `;
        pool.query(queryPayments, (err3, payments) => {
          if (err3) return res.status(500).json({ error: err3.message });

          const mapped = comandas.map(c => {
            return {
              ...c,
              detalles: details.filter(d => d.id_comanda === c.id_comanda),
              pagos: payments.filter(p => p.id_comanda === c.id_comanda)
            };
          });
          return res.json(mapped);
        });
      });
    });
  }
});

// VOID / CANCEL ORDER
app.post('/api/admin/comandas/anular', (req, res) => {
  const { id_comanda, id_admin, motivo_anulacion } = req.body;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (useMockDb) {
    const com = mockDb.comanda.find(c => c.id_comanda === parseInt(id_comanda));
    if (!com) return res.status(404).json({ success: false, message: 'Comanda no encontrada' });

    com.estado_pago = 'ANULADO';
    com.estatus = 'CANCELADA';
    com.anulada_por_admin = parseInt(id_admin);
    com.fecha_anulacion = nowStr;
    com.motivo_anulacion = motivo_anulacion;

    // Restore stocks
    const details = mockDb.detalle_comanda.filter(d => d.id_comanda === com.id_comanda);
    details.forEach(det => {
      const prod = mockDb.producto.find(p => p.id_producto === det.id_producto);
      if (prod) {
        prod.stock_actual += det.cantidad;
      }
    });

    // Update payment states
    mockDb.pago_comanda.filter(p => p.id_comanda === com.id_comanda).forEach(p => {
      p.estado = 'ANULADO';
    });

    // Write audit log
    const admin = mockDb.administrador_evento.find(a => a.id_admin === parseInt(id_admin));
    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: com.id_evento,
      accion: 'ANULAR_COMANDA',
      entidad: 'comanda',
      id_registro: com.id_comanda,
      detalle: `Comanda #${com.id_comanda} anulada por ${admin ? admin.nombre : 'Admin'}. Motivo: ${motivo_anulacion}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true });
  } else {
    withTransaction(async () => {
      const comanda = await dbGet(
        'SELECT id_comanda, id_evento, estado_pago FROM comanda WHERE id_comanda = ?',
        [id_comanda]
      );
      if (!comanda) throw new BusinessError('Comanda no encontrada.', 404);
      if (comanda.estado_pago === 'ANULADO') {
        // Without this guard a second click returned the stock to inventory twice.
        throw new BusinessError('Esta comanda ya estaba anulada.', 409);
      }
      if (!motivo_anulacion || !String(motivo_anulacion).trim()) {
        throw new BusinessError('Debes indicar el motivo de la anulación.');
      }

      const detalles = await dbAll(
        'SELECT id_producto, cantidad FROM detalle_comanda WHERE id_comanda = ?',
        [id_comanda]
      );

      await dbRun(
        `UPDATE comanda SET estado_pago = 'ANULADO', estatus = 'CANCELADA',
         anulada_por_admin = ?, fecha_anulacion = ?, motivo_anulacion = ?
         WHERE id_comanda = ?`,
        [id_admin, nowSql(), motivo_anulacion, id_comanda]
      );
      await dbRun("UPDATE pago_comanda SET estado = 'ANULADO' WHERE id_comanda = ?", [id_comanda]);

      for (const det of detalles) {
        await dbRun('UPDATE producto SET stock_actual = stock_actual + ? WHERE id_producto = ?', [
          det.cantidad,
          det.id_producto
        ]);
        // Returning stock is a real inventory movement; the report was silently missing it.
        const after = await dbGet('SELECT stock_actual FROM producto WHERE id_producto = ?', [det.id_producto]);
        await dbRun(
          `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora)
           VALUES (?, ?, 'ENTRADA', ?, ?, ?, ?, ?)`,
          [
            det.id_producto,
            id_admin,
            det.cantidad,
            after.stock_actual - det.cantidad,
            after.stock_actual,
            `Devolución por anulación de comanda #${id_comanda}`,
            nowSql()
          ]
        );
      }

      const admin = await dbGet('SELECT nombre FROM administrador_evento WHERE id_admin = ?', [id_admin]);
      await dbRun(
        `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle, fecha_hora)
         VALUES (?, ?, 'ANULAR_COMANDA', 'comanda', ?, ?, ?)`,
        [
          id_admin,
          comanda.id_evento,
          id_comanda,
          `Comanda #${id_comanda} anulada por ${admin ? admin.nombre : 'Admin'}. Motivo: ${motivo_anulacion}`,
          nowSql()
        ]
      );

      return true;
    })
      .then(() => res.json({ success: true }))
      .catch(err => {
        if (err instanceof BusinessError) {
          return res.status(err.status).json({ success: false, message: err.message });
        }
        console.error('Error al anular comanda:', err);
        res.status(500).json({ success: false, message: 'Error al anular la comanda.' });
      });
  }
});

// CREATE CATEGORY
app.post('/api/admin/categorias', (req, res) => {
  const { nombre, descripcion, tipo, id_admin, id_evento } = req.body;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (useMockDb) {
    const newCatId = mockDb.categoria_producto.length + 1;
    mockDb.categoria_producto.push({
      id_categoria: newCatId,
      nombre,
      descripcion,
      tipo,
      activo: 1,
      creado_por_admin: parseInt(id_admin),
      fecha_creacion: nowStr
    });

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'CREAR_CATEGORIA',
      entidad: 'categoria_producto',
      id_registro: newCatId,
      detalle: `Se creó la categoría ${nombre}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, id_categoria: newCatId });
  } else {
    const query = `INSERT INTO categoria_producto (nombre, descripcion, tipo, creado_por_admin, fecha_creacion) VALUES (?, ?, ?, ?, ?)`;
    pool.query(query, [nombre, descripcion, tipo, id_admin, nowStr], (err, result) => {
      if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'categoría') });
      const newCatId = result.insertId;

      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_CATEGORIA', 'categoria_producto', ?, ?)`;
      pool.query(queryAudit, [id_admin, id_evento || 1, newCatId, `Se creó la categoría ${nombre}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_categoria: newCatId });
      });
    });
  }
});

// CREATE PRODUCT
app.post('/api/admin/productos', (req, res) => {
  const { id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual, id_admin, id_evento } = req.body;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (useMockDb) {
    const newProdId = mockDb.producto.length + 1;
    mockDb.producto.push({
      id_producto: newProdId,
      id_categoria: parseInt(id_categoria),
      nombre,
      descripcion,
      tipo_producto,
      precio_venta: parseFloat(precio_venta),
      stock_actual: parseInt(stock_actual || 0),
      activo: 1,
      creado_por_admin: parseInt(id_admin),
      fecha_creacion: nowStr
    });

    // Stock Movement Log
    if (parseInt(stock_actual) > 0) {
      mockDb.movimiento_stock.push({
        id_movimiento: mockDb.movimiento_stock.length + 1,
        id_producto: newProdId,
        id_admin: parseInt(id_admin),
        tipo_movimiento: 'ENTRADA',
        cantidad: parseInt(stock_actual),
        stock_anterior: 0,
        stock_nuevo: parseInt(stock_actual),
        motivo: 'Carga inicial de stock',
        fecha_hora: nowStr
      });
    }

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'CREAR_PRODUCTO',
      entidad: 'producto',
      id_registro: newProdId,
      detalle: `Se creó el producto ${nombre} con stock inicial de ${stock_actual || 0}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, id_producto: newProdId });
  } else {
    // Un precio con letras se colaba como NaN y el producto quedaba invendible:
    // toda comanda que lo incluyera daba un total NaN. Y un precio negativo
    // habría restado del total de la comanda.
    const precio = Number(precio_venta);
    const stockInicial = Number(stock_actual || 0);
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ success: false, message: 'El producto necesita un nombre.' });
    }
    if (!Number.isFinite(precio) || precio <= 0) {
      return res.status(400).json({ success: false, message: 'El precio debe ser un número mayor que cero.' });
    }
    if (!Number.isInteger(stockInicial) || stockInicial < 0) {
      return res.status(400).json({ success: false, message: 'El stock inicial debe ser un número entero de 0 o más.' });
    }

    // Real MySQL Insertion
    const query = `INSERT INTO producto (id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual, creado_por_admin, fecha_creacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    pool.query(query, [id_categoria, String(nombre).trim(), descripcion, tipo_producto, round2(precio), stockInicial, id_admin, nowStr], (err, result) => {
      if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'producto') });
      const newProdId = result.insertId;

      // Log Stock movement
      if (stockInicial > 0) {
        const queryMov = `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo) VALUES (?, ?, 'ENTRADA', ?, 0, ?, 'Carga inicial de stock')`;
        pool.query(queryMov, [newProdId, id_admin, stockInicial, stockInicial], (errMov) => {
          if (errMov) console.error(errMov);
        });
      }

      // Audit Log
      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_PRODUCTO', 'producto', ?, ?)`;
      pool.query(queryAudit, [id_admin, id_evento || 1, newProdId, `Se creó el producto ${nombre} con stock inicial de ${stock_actual || 0}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_producto: newProdId });
      });
    });
  }
});

// CREATE BARRA
app.post('/api/admin/barras', (req, res) => {
  const { nombre_barra, descripcion, ubicacion, id_evento, id_admin } = req.body;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (useMockDb) {
    const newBarraId = mockDb.barra.length + 1;
    mockDb.barra.push({
      id_barra: newBarraId,
      id_evento: parseInt(id_evento || 1),
      nombre_barra,
      descripcion,
      ubicacion,
      activo: 1
    });

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'CREAR_BARRA',
      entidad: 'barra',
      id_registro: newBarraId,
      detalle: `Se creó la barra ${nombre_barra}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, id_barra: newBarraId });
  } else {
    const query = `INSERT INTO barra (id_evento, nombre_barra, descripcion, ubicacion) VALUES (?, ?, ?, ?)`;
    pool.query(query, [id_evento || 1, nombre_barra, descripcion, ubicacion], (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const newBarraId = result.insertId;

      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_BARRA', 'barra', ?, ?)`;
      pool.query(queryAudit, [id_admin, id_evento || 1, newBarraId, `Se creó la barra ${nombre_barra}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_barra: newBarraId });
      });
    });
  }
});

// CREATE CAJERO
app.post('/api/admin/cajeros', (req, res) => {
  const { id_barra, nombre, usuario, password, id_admin, id_evento } = req.body;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (useMockDb) {
    const newCajeroId = mockDb.cajero.length + 1;
    mockDb.cajero.push({
      id_cajero: newCajeroId,
      id_barra: parseInt(id_barra),
      nombre,
      usuario,
      password,
      activo: 1
    });

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'CREAR_CAJERO',
      entidad: 'cajero',
      id_registro: newCajeroId,
      detalle: `Se registró al cajero ${nombre} con usuario ${usuario}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, id_cajero: newCajeroId });
  } else {
    const query = `INSERT INTO cajero (id_barra, nombre, usuario, password) VALUES (?, ?, ?, ?)`;
    pool.query(query, [id_barra, nombre, usuario, password], (err, result) => {
      if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'cajero') });
      const newCajeroId = result.insertId;

      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_CAJERO', 'cajero', ?, ?)`;
      pool.query(queryAudit, [id_admin, id_evento || 1, newCajeroId, `Se registró al cajero ${nombre} con usuario ${usuario}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_cajero: newCajeroId });
      });
    });
  }
});

// CREATE MESERO
app.post('/api/admin/meseros', (req, res) => {
  const { id_evento, id_cajero, nombre, usuario, password, id_admin } = req.body;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (useMockDb) {
    const newMeseroId = mockDb.mesero.length + 1;
    mockDb.mesero.push({
      id_mesero: newMeseroId,
      id_evento: parseInt(id_evento || 1),
      id_cajero: parseInt(id_cajero),
      nombre,
      usuario,
      password,
      activo: 1
    });

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'CREAR_MESERO',
      entidad: 'mesero',
      id_registro: newMeseroId,
      detalle: `Se registró al mesero ${nombre} asignado al cajero ID ${id_cajero}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, id_mesero: newMeseroId });
  } else {
    // The PIN is the waiter's only credential, so it has to be unique within the scope
    // that /api/login/mesero searches, otherwise sales get attributed to the wrong person.
    let scopeSql;
    let scopeParams;
    if (MESERO_PIN_SCOPE === 'barra') {
      scopeSql = `SELECT m.id_mesero FROM mesero m
                  JOIN cajero c ON m.id_cajero = c.id_cajero
                  WHERE m.password = ? AND m.activo = 1
                    AND c.id_barra = (SELECT id_barra FROM cajero WHERE id_cajero = ?)`;
      scopeParams = [password, id_cajero];
    } else if (MESERO_PIN_SCOPE === 'cajero') {
      scopeSql = 'SELECT id_mesero FROM mesero WHERE password = ? AND id_cajero = ? AND activo = 1';
      scopeParams = [password, id_cajero];
    } else {
      scopeSql = 'SELECT id_mesero FROM mesero WHERE password = ? AND activo = 1';
      scopeParams = [password];
    }

    pool.query(scopeSql, scopeParams, (errDup, dup) => {
      if (errDup) return res.status(500).json({ success: false, message: errDup.message });
      if (dup.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Ese PIN ya está en uso por otro mesero. Elige uno distinto.'
        });
      }

    const query = `INSERT INTO mesero (id_evento, id_cajero, nombre, usuario, password) VALUES (?, ?, ?, ?, ?)`;
    pool.query(query, [id_evento || 1, id_cajero, nombre, usuario, password], (err, result) => {
      if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'mesero') });
      const newMeseroId = result.insertId;

      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_MESERO', 'mesero', ?, ?)`;
      pool.query(queryAudit, [id_admin, id_evento || 1, newMeseroId, `Se registró al mesero ${nombre} asignado al cajero ID ${id_cajero}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_mesero: newMeseroId });
      });
    });
    });
  }
});

// REGISTER STOCK MOVEMENT (MANUAL)
app.post('/api/admin/stock/movimiento', (req, res) => {
  const { id_producto, tipo_movimiento, cantidad, motivo, id_admin, id_evento } = req.body;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (useMockDb) {
    const prod = mockDb.producto.find(p => p.id_producto === parseInt(id_producto));
    if (!prod) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    const prevStock = prod.stock_actual;
    let newStock = prevStock;

    if (tipo_movimiento === 'ENTRADA') newStock += parseInt(cantidad);
    else if (tipo_movimiento === 'SALIDA') newStock = Math.max(0, newStock - parseInt(cantidad));
    else if (tipo_movimiento === 'AJUSTE') newStock = parseInt(cantidad);

    prod.stock_actual = newStock;
    const diff = newStock - prevStock;

    const newMovId = mockDb.movimiento_stock.length + 1;
    mockDb.movimiento_stock.push({
      id_movimiento: newMovId,
      id_producto: parseInt(id_producto),
      id_admin: parseInt(id_admin),
      tipo_movimiento,
      cantidad: Math.abs(diff),
      stock_anterior: prevStock,
      stock_nuevo: newStock,
      motivo,
      fecha_hora: nowStr
    });

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'MODIFICAR_STOCK',
      entidad: 'producto',
      id_registro: prod.id_producto,
      detalle: `Ajuste manual de stock de ${prod.nombre} (${tipo_movimiento}): stock cambió de ${prevStock} a ${newStock}. Motivo: ${motivo}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, stock_nuevo: newStock });
  } else {
    // Ajuste manual de stock.
    //
    // Antes esta ruta abría su propia transacción con pool.getConnection() +
    // beginTransaction, saltándose la cola de withTransaction. Con una sola
    // conexión SQLite eso era una bomba: si un admin ajustaba stock mientras una
    // caja estaba cerrando una venta, el BEGIN de aquí caía dentro de la
    // transacción de la venta y el COMMIT (o el ROLLBACK) de una se llevaba por
    // delante el trabajo a medias de la otra. Ahora hace cola como todo lo demás.
    withTransaction(async () => {
      const tipo = String(tipo_movimiento || '').toUpperCase();
      if (!['ENTRADA', 'SALIDA', 'AJUSTE'].includes(tipo)) {
        throw new BusinessError('Tipo de movimiento no válido.');
      }

      // Sin esto, una cantidad vacía o con letras dejaba stock_actual en NaN y
      // el producto quedaba invendible hasta corregirlo a mano en la base.
      const cant = Number(cantidad);
      if (!Number.isFinite(cant) || !Number.isInteger(cant) || cant < 0) {
        throw new BusinessError('La cantidad debe ser un número entero de 0 o más.');
      }
      if (tipo !== 'AJUSTE' && cant === 0) {
        throw new BusinessError('La cantidad tiene que ser mayor que cero.');
      }
      if (!motivo || !String(motivo).trim()) {
        throw new BusinessError('Indica el motivo del movimiento.');
      }

      const prod = await dbGet('SELECT stock_actual, nombre FROM producto WHERE id_producto = ?', [id_producto]);
      if (!prod) throw new BusinessError('Producto no encontrado.', 404);

      const prevStock = prod.stock_actual;
      let newStock = prevStock;
      if (tipo === 'ENTRADA') newStock = prevStock + cant;
      else if (tipo === 'SALIDA') newStock = Math.max(0, prevStock - cant);
      else newStock = cant;

      await dbRun('UPDATE producto SET stock_actual = ? WHERE id_producto = ?', [newStock, id_producto]);

      await dbRun(
        `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id_producto, id_admin, tipo, Math.abs(newStock - prevStock), prevStock, newStock, motivo, nowSql()]
      );

      await dbRun(
        `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle, fecha_hora)
         VALUES (?, ?, 'MODIFICAR_STOCK', 'producto', ?, ?, ?)`,
        [
          id_admin,
          id_evento || 1,
          id_producto,
          `Ajuste manual de stock de ${prod.nombre} (${tipo}): stock cambió de ${prevStock} a ${newStock}. Motivo: ${motivo}`,
          nowSql()
        ]
      );

      return newStock;
    })
      .then(stock_nuevo => res.json({ success: true, stock_nuevo }))
      .catch(err => {
        if (err instanceof BusinessError) {
          return res.status(err.status).json({ success: false, message: err.message });
        }
        console.error('Error al ajustar stock:', err);
        res.status(500).json({ success: false, message: 'No se pudo ajustar el stock.' });
      });
  }
});

// ==========================================
// 4b. API: REPORTE DE CIERRE
// ==========================================
// Todas las cifras salen de SQL, no de lo que tenga cargado el navegador: el
// panel de admin sólo trae las comandas de una en una y sumar allí daría
// números distintos según cuándo se abrió la pestaña.
//
// Las comandas anuladas quedan fuera de la recaudación pero se listan aparte,
// que es justo lo que se revisa al cuadrar la caja.

// Rango de fechas en el formato en que se guarda fecha_hora ('AAAA-MM-DD HH:MM:SS').
function rangoFechas(query) {
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/;
  const desde = soloFecha.test(query.desde || '') ? query.desde + ' 00:00:00' : '0000-01-01 00:00:00';
  const hasta = soloFecha.test(query.hasta || '') ? query.hasta + ' 23:59:59' : '9999-12-31 23:59:59';
  return { desde, hasta, todo: !soloFecha.test(query.desde || '') && !soloFecha.test(query.hasta || '') };
}

async function construirReporte(query) {
  const { desde, hasta, todo } = rangoFechas(query);
  const P = [desde, hasta];

  const evento = await dbGet('SELECT nombre_evento, fecha_evento, lugar FROM evento LIMIT 1');

  const resumen = await dbGet(`
    SELECT
      COUNT(*)                                                     AS comandas,
      COALESCE(SUM(CASE WHEN estado_pago != 'ANULADO' THEN total END), 0)      AS recaudado,
      SUM(CASE WHEN estado_pago != 'ANULADO' THEN 1 ELSE 0 END)    AS validas,
      SUM(CASE WHEN estado_pago  = 'ANULADO' THEN 1 ELSE 0 END)    AS anuladas,
      COALESCE(SUM(CASE WHEN estado_pago  = 'ANULADO' THEN total END), 0)      AS importe_anulado
    FROM comanda WHERE fecha_hora BETWEEN ? AND ?
  `, P);

  const unidades = await dbGet(`
    SELECT COALESCE(SUM(d.cantidad), 0) AS n
    FROM detalle_comanda d JOIN comanda c ON c.id_comanda = d.id_comanda
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
  `, P);

  const porMetodo = await dbAll(`
    SELECT mp.nombre AS metodo, COUNT(*) AS operaciones, COALESCE(SUM(p.monto), 0) AS importe
    FROM pago_comanda p
    JOIN comanda c    ON c.id_comanda = p.id_comanda
    JOIN metodo_pago mp ON mp.id_metodo_pago = p.id_metodo_pago
    WHERE p.estado = 'APROBADO' AND c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY mp.id_metodo_pago ORDER BY importe DESC
  `, P);

  const porBarra = await dbAll(`
    SELECT b.nombre_barra AS barra, COUNT(*) AS comandas, COALESCE(SUM(c.total), 0) AS importe
    FROM comanda c JOIN barra b ON b.id_barra = c.id_barra
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY b.id_barra ORDER BY importe DESC
  `, P);

  const porCajero = await dbAll(`
    SELECT cj.nombre AS cajero, b.nombre_barra AS barra,
           COUNT(*) AS comandas, COALESCE(SUM(c.total), 0) AS importe
    FROM comanda c
    JOIN cajero cj ON cj.id_cajero = c.id_cajero
    JOIN barra b   ON b.id_barra   = cj.id_barra
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY cj.id_cajero ORDER BY importe DESC
  `, P);

  const porMesero = await dbAll(`
    SELECT m.nombre AS mesero, COUNT(*) AS comandas, COALESCE(SUM(c.total), 0) AS importe
    FROM comanda c JOIN mesero m ON m.id_mesero = c.id_mesero
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY m.id_mesero ORDER BY importe DESC
  `, P);

  const productos = await dbAll(`
    SELECT p.nombre AS producto, cat.nombre AS categoria,
           SUM(d.cantidad) AS unidades, COALESCE(SUM(d.subtotal), 0) AS importe
    FROM detalle_comanda d
    JOIN comanda c  ON c.id_comanda  = d.id_comanda
    JOIN producto p ON p.id_producto = d.id_producto
    LEFT JOIN categoria_producto cat ON cat.id_categoria = p.id_categoria
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY p.id_producto ORDER BY importe DESC
  `, P);

  const anuladas = await dbAll(`
    SELECT c.id_comanda, c.total, c.fecha_anulacion, c.motivo_anulacion,
           a.nombre AS admin, m.nombre AS mesero
    FROM comanda c
    LEFT JOIN administrador_evento a ON a.id_admin = c.anulada_por_admin
    LEFT JOIN mesero m ON m.id_mesero = c.id_mesero
    WHERE c.estado_pago = 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    ORDER BY c.id_comanda DESC
  `, P);

  const stock = await dbAll(`
    SELECT p.nombre AS producto, cat.nombre AS categoria, p.stock_actual, p.precio_venta
    FROM producto p
    LEFT JOIN categoria_producto cat ON cat.id_categoria = p.id_categoria
    WHERE p.activo = 1 ORDER BY p.stock_actual ASC, p.nombre ASC
  `);

  const validas = Number(resumen.validas) || 0;
  return {
    evento,
    // El cierre lleva la barra en la cabecera y en el nombre del archivo: con
    // tres instancias, tres PDFs iguales sin identificar son inservibles.
    instancia: INSTANCIA,
    rango: { desde: query.desde || null, hasta: query.hasta || null, todo },
    generado: nowSql(),
    resumen: {
      comandas: Number(resumen.comandas) || 0,
      validas,
      anuladas: Number(resumen.anuladas) || 0,
      recaudado: round2(resumen.recaudado),
      importe_anulado: round2(resumen.importe_anulado),
      unidades: Number(unidades.n) || 0,
      ticket_medio: validas > 0 ? round2(Number(resumen.recaudado) / validas) : 0
    },
    porMetodo, porBarra, porCajero, porMesero, productos, anuladas, stock
  };
}

app.get('/api/admin/reporte', (req, res) => {
  if (useMockDb) {
    return res.status(503).json({ success: false, message: 'El reporte necesita la base de datos real.' });
  }
  construirReporte(req.query)
    .then(datos => res.json(datos))
    .catch(err => {
      console.error('Error al construir el reporte:', err);
      res.status(500).json({ success: false, message: 'No se pudo generar el reporte.' });
    });
});

app.get('/api/admin/reporte.pdf', (req, res) => {
  if (useMockDb) {
    return res.status(503).send('El reporte necesita la base de datos real.');
  }
  construirReporte(req.query)
    .then(datos => {
      const pdf = construirPdfCierre(datos);
      // 'attachment' para que Android lo guarde como archivo y se pueda mandar
      // por WhatsApp, en vez de abrirlo dentro de la pestaña del POS.
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoReporte(datos)}"`);
      res.setHeader('Content-Length', pdf.length);
      res.send(pdf);
    })
    .catch(err => {
      console.error('Error al generar el PDF:', err);
      res.status(500).send('No se pudo generar el PDF.');
    });
});

// GET AUDIT LOG & STOCK LOGS & BARRAS
app.get('/api/admin/auditoria', (req, res) => {
  if (useMockDb) {
    const sortedAudits = [...mockDb.auditoria_admin].sort((a, b) => b.id_auditoria - a.id_auditoria);
    const sortedMovs = [...mockDb.movimiento_stock].map(m => {
      const prod = mockDb.producto.find(p => p.id_producto === m.id_producto);
      const admin = mockDb.administrador_evento.find(a => a.id_admin === m.id_admin);
      return {
        ...m,
        nombre_producto: prod ? prod.nombre : 'Producto Eliminado',
        nombre_admin: admin ? admin.nombre : 'Admin'
      };
    }).sort((a, b) => b.id_movimiento - a.id_movimiento);
    
    return res.json({
      auditoria: sortedAudits,
      movimientos: sortedMovs,
      barras: mockDb.barra,
      cajeros: mockDb.cajero,
      metodos_pago: mockDb.metodo_pago
    });
  } else {
    // Real MySQL audit fetching
    const qAudit = `
      SELECT au.*, COALESCE(a.nombre, 'Sistema') AS nombre_admin
      FROM auditoria_admin au
      LEFT JOIN administrador_evento a ON au.id_admin = a.id_admin
      ORDER BY au.id_auditoria DESC
    `;
    pool.query(qAudit, (err, audits) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Sales write stock movements with id_admin NULL, so this must be a LEFT JOIN or
      // every sale would be invisible in the stock report.
      const qMovs = `
        SELECT ms.*,
               COALESCE(p.nombre, 'Producto eliminado') AS nombre_producto,
               COALESCE(a.nombre, 'Venta POS') AS nombre_admin
        FROM movimiento_stock ms
        LEFT JOIN producto p ON ms.id_producto = p.id_producto
        LEFT JOIN administrador_evento a ON ms.id_admin = a.id_admin
        ORDER BY ms.id_movimiento DESC
        LIMIT 500
      `;
      pool.query(qMovs, (err2, movs) => {
        if (err2) return res.status(500).json({ error: err2.message });

        pool.query('SELECT * FROM barra', (err3, barras) => {
          if (err3) return res.status(500).json({ error: err3.message });
          
          pool.query('SELECT * FROM cajero', (err4, cajeros) => {
            if (err4) return res.status(500).json({ error: err4.message });

            pool.query('SELECT * FROM metodo_pago', (err5, metodos) => {
              if (err5) return res.status(500).json({ error: err5.message });
              return res.json({ auditoria: audits, movimientos: movs, barras, cajeros, metodos_pago: metodos });
            });
          });
        });
      });
    });
  }
});

// ==========================================
// 5. API: PRINT LOG
// ==========================================
// impresion_comanda_cajero / _mesero existed in the schema but nothing ever wrote a
// reprint, so numero_copia was meaningless. Every physical print now lands here.
app.post('/api/impresion', (req, res) => {
  const { id_comanda, tipo } = req.body;
  const table = tipo === 'mesero' ? 'impresion_comanda_mesero' : 'impresion_comanda_cajero';

  dbGet(`SELECT COALESCE(MAX(numero_copia), 0) AS ultima FROM ${table} WHERE id_comanda = ?`, [id_comanda])
    .then(row =>
      dbRun(`INSERT INTO ${table} (id_comanda, fecha_hora_impresion, numero_copia) VALUES (?, ?, ?)`, [
        id_comanda,
        nowSql(),
        (row ? row.ultima : 0) + 1
      ]).then(() => res.json({ success: true, numero_copia: (row ? row.ultima : 0) + 1 }))
    )
    .catch(err => {
      console.error('Error al registrar impresión:', err.message);
      // A failed print log must never block the cashier from printing.
      res.status(200).json({ success: false, message: 'No se pudo registrar la impresión.' });
    });
});

// GET BARRAS & CAJEROS DIRECTLY (for selectors)
app.get('/api/admin/configuracion', (req, res) => {
  if (useMockDb) {
    return res.json({
      barras: mockDb.barra,
      cajeros: mockDb.cajero,
      eventos: mockDb.evento
    });
  } else {
    pool.query('SELECT * FROM barra WHERE activo = 1', (err, barras) => {
      if (err) return res.status(500).json({ error: err.message });
      pool.query('SELECT * FROM cajero WHERE activo = 1', (err2, cajeros) => {
        if (err2) return res.status(500).json({ error: err2.message });
        pool.query('SELECT * FROM evento WHERE activo = 1', (err3, eventos) => {
          if (err3) return res.status(500).json({ error: err3.message });
          return res.json({ barras, cajeros, eventos });
        });
      });
    });
  }
});

// Devuelve las IPv4 de la red local (WiFi) de este equipo.
function localAddresses() {
  const nets = require('os').networkInterfaces();
  const found = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  return found;
}

// Cierre ordenado (Ctrl+C en Termux, o cuando Android mata el proceso).
// Sin esto el archivo -wal se queda con ventas dentro y el .db por sí solo
// está incompleto: copiarlo para respaldo daría una base a medias.
let cerrando = false;
function cerrarOrdenado(senal) {
  if (cerrando) return;
  cerrando = true;
  console.log(`\n${senal} recibido: guardando la base...`);
  try {
    // Vuelca el WAL dentro del .db y lo deja como archivo único y completo.
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('✅ Base cerrada. Ya puedes copiar pos_evento.db sin riesgo.');
  } catch (err) {
    console.error('⚠ Error al cerrar la base:', err.message);
  }
  process.exit(0);
}

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(senal => {
  process.on(senal, () => cerrarOrdenado(senal));
});

// Server Initialization
// 0.0.0.0 explícito: la tablet que hace de servidor tiene que aceptar las
// conexiones de las demás por WiFi, no solo las de sí misma.
app.listen(PORT, '0.0.0.0', () => {
  const ips = localAddresses();
  // La barra va lo primero y en grande. Con dos o tres tablets servidor
  // idénticas encima de la mesa, este cartel es la forma más rápida de saber
  // cuál tienes delante antes de tocar nada.
  const rotulo = INSTANCIA.nombre.toUpperCase();
  console.log(`\n==================================================`);
  console.log(`   B A R R A :   ${rotulo}`);
  console.log(`   Comandas de esta barra: ${INSTANCIA.prefijo}-1, ${INSTANCIA.prefijo}-2, ...`);
  console.log(`==================================================`);
  console.log(`🚀 MasterDrinks POS iniciado`);
  console.log(`   En esta misma tablet:  http://localhost:${PORT}`);
  if (ips.length) {
    console.log(`\n   👉 En las OTRAS tablets de la barra ${INSTANCIA.nombre}:`);
    ips.forEach(ip => console.log(`      http://${ip}:${PORT}`));
  } else {
    console.log(`\n   ⚠ Sin red detectada: enciende el WiFi/hotspot y reinicia.`);
  }
  if (INSTANCIA.nombre === 'Principal') {
    // Aviso, no error: en un montaje de una sola barra es correcto.
    console.log(`\n   ⚠ Esta instancia no tiene nombre de barra propio.`);
    console.log(`     Si montas varias barras, pon INSTANCIA y PREFIJO en el .env`);
    console.log(`     o las tres numerarán sus comandas igual.`);
  }
  console.log(`\n   Ctrl+C para detener.`);
  console.log(`==================================================\n`);
});
