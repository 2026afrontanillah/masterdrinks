'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = path.join(__dirname, '..');
const BASE = path.join(RAIZ, 'pos_evento.db');
const RESPALDOS = path.join(RAIZ, 'respaldos');

if (!fs.existsSync(RESPALDOS)) {
  fs.mkdirSync(RESPALDOS, { recursive: true });
}

// 1. Checkpoint WAL and Backup
const dbtmp = new DatabaseSync(BASE);
dbtmp.exec('PRAGMA wal_checkpoint(TRUNCATE);');
dbtmp.close();

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(RESPALDOS, `pos_evento.backup-${timestamp}.db`);
fs.copyFileSync(BASE, backupPath);
console.log('✔ Copia de respaldo guardada en:', backupPath);

// 2. Perform Reset
const db = new DatabaseSync(BASE);
db.exec('PRAGMA foreign_keys = OFF;');
db.exec('BEGIN TRANSACTION;');

// Tablas a vaciar
const tablas = [
  'detalle_comanda',
  'pago_comanda',
  'impresion_comanda_cajero',
  'impresion_comanda_mesero',
  'comanda',
  'movimiento_stock',
  'auditoria_admin',
  'traspaso_detalle',
  'traspaso'
];

tablas.forEach(tabla => {
  db.exec(`DELETE FROM ${tabla};`);
  console.log(`✔ Vaciada tabla: ${tabla}`);
});

// Poner stock a 0 en todos los productos
const resProd = db.prepare('UPDATE producto SET stock_actual = 0;').run();
console.log(`✔ Stock de productos reseteado a 0 (${resProd.changes} productos actualizados).`);

// Resetear secuencias autoincrementales
const placeholders = tablas.map(t => `'${t}'`).join(', ');
db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders});`);
console.log('✔ Secuencias autoincrementales reiniciadas.');

db.exec('COMMIT;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('VACUUM;');
db.close();

console.log('\n=============================================');
console.log(' Base de datos lista en punto cero conocido.');
console.log('=============================================');
