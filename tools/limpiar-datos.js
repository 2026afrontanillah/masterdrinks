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
  'pos_evento.antes-de-limpieza-' + Date.now() + '.db'
);

const db = new DatabaseSync(BASE);
db.exec('PRAGMA foreign_keys = ON;');

try {
  // 1. Respaldo previo
  db.exec("VACUUM INTO '" + respaldo.replace(/'/g, "''") + "'");
  console.log('✔ Respaldo creado en:', respaldo);
} catch (err) {
  console.warn('Aviso sobre respaldo:', err.message);
}

db.exec('BEGIN IMMEDIATE');

try {
  // 2. Eliminar todas las comandas, pagos, líneas de venta e impresiones
  db.exec('DELETE FROM impresion_comanda_cajero');
  db.exec('DELETE FROM impresion_comanda_mesero');
  db.exec('DELETE FROM pago_comanda');
  db.exec('DELETE FROM detalle_comanda');
  db.exec('DELETE FROM comanda');
  console.log('✔ Todas las comandas, pagos, detalles e impresiones eliminadas.');

  // 3. Eliminar todos los traspasos
  try {
    db.exec('DELETE FROM traspaso_detalle');
    db.exec('DELETE FROM traspaso');
    console.log('✔ Traspasos eliminados.');
  } catch (e) {
    console.log('Nota traspasos:', e.message);
  }

  // 4. Eliminar todas las promociones
  try {
    db.exec('DELETE FROM promocion_detalle');
    db.exec('DELETE FROM promocion');
    console.log('✔ Promociones y detalles de promociones eliminados.');
  } catch (e) {
    console.log('Nota promociones:', e.message);
  }

  // 5. Eliminar todos los movimientos de stock anteriores
  db.exec('DELETE FROM movimiento_stock');
  console.log('✔ Todos los movimientos de stock eliminados.');

  // 6. Eliminar todas las auditorías
  db.exec('DELETE FROM auditoria_admin');
  console.log('✔ Todas las auditorías de administración eliminadas.');

  // 7. Eliminar productos de la categoría "Aguas" y la categoría en sí
  const catAguas = db.prepare("SELECT id_categoria, nombre FROM categoria_producto WHERE LOWER(nombre) LIKE '%agua%'").all();
  for (const cat of catAguas) {
    const prodsCat = db.prepare('SELECT id_producto, nombre FROM producto WHERE id_categoria = ?').all(cat.id_categoria);
    for (const p of prodsCat) {
      db.prepare('DELETE FROM producto WHERE id_producto = ?').run(p.id_producto);
      console.log(`  - Producto eliminado: ${p.nombre} (ID ${p.id_producto})`);
    }
    db.prepare('DELETE FROM categoria_producto WHERE id_categoria = ?').run(cat.id_categoria);
    console.log(`  - Categoría eliminada: ${cat.nombre} (ID ${cat.id_categoria})`);
  }

  // 8. Eliminar categoría "Promociones" si existiera en categoria_producto
  const catPromos = db.prepare("SELECT id_categoria, nombre FROM categoria_producto WHERE LOWER(nombre) LIKE '%promo%'").all();
  for (const cat of catPromos) {
    const prodsCat = db.prepare('SELECT id_producto, nombre FROM producto WHERE id_categoria = ?').all(cat.id_categoria);
    for (const p of prodsCat) {
      db.prepare('DELETE FROM producto WHERE id_producto = ?').run(p.id_producto);
    }
    db.prepare('DELETE FROM categoria_producto WHERE id_categoria = ?').run(cat.id_categoria);
    console.log(`  - Categoría eliminada: ${cat.nombre}`);
  }

  // 9. Actualizar todos los productos restantes y activos a stock = 50
  db.prepare('UPDATE producto SET stock_actual = 50 WHERE activo = 1').run();
  console.log('✔ Todos los productos restantes y activos fijados con 50 unidades de stock.');

  // 10. Crear movimiento inicial de 50 unidades para cada producto activo
  const productos = db.prepare('SELECT id_producto, nombre FROM producto WHERE activo = 1').all();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const stmtMov = db.prepare(`
    INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora)
    VALUES (?, 1, 'ENTRADA', 50, 0, 50, 'Carga inicial de stock para el evento', ?)
  `);

  for (const prod of productos) {
    stmtMov.run(prod.id_producto, now);
  }
  console.log(`✔ Creados ${productos.length} movimientos de stock iniciales de 50 unidades (cuadre de inventario exacto).`);

  // 11. Resetear secuencias sqlite
  db.exec(`
    DELETE FROM sqlite_sequence WHERE name IN (
      'comanda', 'detalle_comanda', 'pago_comanda',
      'impresion_comanda_cajero', 'impresion_comanda_mesero',
      'traspaso', 'traspaso_detalle',
      'promocion', 'promocion_detalle',
      'movimiento_stock', 'auditoria_admin'
    )
  `);
  db.prepare('UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id_movimiento),0) FROM movimiento_stock) WHERE name = ?')
    .run('movimiento_stock');

  db.exec('COMMIT');
  console.log('\n✅ Proceso completado exitosamente.');

} catch (error) {
  db.exec('ROLLBACK');
  console.error('❌ Error durante la limpieza, transacción revertida:', error);
  process.exit(1);
}

// Resumen final
console.log('\n========================================');
console.log('         RESUMEN DE BASE DE DATOS       ');
console.log('========================================');
console.log('Categorías existentes:');
console.table(db.prepare('SELECT id_categoria, nombre, tipo, activo FROM categoria_producto').all());

console.log('Productos y Stock actual:');
console.table(db.prepare('SELECT p.id_producto, p.nombre, c.nombre as categoria, p.precio_venta, p.stock_actual FROM producto p JOIN categoria_producto c ON p.id_categoria = c.id_categoria WHERE p.activo = 1').all());

console.log('Comandas restantes:', db.prepare('SELECT COUNT(*) as total FROM comanda').get().total);
console.log('Movimientos de stock:', db.prepare('SELECT COUNT(*) as total FROM movimiento_stock').get().total);
console.log('Auditorías restantes:', db.prepare('SELECT COUNT(*) as total FROM auditoria_admin').get().total);
console.log('Promociones restantes:', db.prepare('SELECT COUNT(*) as total FROM promocion').get().total);

db.close();
