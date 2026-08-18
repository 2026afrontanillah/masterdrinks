/* ==========================================================================
 * MasterDrinks — Prueba de carga
 * ==========================================================================
 *
 * Simula varias tablets vendiendo a la vez contra el servidor, como en la
 * noche del evento, y después audita la base para comprobar que el desorden
 * no dejó ninguna venta a medias.
 *
 * NUNCA toca pos_evento.db: copia la base a un archivo aparte y arranca un
 * servidor propio contra esa copia (DB_FILE) en un puerto propio.
 *
 *   node tools/stress-test.js
 *   node tools/stress-test.js --tablets 12 --comandas 40 --puerto 3210
 *
 * Lo que verifica al terminar:
 *   1. Ninguna venta aceptada se perdió, y ninguna rechazada dejó rastro.
 *   2. El stock nunca quedó negativo.
 *   3. Lo descontado del stock coincide con lo vendido, producto por producto.
 *   4. El total de cada comanda es la suma de sus líneas, sin céntimos sueltos.
 *   5. Los pagos cubren el total de cada comanda.
 *   6. Hay un movimiento_stock por cada línea vendida.
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = path.join(__dirname, '..');
const BASE_ORIGEN = path.join(RAIZ, 'pos_evento.db');

// --------------------------------------------------------------------------
// Argumentos
// --------------------------------------------------------------------------
function arg(nombre, pordefecto) {
  const i = process.argv.indexOf('--' + nombre);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : pordefecto;
}

const TABLETS = arg('tablets', 9);      // cuántas tablets venden a la vez
const COMANDAS = arg('comandas', 25);   // comandas que cierra cada tablet
const PUERTO = arg('puerto', 3399);
// Con el stock real las existencias se agotan enseguida y a partir de ahí el
// servidor sólo rechaza, que es el camino barato. Reponer en la copia obliga a
// que casi todas las ventas se escriban de verdad.
const STOCK = arg('stock', 0);
const BASE = process.env.DB_FILE || path.join(RAIZ, 'pos_evento.stress.db');
const URL = 'http://127.0.0.1:' + PUERTO;

// --------------------------------------------------------------------------
// Utilidades
// --------------------------------------------------------------------------
const esperar = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const azar = arr => arr[Math.floor(Math.random() * arr.length)];

const C = {
  ok: s => '\x1b[32m' + s + '\x1b[0m',
  mal: s => '\x1b[31m' + s + '\x1b[0m',
  dim: s => '\x1b[90m' + s + '\x1b[0m',
  tit: s => '\x1b[1m\x1b[36m' + s + '\x1b[0m'
};

async function post(ruta, cuerpo) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(URL + ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let json = null;
  try { json = await res.json(); } catch (e) { /* respuesta no JSON */ }
  return { status: res.status, json, ms };
}

// --------------------------------------------------------------------------
// Preparar una copia limpia de la base
// --------------------------------------------------------------------------
function prepararBase() {
  if (!fs.existsSync(BASE_ORIGEN)) {
    console.error(C.mal('No encuentro ' + BASE_ORIGEN));
    process.exit(1);
  }
  // El -wal puede tener ventas que aún no están en el .db; un checkpoint las
  // vuelca antes de copiar, si no la copia saldría incompleta.
  const origen = new DatabaseSync(BASE_ORIGEN);
  origen.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  origen.close();

  ['', '-wal', '-shm'].forEach(suf => {
    if (fs.existsSync(BASE + suf)) fs.unlinkSync(BASE + suf);
  });
  fs.copyFileSync(BASE_ORIGEN, BASE);

  if (STOCK > 0) {
    const copia = new DatabaseSync(BASE);
    copia.prepare('UPDATE producto SET stock_actual = ?').run(STOCK);
    copia.close();
  }
}

// --------------------------------------------------------------------------
// Arrancar el servidor contra la copia
// --------------------------------------------------------------------------
function arrancarServidor() {
  const hijo = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, { PORT: String(PUERTO), DB_FILE: BASE }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const registro = [];
  hijo.stdout.on('data', d => registro.push(String(d)));
  hijo.stderr.on('data', d => registro.push(String(d)));
  return { hijo, registro };
}

async function esperarServidor(intentos = 40) {
  for (let i = 0; i < intentos; i++) {
    try {
      const res = await fetch(URL + '/api/productos');
      if (res.ok) return true;
    } catch (e) { /* todavía no escucha */ }
    await esperar(250);
  }
  return false;
}

// --------------------------------------------------------------------------
// La carga: cada tablet inicia sesión y va cerrando comandas
// --------------------------------------------------------------------------
async function correrTablet(idTablet, catalogo, resultados) {
  const cajero = catalogo.cajeros[idTablet % catalogo.cajeros.length];

  const login = await post('/api/login', { usuario: cajero.usuario, password: 'demo123' });
  if (!login.json || !login.json.success) {
    resultados.erroresLogin.push('tablet ' + idTablet + ': login cajero ' + login.status);
    return;
  }
  const usuario = login.json.user;

  // PIN de un mesero cualquiera: con el alcance por servidor debe abrir en
  // cualquier tablet, así que también se está probando eso bajo carga.
  const mesero = azar(catalogo.meseros);
  const pin = await post('/api/login/mesero', {
    password: mesero.password,
    id_cajero: usuario.id_cajero,
    id_barra: usuario.id_barra,
    id_evento: usuario.id_evento
  });
  if (!pin.json || !pin.json.success) {
    resultados.erroresLogin.push('tablet ' + idTablet + ': PIN ' + mesero.password + ' -> ' + pin.status);
    return;
  }

  for (let n = 0; n < COMANDAS; n++) {
    // Carrito al azar: 1-4 productos distintos, 1-3 unidades de cada uno.
    const cuantos = 1 + Math.floor(Math.random() * 4);
    const elegidos = [];
    while (elegidos.length < cuantos) {
      const p = azar(catalogo.productos);
      if (!elegidos.find(e => e.id_producto === p.id_producto)) elegidos.push(p);
    }
    const items = elegidos.map(p => {
      const cantidad = 1 + Math.floor(Math.random() * 3);
      return {
        id_producto: p.id_producto,
        cantidad,
        precio_unitario: p.precio_venta,
        subtotal: round2(p.precio_venta * cantidad)
      };
    });
    const total = round2(items.reduce((s, i) => s + i.subtotal, 0));

    // Una de cada tres se paga partida entre dos métodos.
    const metodos = Math.random() < 0.33
      ? [
          { id_metodo_pago: 1, monto: round2(total / 2), referencia: 'EFECTIVO-CAJA-' + idTablet },
          { id_metodo_pago: 3, monto: round2(total - round2(total / 2)), referencia: 'QR-CAJA-' + idTablet }
        ]
      : [{ id_metodo_pago: 1, monto: total, referencia: 'EFECTIVO-CAJA-' + idTablet }];

    const res = await post('/api/comanda', {
      id_evento: usuario.id_evento,
      id_barra: usuario.id_barra,
      id_cajero: usuario.id_cajero,
      id_mesero: pin.json.mesero.id_mesero,
      total,
      observaciones: 'carga t' + idTablet + ' n' + n,
      items,
      metodos_pago: metodos
    });

    resultados.latencias.push(res.ms);

    if (res.status === 200 && res.json && res.json.success) {
      resultados.aceptadas.push({ id: res.json.id_comanda, total: res.json.total, enviado: total });
      // El servidor recalcula el total desde la base; si no coincide con lo
      // que pidió la tablet, el ticket impreso mentiría.
      if (round2(res.json.total) !== total) {
        resultados.totalesDispares.push({ id: res.json.id_comanda, servidor: res.json.total, tablet: total });
      }
    } else if (res.status === 400 && res.json && /Stock insuficiente/i.test(res.json.message || '')) {
      resultados.sinStock++;
    } else {
      resultados.fallos.push({ status: res.status, message: (res.json && res.json.message) || 'sin cuerpo' });
    }
  }
}

// --------------------------------------------------------------------------
// Auditoría de la base después del castigo
// --------------------------------------------------------------------------
function auditar(stockInicial, resultados) {
  const db = new DatabaseSync(BASE);
  const pruebas = [];
  const prueba = (nombre, ok, detalle) => pruebas.push({ nombre, ok, detalle: detalle || '' });

  const marca = 'carga t%';
  const comandas = db.prepare(
    "SELECT id_comanda, total FROM comanda WHERE observaciones LIKE ?"
  ).all(marca);

  // 1. Ni ventas perdidas ni ventas fantasma.
  const idsAceptadas = new Set(resultados.aceptadas.map(a => a.id));
  const idsEnBase = new Set(comandas.map(c => c.id_comanda));
  const perdidas = [...idsAceptadas].filter(id => !idsEnBase.has(id));
  const fantasma = [...idsEnBase].filter(id => !idsAceptadas.has(id));
  prueba(
    'Toda venta aceptada está guardada, y nada más',
    perdidas.length === 0 && fantasma.length === 0,
    perdidas.length + ' perdidas · ' + fantasma.length + ' fantasma'
  );

  // 2. Stock nunca negativo.
  const negativos = db.prepare('SELECT id_producto, stock_actual FROM producto WHERE stock_actual < 0').all();
  prueba('Ningún producto quedó con stock negativo', negativos.length === 0,
    negativos.map(n => '#' + n.id_producto + '=' + n.stock_actual).join(', '));

  // 3. Lo vendido cuadra con lo descontado.
  const vendido = db.prepare(`
    SELECT d.id_producto, SUM(d.cantidad) AS unidades
    FROM detalle_comanda d
    JOIN comanda c ON c.id_comanda = d.id_comanda
    WHERE c.observaciones LIKE ?
    GROUP BY d.id_producto
  `).all(marca);
  const stockFinal = new Map(
    db.prepare('SELECT id_producto, stock_actual FROM producto').all().map(p => [p.id_producto, p.stock_actual])
  );
  const descuadres = [];
  for (const v of vendido) {
    const esperado = stockInicial.get(v.id_producto) - v.unidades;
    const real = stockFinal.get(v.id_producto);
    if (esperado !== real) {
      descuadres.push('#' + v.id_producto + ' esperado ' + esperado + ' pero hay ' + real);
    }
  }
  prueba('El stock descontado coincide con lo vendido', descuadres.length === 0, descuadres.join(' · '));

  // 4. Cada total es la suma de sus líneas.
  const totalesMalos = db.prepare(`
    SELECT c.id_comanda, c.total, ROUND(SUM(d.subtotal), 2) AS suma
    FROM comanda c JOIN detalle_comanda d ON d.id_comanda = c.id_comanda
    WHERE c.observaciones LIKE ?
    GROUP BY c.id_comanda
    HAVING ABS(c.total - suma) > 0.005
  `).all(marca);
  prueba('El total de cada comanda es la suma de sus líneas', totalesMalos.length === 0,
    totalesMalos.slice(0, 3).map(t => '#' + t.id_comanda).join(', '));

  // 5. Los pagos cubren el total.
  const pagosCortos = db.prepare(`
    SELECT c.id_comanda, c.total, ROUND(SUM(p.monto), 2) AS pagado
    FROM comanda c JOIN pago_comanda p ON p.id_comanda = c.id_comanda
    WHERE c.observaciones LIKE ?
    GROUP BY c.id_comanda
    HAVING pagado + 0.005 < c.total
  `).all(marca);
  prueba('Los pagos cubren el total de cada comanda', pagosCortos.length === 0,
    pagosCortos.slice(0, 3).map(t => '#' + t.id_comanda).join(', '));

  // 6. Un movimiento de stock por línea vendida.
  const lineas = db.prepare(`
    SELECT COUNT(*) AS n FROM detalle_comanda d
    JOIN comanda c ON c.id_comanda = d.id_comanda WHERE c.observaciones LIKE ?
  `).get(marca).n;
  const movimientos = db.prepare(`
    SELECT COUNT(*) AS n FROM movimiento_stock WHERE motivo LIKE 'Venta comanda #%'
      AND CAST(REPLACE(motivo, 'Venta comanda #', '') AS INTEGER) IN (
        SELECT id_comanda FROM comanda WHERE observaciones LIKE ?
      )
  `).get(marca).n;
  prueba('Hay un movimiento de stock por cada línea vendida', lineas === movimientos,
    lineas + ' líneas vs ' + movimientos + ' movimientos');

  // 7. El servidor no aceptó ningún total distinto al que calculó él mismo.
  prueba('El total que devuelve el servidor coincide con el del carrito',
    resultados.totalesDispares.length === 0,
    resultados.totalesDispares.slice(0, 3).map(t => '#' + t.id).join(', '));

  db.close();
  return pruebas;
}

// --------------------------------------------------------------------------
// Programa principal
// --------------------------------------------------------------------------
(async () => {
  console.log(C.tit('\n  MasterDrinks · prueba de carga'));
  console.log(C.dim('  ' + TABLETS + ' tablets a la vez × ' + COMANDAS + ' comandas cada una = ' +
    TABLETS * COMANDAS + ' ventas'));
  console.log(C.dim('  base de pruebas: ' + path.basename(BASE) + ' (copia; la del evento no se toca)\n'));

  prepararBase();

  const { hijo, registro } = arrancarServidor();
  const arriba = await esperarServidor();
  if (!arriba) {
    console.error(C.mal('  El servidor no llegó a arrancar:\n') + registro.join(''));
    hijo.kill();
    process.exit(1);
  }

  // Catálogo y stock de partida, leídos de la copia antes de empezar.
  const db = new DatabaseSync(BASE);
  const catalogo = {
    productos: db.prepare('SELECT id_producto, precio_venta FROM producto WHERE activo = 1').all(),
    cajeros: db.prepare('SELECT id_cajero, usuario FROM cajero WHERE activo = 1').all(),
    meseros: db.prepare('SELECT id_mesero, password FROM mesero WHERE activo = 1').all()
  };
  const stockInicial = new Map(
    db.prepare('SELECT id_producto, stock_actual FROM producto').all().map(p => [p.id_producto, p.stock_actual])
  );
  db.close();

  const resultados = {
    aceptadas: [], fallos: [], erroresLogin: [], totalesDispares: [],
    sinStock: 0, latencias: []
  };

  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: TABLETS }, (_, i) => correrTablet(i, catalogo, resultados))
  );
  const segundos = (Date.now() - t0) / 1000;

  // ---- Resultados de rendimiento ----
  const lat = resultados.latencias.slice().sort((a, b) => a - b);
  const pct = p => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0);
  const enviadas = resultados.latencias.length;

  console.log(C.tit('  Rendimiento'));
  console.log('  Ventas enviadas       ' + enviadas + ' en ' + segundos.toFixed(2) + ' s');
  console.log('  Ritmo                 ' + (enviadas / segundos).toFixed(1) + ' ventas/s');
  console.log('  Respuesta mediana     ' + pct(0.5).toFixed(1) + ' ms');
  console.log('  Respuesta p95         ' + pct(0.95).toFixed(1) + ' ms');
  console.log('  Respuesta peor caso   ' + (lat[lat.length - 1] || 0).toFixed(1) + ' ms');
  console.log('  Aceptadas             ' + resultados.aceptadas.length);
  console.log('  Rechazadas sin stock  ' + resultados.sinStock + C.dim('  (esperable al agotar existencias)'));
  console.log('  Errores inesperados   ' +
    (resultados.fallos.length ? C.mal(String(resultados.fallos.length)) : C.ok('0')));

  if (resultados.erroresLogin.length) {
    console.log('\n  ' + C.mal('Fallos de sesión:'));
    resultados.erroresLogin.slice(0, 5).forEach(e => console.log('   · ' + e));
  }
  if (resultados.fallos.length) {
    const porMensaje = {};
    resultados.fallos.forEach(f => {
      const k = f.status + ' · ' + f.message;
      porMensaje[k] = (porMensaje[k] || 0) + 1;
    });
    console.log('\n  ' + C.mal('Errores inesperados:'));
    Object.entries(porMensaje).forEach(([k, n]) => console.log('   · ' + n + ' × ' + k));
  }

  // ---- Auditoría de integridad ----
  console.log(C.tit('\n  Integridad de la base'));
  const pruebas = auditar(stockInicial, resultados);
  pruebas.forEach(p => {
    console.log('  ' + (p.ok ? C.ok('✓') : C.mal('✗')) + ' ' + p.nombre +
      (p.detalle && !p.ok ? C.mal('  → ' + p.detalle) : C.dim(p.detalle ? '  (' + p.detalle + ')' : '')));
  });

  const fallaron = pruebas.filter(p => !p.ok).length;
  console.log('');
  if (fallaron === 0 && resultados.fallos.length === 0 && resultados.erroresLogin.length === 0) {
    console.log('  ' + C.ok('Todo correcto: la concurrencia no dejó ninguna venta a medias.\n'));
  } else {
    console.log('  ' + C.mal(fallaron + ' comprobación(es) fallidas.\n'));
  }

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
  process.exit(fallaron === 0 && resultados.fallos.length === 0 ? 0 : 1);
})();
