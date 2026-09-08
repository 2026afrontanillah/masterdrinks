/* ==========================================================================
 * MasterDrinks — Medir cuánto tarda cada cosa
 * ==========================================================================
 *
 * Optimizar sin medir es adivinar. Esto arranca un servidor sobre una copia
 * desechable de la base y cronometra las operaciones que el cajero repite toda
 * la noche, para poder comparar antes y después de tocar nada.
 *
 *   npm run medir
 *   npm run medir -- --ventas 300
 *
 * Se fija en el percentil 95 y no en la media: lo que arruina la sensación de
 * rapidez no es el caso típico, es el toque que de vez en cuando tarda medio
 * segundo con el cliente delante.
 * ======================================================================== */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = path.join(__dirname, '..');
const BASE = path.join(RAIZ, 'pos_evento.medir.db');
const PUERTO = 3910;
const URL = 'http://127.0.0.1:' + PUERTO;

const arg = (nombre, pordefecto) => {
  const i = process.argv.indexOf('--' + nombre);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : pordefecto;
};
const VENTAS = arg('ventas', 200);

const C = {
  tit: t => '\x1b[1m\x1b[36m' + t + '\x1b[0m',
  ok: t => '\x1b[32m' + t + '\x1b[0m',
  mal: t => '\x1b[31m' + t + '\x1b[0m',
  gris: t => '\x1b[90m' + t + '\x1b[0m'
};

const esperar = ms => new Promise(r => setTimeout(r, ms));

function percentil(valores, p) {
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.floor(orden.length * p))];
}

function resumen(nombre, tiempos, presupuesto) {
  const p50 = percentil(tiempos, 0.50);
  const p95 = percentil(tiempos, 0.95);
  const peor = Math.max(...tiempos);
  const bien = p95 <= presupuesto;
  console.log(
    '  ' + (bien ? C.ok('✓') : C.mal('✗')) + ' ' + nombre.padEnd(34) +
    'p50 ' + p50.toFixed(1).padStart(6) + ' ms   ' +
    'p95 ' + p95.toFixed(1).padStart(6) + ' ms   ' +
    'peor ' + peor.toFixed(1).padStart(6) + ' ms' +
    C.gris('   presupuesto ' + presupuesto + ' ms')
  );
  return bien;
}

async function cronometrar(veces, tarea) {
  const tiempos = [];
  for (let i = 0; i < veces; i++) {
    const t0 = performance.now();
    await tarea(i);
    tiempos.push(performance.now() - t0);
  }
  return tiempos;
}

(async () => {
  ['', '-wal', '-shm'].forEach(s => { if (fs.existsSync(BASE + s)) fs.unlinkSync(BASE + s); });
  fs.copyFileSync(path.join(RAIZ, 'pos_evento.db'), BASE);

  const hijo = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, { PORT: String(PUERTO), DB_FILE: BASE }),
    stdio: 'ignore'
  });

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(URL + '/api/productos')).ok) break; } catch (e) { /* aún no */ }
    await esperar(250);
  }

  // Stock de sobra: se mide la velocidad, no el agotamiento.
  const base = new DatabaseSync(BASE);
  base.exec('UPDATE producto SET stock_actual = 1000000');

  // Fotos en todos los productos, del tamaño que salen de la tablet (~30 KB).
  // Sin esto se mide un catálogo vacío y no se ve el problema de verdad: el
  // montaje real lleva foto en cada producto.
  if (arg('fotos', 1) === 1) {
    const relleno = 'A'.repeat(30 * 1024);
    const poner = base.prepare('UPDATE producto SET foto = ? WHERE id_producto = ?');
    base.prepare('SELECT id_producto FROM producto').all()
      .forEach(p => poner.run('data:image/jpeg;base64,' + relleno, p.id_producto));
  }
  base.close();

  const { productos } = await (await fetch(URL + '/api/productos')).json();
  const idBarra = (await (await fetch(URL + '/api/instancia')).json()).id_barra || 1;

  console.log(C.tit('\n  MasterDrinks · cuánto tarda cada cosa'));
  console.log(C.gris('  ' + VENTAS + ' ventas sobre una copia de tu base\n'));

  let todoBien = true;

  // ---- 1. Abrir la caja -------------------------------------------------
  // Es lo primero que ve el cajero al entrar. Con el catálogo con fotos, es
  // también la respuesta más pesada del servidor.
  const catalogo = await cronometrar(20, async () => {
    await (await fetch(URL + '/api/productos')).json();
  });
  todoBien &= resumen('Cargar el catálogo', catalogo, 120);

  // ---- 2. Comprobar el stock (cada 12 s en cada tablet) -----------------
  const RUTA_STOCK = arg('rutaStock', 0) === 1 ? '/api/productos' : '/api/stock';
  let pesoSondeo = 0;
  const stock = await cronometrar(30, async () => {
    const txt = await (await fetch(URL + RUTA_STOCK)).text();
    pesoSondeo = txt.length;
  });
  todoBien &= resumen('Sondeo de stock (' + RUTA_STOCK + ')', stock, 60);
  console.log(C.gris('      cada sondeo mueve ' + (pesoSondeo / 1024).toFixed(1) +
    ' KB · cada 12 s · por tablet'));

  // ---- 3. Cobrar --------------------------------------------------------
  // Lo que ocurre entre que el cajero pulsa CONFIRMAR y aparece el ticket.
  // Es el momento en que hay alguien esperando con el dinero en la mano.
  const productosSueltos = productos.filter(p => !p.requiere_acompanante && !p.es_acompanante);
  const poolLineas = productosSueltos.length >= 3 ? productosSueltos : productos;
  const tresLineas = poolLineas.slice(0, 3).map(p => ({
    id_producto: p.id_producto, cantidad: 2,
    precio_unitario: p.precio_venta, subtotal: p.precio_venta * 2
  }));
  const totalTres = tresLineas.reduce((s, i) => s + i.subtotal, 0);

  const cobros = await cronometrar(VENTAS, async i => {
    const res = await fetch(URL + '/api/comanda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id_evento: 1, id_barra: idBarra, id_cajero: 1, id_mesero: 1,
        observaciones: '', clave_idempotencia: 'medir-' + Date.now() + '-' + i,
        total: totalTres, items: tresLineas,
        metodos_pago: [{ id_metodo_pago: 1, monto: totalTres }]
      })
    });
    if (!res.ok) throw new Error('la venta falló con ' + res.status);
  });
  todoBien &= resumen('Cobrar (3 líneas, 6 unidades)', cobros, 150);

  // ---- 4. Cobrar un pedido grande ---------------------------------------
  const diezLineas = (poolLineas.length >= 10 ? poolLineas.slice(0, 10) : poolLineas).map(p => ({
    id_producto: p.id_producto, cantidad: 1,
    precio_unitario: p.precio_venta, subtotal: p.precio_venta
  }));
  const totalDiez = diezLineas.reduce((s, i) => s + i.subtotal, 0);

  const grandes = await cronometrar(Math.max(20, Math.round(VENTAS / 4)), async i => {
    const res = await fetch(URL + '/api/comanda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id_evento: 1, id_barra: idBarra, id_cajero: 1, id_mesero: 1,
        observaciones: '', clave_idempotencia: 'medir-g-' + Date.now() + '-' + i,
        total: totalDiez, items: diezLineas,
        metodos_pago: [{ id_metodo_pago: 1, monto: totalDiez }]
      })
    });
    if (!res.ok) throw new Error('la venta falló con ' + res.status);
  });
  todoBien &= resumen('Cobrar (10 líneas)', grandes, 250);

  // ---- 5. Historial del panel -------------------------------------------
  const historial = await cronometrar(10, async () => {
    await (await fetch(URL + '/api/admin/comandas')).json();
  });
  todoBien &= resumen('Historial de comandas del panel', historial, 400);

  // ---- Tamaño de lo que viaja por el WiFi -------------------------------
  const cuerpo = await (await fetch(URL + '/api/productos')).text();
  console.log(C.gris('\n  El catálogo pesa ' + (cuerpo.length / 1024).toFixed(1) + ' KB por tablet.'));
  const conFoto = JSON.parse(cuerpo).productos.filter(p => p.tiene_foto).length;
  console.log(C.gris('  ' + conFoto + ' producto(s) con foto, que viajan aparte y se cachean.'));

  // Lo que cuesta una foto suelta, ya con su cabecera de caché.
  if (conFoto > 0) {
    const unId = JSON.parse(cuerpo).productos.find(p => p.tiene_foto).id_producto;
    const t0 = performance.now();
    const img = await fetch(URL + '/api/producto/' + unId + '/foto');
    const bytes = (await img.arrayBuffer()).byteLength;
    console.log(C.gris('  Una foto: ' + (bytes / 1024).toFixed(1) + ' KB en ' +
      (performance.now() - t0).toFixed(1) + ' ms · ' + img.headers.get('cache-control')));
  }

  hijo.kill('SIGTERM');
  await esperar(600);
  hijo.kill('SIGKILL');
  await esperar(400);
  ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(BASE + s); } catch (e) {} });

  console.log('');
  console.log(todoBien
    ? '  ' + C.ok('Todo dentro de presupuesto.') + '\n'
    : '  ' + C.mal('Algo se sale del presupuesto.') + '\n');
  process.exit(todoBien ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
