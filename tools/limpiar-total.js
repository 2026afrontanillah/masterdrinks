'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = path.join(__dirname, '..');
const BASE = process.env.DB_FILE
  ? path.resolve(RAIZ, process.env.DB_FILE)
  : path.join(RAIZ, 'pos_evento.db');

if (!fs.existsSync(BASE)) {
  console.error('\n❌ No existe la base de datos: ' + BASE);
  process.exit(1);
}

// 1. Crear respaldo preventivo
const carpetaRespaldos = path.join(path.dirname(BASE), 'respaldos');
fs.mkdirSync(carpetaRespaldos, { recursive: true });
const respaldo = path.join(carpetaRespaldos, 'pos_evento_backup_completo_' + Date.now() + '.db');

const db = new DatabaseSync(BASE);

try {
  db.exec("VACUUM INTO '" + respaldo.replace(/'/g, "''") + "'");
  console.log('📦 Copia de seguridad guardada en:', respaldo);
} catch (err) {
  console.warn('⚠️ Nota de respaldo:', err.message);
}

db.exec('PRAGMA foreign_keys = OFF;');
db.exec('BEGIN IMMEDIATE;');

try {
  // 2. Limpiar todas las transacciones, comandas, pagos, impresiones, auditorías y traspasos
  const tablasTransaccionales = [
    'impresion_comanda_cajero',
    'impresion_comanda_mesero',
    'pago_comanda',
    'detalle_comanda',
    'comanda',
    'movimiento_stock',
    'auditoria_admin',
    'traspaso_detalle',
    'traspaso'
  ];

  tablasTransaccionales.forEach(tabla => {
    try {
      db.exec(`DELETE FROM ${tabla};`);
      console.log(`✔ Vaciada tabla: ${tabla}`);
    } catch (e) {
      console.warn(`⚠️ No se pudo vaciar ${tabla}:`, e.message);
    }
  });

  // 3. Limpiar personal (cajeros, meseros, supervisores/encargados)
  db.exec('DELETE FROM mesero;');
  console.log('✔ Vaciada tabla: mesero');

  db.exec('DELETE FROM cajero;');
  console.log('✔ Vaciada tabla: cajero');

  // Dejar únicamente al usuario admin
  db.exec("DELETE FROM administrador_evento WHERE usuario != 'admin' AND id_admin != 1;");
  
  // Asegurar que admin tenga password admin*12345
  const adminExiste = db.prepare("SELECT id_admin FROM administrador_evento WHERE id_admin = 1 OR usuario = 'admin'").get();
  if (adminExiste) {
    db.prepare("UPDATE administrador_evento SET nombre = 'Administrador Principal', usuario = 'admin', password = 'admin*12345', rol = 'ADMINISTRADOR', activo = 1 WHERE id_admin = ?").run(adminExiste.id_admin);
  } else {
    db.prepare("INSERT INTO administrador_evento (id_admin, id_evento, nombre, usuario, password, rol, activo) VALUES (1, 1, 'Administrador Principal', 'admin', 'admin*12345', 'ADMINISTRADOR', 1)").run();
  }
  console.log('✔ Usuario admin configurado con contraseña: admin*12345 (demás usuarios eliminados)');

  // 4. Poner stock de todos los productos en 0 (sin borrar productos ni categorías)
  const resProd = db.prepare('UPDATE producto SET stock_actual = 0;').run();
  console.log(`✔ Stock de todos los productos puesto en 0 (${resProd.changes} productos actualizados).`);

  // 5. Reiniciar secuencias autoincrementales
  const secuencias = [
    'comanda',
    'detalle_comanda',
    'pago_comanda',
    'impresion_comanda_cajero',
    'impresion_comanda_mesero',
    'movimiento_stock',
    'auditoria_admin',
    'traspaso',
    'traspaso_detalle',
    'mesero',
    'cajero'
  ];
  const placeholders = secuencias.map(t => `'${t}'`).join(', ');
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders});`);
  console.log('✔ Secuencias autoincrementales reiniciadas a 1.');

  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.exec('VACUUM;');

  console.log('\n======================================================');
  console.log('✅ BASE DE DATOS COMPLETAMENTE LIMPIA:');
  console.log('   - Usuario Admin: admin / admin*12345 (Único usuario)');
  console.log('   - Personal (Cajeros, Meseros, Encargados): 0');
  console.log('   - Comandas, Pagos, Transacciones: 0');
  console.log('   - Movimientos de stock y Auditorías: 0');
  console.log('   - Productos y Categorías: Conservados intactos');
  console.log('   - Stock de todos los productos: 0');
  console.log('======================================================\n');
} catch (err) {
  db.exec('ROLLBACK;');
  console.error('❌ Error durante la limpieza:', err);
  db.close();
  process.exit(1);
}

db.close();
process.exit(0);
