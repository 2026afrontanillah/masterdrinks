'use strict';

/**
 * Herramienta para verificar, crear índices de rendimiento y optimizar la base de datos SQLite.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BASE = path.join(__dirname, '..', 'pos_evento.db');
const db = new DatabaseSync(BASE);

const indexes = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_comanda_idempotencia ON comanda(clave_idempotencia) WHERE clave_idempotencia IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_comanda_evento_fecha ON comanda(id_evento, fecha_hora)',
  'CREATE INDEX IF NOT EXISTS idx_comanda_estatus ON comanda(estatus, fecha_hora)',
  'CREATE INDEX IF NOT EXISTS idx_comanda_anulada ON comanda(anulada_por_admin)',
  'CREATE INDEX IF NOT EXISTS idx_comanda_cajero ON comanda(id_cajero)',
  'CREATE INDEX IF NOT EXISTS idx_comanda_barra ON comanda(id_barra)',
  'CREATE INDEX IF NOT EXISTS idx_detalle_comanda_comanda ON detalle_comanda(id_comanda)',
  'CREATE INDEX IF NOT EXISTS idx_detalle_comanda_producto ON detalle_comanda(id_producto)',
  'CREATE INDEX IF NOT EXISTS idx_pago_comanda_comanda ON pago_comanda(id_comanda)',
  'CREATE INDEX IF NOT EXISTS idx_pago_comanda_metodo ON pago_comanda(id_metodo_pago)',
  'CREATE INDEX IF NOT EXISTS idx_movimiento_stock_producto ON movimiento_stock(id_producto)',
  'CREATE INDEX IF NOT EXISTS idx_producto_categoria_activo ON producto(id_categoria, activo)',
  'CREATE INDEX IF NOT EXISTS idx_mesero_cajero_activo ON mesero(id_cajero, activo)'
];

console.log('Aplicando índices de rendimiento a pos_evento.db...');
indexes.forEach(idx => db.exec(idx));

console.log('Actualizando credenciales de administrador principal (admin / 123) y cajeros...');
try {
  db.exec("UPDATE administrador_evento SET usuario = 'admin', password = '123' WHERE id_admin = 1 OR usuario = 'admin_evento';");
  db.exec("UPDATE cajero SET password = 'demo123' WHERE password = '123' OR usuario = 'Rodrigo';");
} catch (e) {
  // Ignorar si la tabla no existe
}

console.log('Compactando y optimizando base de datos...');
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.exec('VACUUM;');
db.exec('PRAGMA optimize;');

db.close();

// Limpiar bases de datos temporales residuales si existen
const fs = require('fs');
const files = fs.readdirSync(path.join(__dirname, '..'));
files.forEach(f => {
  if (/^pos_evento\.(logic|medir|reimp|dos|ui|stress).*\.db/.test(f)) {
    try {
      fs.unlinkSync(path.join(__dirname, '..', f));
      console.log('✔ Archivo temporal eliminado:', f);
    } catch (e) {
      // Archivo en uso o ya eliminado
    }
  }
});

console.log('✅ Base de datos optimizada exitosamente.');

