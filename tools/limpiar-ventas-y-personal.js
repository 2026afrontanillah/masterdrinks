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

const carpetaRespaldos = path.join(path.dirname(BASE), 'respaldos');
fs.mkdirSync(carpetaRespaldos, { recursive: true });
const respaldo = path.join(carpetaRespaldos, 'pos_evento_antes_de_limpiar_' + Date.now() + '.db');

const db = new DatabaseSync(BASE);

try {
  db.exec("VACUUM INTO '" + respaldo.replace(/'/g, "''") + "'");
  console.log('📦 Copia de respaldo creada en: ' + respaldo);
} catch (err) {
  console.error('⚠️ No se pudo crear respaldo automático:', err.message);
}

db.exec('BEGIN IMMEDIATE');
try {
  // 1. Borrar impresiones y pagos de comandas
  db.exec('DELETE FROM impresion_comanda_cajero');
  db.exec('DELETE FROM impresion_comanda_mesero');
  db.exec('DELETE FROM pago_comanda');
  db.exec('DELETE FROM detalle_comanda');
  db.exec('DELETE FROM comanda');

  // 2. Borrar movimientos de stock vinculados a ventas
  try {
    db.exec("DELETE FROM movimiento_stock WHERE motivo LIKE 'Venta comanda #%' OR motivo LIKE 'Anulación%'");
  } catch (_) {}

  // 3. Borrar personal (meseros, cajeros, encargados)
  db.exec('DELETE FROM mesero');
  db.exec('DELETE FROM cajero');
  db.exec("DELETE FROM administrador_evento WHERE UPPER(rol) = 'ENCARGADO'");

  // 4. Limpiar auditorías viejas de comandas y personal
  try {
    db.exec("DELETE FROM auditoria_admin WHERE entidad IN ('comanda', 'cajero', 'mesero', 'encargado')");
  } catch (_) {}

  // 5. Reiniciar contadores de ID para empezar desde 1
  try {
    db.exec(`DELETE FROM sqlite_sequence WHERE name IN (
      'comanda',
      'detalle_comanda',
      'pago_comanda',
      'impresion_comanda_cajero',
      'impresion_comanda_mesero',
      'mesero',
      'cajero'
    )`);
  } catch (_) {}

  db.exec('COMMIT');
  console.log('✅ Base de datos limpiada con éxito:');
  console.log('   - Comandas y ventas: 0 (reiniciadas a #1)');
  console.log('   - Meseros: 0');
  console.log('   - Cajeros: 0');
  console.log('   - Encargados: 0');
  console.log('   - Productos, categorías y Admin: INTACTOS');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('❌ Error al limpiar base de datos:', err);
  db.close();
  process.exit(1);
}

db.close();
process.exit(0);
