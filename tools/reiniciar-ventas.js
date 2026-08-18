/* ==========================================================================
 * MasterDrinks — Borrar las ventas y dejar la base como recién montada
 * ==========================================================================
 *
 * Para desarrollo y para el ensayo previo al evento: quita las comandas de
 * prueba y devuelve el stock que consumieron, sin tocar el catálogo, el
 * personal ni los datos del evento.
 *
 * Es un comando y no un botón del panel a propósito: durante el evento no
 * puede existir la forma de borrar la caja de un toque.
 *
 *   npm run reiniciar            enseña qué se borraría, sin borrar nada
 *   npm run reiniciar -- --si    borra de verdad
 *
 * Antes de tocar nada deja una copia del archivo, hecha con VACUUM INTO para
 * que incluya lo que aún esté en el -wal.
 * ======================================================================== */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = path.join(__dirname, '..');
const BASE = process.env.DB_FILE
  ? path.resolve(RAIZ, process.env.DB_FILE)
  : path.join(RAIZ, 'pos_evento.db');

const C = {
  tit: t => '\x1b[1m\x1b[36m' + t + '\x1b[0m',
  ok: t => '\x1b[32m' + t + '\x1b[0m',
  mal: t => '\x1b[31m' + t + '\x1b[0m',
  gris: t => '\x1b[90m' + t + '\x1b[0m'
};

const enSerio = process.argv.includes('--si');

if (!fs.existsSync(BASE)) {
  console.error(C.mal('\n  No existe la base ') + BASE + '\n');
  process.exit(1);
}

// Un -wal con contenido significa una de dos: el servidor sigue abierto, o se
// cerró de golpe sin volcar. En el primer caso, borrar por debajo lo dejaría
// escribiendo sobre lo borrado; en el segundo no pasa nada. No se distinguen
// desde aquí, así que se avisa y se sigue.
const wal = BASE + '-wal';
if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
  console.log(C.mal('\n  ⚠ La base tiene datos sin volcar (archivo -wal).'));
  console.log('    Si el servidor está encendido, párale con Ctrl+C antes de');
  console.log('    seguir: podría reescribir lo que acabamos de borrar.');
  console.log(C.gris('    Si ya lo paraste, es sólo el rastro del último cierre.\n'));
}

const db = new DatabaseSync(BASE);
const q = (sql, p = []) => db.prepare(sql).all(...p);
const uno = (sql, p = []) => db.prepare(sql).get(...p);

console.log(C.tit('\n  MasterDrinks · reiniciar ventas'));
console.log(C.gris('  ' + BASE + '\n'));

// ---- Qué hay ahora --------------------------------------------------------
const antes = {
  comandas: uno('SELECT COUNT(*) n FROM comanda').n,
  lineas: uno('SELECT COUNT(*) n FROM detalle_comanda').n,
  pagos: uno('SELECT COUNT(*) n FROM pago_comanda').n,
  salidas: uno("SELECT COUNT(*) n FROM movimiento_stock WHERE motivo LIKE 'Venta comanda #%'").n,
  recaudado: uno("SELECT COALESCE(SUM(total),0) t FROM comanda WHERE estado_pago <> 'ANULADO'").t
};

console.log('  Se borrarán:');
console.log('    comandas                 ' + antes.comandas);
console.log('    líneas de venta          ' + antes.lineas);
console.log('    pagos                    ' + antes.pagos);
console.log('    movimientos de venta     ' + antes.salidas);
console.log('    recaudado que desaparece ' + Number(antes.recaudado).toFixed(2) + ' Bs.');

// Devolver al stock lo que se llevaron esas ventas. Se calcula desde los
// propios movimientos y no desde las líneas: si una venta se anuló, su
// devolución ya está registrada y sumarla otra vez inflaría el inventario.
const devoluciones = q(`
  SELECT id_producto,
         SUM(CASE WHEN tipo_movimiento = 'SALIDA'  THEN cantidad ELSE 0 END) -
         SUM(CASE WHEN tipo_movimiento = 'ENTRADA' THEN cantidad ELSE 0 END) AS neto
    FROM movimiento_stock
   WHERE motivo LIKE 'Venta comanda #%' OR motivo LIKE 'Anulación%'
   GROUP BY id_producto
  HAVING neto <> 0`);

if (devoluciones.length) {
  console.log('\n  Se devolverá al stock:');
  devoluciones.forEach(d => {
    const p = uno('SELECT nombre, stock_actual FROM producto WHERE id_producto = ?', [d.id_producto]);
    if (!p) return;
    console.log('    ' + String(p.nombre).slice(0, 34).padEnd(36) +
      p.stock_actual + ' → ' + (p.stock_actual + d.neto) + C.gris('  (+' + d.neto + ')'));
  });
}

if (!enSerio) {
  console.log(C.gris('\n  Esto ha sido sólo un vistazo: no se ha tocado nada.'));
  console.log('  Para hacerlo de verdad:  ' + C.tit('npm run reiniciar -- --si') + '\n');
  db.close();
  process.exit(0);
}

// ---- Copia de seguridad ---------------------------------------------------
const respaldo = BASE.replace(/\.db$/, '') + '.antes-de-reiniciar.db';
try {
  if (fs.existsSync(respaldo)) fs.unlinkSync(respaldo);
  db.exec("VACUUM INTO '" + respaldo.replace(/'/g, "''") + "'");
  console.log(C.gris('\n  Copia previa: ' + path.basename(respaldo)));
} catch (err) {
  console.error(C.mal('\n  No se pudo crear la copia de seguridad: ') + err.message);
  console.error('  No se borra nada.\n');
  db.close();
  process.exit(1);
}

// ---- Borrado ---------------------------------------------------------------
// Todo dentro de una transacción: o se va entero o no se va nada. A medias
// quedarían pagos sin comanda y el cierre no cuadraría nunca más.
let regularizados = [];
db.exec('BEGIN IMMEDIATE');
try {
  devoluciones.forEach(d => {
    db.prepare('UPDATE producto SET stock_actual = stock_actual + ? WHERE id_producto = ?')
      .run(d.neto, d.id_producto);
  });

  db.exec('DELETE FROM impresion_comanda_cajero');
  db.exec('DELETE FROM impresion_comanda_mesero');
  db.exec('DELETE FROM pago_comanda');
  db.exec('DELETE FROM detalle_comanda');
  db.exec('DELETE FROM comanda');
  db.exec("DELETE FROM movimiento_stock WHERE motivo LIKE 'Venta comanda #%' OR motivo LIKE 'Anulación%'");

  // Los contadores vuelven a empezar para que la primera comanda sea la #1.
  // Sin esto la numeración arrancaba en el 119 de las pruebas anteriores.
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN
    ('comanda','detalle_comanda','pago_comanda',
     'impresion_comanda_cajero','impresion_comanda_mesero')`);
  db.prepare('UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id_movimiento),0) FROM movimiento_stock) WHERE name = ?')
    .run('movimiento_stock');

  // Existencias sin movimiento detrás.
  //
  // Las bases creadas con la semilla antigua traían veinte productos con stock
  // pero sólo tres movimientos de entrada: los otros diecisiete tenían unidades
  // que nadie había registrado nunca, y el reporte de stock no podía cuadrar.
  // Se les escribe el movimiento que les falta en vez de callarlo.
  regularizados = q(`
    SELECT p.id_producto, p.nombre, p.stock_actual,
           COALESCE((SELECT m.stock_nuevo FROM movimiento_stock m
                      WHERE m.id_producto = p.id_producto
                      ORDER BY m.id_movimiento DESC LIMIT 1), 0) AS respaldado
      FROM producto p`)
    .filter(p => p.stock_actual !== p.respaldado);

  regularizados.forEach(p => {
    const salto = p.stock_actual - p.respaldado;
    db.prepare(
      `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad,
                                     stock_anterior, stock_nuevo, motivo, fecha_hora)
       VALUES (?, 1, ?, ?, ?, ?, 'Regularización: existencias sin movimiento previo', ?)`
    ).run(p.id_producto, salto > 0 ? 'ENTRADA' : 'SALIDA', Math.abs(salto),
          p.respaldado, p.stock_actual, new Date().toISOString().slice(0, 19).replace('T', ' '));
  });

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(C.mal('\n  Falló el borrado, no se cambió nada: ') + err.message + '\n');
  db.close();
  process.exit(1);
}

// ---- Comprobación ----------------------------------------------------------
const sobran = {
  comandas: uno('SELECT COUNT(*) n FROM comanda').n,
  lineas: uno('SELECT COUNT(*) n FROM detalle_comanda').n,
  pagos: uno('SELECT COUNT(*) n FROM pago_comanda').n,
  impresiones: uno('SELECT COUNT(*) n FROM impresion_comanda_cajero').n +
               uno('SELECT COUNT(*) n FROM impresion_comanda_mesero').n
};
// Cada producto tiene que acabar con el mismo stock que dejó su último
// movimiento. Se compara así, y no sumando entradas menos salidas, porque un
// AJUSTE fija el total en vez de sumarlo: con la resta todo ajuste parecería
// un descuadre.
const descuadre = q(`
  SELECT p.id_producto, p.nombre, p.stock_actual,
         COALESCE((SELECT m.stock_nuevo FROM movimiento_stock m
                    WHERE m.id_producto = p.id_producto
                    ORDER BY m.id_movimiento DESC LIMIT 1), 0) AS respaldado
    FROM producto p
   WHERE p.stock_actual <> respaldado`);
const integridad = uno('PRAGMA integrity_check').integrity_check;

console.log('');
const bien = sobran.comandas === 0 && sobran.lineas === 0 && sobran.pagos === 0 &&
             sobran.impresiones === 0 && descuadre.length === 0 && integridad === 'ok';

console.log('  ' + (sobran.comandas === 0 ? C.ok('✓') : C.mal('✗')) + ' No queda ninguna comanda');
console.log('  ' + (sobran.lineas + sobran.pagos + sobran.impresiones === 0 ? C.ok('✓') : C.mal('✗')) +
  ' Ni líneas, ni pagos, ni tickets huérfanos');
console.log('  ' + (descuadre.length === 0 ? C.ok('✓') : C.mal('✗')) +
  ' Cada producto cuadra con su último movimiento' +
  (descuadre.length ? C.gris('  ' + descuadre.length + ' descuadrado(s)') : ''));
if (descuadre.length) console.table(descuadre);
if (regularizados.length) {
  console.log('  ' + C.ok('✓') + ' Se registraron ' + regularizados.length +
    ' movimientos que faltaban' + C.gris('  existencias que no tenían ninguno'));
}
console.log('  ' + (integridad === 'ok' ? C.ok('✓') : C.mal('✗')) + ' La base pasa la comprobación de integridad');

db.close();

console.log('');
console.log(bien
  ? '  ' + C.ok('Base limpia. La próxima venta será la comanda #1.') + '\n'
  : '  ' + C.mal('Quedó algo por revisar.') + '\n');
process.exit(bien ? 0 : 1);
