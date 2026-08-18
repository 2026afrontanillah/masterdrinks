/* ==========================================================================
 * MasterDrinks — Levantar una barra en este mismo ordenador
 * ==========================================================================
 *
 * SÓLO PARA ENSAYAR. En el evento cada barra va en su propia tablet, con su
 * propia carpeta y su propio .env; ahí no hace falta nada de esto.
 *
 * Esto sirve para probar las tres barras a la vez en un mismo equipo, antes
 * del montaje. Como comparten carpeta, hay que darle a cada una su archivo de
 * base de datos y su puerto, que es justo lo que hace este lanzador.
 *
 *   node tools/barra.js Norte           ->  puerto 3001, barra_norte.db
 *   node tools/barra.js Sur             ->  puerto 3002, barra_sur.db
 *   node tools/barra.js General         ->  puerto 3003, barra_general.db
 *
 * Abre tres terminales, una por barra. Cada una es un servidor independiente:
 * su stock, sus ventas y su numeración no se tocan entre sí.
 * ========================================================================== */

'use strict';

const path = require('path');
const { spawn } = require('child_process');

// Las tres barras del montaje. El puerto sólo importa aquí, porque comparten
// equipo; en tablets separadas las tres usan el 3000.
const BARRAS = {
  norte:   { nombre: 'Norte',   prefijo: 'N', puerto: 3001 },
  sur:     { nombre: 'Sur',     prefijo: 'S', puerto: 3002 },
  general: { nombre: 'General', prefijo: 'G', puerto: 3003 }
};

const pedida = (process.argv[2] || '').toLowerCase();
const barra = BARRAS[pedida];

if (!barra) {
  console.error('\n  Uso:  node tools/barra.js <barra>\n');
  console.error('  Barras disponibles:');
  Object.values(BARRAS).forEach(b =>
    console.error(`     ${b.nombre.padEnd(9)} puerto ${b.puerto}   comandas ${b.prefijo}-1, ${b.prefijo}-2, ...`));
  console.error('\n  Cada una en su propia terminal. Son servidores independientes.\n');
  process.exit(1);
}

const archivoBase = 'barra_' + pedida + '.db';

console.log(`\n  Levantando la barra ${barra.nombre}`);
console.log(`     base de datos:  ${archivoBase}   (propia, no la comparte con nadie)`);
console.log(`     puerto:         ${barra.puerto}`);
console.log(`     comandas:       ${barra.prefijo}-1, ${barra.prefijo}-2, ...\n`);

// La primera vez, el servidor crea y siembra esa base solo.
const hijo = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  cwd: path.join(__dirname, '..'),
  env: Object.assign({}, process.env, {
    INSTANCIA: barra.nombre,
    PREFIJO: barra.prefijo,
    PORT: String(barra.puerto),
    DB_FILE: archivoBase
  }),
  stdio: 'inherit'
});

// Ctrl+C tiene que llegar al servidor para que cierre la base en orden: es lo
// que vuelca las ventas pendientes del -wal dentro del .db.
process.on('SIGINT', () => hijo.kill('SIGINT'));
process.on('SIGTERM', () => hijo.kill('SIGTERM'));
hijo.on('exit', codigo => process.exit(codigo || 0));
