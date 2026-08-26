const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const BASE = path.join(__dirname, '..', 'pos_evento.db');
const carpetaRespaldos = path.join(__dirname, '..', 'respaldos');

if (!fs.existsSync(BASE)) {
  console.error('No se encontró la base de datos:', BASE);
  process.exit(1);
}

fs.mkdirSync(carpetaRespaldos, { recursive: true });
const respaldo = path.join(
  carpetaRespaldos,
  'pos_evento.antes-de-borrar-catalogo-' + Date.now() + '.db'
);

const db = new DatabaseSync(BASE);
db.exec('PRAGMA foreign_keys = ON;');

try {
  db.exec("VACUUM INTO '" + respaldo.replace(/'/g, "''") + "'");
  console.log('✔ Respaldo creado en:', respaldo);
} catch (err) {
  console.warn('Aviso sobre respaldo:', err.message);
}

db.exec('BEGIN IMMEDIATE');

try {
  // 1. Eliminar referencias en tablas dependientes
  db.exec('DELETE FROM impresion_comanda_cajero');
  db.exec('DELETE FROM impresion_comanda_mesero');
  db.exec('DELETE FROM pago_comanda');
  db.exec('DELETE FROM detalle_comanda');
  db.exec('DELETE FROM comanda');
  db.exec('DELETE FROM traspaso_detalle');
  db.exec('DELETE FROM traspaso');
  db.exec('DELETE FROM promocion_detalle');
  db.exec('DELETE FROM promocion');
  db.exec('DELETE FROM movimiento_stock');

  // 2. Eliminar todos los productos
  const rProd = db.prepare('DELETE FROM producto').run();
  console.log(`✔ Todos los productos eliminados (${rProd.changes} registros).`);

  // 3. Eliminar todas las categorías
  const rCat = db.prepare('DELETE FROM categoria_producto').run();
  console.log(`✔ Todas las categorías eliminadas (${rCat.changes} registros).`);

  // 4. Resetear contadores de secuencia de SQLite
  db.exec(`
    DELETE FROM sqlite_sequence WHERE name IN (
      'producto', 'categoria_producto', 'movimiento_stock',
      'comanda', 'detalle_comanda', 'pago_comanda',
      'impresion_comanda_cajero', 'impresion_comanda_mesero',
      'traspaso', 'traspaso_detalle', 'promocion', 'promocion_detalle'
    )
  `);

  db.exec('COMMIT');
  console.log('\n✅ Catálogo completamente vaciado.');
} catch (error) {
  db.exec('ROLLBACK');
  console.error('❌ Error al vaciar catálogo:', error);
  process.exit(1);
}

console.log('\n--- ESTADO FINAL ---');
console.log('Total categorías:', db.prepare('SELECT COUNT(*) as total FROM categoria_producto').get().total);
console.log('Total productos:', db.prepare('SELECT COUNT(*) as total FROM producto').get().total);
console.log('Total movimientos stock:', db.prepare('SELECT COUNT(*) as total FROM movimiento_stock').get().total);
console.log('Total comandas:', db.prepare('SELECT COUNT(*) as total FROM comanda').get().total);

db.close();
