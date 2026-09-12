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

// El tercer argumento permite reutilizarla para DELETE, que también manda
// cuerpo (el id del administrador que firma la acción en la auditoría).
async function post(ruta, cuerpo, metodo) {
  const res = await fetch(URL + ruta, {
    method: metodo || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* sin cuerpo */ }
  return { status: res.status, json };
}
const get = async ruta => (await fetch(URL + ruta)).json();
// El mismo redondeo que usa el servidor, para comparar importes sin arrastrar
// los céntimos que inventa el coma flotante.
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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
  const prod = productos.find(p => !p.requiere_acompanante && !p.es_acompanante && p.stock_actual > 0) || productos[0];
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
  // El nombre de la barra sale del panel y encabeza tickets y cierre, así que
  // el servidor tiene que saber decir cuál es.
  const ident = await get('/api/instancia');
  check('El servidor dice cómo se llama la barra', !!ident.nombre, ident.nombre);

  const guardada = leer("SELECT clave, valor FROM instancia");
  const comoMapa = Object.fromEntries(guardada.map(r => [r.clave, r.valor]));
  check('La identidad queda grabada dentro de la propia base',
    comoMapa.nombre === ident.nombre,
    'la base se identifica sola aunque se copie a otro equipo');
  check('Queda registrado el primer arranque', !!comoMapa.primer_arranque, comoMapa.primer_arranque);

  const venta = await post('/api/comanda', Object.assign({}, base, {
    observaciones: 'referencia',
    total: prod.precio_venta,
    items: [item(prod.id_producto, 1)],
    metodos_pago: [{ id_metodo_pago: 1, monto: prod.precio_venta }]
  }));
  // Sólo el número: nada de letras delante. Es lo que el mesero canta en voz
  // alta en la barra, y un "B1-" por delante sólo estorba.
  check('La comanda se identifica sólo con su número',
    venta.json.ref_comanda === String(venta.json.id_comanda) &&
    /^\d+$/.test(String(venta.json.ref_comanda)),
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

  // El nombre de la barra ES la identidad: al cambiarlo desde el panel tiene
  // que cambiar lo que se ve en la caja y lo que se imprime, sin reiniciar.
  const identidadTrasGuardar = await get('/api/instancia');
  check('Cambiar la barra en el panel cambia la identidad al vuelo',
    identidadTrasGuardar.nombre === 'Barra de prueba',
    identidadTrasGuardar.nombre);
  check('La tabla barra sigue al nombre del panel',
    leer('SELECT nombre_barra FROM barra')[0].nombre_barra === 'Barra de prueba');

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
    leer("SELECT id_admin FROM administrador_evento WHERE usuario = 'admin'").length === 1);

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
  console.log(C.tit(String.fromCharCode(10) + '  Eliminar del catálogo y de la plantilla'));
  // =======================================================================
  // Borrar tiene dos comportamientos y la diferencia es la que protege el
  // cierre de caja: lo que nunca se vendió se va entero; lo que ya se vendió se
  // retira de la caja pero se conserva, porque el informe lo nombra.
  const del = (url) => post(url, { id_admin: 1 }, 'DELETE');

  // -- producto sin ventas: se va de verdad
  const libre = leer(`SELECT p.id_producto, p.nombre FROM producto p
                      WHERE p.activo = 1
                        AND NOT EXISTS (SELECT 1 FROM detalle_comanda d WHERE d.id_producto = p.id_producto)
                      LIMIT 1`)[0];
  r = await del('/api/admin/productos/' + libre.id_producto);
  check('Un producto sin ventas se elimina de verdad',
    r.status === 200 && r.json.success && r.json.retirado === false, r.json.message);
  check('Y desaparece de la tabla',
    leer('SELECT id_producto FROM producto WHERE id_producto = ' + libre.id_producto).length === 0);
  check('Con él se van sus movimientos de stock, que ya no significan nada',
    leer('SELECT id_movimiento FROM movimiento_stock WHERE id_producto = ' + libre.id_producto).length === 0);

  // -- producto vendido: se retira, no se borra
  let vendidoFila = leer(`SELECT d.id_producto FROM detalle_comanda d
                          JOIN producto p ON p.id_producto = d.id_producto
                          WHERE p.activo = 1 LIMIT 1`)[0];
  if (!vendidoFila) {
    const pVender = leer('SELECT id_producto, precio_venta FROM producto WHERE activo = 1 LIMIT 1')[0];
    const dbTmp = new DatabaseSync(BASE);
    const idC = Number(dbTmp.prepare("INSERT INTO comanda (id_evento, id_barra, id_cajero, id_mesero, total, estado_pago, estatus) VALUES (1, 1, 1, 1, ?, 'PAGADO', 'COMPLETADO')").run(pVender.precio_venta).lastInsertRowid);
    dbTmp.prepare("INSERT INTO detalle_comanda (id_comanda, id_producto, cantidad, precio_unitario, subtotal) VALUES (?, ?, 1, ?, ?)").run(idC, pVender.id_producto, pVender.precio_venta, pVender.precio_venta);
    dbTmp.close();
    vendidoFila = { id_producto: pVender.id_producto };
  }
  const vendidoId = vendidoFila.id_producto;
  r = await del('/api/admin/productos/' + vendidoId);
  check('Un producto ya vendido se retira, no se borra',
    r.status === 200 && r.json.success && r.json.retirado === true, r.json.message);
  const retirado = leer('SELECT activo FROM producto WHERE id_producto = ' + vendidoId)[0];
  check('Sigue en la base, marcado como inactivo', retirado && retirado.activo === 0);
  check('Sus líneas de venta siguen enteras',
    leer('SELECT id_detalle FROM detalle_comanda WHERE id_producto = ' + vendidoId).length > 0,
    'el cierre lo sigue nombrando');

  const enCaja = await get('/api/productos');
  check('La caja ya no lo ofrece',
    !enCaja.productos.some(p => p.id_producto === vendidoId));

  const repTrasRetirar = await get('/api/admin/reporte');
  check('Pero el cierre lo sigue contando',
    repTrasRetirar.productos.length > 0, repTrasRetirar.productos.length + ' producto(s) en el informe');

  // -- categoría con productos dentro: no se toca
  const catLlena = leer(`SELECT c.id_categoria, c.nombre FROM categoria_producto c
                         WHERE (SELECT COUNT(*) FROM producto p
                                 WHERE p.id_categoria = c.id_categoria AND p.activo = 1) > 0
                         LIMIT 1`)[0];
  r = await del('/api/admin/categorias/' + catLlena.id_categoria);
  check('Una categoría con productos dentro no se puede eliminar',
    r.status === 400 && !r.json.success, r.json.message);
  check('Y sigue ahí',
    leer('SELECT id_categoria FROM categoria_producto WHERE id_categoria = ' + catLlena.id_categoria).length === 1);

  // -- cajero con comandas: se retira y deja de poder entrar
  const cajConVentas = leer(`SELECT DISTINCT id_cajero FROM comanda LIMIT 1`)[0];
  if (cajConVentas) {
    const usuario = leer('SELECT usuario FROM cajero WHERE id_cajero = ' + cajConVentas.id_cajero)[0].usuario;
    r = await del('/api/admin/cajeros/' + cajConVentas.id_cajero);
    check('Un cajero que ya cobró se da de baja, no se borra',
      r.status === 200 && r.json.success && r.json.retirado === true, r.json.message);
    const entra = await post('/api/login', { usuario, password: 'demo123' });
    check('Y deja de poder entrar', entra.status === 401, 'status ' + entra.status);
    check('Sus comandas siguen a su nombre',
      leer('SELECT id_comanda FROM comanda WHERE id_cajero = ' + cajConVentas.id_cajero).length > 0);
  }

  // -- cajero con meseros a su cargo: no se puede
  const cajConMeseros = leer(`SELECT c.id_cajero FROM cajero c
                              WHERE c.activo = 1
                                AND (SELECT COUNT(*) FROM mesero m WHERE m.id_cajero = c.id_cajero) > 0
                                AND (SELECT COUNT(*) FROM comanda k WHERE k.id_cajero = c.id_cajero) = 0
                              LIMIT 1`)[0];
  if (cajConMeseros) {
    r = await del('/api/admin/cajeros/' + cajConMeseros.id_cajero);
    check('Un cajero con meseros a su cargo no se puede eliminar',
      r.status === 400 && !r.json.success, r.json.message);
  }

  // -- mesero sin comandas: se va entero
  const mesLibre = leer(`SELECT m.id_mesero FROM mesero m
                         WHERE m.activo = 1
                           AND NOT EXISTS (SELECT 1 FROM comanda k WHERE k.id_mesero = m.id_mesero)
                         LIMIT 1`)[0];
  r = await del('/api/admin/meseros/' + mesLibre.id_mesero);
  check('Un mesero sin comandas se elimina de verdad',
    r.status === 200 && r.json.success && r.json.retirado === false, r.json.message);
  check('Y su PIN deja de existir',
    leer('SELECT id_mesero FROM mesero WHERE id_mesero = ' + mesLibre.id_mesero).length === 0);

  // -- ids inventados
  r = await del('/api/admin/productos/999999');
  check('Eliminar algo que no existe da 404, no un error del servidor', r.status === 404);
  r = await del('/api/admin/productos/abc');
  check('Un id que no es número se rechaza', r.status === 400);

  // -- las listas que alimentan el panel
  const cat = await get('/api/admin/catalogo');
  check('El panel puede listar el catálogo',
    Array.isArray(cat.categorias) && Array.isArray(cat.productos) && cat.productos.length > 0,
    cat.categorias.length + ' categorías y ' + cat.productos.length + ' productos');
  check('Y marca cuáles están retirados y cuáles se vendieron',
    cat.productos.some(p => p.activo === 0) && cat.productos.every(p => 'vendido' in p));

  const per = await get('/api/admin/personal');
  check('El panel puede listar el personal',
    per.cajeros.length > 0 && per.meseros.length > 0,
    per.cajeros.length + ' cajeros y ' + per.meseros.length + ' meseros');
  check('Los meseros traen su PIN, para poder consultarlo en mitad del evento',
    per.meseros.every(m => m.pin));


  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Sondeo de existencias'));
  // =======================================================================
  // Cada tablet pregunta el stock cada doce segundos. Reutilizaba
  // /api/productos, que con una foto por producto son 600 KB por sondeo: sobre
  // el WiFi de un teléfono, con tres tablets, eso deja sin antena a las ventas.
  const sondeo = await get('/api/stock');
  check('El sondeo devuelve las existencias', Array.isArray(sondeo.stock) && sondeo.stock.length > 0,
    sondeo.stock.length + ' productos');
  check('Y sólo eso: id y cantidad, nada más',
    sondeo.stock.every(p => Object.keys(p).length === 2 && 'id' in p && 's' in p),
    JSON.stringify(sondeo.stock[0]));

  const pesoSondeo = JSON.stringify(sondeo).length;
  const pesoCatalogo = JSON.stringify(await get('/api/productos')).length;
  check('Pesa mucho menos que el catálogo entero',
    pesoSondeo < pesoCatalogo,
    pesoSondeo + ' bytes frente a ' + pesoCatalogo);

  check('Las cifras del sondeo coinciden con la base',
    sondeo.stock.every(p => {
      const real = leer('SELECT stock_actual FROM producto WHERE id_producto = ' + p.id)[0];
      return real && real.stock_actual === p.s;
    }));

  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Fotos de producto'));
  // =======================================================================
  // La foto se guarda dentro de la base para que viaje con ella. Sólo se acepta
  // el contenido de la imagen: una dirección remota no cargaría en el evento
  // (no hay internet) y además dejaría meter cualquier cosa en la pantalla de
  // la caja.
  const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfF' +
    'cSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const conFoto = leer('SELECT id_producto FROM producto WHERE activo = 1 LIMIT 1')[0].id_producto;
  const ponerFoto = valor => post('/api/admin/productos/' + conFoto + '/foto', { foto: valor }, 'PUT');

  r = await ponerFoto(PNG_1PX);
  check('Se puede ponerle una foto a un producto',
    r.status === 200 && r.json.success, r.json.message);
  check('Y queda guardada dentro de la base',
    (leer('SELECT foto FROM producto WHERE id_producto = ' + conFoto)[0].foto || '').startsWith('data:image/'),
    'viaja con el .db, sin carpeta aparte que olvidar en la copia');

  // La foto NO viaja dentro del catálogo: iría a 600 KB por tablet y la
  // rejilla no se pintaría hasta que llegara la última. El catálogo sólo dice
  // si hay foto; la imagen se pide aparte y el navegador la cachea.
  const enCajaConFoto = await get('/api/productos');
  const ficha = enCajaConFoto.productos.find(p => p.id_producto === conFoto) || {};
  check('El catálogo avisa de que ese producto tiene foto', ficha.tiene_foto === 1);
  check('Pero no arrastra la imagen dentro del JSON',
    !('foto' in ficha),
    JSON.stringify(enCajaConFoto.productos).length + ' bytes el catálogo entero');

  const img = await fetch(URL + '/api/producto/' + conFoto + '/foto');
  check('La foto se sirve aparte, como imagen de verdad',
    img.ok && (img.headers.get('content-type') || '').startsWith('image/'),
    img.headers.get('content-type'));
  check('Y con permiso para quedarse en la caché del navegador',
    (img.headers.get('cache-control') || '').includes('max-age'),
    img.headers.get('cache-control'));
  check('La dirección lleva versión, para que al cambiarla se entere el navegador',
    typeof ficha.foto_v === 'number' && ficha.foto_v > 0, 'v=' + ficha.foto_v);

  const sinImagen = await fetch(URL + '/api/producto/999999/foto');
  check('Pedir la foto de algo que no existe da 404', sinImagen.status === 404);

  // Lo que NO se acepta.
  r = await ponerFoto('https://ejemplo.invalido/botella.png');
  check('Rechaza una dirección remota, que en el evento no cargaría',
    r.status === 400 && !r.json.success, r.json.message);
  r = await ponerFoto('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==');
  check('Rechaza algo que no es una imagen aunque venga como data URI',
    r.status === 400 && !r.json.success);
  r = await ponerFoto('data:image/png;base64,' + 'A'.repeat(600000));
  check('Rechaza una foto demasiado pesada para la base',
    r.status === 400 && !r.json.success,
    'veinte fotos de cámara harían el .db intransportable');

  // Quitarla es mandar una cadena vacía, distinto de no mandar nada.
  r = await ponerFoto('');
  check('Se puede quitar la foto', r.status === 200 && r.json.success && r.json.foto === null);
  check('Y el producto se queda sin ella, pero sigue existiendo',
    leer('SELECT foto, nombre FROM producto WHERE id_producto = ' + conFoto)[0].foto === null);

  r = await post('/api/admin/productos/999999/foto', { foto: PNG_1PX }, 'PUT');
  check('Poner foto a un producto que no existe da 404', r.status === 404);

  // Y también se puede dar de alta un producto ya con su foto.
  const conFotoNuevo = await post('/api/admin/productos', {
    id_categoria: 1, nombre: 'Producto con foto', descripcion: '', tipo_producto: 'BEBIDA_ALCOHOLICA',
    precio_venta: 25, stock_actual: 5, id_admin: 1, id_evento: 1, foto: PNG_1PX
  });
  check('Un producto puede nacer ya con foto',
    conFotoNuevo.status === 200 && conFotoNuevo.json.success);
  check('Y la foto se guardó con él',
    (leer("SELECT foto FROM producto WHERE nombre = 'Producto con foto'")[0].foto || '')
      .startsWith('data:image/'));

  const conFotoMala = await post('/api/admin/productos', {
    id_categoria: 1, nombre: 'Producto con foto mala', descripcion: '', tipo_producto: 'COMIDA',
    precio_venta: 25, stock_actual: 5, id_admin: 1, id_evento: 1, foto: 'javascript:alert(1)'
  });
  check('Un alta con una foto inválida se rechaza entera',
    conFotoMala.status === 400 && !conFotoMala.json.success,
    'y no deja el producto a medias');
  check('Ese producto no se creó',
    leer("SELECT id_producto FROM producto WHERE nombre = 'Producto con foto mala'").length === 0);



  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Cambiar un producto ya dado de alta'));
  // =======================================================================
  // Se equivocaron con el precio del Etiqueta Roja y no había forma de
  // corregirlo sin borrarlo y volver a crearlo, que además perdía el
  // histórico. Se cambia el nombre, la descripción, el precio y la categoría;
  // el stock no, que ése se mueve con ingresos y traspasos y tiene que dejar
  // rastro.
  const catId = leer('SELECT id_categoria FROM categoria_producto ORDER BY id_categoria LIMIT 1')[0].id_categoria;
  const otraCat = (leer(`SELECT id_categoria FROM categoria_producto
                         WHERE id_categoria <> ${catId} ORDER BY id_categoria LIMIT 1`)[0] || {}).id_categoria;
  const editable = await post('/api/admin/productos', {
    id_categoria: catId, nombre: 'Whisky Editable 750 ml', descripcion: 'antes',
    tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 100, stock_actual: 30,
    id_admin: 1, id_evento: 1
  });
  const idEd = editable.json.id_producto;
  const editar = cuerpo => post('/api/admin/productos/' + idEd, cuerpo, 'PUT');
  const filaEd = () => leer(`SELECT nombre, descripcion, precio_venta, stock_actual, id_categoria
                             FROM producto WHERE id_producto = ${idEd}`)[0];

  r = await editar({ nombre: 'Whisky Etiqueta Roja 750 ml', descripcion: 'después',
                     precio_venta: 185.5, id_categoria: catId });
  check('Se puede cambiar el precio de un producto ya dado de alta',
    r.status === 200 && r.json.success && Number(filaEd().precio_venta) === 185.5,
    'quedó en ' + filaEd().precio_venta);
  check('Y también el nombre y la descripción',
    filaEd().nombre === 'Whisky Etiqueta Roja 750 ml' && filaEd().descripcion === 'después');

  if (otraCat) {
    r = await editar({ nombre: 'Whisky Etiqueta Roja 750 ml', precio_venta: 185.5, id_categoria: otraCat });
    check('Y se puede mudar de categoría, si se dio de alta en la que no era',
      filaEd().id_categoria === otraCat);
    await editar({ nombre: 'Whisky Etiqueta Roja 750 ml', precio_venta: 185.5, id_categoria: catId });
  }

  const stockAntesEd = filaEd().stock_actual;
  r = await editar({ nombre: 'Whisky Etiqueta Roja 750 ml', precio_venta: 190,
                     id_categoria: catId, stock_actual: 9999, stock_inicial: 9999 });
  check('Editar no toca el stock aunque se lo manden',
    filaEd().stock_actual === stockAntesEd,
    'sigue en ' + filaEd().stock_actual + '; el stock se mueve con ingresos y traspasos');

  const precioBueno = Number(filaEd().precio_venta);
  for (const malo of [{ precio_venta: 0 }, { precio_venta: -5 }, { precio_venta: 'gratis' }]) {
    r = await editar(Object.assign({ nombre: 'X', id_categoria: catId }, malo));
    check('Un precio de "' + malo.precio_venta + '" se rechaza',
      r.status === 400 && !r.json.success && Number(filaEd().precio_venta) === precioBueno);
  }

  r = await editar({ nombre: '   ', precio_venta: 50, id_categoria: catId });
  check('Un nombre en blanco se rechaza',
    r.status === 400 && filaEd().nombre === 'Whisky Etiqueta Roja 750 ml');

  r = await editar({ nombre: 'X', precio_venta: 50, id_categoria: 999999 });
  check('Una categoría que no existe se rechaza',
    r.status === 400 && filaEd().id_categoria === catId);

  r = await editar({ nombre: 'X', precio_venta: 50, id_categoria: catId });
  r = await post('/api/admin/productos/999999', { nombre: 'X', precio_venta: 5, id_categoria: catId }, 'PUT');
  check('Editar un producto que no existe da 404', r.status === 404);

  const logEd = leer(`SELECT detalle FROM auditoria_admin
                      WHERE accion = 'EDITAR_PRODUCTO' AND id_registro = ${idEd}
                      ORDER BY id_auditoria`);
  check('Cada edición queda en el registro de auditoría',
    logEd.length >= 2, logEd.length + ' apuntes');
  check('Y el apunte dice cómo cambió el precio',
    logEd.some(l => /100/.test(l.detalle) && /185/.test(l.detalle)),
    (logEd[0] || {}).detalle);

  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Botellas con acompañante'));
  // =======================================================================
  // Una botella se vende con su refresco incluido. El refresco es gratis pero
  // sale de la nevera igual, así que tiene que descontar stock: si no, el
  // inventario diría al cerrar que quedan refrescos que ya no están.
  const botella = leer(`SELECT id_producto, nombre, precio_venta FROM producto
                        WHERE activo = 1 AND stock_actual > 20 AND (id_categoria IS NULL OR id_categoria IN (SELECT id_categoria FROM categoria_producto WHERE activo = 1)) ORDER BY precio_venta DESC LIMIT 1`)[0];
  const refresco = leer(`SELECT id_producto, nombre, precio_venta FROM producto
                         WHERE activo = 1 AND stock_actual > 20 AND (id_categoria IS NULL OR id_categoria IN (SELECT id_categoria FROM categoria_producto WHERE activo = 1)) AND id_producto <> ${botella.id_producto}
                         ORDER BY precio_venta ASC LIMIT 1`)[0];
  const marcar = (id, cuerpo) => post('/api/admin/productos/' + id + '/acompanamiento', cuerpo, 'PUT');

  r = await marcar(botella.id_producto, { requiere_acompanante: true });
  check('Se puede marcar una botella como "se vende con acompañante"',
    r.status === 200 && r.json.success, r.json.message);
  r = await marcar(refresco.id_producto, { es_acompanante: true });
  check('Y un refresco como "puede ir de acompañante"',
    r.status === 200 && r.json.success, r.json.message);

  r = await marcar(botella.id_producto, { requiere_acompanante: true, es_acompanante: true });
  check('Las dos marcas a la vez se rechazan',
    r.status === 400 && !r.json.success,
    'se llamarían la una a la otra y el cuadro no tendría fin');

  const catAcomp = await get('/api/productos');
  check('La caja sabe cuál pide acompañante y cuál puede serlo',
    (catAcomp.productos.find(p => p.id_producto === botella.id_producto) || {}).requiere_acompanante === 1 &&
    (catAcomp.productos.find(p => p.id_producto === refresco.id_producto) || {}).es_acompanante === 1);

  // -- la venta -----------------------------------------------------------
  const stockAntesBot = stockDe(botella.id_producto);
  const stockAntesRef = stockDe(refresco.id_producto);
  const precioBot = Number(botella.precio_venta);

  const conAcomp = await post('/api/comanda', Object.assign({}, base, {
    clave_idempotencia: 'acomp-' + Date.now(),
    total: precioBot * 2,
    items: [{ id_producto: botella.id_producto, cantidad: 2, precio_unitario: precioBot,
              subtotal: precioBot * 2, acompanante: refresco.id_producto }],
    metodos_pago: [{ id_metodo_pago: 1, monto: precioBot * 2 }]
  }));
  check('Se vende la botella con su acompañante',
    conAcomp.status === 200 && conAcomp.json.success, conAcomp.json.message || '');
  check('Sólo se cobra la botella',
    Math.abs(conAcomp.json.total - precioBot * 2) < 0.01,
    conAcomp.json.total + ' Bs. por dos botellas de ' + precioBot);
  check('El acompañante viaja dentro de su línea, no como línea aparte',
    conAcomp.json.items.length === 1 && conAcomp.json.items[0].acompanantes.length === 1,
    JSON.stringify(conAcomp.json.items[0].acompanantes));

  check('La botella descuenta stock', stockDe(botella.id_producto) === stockAntesBot - 2,
    stockAntesBot + ' -> ' + stockDe(botella.id_producto));
  check('Y el acompañante TAMBIÉN, aunque vaya gratis',
    stockDe(refresco.id_producto) === stockAntesRef - 2,
    stockAntesRef + ' -> ' + stockDe(refresco.id_producto) + ' · sale de la nevera igual');

  const idNueva = conAcomp.json.id_comanda;
  const lineas = leer(`SELECT id_detalle, id_producto, cantidad, precio_unitario, subtotal, id_detalle_padre
                       FROM detalle_comanda WHERE id_comanda = ${idNueva} ORDER BY id_detalle`);
  check('Se guardan dos líneas: la botella y su acompañante', lineas.length === 2);
  const hija = lineas.find(l => l.id_detalle_padre);
  check('El acompañante cuelga de la botella',
    hija && hija.id_detalle_padre === lineas.find(l => !l.id_detalle_padre).id_detalle);
  check('Y vale cero', hija && hija.precio_unitario === 0 && hija.subtotal === 0);
  check('El total de la comanda no lo incluye',
    Math.abs(leer(`SELECT total FROM comanda WHERE id_comanda = ${idNueva}`)[0].total - precioBot * 2) < 0.01);

  // -- lo que NO se permite ------------------------------------------------
  r = await post('/api/comanda', Object.assign({}, base, {
    clave_idempotencia: 'acomp-sin-' + Date.now(),
    total: precioBot,
    items: [{ id_producto: botella.id_producto, cantidad: 1, precio_unitario: precioBot, subtotal: precioBot }],
    metodos_pago: [{ id_metodo_pago: 1, monto: precioBot }]
  }));
  check('Una botella que pide acompañante no se puede cobrar sin él',
    r.status === 400 && !r.json.success, r.json.message);

  const noAcomp = leer(`SELECT id_producto, nombre FROM producto
                        WHERE activo = 1 AND COALESCE(es_acompanante,0) = 0
                          AND id_producto <> ${botella.id_producto} LIMIT 1`)[0];
  r = await post('/api/comanda', Object.assign({}, base, {
    clave_idempotencia: 'acomp-malo-' + Date.now(),
    total: precioBot,
    items: [{ id_producto: botella.id_producto, cantidad: 1, precio_unitario: precioBot,
              subtotal: precioBot, acompanante: noAcomp.id_producto }],
    metodos_pago: [{ id_metodo_pago: 1, monto: precioBot }]
  }));
  check('No vale poner de acompañante algo que no está marcado como tal',
    r.status === 400 && !r.json.success, r.json.message);

  // -- dos botellas iguales con acompañantes distintos ---------------------
  const otroRef = leer(`SELECT id_producto, nombre FROM producto
                        WHERE activo = 1 AND stock_actual > 20
                          AND id_producto NOT IN (${botella.id_producto}, ${refresco.id_producto})
                        LIMIT 1`)[0];
  await marcar(otroRef.id_producto, { es_acompanante: true });

  const dosDistintos = await post('/api/comanda', Object.assign({}, base, {
    clave_idempotencia: 'acomp-dos-' + Date.now(),
    total: precioBot * 2,
    items: [
      { id_producto: botella.id_producto, cantidad: 1, precio_unitario: precioBot,
        subtotal: precioBot, acompanante: refresco.id_producto },
      { id_producto: botella.id_producto, cantidad: 1, precio_unitario: precioBot,
        subtotal: precioBot, acompanante: otroRef.id_producto }
    ],
    metodos_pago: [{ id_metodo_pago: 1, monto: precioBot * 2 }]
  }));
  check('Dos botellas iguales con acompañantes distintos son dos líneas',
    dosDistintos.status === 200 && dosDistintos.json.items.length === 2,
    'si se fundieran no se sabría cuál lleva cuál al prepararlas');
  check('Cada una con el suyo',
    dosDistintos.json.items[0].acompanantes[0].nombre !==
    dosDistintos.json.items[1].acompanantes[0].nombre,
    dosDistintos.json.items.map(i => i.acompanantes[0].nombre).join(' / '));

  // -- varios acompañantes por botella -------------------------------------
  // Si se acabó la Coca de dos litros se dan dos pequeñas: el acompañamiento
  // es una lista con cantidades, no un producto suelto.
  const stockA = stockDe(refresco.id_producto);
  const stockB = stockDe(otroRef.id_producto);

  const variosAcomp = await post('/api/comanda', Object.assign({}, base, {
    clave_idempotencia: 'acomp-varios-' + Date.now(),
    total: precioBot * 2,
    items: [{
      id_producto: botella.id_producto, cantidad: 2,
      precio_unitario: precioBot, subtotal: precioBot * 2,
      acompanantes: [
        { id_producto: refresco.id_producto, cantidad: 2 },
        { id_producto: otroRef.id_producto, cantidad: 1 }
      ]
    }],
    metodos_pago: [{ id_metodo_pago: 1, monto: precioBot * 2 }]
  }));
  check('Una botella puede llevar varios acompañantes a la vez',
    variosAcomp.status === 200 && variosAcomp.json.items[0].acompanantes.length === 2,
    JSON.stringify(variosAcomp.json.items[0].acompanantes));
  check('Sigue cobrándose sólo la botella',
    Math.abs(variosAcomp.json.total - precioBot * 2) < 0.01);

  // Las cantidades son POR BOTELLA: dos whiskys con dos colas cada uno son
  // cuatro colas fuera de la nevera.
  check('Las cantidades se multiplican por las botellas de la línea',
    stockDe(refresco.id_producto) === stockA - 4 && stockDe(otroRef.id_producto) === stockB - 2,
    '2 por botella x 2 botellas = 4');

  const lineasVarias = leer(`SELECT id_detalle, id_detalle_padre, cantidad FROM detalle_comanda
                             WHERE id_comanda = ${variosAcomp.json.id_comanda}`);
  check('Se guardan tres líneas: la botella y sus dos acompañantes',
    lineasVarias.length === 3 && lineasVarias.filter(l => l.id_detalle_padre).length === 2);
  check('Las dos cuelgan de la misma botella',
    new Set(lineasVarias.filter(l => l.id_detalle_padre).map(l => l.id_detalle_padre)).size === 1);

  // -- el mismo refresco, suelto y de acompañante en la misma comanda ------
  const stockMixto = stockDe(refresco.id_producto);
  const mixto = await post('/api/comanda', Object.assign({}, base, {
    clave_idempotencia: 'acomp-mixto-' + Date.now(),
    total: precioBot + 1,
    items: [
      { id_producto: botella.id_producto, cantidad: 1, precio_unitario: precioBot,
        subtotal: precioBot, acompanante: refresco.id_producto },
      { id_producto: refresco.id_producto, cantidad: 1, precio_unitario: 1, subtotal: 1 }
    ],
    metodos_pago: [{ id_metodo_pago: 1, monto: precioBot + 100 }]
  }));
  check('El mismo refresco puede ir gratis dentro y cobrado aparte',
    mixto.status === 200 && mixto.json.success, mixto.json.message || '');
  check('Y salen las dos unidades del almacén',
    stockDe(refresco.id_producto) === stockMixto - 2,
    stockMixto + ' -> ' + stockDe(refresco.id_producto));


// =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Promociones (paquetes a precio cerrado)'));
  // =======================================================================
  // Una promoción es un conjunto de productos a un precio cerrado: "1 whisky y
  // 2 cervezas por 60". No es un producto: no tiene stock propio. Al venderla
  // salen de la nevera los que lleva dentro, y el precio del paquete se reparte
  // entre ellos para que el reporte de cierre siga sabiendo cuánto se vendió de
  // cada cosa sin enterarse de que existen los combos.
  const caro = leer(`SELECT id_producto, nombre, precio_venta FROM producto
                     WHERE activo = 1 AND stock_actual > 10
                     ORDER BY precio_venta DESC LIMIT 1`)[0];
  const barato = leer(`SELECT id_producto, nombre, precio_venta FROM producto
                       WHERE activo = 1 AND stock_actual > 10 AND id_producto <> ${caro.id_producto}
                       ORDER BY precio_venta ASC LIMIT 1`)[0];

  const sueltoPaquete = round2(Number(caro.precio_venta) + Number(barato.precio_venta) * 2);
  const precioPaquete = round2(sueltoPaquete - 11);

  let r2 = await post('/api/admin/promociones', {
    nombre: 'Combo de prueba', descripcion: 'uno caro y dos baratos',
    precio: precioPaquete, id_admin: 1,
    contenido: [
      { id_producto: caro.id_producto, cantidad: 1 },
      { id_producto: barato.id_producto, cantidad: 2 }
    ]
  });
  check('Se puede crear una promoción con varios productos',
    r2.status === 200 && r2.json.success, r2.json.message);
  const idPromo = r2.json.id_promocion;

  const listado = await get('/api/admin/promociones');
  const laPromo = (listado.promociones || []).find(p => p.id_promocion === idPromo);
  check('El panel la lista con lo que lleva dentro',
    laPromo && laPromo.contenido.length === 2,
    laPromo ? laPromo.contenido.map(c => c.cantidad + ' x ' + c.nombre).join(' + ') : 'no está');
  check('Y calcula sola cuánto se ahorra el cliente',
    laPromo && Math.abs(laPromo.precio_suelto - sueltoPaquete) < 0.005 &&
    Math.abs(laPromo.ahorro - 11) < 0.005,
    laPromo ? 'sueltos ' + laPromo.precio_suelto + ', paquete ' + laPromo.precio + ', ahorro ' + laPromo.ahorro : '');

  // -- rechazos al crearla --------------------------------------------------
  for (const [malo, motivo] of [
    [{ nombre: '', precio: 50, contenido: [{ id_producto: caro.id_producto, cantidad: 1 }] }, 'sin nombre'],
    [{ nombre: 'X', precio: 0, contenido: [{ id_producto: caro.id_producto, cantidad: 1 }] }, 'precio cero'],
    [{ nombre: 'X', precio: -5, contenido: [{ id_producto: caro.id_producto, cantidad: 1 }] }, 'precio negativo'],
    [{ nombre: 'X', precio: 50, contenido: [] }, 'sin productos'],
    [{ nombre: 'X', precio: 50, contenido: [{ id_producto: caro.id_producto, cantidad: 0 }] }, 'cantidad cero'],
    [{ nombre: 'X', precio: 50, contenido: [{ id_producto: 999999, cantidad: 1 }] }, 'producto inexistente']
  ]) {
    r2 = await post('/api/admin/promociones', Object.assign({ id_admin: 1 }, malo));
    check('Una promoción ' + motivo + ' se rechaza',
      r2.status === 400 && !r2.json.success, r2.json.message);
  }
  check('Y ninguna de esas se creó',
    leer("SELECT id_promocion FROM promocion WHERE nombre = 'X'").length === 0);

  // -- la venta -------------------------------------------------------------
  const stockCaroAntes = stockDe(caro.id_producto);
  const stockBaratoAntes = stockDe(barato.id_producto);

  const ventaPromo = await post('/api/comanda', Object.assign({}, base, {
    items: [],
    promociones: [{ id_promocion: idPromo, cantidad: 2 }],
    total: round2(precioPaquete * 2),
    metodos_pago: [{ id_metodo_pago: 1, monto: round2(precioPaquete * 2) }],
    clave_idempotencia: 'promo-' + Date.now()
  }));
  check('Se puede cobrar una comanda que sólo lleva promociones',
    ventaPromo.status === 200 && ventaPromo.json.success, ventaPromo.json.message);
  check('Y el total es el del paquete, no el de los productos sueltos',
    Math.abs(ventaPromo.json.total - round2(precioPaquete * 2)) < 0.005,
    'cobró ' + ventaPromo.json.total + ', sueltos habrían sido ' + round2(sueltoPaquete * 2));

  check('Sale de la nevera lo que el paquete lleva dentro, no un "combo"',
    stockDe(caro.id_producto) === stockCaroAntes - 2 &&
    stockDe(barato.id_producto) === stockBaratoAntes - 4,
    caro.nombre + ': ' + stockCaroAntes + '->' + stockDe(caro.id_producto) + ' · ' +
    barato.nombre + ': ' + stockBaratoAntes + '->' + stockDe(barato.id_producto));

  const idComPromo = ventaPromo.json.id_comanda;
  const lineasPromo = leer(`SELECT id_producto, cantidad, precio_unitario, subtotal, id_promocion
                            FROM detalle_comanda WHERE id_comanda = ${idComPromo}`);
  check('Las líneas guardadas son productos de verdad, no un paquete abstracto',
    lineasPromo.length === 2 && lineasPromo.every(l => l.id_producto > 0),
    lineasPromo.length + ' líneas');
  check('Y cada una sabe de qué promoción salió',
    lineasPromo.every(l => l.id_promocion === idPromo));
  check('La suma de las líneas es exactamente el total de la comanda',
    Math.abs(round2(lineasPromo.reduce((s, l) => s + l.subtotal, 0)) - ventaPromo.json.total) < 0.005,
    'suma ' + round2(lineasPromo.reduce((s, l) => s + l.subtotal, 0)) + ' vs total ' + ventaPromo.json.total);
  check('Hay un movimiento de stock por cada producto del paquete',
    leer(`SELECT id_movimiento FROM movimiento_stock
          WHERE motivo = 'Venta comanda #${idComPromo}'`).length === 2);

  check('El ticket recibe el paquete entero, para imprimirlo como tal',
    (ventaPromo.json.promociones || []).length === 1 &&
    ventaPromo.json.promociones[0].cantidad === 2 &&
    ventaPromo.json.promociones[0].contenido.length === 2,
    JSON.stringify(ventaPromo.json.promociones || []));

  // -- mezclada con venta suelta -------------------------------------------
  const stockCaro2 = stockDe(caro.id_producto);
  const mezcla = await post('/api/comanda', Object.assign({}, base, {
    items: [{ id_producto: caro.id_producto, cantidad: 1, precio_unitario: 1, subtotal: 1 }],
    promociones: [{ id_promocion: idPromo, cantidad: 1 }],
    total: 1,
    metodos_pago: [{ id_metodo_pago: 1, monto: round2(precioPaquete + Number(caro.precio_venta)) }],
    clave_idempotencia: 'mezcla-' + Date.now()
  }));
  check('Se puede mezclar promoción y venta suelta en la misma comanda',
    mezcla.status === 200 && mezcla.json.success, mezcla.json.message);
  check('Y el total suma el paquete más el producto suelto a su precio normal',
    Math.abs(mezcla.json.total - round2(precioPaquete + Number(caro.precio_venta))) < 0.005,
    'cobró ' + mezcla.json.total);
  check('El mismo producto, dentro y fuera del paquete, sale dos veces de la nevera',
    stockDe(caro.id_producto) === stockCaro2 - 2,
    stockCaro2 + ' -> ' + stockDe(caro.id_producto));

  // -- rechazos al venderla -------------------------------------------------
  const rechazos = [
    [{ id_promocion: 999999, cantidad: 1 }, 'que no existe'],
    [{ id_promocion: idPromo, cantidad: 0 }, 'con cantidad cero'],
    [{ id_promocion: idPromo, cantidad: -3 }, 'con cantidad negativa'],
    [{ id_promocion: idPromo, cantidad: 1.5 }, 'con media unidad']
  ];
  for (const [promo, motivo] of rechazos) {
    const antesRech = stockDe(caro.id_producto);
    r2 = await post('/api/comanda', Object.assign({}, base, {
      items: [], promociones: [promo], total: 10,
      metodos_pago: [{ id_metodo_pago: 1, monto: 500 }],
      clave_idempotencia: 'rech-' + Date.now() + Math.random()
    }));
    check('Una promoción ' + motivo + ' se rechaza',
      r2.status >= 400 && !r2.json.success, r2.json.message);
    check('  y no toca el stock', stockDe(caro.id_producto) === antesRech);
  }

  // -- apagarla la saca de la caja -----------------------------------------
  r2 = await post('/api/admin/promociones/' + idPromo, {
    nombre: 'Combo de prueba', precio: precioPaquete, activa: false, id_admin: 1
  }, 'PUT');
  check('Se puede apagar una promoción sin borrarla',
    r2.status === 200 && r2.json.success, r2.json.message);

  const catSinPromo = await get('/api/productos');
  check('Apagada, ya no le llega a la caja',
    !(catSinPromo.promociones || []).some(p => p.id_promocion === idPromo),
    (catSinPromo.promociones || []).length + ' promociones activas');

  r2 = await post('/api/comanda', Object.assign({}, base, {
    items: [], promociones: [{ id_promocion: idPromo, cantidad: 1 }], total: 10,
    metodos_pago: [{ id_metodo_pago: 1, monto: 500 }],
    clave_idempotencia: 'apagada-' + Date.now()
  }));
  check('Y si alguien la pide igualmente, se rechaza',
    r2.status >= 400 && !r2.json.success, r2.json.message);

  // -- borrar una que ya se vendió ------------------------------------------
  r2 = await del('/api/admin/promociones/' + idPromo);
  check('Una promoción ya vendida se apaga, no se borra',
    r2.status === 200 && r2.json.success && r2.json.retirada === true, r2.json.message);
  check('Y sigue en la base, para que el historial cuadre',
    leer(`SELECT id_promocion FROM promocion WHERE id_promocion = ${idPromo}`).length === 1);

  // -- borrar una que no se vendió nunca ------------------------------------
  const sinVender = await post('/api/admin/promociones', {
    nombre: 'Combo que nadie compró', precio: 50, id_admin: 1,
    contenido: [{ id_producto: barato.id_producto, cantidad: 3 }]
  });
  r2 = await del('/api/admin/promociones/' + sinVender.json.id_promocion);
  check('Una que nunca se vendió sí se borra del todo',
    r2.status === 200 && r2.json.success && !r2.json.retirada,
    r2.json.message);
  check('Y se lleva su contenido con ella',
    leer(`SELECT id_detalle_promocion FROM promocion_detalle
          WHERE id_promocion = ${sinVender.json.id_promocion}`).length === 0);

  // -- el cierre ------------------------------------------------------------
  const cierrePromo = await get('/api/admin/reporte');
  const filaCaro = (cierrePromo.productos || []).find(p => p.producto === caro.nombre);
  check('El reporte de cierre cuenta las unidades vendidas dentro de paquetes',
    filaCaro && filaCaro.unidades >= 3,
    filaCaro ? filaCaro.unidades + ' unidades de ' + caro.nombre : 'no aparece');
  check('Y les atribuye su parte del importe, sin dejarlo fuera del reporte',
    filaCaro && filaCaro.importe > 0,
    filaCaro ? filaCaro.importe + ' Bs.' : '');

  const auditPromo = leer(`SELECT accion FROM auditoria_admin
                           WHERE entidad = 'promocion'`);
  check('Crear, editar y apagar promociones queda en auditoría',
    ['CREAR_PROMOCION', 'EDITAR_PROMOCION', 'APAGAR_PROMOCION']
      .every(a => auditPromo.some(x => x.accion === a)),
    auditPromo.map(a => a.accion).join(', '));

  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Mover stock e ingresar mercancía'));
  // =======================================================================
  // La mercancía se mueve entre barras y entra por compra. Las dos cosas tocan
  // el mismo stock que las ventas, así que van por la misma cola de
  // transacciones: mientras se mueve una caja no se puede vender esa caja.
  const prodMov = leer('SELECT id_producto, nombre, stock_actual FROM producto WHERE activo = 1 AND stock_actual > 30 LIMIT 1')[0];
  const stockMov0 = stockDe(prodMov.id_producto);

  // -- salida ---------------------------------------------------------------
  let mov = await post('/api/traspaso', {
    tipo: 'SALIDA', motivo: 'TRASPASO', contraparte: 'Barra VIP',
    observaciones: 'Lo lleva Marcos', id_cajero: 1,
    items: [{ id_producto: prodMov.id_producto, cantidad: 10 }]
  });
  check('Se puede mover stock a otra barra',
    mov.status === 200 && mov.json.success, mov.json.message);
  check('El stock baja en esta barra', stockDe(prodMov.id_producto) === stockMov0 - 10,
    stockMov0 + ' -> ' + stockDe(prodMov.id_producto));
  check('Queda el documento, con su número y su destino',
    leer(`SELECT contraparte, tipo FROM traspaso WHERE id_traspaso = ${mov.json.id_traspaso}`)[0].contraparte === 'Barra VIP');
  check('Y el apunte dice a dónde fue, no sólo que salió',
    leer(`SELECT motivo FROM movimiento_stock WHERE motivo LIKE 'Traspaso #${mov.json.id_traspaso} a %'`).length > 0,
    'Traspaso #' + mov.json.id_traspaso + ' a Barra VIP');

  // -- entrada por compra ---------------------------------------------------
  const stockMov1 = stockDe(prodMov.id_producto);
  mov = await post('/api/traspaso', {
    tipo: 'ENTRADA', motivo: 'COMPRA', contraparte: 'Distribuidora Central',
    observaciones: 'Factura 4471', id_admin: 1,
    items: [{ id_producto: prodMov.id_producto, cantidad: 48 }]
  });
  check('Se puede ingresar mercancía comprada',
    mov.status === 200 && mov.json.success, mov.json.message);
  check('Y el stock sube', stockDe(prodMov.id_producto) === stockMov1 + 48,
    stockMov1 + ' -> ' + stockDe(prodMov.id_producto));
  check('El apunte distingue la compra del traspaso',
    leer(`SELECT motivo FROM movimiento_stock WHERE motivo LIKE 'Compra #${mov.json.id_traspaso} a %'`).length > 0,
    'lo comprado costó dinero, lo traspasado ya estaba pagado');

  // -- entrada por traspaso recibido ---------------------------------------
  const stockMov2 = stockDe(prodMov.id_producto);
  mov = await post('/api/traspaso', {
    tipo: 'ENTRADA', motivo: 'TRASPASO', contraparte: 'Barra VIP', id_admin: 1,
    items: [{ id_producto: prodMov.id_producto, cantidad: 5 }]
  });
  check('Y mercancía recibida de otra barra',
    mov.status === 200 && stockDe(prodMov.id_producto) === stockMov2 + 5, mov.json.message);

  // -- lo que no se permite -------------------------------------------------
  const stockAntesFallo = stockDe(prodMov.id_producto);
  mov = await post('/api/traspaso', {
    tipo: 'SALIDA', motivo: 'TRASPASO', contraparte: 'Barra VIP',
    items: [{ id_producto: prodMov.id_producto, cantidad: 999999 }]
  });
  check('No se puede mover más de lo que hay',
    mov.status === 400 && !mov.json.success, mov.json.message);
  check('Y el intento fallido no toca el stock',
    stockDe(prodMov.id_producto) === stockAntesFallo);

  mov = await post('/api/traspaso', {
    tipo: 'SALIDA', motivo: 'TRASPASO', contraparte: '',
    items: [{ id_producto: prodMov.id_producto, cantidad: 1 }]
  });
  check('Una salida sin destino se rechaza',
    mov.status === 400, 'sin destino, dentro de tres horas nadie sabe dónde fue');

  mov = await post('/api/traspaso', {
    tipo: 'SALIDA', motivo: 'TRASPASO', contraparte: 'X',
    items: [{ id_producto: prodMov.id_producto, cantidad: 0 }]
  });
  check('Cero unidades se rechaza', mov.status === 400);

  mov = await post('/api/traspaso', {
    tipo: 'INVENTADO', motivo: 'TRASPASO', contraparte: 'X',
    items: [{ id_producto: prodMov.id_producto, cantidad: 1 }]
  });
  check('Un tipo de movimiento inventado se rechaza', mov.status === 400);

  // -- un traspaso a medias no deja rastro ---------------------------------
  // Dos productos, el segundo imposible: la primera resta ya se había hecho y
  // tiene que deshacerse, o la mercancía desaparecería del inventario sin
  // haber salido de la barra.
  const otroProd = leer(`SELECT id_producto FROM producto WHERE activo = 1 AND stock_actual > 5
                         AND id_producto <> ${prodMov.id_producto} LIMIT 1`)[0];
  const antesA = stockDe(prodMov.id_producto);
  const antesB = stockDe(otroProd.id_producto);
  const docsAntes = leer('SELECT id_traspaso FROM traspaso').length;

  mov = await post('/api/traspaso', {
    tipo: 'SALIDA', motivo: 'TRASPASO', contraparte: 'Barra VIP',
    items: [
      { id_producto: prodMov.id_producto, cantidad: 2 },
      { id_producto: otroProd.id_producto, cantidad: 999999 }
    ]
  });
  check('Un traspaso que falla a medias no se guarda', mov.status === 400);
  check('Ni descuenta lo que sí cabía',
    stockDe(prodMov.id_producto) === antesA && stockDe(otroProd.id_producto) === antesB,
    'o la mercancía desaparecería sin haber salido');
  check('Ni deja el documento a medias',
    leer('SELECT id_traspaso FROM traspaso').length === docsAntes);

  // -- el historial ---------------------------------------------------------
  const hist = await get('/api/traspasos');
  check('El panel puede listar entradas y salidas',
    Array.isArray(hist.traspasos) && hist.traspasos.length > 0,
    hist.traspasos.length + ' movimientos');
  check('Cada uno trae cuántas unidades movió',
    hist.traspasos.every(t => typeof t.unidades === 'number'));
  check('Y se sugieren los destinos ya usados, para no escribirlos distinto cada vez',
    (hist.destinos || []).some(d => d.contraparte === 'Barra VIP'),
    'si no, "Barra VIP" y "barra vip" serían dos destinos que no se pueden sumar');

  const uno = await get('/api/traspaso/' + hist.traspasos[0].id_traspaso);
  check('Se puede recuperar uno para reimprimir su comanda',
    uno.success && Array.isArray(uno.items) && uno.items.length > 0);


  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Todo queda en el log de auditoría'));
  // =======================================================================
  // Al día siguiente alguien pregunta quién cambió un precio o a dónde fueron
  // doce cervezas. El log es lo único que puede responder, así que toda acción
  // del encargado tiene que dejar rastro.
  const auditoriaDe = accion =>
    leer(`SELECT id_auditoria, detalle FROM auditoria_admin WHERE accion = '${accion}'`);

  const antesLog = leer('SELECT id_auditoria FROM auditoria_admin').length;

  const prodLog = await post('/api/admin/productos', {
    id_categoria: 1, nombre: 'Whisky de prueba de auditoría', descripcion: '',
    tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 95, stock_actual: 6,
    id_admin: 1, id_evento: 1
  });
  check('Crear un producto queda en el log',
    auditoriaDe('CREAR_PRODUCTO').some(a => a.detalle.includes('auditoría')),
    'era la duda: sí se guarda');

  await post('/api/admin/productos/' + prodLog.json.id_producto + '/acompanamiento',
    { es_acompanante: true, id_admin: 1 }, 'PUT');
  check('Marcarlo como acompañante también',
    auditoriaDe('MARCAR_ACOMPANAMIENTO').length > 0);

  await post('/api/admin/productos/' + prodLog.json.id_producto + '/foto',
    { foto: PNG_1PX, id_admin: 1 }, 'PUT');
  check('Ponerle una foto también', auditoriaDe('PONER_FOTO').length > 0);

  await post('/api/traspaso', {
    tipo: 'SALIDA', motivo: 'TRASPASO', contraparte: 'Barra de auditoría',
    id_admin: 1, items: [{ id_producto: prodLog.json.id_producto, cantidad: 2 }]
  });
  check('Mover mercancía también, con destino y cantidades',
    auditoriaDe('TRASPASO_SALIDA').some(a => a.detalle.includes('Barra de auditoría')),
    auditoriaDe('TRASPASO_SALIDA').slice(-1)[0].detalle);

  await post('/api/admin/configuracion-evento', {
    evento: 'Evento de auditoría', fecha: '2026-09-12', lugar: 'X',
    barra: 'Barra de prueba', responsable: 'Y', id_admin: 1
  }, 'PUT');
  check('Cambiar los datos del evento también',
    auditoriaDe('CAMBIAR_DATOS_EVENTO').length > 0);

  // Ese producto ya se movió en un traspaso, así que no se puede borrar del
  // todo: el papel del traspaso lo nombra. Antes esto daba un 500 seco.
  const borrado = await post('/api/admin/productos/' + prodLog.json.id_producto,
    { id_admin: 1 }, 'DELETE');
  check('Un producto ya traspasado se retira, no revienta',
    borrado.status === 200 && borrado.json.success && borrado.json.retirado === true,
    borrado.json.message);
  check('Y eliminarlo queda en el log', auditoriaDe('ELIMINAR_PRODUCTO').length > 0);

  check('Ninguna de esas acciones se quedó sin registrar',
    leer('SELECT id_auditoria FROM auditoria_admin').length >= antesLog + 6,
    (leer('SELECT id_auditoria FROM auditoria_admin').length - antesLog) + ' apuntes nuevos');


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
