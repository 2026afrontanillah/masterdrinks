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
  const base = {
    id_evento: 1, id_barra: 1, id_cajero: 1, id_mesero: 1,
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

  r = await post('/api/login/mesero', { password: '0000', id_cajero: 1, id_barra: 1, id_evento: 1 });
  check('Rechaza un PIN que no existe', r.status === 401);

  r = await post('/api/login/mesero', { password: '1009', id_cajero: 1, id_barra: 1, id_evento: 1 });
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
  console.log(C.tit('\n  Identidad de instancia'));
  // =======================================================================
  // Cada barra corre su propio servidor con su propia base. Sin identidad, las
  // tres numeran desde 1 y al juntarlas no se sabe qué venta fue de dónde.
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
  // El nombre lleva la barra: si llegan tres cierres al mismo chat de WhatsApp
  // y se llaman igual, el segundo pisa al primero.
  check('Se descarga como archivo con la barra en el nombre',
    new RegExp('attachment; filename="Cierre_' + ident.nombre + '_.*\\.pdf"')
      .test(resPdf.headers.get('content-disposition') || ''),
    resPdf.headers.get('content-disposition'));
  check('El PDF dice a qué barra corresponde',
    texto.includes('Cierre de caja') && texto.includes(ident.nombre));
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

  console.log('');
  console.log(fallos === 0
    ? '  ' + C.ok('Todo correcto: ninguna entrada inválida pasó ni dejó rastro.') + '\n'
    : '  ' + C.mal(fallos + ' comprobación(es) fallidas.') + '\n');

  hijo.kill('SIGTERM');
  await esperar(600);
  hijo.kill('SIGKILL');
  process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(C.mal('Error: '), e); process.exit(1); });
