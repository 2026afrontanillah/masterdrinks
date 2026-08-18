/* ==========================================================================
 * MasterDrinks — Pruebas de lógica
 * ==========================================================================
 *
 * Le tira al servidor todo lo que NO debería aceptar, y comprueba que además
 * de rechazarlo no deja la base tocada. Complementa a stress-test.js: aquélla
 * mide qué aguanta bajo carga, ésta si razona bien.
 *
 * Como la de carga, trabaja sobre una copia desechable de la base.
 *
 *   node tools/logic-test.js
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = path.join(__dirname, '..');
const BASE_ORIGEN = path.join(RAIZ, 'pos_evento.db');
const BASE = path.join(RAIZ, 'pos_evento.logic.db');
const PUERTO = Number(process.argv[process.argv.indexOf('--puerto') + 1]) || 3388;
const URL = 'http://127.0.0.1:' + PUERTO;

const esperar = ms => new Promise(r => setTimeout(r, ms));
const C = {
  ok: s => '\x1b[32m' + s + '\x1b[0m',
  mal: s => '\x1b[31m' + s + '\x1b[0m',
  dim: s => '\x1b[90m' + s + '\x1b[0m',
  tit: s => '\x1b[1m\x1b[36m' + s + '\x1b[0m'
};

let fallos = 0;
function check(nombre, ok, detalle) {
  console.log('  ' + (ok ? C.ok('✓') : C.mal('✗')) + ' ' + nombre + (detalle ? C.dim('  ' + detalle) : ''));
  if (!ok) fallos++;
}

async function post(ruta, cuerpo) {
  const res = await fetch(URL + ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* sin cuerpo */ }
  return { status: res.status, json };
}
const get = async ruta => (await fetch(URL + ruta)).json();

// --------------------------------------------------------------------------
function prepararBase() {
  const origen = new DatabaseSync(BASE_ORIGEN);
  origen.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  origen.close();
  ['', '-wal', '-shm'].forEach(s => { if (fs.existsSync(BASE + s)) fs.unlinkSync(BASE + s); });
  fs.copyFileSync(BASE_ORIGEN, BASE);
}

const leer = sql => {
  const db = new DatabaseSync(BASE);
  const filas = db.prepare(sql).all();
  db.close();
  return filas;
};

// --------------------------------------------------------------------------
(async () => {
  console.log(C.tit('\n  MasterDrinks · pruebas de lógica'));
  console.log(C.dim('  entradas inválidas y casos límite sobre una copia de la base\n'));

  prepararBase();
  const hijo = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, { PORT: String(PUERTO), DB_FILE: BASE }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const registro = [];
  hijo.stdout.on('data', d => registro.push(String(d)));
  hijo.stderr.on('data', d => registro.push(String(d)));

  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(URL + '/api/productos')).ok) break; } catch (e) { /* aún no */ }
    await esperar(250);
  }

  const { productos } = await get('/api/productos');
  const prod = productos[0];
  // La barra no se escribe a mano: el servidor unifica la base en una sola y su
  // id depende de con cuál se quedó. Escribir "1" aquí ataba la prueba a un
  // detalle interno que ya no se cumple.
  const idBarra = leer('SELECT id_barra FROM barra ORDER BY id_barra')[0].id_barra;
  const base = {
    id_evento: 1, id_barra: idBarra, id_cajero: 1, id_mesero: 1,
    observaciones: 'prueba de logica'
  };
  const item = (id, cant) => ({ id_producto: id, cantidad: cant, precio_unitario: 1, subtotal: 1 });
  const stockDe = id => leer(`SELECT stock_actual FROM producto WHERE id_producto = ${id}`)[0].stock_actual;

  // =======================================================================
  console.log(C.tit('  Cobro de una comanda'));
  // =======================================================================
  const stock0 = stockDe(prod.id_producto);

  let r = await post('/api/comanda', Object.assign({}, base, {
    total: prod.precio_venta,
    items: [item(prod.id_producto, 1)],
    metodos_pago: [{ id_metodo_pago: 1, monto: 'abc' }]
  }));
  check('Rechaza un monto que no es un número', r.status === 400,
    r.status + ' ' + ((r.json && r.json.message) || ''));

  r = await post('/api/comanda', Object.assign({}, base, {
    total: 100,
    items: [item(prod.id_producto, 1)],
    metodos_pago: [{ id_metodo_pago: 1, monto: 200 }, { id_metodo_pago: 3, monto: -100 }]
  }));
  check('Rechaza un pago negativo que compensa a otro inflado', r.status === 400,
    r.status + ' ' + ((r.json && r.json.message) || ''));

  r = await post('/api/comanda', Object.assign({}, base, {
    total: prod.precio_venta,
    items: [item(prod.id_producto, 1)],
    metodos_pago: [{ id_metodo_pago: 99, monto: prod.precio_venta }]
  }));
  check('Rechaza una forma de pago que no existe', r.status === 400,
    r.status + ' ' + ((r.json && r.json.message) || ''));

  r = await post('/api/comanda', Object.assign({}, base, {
    total: 1,
    items: [item(prod.id_producto, 1)],
    metodos_pago: [{ id_metodo_pago: 1, monto: 0.01 }]
  }));
  check('Rechaza cuando los pagos no cubren el total', r.status === 400,
    (r.json && r.json.message) || '');

  // La decimal importa: antes parseInt('1.5') la convertía en 1 y la comanda
  // se guardaba con menos unidades de las pedidas, sin avisar.
  for (const [nombre, cant] of [['cero', 0], ['negativa', -3], ['con letras', 'dos'],
                                ['decimal', 1.5], ['nula', null]]) {
    r = await post('/api/comanda', Object.assign({}, base, {
      total: 100, items: [item(prod.id_producto, cant)],
      metodos_pago: [{ id_metodo_pago: 1, monto: 100 }]
    }));
    check('Rechaza una cantidad ' + nombre, r.status === 400,
      'status ' + r.status + ' ' + ((r.json && r.json.message) || ''));
  }

  r = await post('/api/comanda', Object.assign({}, base, {
    total: 10, items: [item(999999, 1)], metodos_pago: [{ id_metodo_pago: 1, monto: 10 }]
  }));
  check('Rechaza un producto que no existe', r.status === 400);

  r = await post('/api/comanda', Object.assign({}, base, {
    total: 10, items: [], metodos_pago: [{ id_metodo_pago: 1, monto: 10 }]
  }));
  check('Rechaza una comanda sin productos', r.status === 400);

  r = await post('/api/comanda', Object.assign({}, base, {
    total: 10, items: [item(prod.id_producto, 1)], metodos_pago: []
  }));
  check('Rechaza una comanda sin pagos', r.status === 400);

  r = await post('/api/comanda', Object.assign({}, base, {
    id_barra: null, total: 10, items: [item(prod.id_producto, 1)],
    metodos_pago: [{ id_metodo_pago: 1, monto: 10 }]
  }));
  check('Rechaza una comanda sin barra', r.status === 400);

  check('Ninguna de las comandas rechazadas tocó el stock',
    stockDe(prod.id_producto) === stock0, 'stock ' + stock0 + ' → ' + stockDe(prod.id_producto));
  check('Ninguna de las comandas rechazadas se guardó',
    leer("SELECT id_comanda FROM comanda WHERE observaciones = 'prueba de logica'").length === 0);
  check('No quedó ningún pago con importe no numérico',
    leer('SELECT id_pago FROM pago_comanda WHERE monto IS NULL OR monto != monto').length === 0);

  // El precio manda el servidor, no la tablet.
  r = await post('/api/comanda', Object.assign({}, base, {
    observaciones: 'precio manipulado',
    total: 0.01,
    items: [{ id_producto: prod.id_producto, cantidad: 2, precio_unitario: 0.005, subtotal: 0.01 }],
    metodos_pago: [{ id_metodo_pago: 1, monto: prod.precio_venta * 2 }]
  }));
  check('El precio lo pone la base, no el navegador',
    r.status === 200 && Math.abs(r.json.total - prod.precio_venta * 2) < 0.01,
    'cobrado ' + (r.json && r.json.total) + ' con precio real ' + prod.precio_venta);
  const idManipulada = r.json && r.json.id_comanda;

  // =======================================================================
  console.log(C.tit('\n  Venta duplicada por reintento'));
  // =======================================================================
  // Si la respuesta se pierde por el WiFi, el cajero vuelve a pulsar. Sin
  // protección eso guardaba la venta dos veces: se cobraba una y el stock
  // bajaba dos. La tablet manda una clave por intento de cobro y el servidor
  // devuelve la comanda ya guardada en vez de crear otra.
  const stockPrevioIdem = stockDe(prod.id_producto);
  const ventaRepetida = Object.assign({}, base, {
    observaciones: 'reintento',
    clave_idempotencia: 'prueba-idem-' + Date.now(),
    total: prod.precio_venta,
    items: [item(prod.id_producto, 1)],
    metodos_pago: [{ id_metodo_pago: 1, monto: prod.precio_venta }]
  });

  const env1 = await post('/api/comanda', ventaRepetida);
  const env2 = await post('/api/comanda', ventaRepetida);
  const env3 = await post('/api/comanda', ventaRepetida);

  check('Tres envíos de la misma venta dan una sola comanda',
    env1.json.id_comanda === env2.json.id_comanda && env2.json.id_comanda === env3.json.id_comanda,
    'comanda ' + env1.json.id_comanda);
  check('El stock bajó una sola vez',
    stockDe(prod.id_producto) === stockPrevioIdem - 1,
    stockPrevioIdem + ' → ' + stockDe(prod.id_producto));
  check('No se guardó ninguna comanda de más',
    leer("SELECT id_comanda FROM comanda WHERE observaciones = 'reintento'").length === 1);
  check('Ni ningún pago de más',
    leer(`SELECT p.id_pago FROM pago_comanda p JOIN comanda c ON c.id_comanda = p.id_comanda
          WHERE c.observaciones = 'reintento'`).length === 1);
  check('El reintento se distingue de una venta nueva',
    env1.json.repetida === false && env2.json.repetida === true);
  check('El reintento devuelve las líneas, para poder reimprimir el ticket',
    Array.isArray(env2.json.items) && env2.json.items.length === 1);

  // Varios reintentos a la vez: la cola de transacciones tiene que impedir
  // que dos se cuelen entre la comprobación y la inserción.
  const stockAntesSimultaneo = stockDe(prod.id_producto);
  const ventaSimultanea = Object.assign({}, ventaRepetida, {
    observaciones: 'simultanea', clave_idempotencia: 'prueba-simul-' + Date.now()
  });
  const enParalelo = await Promise.all(
    Array.from({ length: 5 }, () => post('/api/comanda', ventaSimultanea))
  );
  check('Cinco reintentos simultáneos crean una sola comanda',
    new Set(enParalelo.map(r => r.json.id_comanda)).size === 1);
  check('Y descuentan una sola unidad',
    stockDe(prod.id_producto) === stockAntesSimultaneo - 1);

  // Y que no estorbe a las ventas de verdad.
  const stockAntesDistinta = stockDe(prod.id_producto);
  const otra = await post('/api/comanda', Object.assign({}, ventaRepetida, {
    observaciones: 'distinta', clave_idempotencia: 'prueba-otra-' + Date.now()
  }));
  check('Una venta con clave distinta sí se guarda y descuenta',
    otra.json.id_comanda !== env1.json.id_comanda &&
    stockDe(prod.id_producto) === stockAntesDistinta - 1);

  // =======================================================================
  console.log(C.tit('\n  Anulación'));
  // =======================================================================
  const stockAntesAnular = stockDe(prod.id_producto);
  r = await post('/api/admin/comandas/anular', { id_comanda: idManipulada, motivo_anulacion: '', id_admin: 1 });
  check('Exige un motivo para anular', r.status === 400, (r.json && r.json.message) || '');

  r = await post('/api/admin/comandas/anular', { id_comanda: idManipulada, motivo_anulacion: 'prueba', id_admin: 1 });
  check('Anula la comanda', r.status === 200);
  check('Devuelve el stock al anular',
    stockDe(prod.id_producto) === stockAntesAnular + 2,
    stockAntesAnular + ' → ' + stockDe(prod.id_producto));

  r = await post('/api/admin/comandas/anular', { id_comanda: idManipulada, motivo_anulacion: 'otra vez', id_admin: 1 });
  check('Rechaza anular dos veces la misma comanda', r.status === 409, 'status ' + r.status);
  check('La segunda anulación no devolvió stock de nuevo',
    stockDe(prod.id_producto) === stockAntesAnular + 2);

  r = await post('/api/admin/comandas/anular', { id_comanda: 999999, motivo_anulacion: 'x', id_admin: 1 });
  check('Rechaza anular una comanda inexistente', r.status === 404, 'status ' + r.status);

  // =======================================================================
  console.log(C.tit('\n  Ajuste manual de stock'));
  // =======================================================================
  const stockPrevio = stockDe(prod.id_producto);

  for (const [nombre, cuerpo] of [
    ['cantidad con letras', { cantidad: 'diez', tipo_movimiento: 'AJUSTE' }],
    ['cantidad vacía', { cantidad: '', tipo_movimiento: 'ENTRADA' }],
    ['cantidad negativa', { cantidad: -5, tipo_movimiento: 'ENTRADA' }],
    ['cantidad decimal', { cantidad: 2.7, tipo_movimiento: 'ENTRADA' }],
    ['tipo inventado', { cantidad: 5, tipo_movimiento: 'ROBO' }],
    ['sin motivo', { cantidad: 5, tipo_movimiento: 'ENTRADA', sinMotivo: true }]
  ]) {
    r = await post('/api/admin/stock/movimiento', {
      id_producto: prod.id_producto,
      tipo_movimiento: cuerpo.tipo_movimiento,
      cantidad: cuerpo.cantidad,
      motivo: cuerpo.sinMotivo ? '' : 'prueba',
      id_admin: 1, id_evento: 1
    });
    check('Rechaza ' + nombre, r.status === 400, 'status ' + r.status + ' ' + ((r.json && r.json.message) || ''));
  }

  check('El stock sigue intacto tras los ajustes inválidos',
    stockDe(prod.id_producto) === stockPrevio, 'stock ' + stockDe(prod.id_producto));
  check('No hay ningún producto con stock no numérico',
    leer('SELECT id_producto FROM producto WHERE stock_actual IS NULL OR stock_actual != stock_actual').length === 0);

  r = await post('/api/admin/stock/movimiento', {
    id_producto: prod.id_producto, tipo_movimiento: 'ENTRADA', cantidad: 10,
    motivo: 'reposición de prueba', id_admin: 1, id_evento: 1
  });
  check('Acepta una entrada válida', r.status === 200 && r.json.stock_nuevo === stockPrevio + 10,
    'stock ' + (r.json && r.json.stock_nuevo));

  // =======================================================================
  console.log(C.tit('\n  Ajuste de stock a la vez que se vende'));
  // =======================================================================
  // Éste es el caso que rompía: la ruta de ajuste abría su propia transacción
  // por fuera de la cola y podía confirmar o deshacer una venta a medias.
  const stockAntesMezcla = stockDe(prod.id_producto);
  const ventas = Array.from({ length: 12 }, () =>
    post('/api/comanda', Object.assign({}, base, {
      observaciones: 'mezcla',
      total: prod.precio_venta,
      items: [item(prod.id_producto, 1)],
      metodos_pago: [{ id_metodo_pago: 1, monto: prod.precio_venta }]
    }))
  );
  const ajustes = Array.from({ length: 6 }, () =>
    post('/api/admin/stock/movimiento', {
      id_producto: prod.id_producto, tipo_movimiento: 'ENTRADA', cantidad: 5,
      motivo: 'mezcla', id_admin: 1, id_evento: 1
    })
  );
  const resultados = await Promise.all([...ventas, ...ajustes]);
  const ventasOk = resultados.slice(0, 12).filter(x => x.status === 200).length;
  const ajustesOk = resultados.slice(12).filter(x => x.status === 200).length;
  const errores500 = resultados.filter(x => x.status >= 500).length;

  check('Ninguna petición reventó al mezclar ventas y ajustes', errores500 === 0,
    ventasOk + ' ventas y ' + ajustesOk + ' ajustes aceptados');
  check('El stock cuadra exactamente: entradas menos ventas',
    stockDe(prod.id_producto) === stockAntesMezcla + ajustesOk * 5 - ventasOk,
    stockAntesMezcla + ' + ' + (ajustesOk * 5) + ' - ' + ventasOk + ' = ' +
    (stockAntesMezcla + ajustesOk * 5 - ventasOk) + ' · hay ' + stockDe(prod.id_producto));
  check('Todas las ventas de la mezcla quedaron completas',
    leer(`SELECT c.id_comanda FROM comanda c
          LEFT JOIN detalle_comanda d ON d.id_comanda = c.id_comanda
          WHERE c.observaciones = 'mezcla' AND d.id_detalle IS NULL`).length === 0);
  check('Todas las ventas de la mezcla tienen su pago',
    leer(`SELECT c.id_comanda FROM comanda c
          LEFT JOIN pago_comanda p ON p.id_comanda = c.id_comanda
          WHERE c.observaciones = 'mezcla' AND p.id_pago IS NULL`).length === 0);

  // =======================================================================
  console.log(C.tit('\n  Alta de productos'));
  // =======================================================================
  const cuantosAntes = leer('SELECT id_producto FROM producto').length;
  for (const [nombre, cuerpo] of [
    ['precio con letras', { nombre: 'Prueba', precio_venta: 'gratis', stock_actual: 5 }],
    ['precio negativo', { nombre: 'Prueba', precio_venta: -10, stock_actual: 5 }],
    ['precio cero', { nombre: 'Prueba', precio_venta: 0, stock_actual: 5 }],
    ['nombre vacío', { nombre: '   ', precio_venta: 10, stock_actual: 5 }],
    ['stock negativo', { nombre: 'Prueba', precio_venta: 10, stock_actual: -5 }],
    ['stock con letras', { nombre: 'Prueba', precio_venta: 10, stock_actual: 'muchos' }]
  ]) {
    r = await post('/api/admin/productos', Object.assign(
      { id_categoria: 1, descripcion: '', tipo_producto: 'COMIDA', id_admin: 1, id_evento: 1 }, cuerpo));
    check('Rechaza ' + nombre, r.status === 400, 'status ' + r.status + ' ' + ((r.json && r.json.message) || ''));
  }
  check('No se creó ningún producto inválido',
    leer('SELECT id_producto FROM producto').length === cuantosAntes);

  // =======================================================================
  console.log(C.tit('\n  Sesión y PIN de mesero'));
  // =======================================================================
  r = await post('/api/login', { usuario: 'cajero_norte_1', password: 'incorrecta' });
  check('Rechaza una contraseña equivocada', r.status === 401);

  r = await post('/api/login/mesero', { password: '0000', id_cajero: 1, id_barra: idBarra, id_evento: 1 });
  check('Rechaza un PIN que no existe', r.status === 401);

  r = await post('/api/login/mesero', { password: '1009', id_cajero: 1, id_barra: idBarra, id_evento: 1 });
  check('Acepta el PIN de un mesero de otra caja del mismo servidor',
    r.status === 200 && r.json.mesero.id_mesero === 9);

  r = await post('/api/admin/meseros', {
    id_cajero: 3, nombre: 'Duplicado', usuario: 'mesero_dup_test',
    password: '1001', id_admin: 1, id_evento: 1
  });
  check('Rechaza un PIN de mesero repetido', r.status === 400, (r.json && r.json.message) || '');

  // =======================================================================
  console.log(C.tit('\n  Registro de impresiones'));
  // =======================================================================
  const comandaViva = leer("SELECT id_comanda FROM comanda WHERE observaciones = 'mezcla' LIMIT 1")[0];
  if (comandaViva) {
    const p1 = await post('/api/impresion', { id_comanda: comandaViva.id_comanda, tipo: 'cajero' });
    const p2 = await post('/api/impresion', { id_comanda: comandaViva.id_comanda, tipo: 'cajero' });
    check('Cada reimpresión cuenta como una copia más',
      p2.json.numero_copia === p1.json.numero_copia + 1,
      'copia ' + p1.json.numero_copia + ' → ' + p2.json.numero_copia);
  }

  // =======================================================================
  console.log(C.tit('\n  Identidad de la barra'));
  // =======================================================================
  // El nombre de la barra sale del panel y de él depende el prefijo con el que
  // se numeran las comandas, así que el servidor tiene que saber decir cuál es.
  const ident = await get('/api/instancia');
  check('El servidor dice quién es', !!ident.nombre && !!ident.prefijo,
    ident.nombre + ' / ' + ident.prefijo);

  const guardada = leer("SELECT clave, valor FROM instancia");
  const comoMapa = Object.fromEntries(guardada.map(r => [r.clave, r.valor]));
  check('La identidad queda grabada dentro de la propia base',
    comoMapa.nombre === ident.nombre && comoMapa.prefijo === ident.prefijo,
    'la base se identifica sola aunque se copie a otro equipo');
  check('Queda registrado el primer arranque', !!comoMapa.primer_arranque, comoMapa.primer_arranque);

  const venta = await post('/api/comanda', Object.assign({}, base, {
    observaciones: 'con prefijo',
    total: prod.precio_venta,
    items: [item(prod.id_producto, 1)],
    metodos_pago: [{ id_metodo_pago: 1, monto: prod.precio_venta }]
  }));
  check('La venta devuelve la referencia con prefijo',
    venta.json.ref_comanda === ident.prefijo + '-' + venta.json.id_comanda,
    venta.json.ref_comanda);

  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Datos del evento (tabla configuracion)'));
  // =======================================================================
  // Encabezan los tickets y el cierre, así que no pueden quedar vacíos ni
  // duplicarse: es una sola fila que el encargado edita desde el panel.
  const columnasCfg = leer('PRAGMA table_info(configuracion)').map(c => c.name);
  check('La tabla configuracion tiene sus cinco campos',
    ['evento', 'fecha', 'lugar', 'barra', 'responsable'].every(c => columnasCfg.includes(c)),
    columnasCfg.join(', '));

  const cfgInicial = await get('/api/configuracion');
  check('Nace con su fila, no vacía del todo', !!cfgInicial.evento, cfgInicial.evento);
  // La barra es la excepción a propósito: se deja en blanco para que nadie
  // acabe imprimiendo tickets con un nombre sembrado que no eligió. El panel
  // no deja guardar sin ella, y eso se comprueba unas líneas más abajo.
  check('La barra empieza sin nombre, esperando al panel',
    typeof cfgInicial.barra === 'string', JSON.stringify(cfgInicial.barra));

  const guardarCfg = cuerpo => fetch(URL + '/api/admin/configuracion-evento', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo)
  });

  let rc = await guardarCfg({ evento: '', barra: 'X' });
  check('Rechaza guardar sin nombre de evento', rc.status === 400);
  rc = await guardarCfg({ evento: 'X', barra: '' });
  check('Rechaza guardar sin nombre de barra', rc.status === 400);
  rc = await guardarCfg({ evento: 'X', barra: 'Y', fecha: '12 de agosto' });
  check('Rechaza una fecha con formato inválido', rc.status === 400);

  rc = await guardarCfg({
    evento: 'Prueba de configuración', fecha: '2026-09-12', lugar: 'Estadio',
    barra: 'Barra de prueba', responsable: 'Responsable Ñ'
  });
  check('Guarda los cinco campos', rc.status === 200);
  const cfgGuardada = await get('/api/configuracion');
  check('Y los devuelve tal cual',
    cfgGuardada.evento === 'Prueba de configuración' && cfgGuardada.responsable === 'Responsable Ñ');
  check('Sigue habiendo una sola fila',
    leer('SELECT id_configuracion FROM configuracion').length === 1);

  const repCfg = await get('/api/admin/reporte');
  check('El reporte usa estos datos y no los de ejemplo',
    repCfg.evento.nombre_evento === 'Prueba de configuración' &&
    repCfg.evento.responsable === 'Responsable Ñ');

  // El nombre de la barra ES la identidad en el montaje de un solo servidor:
  // al cambiarlo desde el panel tienen que cambiar con él el prefijo de las
  // comandas y lo que se ve en la caja, sin reiniciar nada.
  const identidadTrasGuardar = await get('/api/instancia');
  check('Cambiar la barra en el panel cambia la identidad al vuelo',
    identidadTrasGuardar.nombre === 'Barra de prueba',
    identidadTrasGuardar.nombre + ' -> ' + identidadTrasGuardar.prefijo);
  check('El prefijo sale de la inicial, ignorando el "Barra " de delante',
    identidadTrasGuardar.prefijo === 'D', 'Barra de prueba -> ' + identidadTrasGuardar.prefijo);

  const ventaConPrefijo = await post('/api/comanda', Object.assign({}, base, {
    observaciones: 'prefijo nuevo',
    clave_idempotencia: 'prefijo-' + Date.now(),
    total: prod.precio_venta,
    items: [item(prod.id_producto, 1)],
    metodos_pago: [{ id_metodo_pago: 1, monto: prod.precio_venta }]
  }));
  check('Las comandas nuevas salen con el prefijo nuevo',
    String(ventaConPrefijo.json.ref_comanda).startsWith(identidadTrasGuardar.prefijo + '-'),
    ventaConPrefijo.json.ref_comanda);

  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Una sola barra'));
  // =======================================================================
  // Antes se sembraban tres barras y el personal de cada una. Ahora la base
  // nace con una sola y todo el personal cuelga de ella; lo que hay que
  // comprobar es que no quede nadie apuntando a una barra que no existe.
  const barrasEnBase = leer('SELECT nombre_barra FROM barra').map(b => b.nombre_barra);
  const cajerosEnBase = leer('SELECT usuario FROM cajero').map(c => c.usuario);

  // Con un servidor por evento la base queda unificada en UNA barra y todo el
  // personal cuelga de ella. Mirar el nombre de usuario ya no sirve de nada:
  // "cajero_sur_1" es un nombre histórico, no dice de qué barra es. Lo que hay
  // que comprobar es que no quede nadie apuntando a una barra borrada, que es
  // lo que sí rompería el cierre de caja.
  check('La base quedó con una sola barra', barrasEnBase.length === 1, barrasEnBase.join(', '));
  check('Todos los cajeros están en esa barra',
    leer(`SELECT c.id_cajero FROM cajero c
          LEFT JOIN barra b ON b.id_barra = c.id_barra
          WHERE b.id_barra IS NULL`).length === 0,
    cajerosEnBase.length + ' cajeros');
  check('Ninguna comanda cuelga de una barra que ya no existe',
    leer(`SELECT k.id_comanda FROM comanda k
          LEFT JOIN barra b ON b.id_barra = k.id_barra
          WHERE b.id_barra IS NULL`).length === 0);
  check('Ninguna venta se perdió al unificar',
    leer('SELECT COUNT(*) AS n FROM comanda')[0].n > 0);
  check('Ningún mesero cuelga de un cajero que no está',
    leer(`SELECT m.id_mesero FROM mesero m
          LEFT JOIN cajero c ON c.id_cajero = m.id_cajero
          WHERE c.id_cajero IS NULL`).length === 0);
  check('El administrador existe siempre, sea cual sea la barra',
    leer("SELECT id_admin FROM administrador_evento WHERE usuario = 'admin_evento'").length === 1);

  // Y ahora una base recién creada: es el caso real de la tablet del evento,
  // que arranca con su .db vacío y tiene que nacer ya con UNA sola barra.
  {
    const BASE_NUEVA = path.join(RAIZ, 'pos_evento.semilla.db');
    ['', '-wal', '-shm'].forEach(x => { if (fs.existsSync(BASE_NUEVA + x)) fs.unlinkSync(BASE_NUEVA + x); });

    const puertoSemilla = PUERTO + 7;
    const cria = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
      cwd: RAIZ,
      env: Object.assign({}, process.env, {
        PORT: String(puertoSemilla), DB_FILE: BASE_NUEVA
      }),
      stdio: 'ignore'
    });
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch('http://127.0.0.1:' + puertoSemilla + '/api/productos')).ok) break; }
      catch (e) { /* aún no */ }
      await esperar(250);
    }

    const nueva = new DatabaseSync(BASE_NUEVA);
    const barras = nueva.prepare('SELECT nombre_barra FROM barra').all().map(b => b.nombre_barra);
    const cajeros = nueva.prepare('SELECT usuario FROM cajero').all().map(c => c.usuario);
    const meseros = nueva.prepare('SELECT COUNT(*) n FROM mesero').get().n;
    const admins = nueva.prepare('SELECT COUNT(*) n FROM administrador_evento').get().n;
    nueva.close();
    cria.kill('SIGKILL');
    await esperar(400);
    ['', '-wal', '-shm'].forEach(x => { try { fs.unlinkSync(BASE_NUEVA + x); } catch (e) {} });

    check('Una base nueva nace con UNA sola barra',
      barras.length === 1, barras.join(', '));
    check('Y se llama "Barra 1", el nombre de partida',
      barras[0] === 'Barra 1', barras[0]);
    check('Su personal de muestra entra entero', cajeros.length === 9 && meseros === 45,
      cajeros.length + ' cajeros y ' + meseros + ' meseros');
    check('Y el administrador, que siempre hace falta', admins > 0);
  }


  // =======================================================================
  console.log(C.tit('\n  Reporte de cierre'));
  // =======================================================================
  const rep = await get('/api/admin/reporte');
  const sumaMetodos = rep.porMetodo.reduce((s, m) => s + Number(m.importe), 0);
  check('Lo cobrado por forma de pago cuadra con lo recaudado',
    Math.abs(sumaMetodos - rep.resumen.recaudado) < 0.01,
    sumaMetodos.toFixed(2) + ' vs ' + rep.resumen.recaudado.toFixed(2));

  const sumaBarras = rep.porBarra.reduce((s, b) => s + Number(b.importe), 0);
  check('Lo vendido por barra cuadra con lo recaudado',
    Math.abs(sumaBarras - rep.resumen.recaudado) < 0.01);
  const sumaCajeros = rep.porCajero.reduce((s, c) => s + Number(c.importe), 0);
  check('Lo vendido por cajero cuadra con lo recaudado',
    Math.abs(sumaCajeros - rep.resumen.recaudado) < 0.01);
  const sumaProductos = rep.productos.reduce((s, p) => s + Number(p.importe), 0);
  check('Lo vendido por producto cuadra con lo recaudado',
    Math.abs(sumaProductos - rep.resumen.recaudado) < 0.01);

  // Lo anulado no puede contarse como recaudado: es el error más caro posible
  // en un cierre de caja.
  const anuladoEnBase = leer("SELECT COALESCE(SUM(total),0) t FROM comanda WHERE estado_pago = 'ANULADO'")[0].t;
  check('Las comandas anuladas quedan fuera de la recaudación',
    rep.resumen.anuladas === rep.anuladas.length &&
    Math.abs(rep.resumen.importe_anulado - anuladoEnBase) < 0.01,
    rep.resumen.anuladas + ' anuladas por ' + Number(anuladoEnBase).toFixed(2) + ' Bs.');

  const recaudadoEnBase = leer("SELECT COALESCE(SUM(total),0) t FROM comanda WHERE estado_pago != 'ANULADO'")[0].t;
  check('Lo recaudado coincide con la suma directa en la base',
    Math.abs(rep.resumen.recaudado - recaudadoEnBase) < 0.01);

  const repVacio = await get('/api/admin/reporte?desde=1999-01-01&hasta=1999-01-02');
  check('Un rango sin ventas devuelve ceros, no un error',
    repVacio.resumen.recaudado === 0 && repVacio.resumen.validas === 0 &&
    repVacio.porMetodo.length === 0);

  const repRaro = await get('/api/admin/reporte?desde=no-es-fecha&hasta=;DROP TABLE comanda;--');
  check('Una fecha inválida se ignora en vez de romper o inyectar',
    repRaro.rango.todo === true && leer('SELECT id_comanda FROM comanda LIMIT 1').length > 0);

  // ---- El PDF ----
  const resPdf = await fetch(URL + '/api/admin/reporte.pdf');
  const pdf = Buffer.from(await resPdf.arrayBuffer());
  const texto = pdf.toString('latin1');
  check('El PDF se sirve como application/pdf',
    resPdf.headers.get('content-type') === 'application/pdf');
  // El nombre lleva la barra: si llegan varios cierres al mismo chat de
  // WhatsApp y se llaman igual, el segundo pisa al primero.
  //
  // Se relee la identidad aquí y no se usa la del principio: el nombre de la
  // barra pudo cambiarse desde el panel en las comprobaciones anteriores, y el
  // archivo lleva siempre el actual.
  const identAhora = await get('/api/instancia');
  const barraEnNombre = identAhora.nombre.normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  check('Se descarga como archivo con la barra en el nombre',
    new RegExp('attachment; filename="Cierre_' + barraEnNombre + '_.*\.pdf"')
      .test(resPdf.headers.get('content-disposition') || ''),
    resPdf.headers.get('content-disposition'));
  check('El PDF dice a qué barra corresponde',
    texto.includes('Cierre de caja') && texto.includes(identAhora.nombre));
  check('Es un PDF bien formado', texto.startsWith('%PDF-') && texto.trimEnd().endsWith('%%EOF'),
    (pdf.length / 1024).toFixed(1) + ' KB');

  // La tabla xref es lo que usa el lector para encontrar cada objeto: si un
  // desplazamiento no cae donde debe, el archivo no abre.
  const inicioXref = Number((texto.match(/startxref\s+(\d+)/) || [])[1]);
  const offsets = [...texto.slice(inicioXref).matchAll(/^(\d{10}) 00000 n $/gm)].map(x => Number(x[1]));
  const rotos = offsets.filter((off, i) => texto.slice(off, off + String(i + 1).length + 6) !== (i + 1) + ' 0 obj').length;
  check('Todos los desplazamientos del xref apuntan a su objeto', offsets.length > 0 && rotos === 0,
    offsets.length + ' objetos');

  const declaradas = Number((texto.match(/\/Count (\d+)/) || [])[1]);
  const reales = (texto.match(/\/Type \/Page[^s]/g) || []).length;
  check('Las páginas declaradas son las que hay', declaradas === reales, declaradas + ' páginas');

  let flujosOk = true;
  const reFlujo = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g;
  let f;
  while ((f = reFlujo.exec(texto))) {
    if (Buffer.byteLength(f[2], 'latin1') !== Number(f[1])) flujosOk = false;
  }
  check('La longitud declarada de cada flujo es la real', flujosOk);

  // Nada de texto fuera del papel: es el fallo típico al maquetar a mano.
  const fuera = [...texto.matchAll(/Tm \((?:.*?)\) Tj/g)].length === 0 ? [] :
    [...texto.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)]
      .filter(m => { const x = +m[1], y = +m[2]; return x < 0 || x > 595 || y < 0 || y > 842; });
  check('Ningún texto cae fuera de la página', fuera.length === 0, fuera.length + ' fuera');

  check('Los acentos salen en WinAnsi, no como interrogaciones',
    pdf.includes(0xf3) || pdf.includes(0xe9) || pdf.includes(0xed), 'ó=0xF3 · é=0xE9 · í=0xED');
  check('El PDF nombra el evento y las secciones del cierre',
    texto.includes('MASTERDRINKS') && texto.includes('COBROS POR FORMA DE PAGO') &&
    texto.includes('EXISTENCIAS AL CIERRE'));

  // =======================================================================
  console.log(C.tit('\n  Estado final de la base'));
  // =======================================================================
  const db = new DatabaseSync(BASE);
  check('La base pasa la comprobación de integridad',
    db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');
  check('No quedó ninguna transacción abierta',
    db.prepare('PRAGMA foreign_key_check').all().length === 0, 'sin claves foráneas rotas');
  db.close();
  check('Ningún total de comanda es no numérico',
    leer('SELECT id_comanda FROM comanda WHERE total IS NULL OR total != total').length === 0);
  check('Ningún stock quedó negativo',
    leer('SELECT id_producto FROM producto WHERE stock_actual < 0').length === 0);

  // Cada unidad que sale tiene que dejar rastro. Sin esto una venta puede bajar
  // el stock sin aparecer en el reporte, y al contar cajas por la noche falta
  // mercancía que nadie sabe explicar.
  check('Ninguna línea vendida se quedó sin su movimiento de stock',
    leer(`SELECT d.id_detalle FROM detalle_comanda d
          WHERE NOT EXISTS (SELECT 1 FROM movimiento_stock m
                             WHERE m.id_producto = d.id_producto
                               AND m.motivo = 'Venta comanda #' || d.id_comanda)`).length === 0);

  // El stock de cada producto tiene que ser el que dejó su último movimiento.
  // Se compara así y no sumando entradas menos salidas porque un AJUSTE fija el
  // total en vez de sumarlo.
  check('Cada producto cuadra con su último movimiento de stock',
    leer(`SELECT p.id_producto FROM producto p
          WHERE p.stock_actual <> COALESCE(
            (SELECT m.stock_nuevo FROM movimiento_stock m
              WHERE m.id_producto = p.id_producto
              ORDER BY m.id_movimiento DESC LIMIT 1), 0)`).length === 0);

  check('Ningún pago quedó sin su comanda',
    leer(`SELECT p.id_pago FROM pago_comanda p
          LEFT JOIN comanda c ON c.id_comanda = p.id_comanda
          WHERE c.id_comanda IS NULL`).length === 0);

  console.log('');
  console.log(fallos === 0
    ? '  ' + C.ok('Todo correcto: ninguna entrada inválida pasó ni dejó rastro.') + '\n'
    : '  ' + C.mal(fallos + ' comprobación(es) fallidas.') + '\n');

  hijo.kill('SIGTERM');
  await esperar(600);
  hijo.kill('SIGKILL');
  await esperar(400);
  // Windows no suelta el archivo en el mismo instante en que muere el
  // proceso, así que se espera un momento antes de borrar; si no, el
  // unlink falla en silencio y la base se queda en la carpeta igual.
  // Se borra la base de la prueba al acabar. Antes se quedaba en la carpeta
  // del proyecto junto a su -wal y su -shm, y acababan conviviendo cuatro
  // juegos de archivos que parecían bases de verdad.
  ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(BASE + s); } catch (e) {} });
  process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(C.mal('Error: '), e); process.exit(1); });
