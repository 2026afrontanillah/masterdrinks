/* ==========================================================================
 * MasterDrinks — Pruebas de interfaz
 * ==========================================================================
 *
 * Carga index.html + app.js en un navegador simulado (jsdom) y recorre una
 * venta entera como la haría un cajero, hablando con un servidor de verdad
 * levantado sobre una copia de la base. Es lo único que cubre el código que
 * corre en la tablet: sin esto, un fallo en app.js no lo ve nadie hasta el
 * evento.
 *
 *   npm install          (una vez, para traer jsdom)
 *   node tools/ui-test.js
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.error('\n  Falta jsdom, que es lo que simula el navegador.');
  console.error('  Instálalo con:  npm install\n');
  process.exit(1);
}

const RAIZ = path.join(__dirname, '..');
const BASE_ORIGEN = path.join(RAIZ, 'pos_evento.db');
const BASE = path.join(RAIZ, 'pos_evento.ui.db');
const PUERTO = Number(process.argv[process.argv.indexOf('--puerto') + 1]) || 3377;
const URL_BASE = 'http://127.0.0.1:' + PUERTO;

const esperar = ms => new Promise(r => setTimeout(r, ms));
const C = {
  ok: s => '\x1b[32m' + s + '\x1b[0m',
  mal: s => '\x1b[31m' + s + '\x1b[0m',
  dim: s => '\x1b[90m' + s + '\x1b[0m',
  tit: s => '\x1b[1m\x1b[36m' + s + '\x1b[0m'
};

let fallos = 0;
const check = (nombre, ok, extra) => {
  console.log('  ' + (ok ? C.ok('✓') : C.mal('✗')) + ' ' + nombre + (extra ? C.dim('  ' + extra) : ''));
  if (!ok) fallos++;
};

(async () => {
  // ---- copia de la base y servidor propio ----
  const origen = new DatabaseSync(BASE_ORIGEN);
  origen.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  origen.close();
  ['', '-wal', '-shm'].forEach(s => { if (fs.existsSync(BASE + s)) fs.unlinkSync(BASE + s); });
  fs.copyFileSync(BASE_ORIGEN, BASE);

  const servidor = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, { RENOMBRAR_BARRA: '1', PORT: String(PUERTO), DB_FILE: BASE }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const registro = [];
  servidor.stdout.on('data', d => registro.push(String(d)));
  servidor.stderr.on('data', d => registro.push(String(d)));

  let arriba = false;
  for (let i = 0; i < 40 && !arriba; i++) {
    try { arriba = (await fetch(URL_BASE + '/api/productos')).ok; } catch (e) { /* aún no */ }
    if (!arriba) await esperar(250);
  }
  if (!arriba) {
    console.error(C.mal('  El servidor no arrancó:\n') + registro.join(''));
    servidor.kill();
    process.exit(1);
  }

  const terminar = codigo => {
    servidor.kill('SIGTERM');
    setTimeout(() => { servidor.kill('SIGKILL'); process.exit(codigo); }, 500);
  };

  // ---- navegador simulado ----
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.error('  [navegador]', e.message));

  const dom = new JSDOM(fs.readFileSync(path.join(RAIZ, 'public/index.html'), 'utf8'), {
    url: URL_BASE + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const { window } = dom;

  window.fetch = (url, opts) => fetch(String(url).startsWith('http') ? url : URL_BASE + url, opts);
  // Si alguien vuelve a meter un alert(), la prueba lo caza aquí: en la tablet
  // es un diálogo del sistema que bloquea la caja.
  window.alert = msg => { throw new Error('Se ha colado un alert(): ' + msg); };
  window.HTMLCanvasElement.prototype.getContext = () => null;

  // Hay que esperar a que el documento termine de cargar ANTES de evaluar
  // app.js. Si no, jsdom dispara su propio DOMContentLoaded después del que
  // lanzamos a mano, app.js se inicializa dos veces y quedan dos juegos de
  // variables peleándose por los mismos elementos: el carrito se llena en uno
  // y el otro, vacío, pisa los cálculos del cobro. En un navegador de verdad
  // el evento salta una sola vez, así que era la prueba la que mentía.
  await new Promise(resolve => {
    if (window.document.readyState === 'complete') return resolve();
    window.addEventListener('load', resolve, { once: true });
  });

  window.eval(fs.readFileSync(path.join(RAIZ, 'public/rawbt.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(RAIZ, 'public/app.js'), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await esperar(150);

  const $ = sel => window.document.querySelector(sel);
  const id = x => window.document.getElementById(x);
  const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const escribir = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const visible = el => !el.classList.contains('hide');

  // =======================================================================
  console.log(C.tit('\n  Sesión'));
  // =======================================================================
  id('login-username').value = 'cajero_norte_1';
  id('login-password').value = 'demo123';
  $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await esperar(400);
  // La tablet tiene que decir a qué barra está conectada antes de cobrar nada.
  check('La pantalla muestra la barra a la que está conectada',
    [...window.document.querySelectorAll('.instancia-badge')].some(el => !visible(el) === false && el.textContent),
    (window.document.querySelector('.instancia-badge') || {}).textContent);
  check('El título de la pestaña lleva la barra, para distinguir los accesos directos',
    /^MasterDrinks · .+/.test(window.document.title), window.document.title);

  check('El cajero entra y sale la pantalla del PIN', visible(id('waiter-lock-modal')));

  for (const d of '1009') click($('.pin-btn[data-key="' + d + '"]'));
  await esperar(600);
  check('El PIN de un mesero de otra caja abre la venta', visible(id('pos-view')),
    'mesero: ' + id('pos-mesero-label').textContent);

  // =======================================================================
  console.log(C.tit('\n  Rejilla de productos'));
  // =======================================================================
  const tarjetas = window.document.querySelectorAll('.product-card:not(.out-of-stock)');
  // Todas las tarjetas, agotadas incluidas. Se guarda aparte porque más abajo
  // hay que comparar catálogo completo con catálogo completo: si la base tiene
  // algún producto agotado, mezclar ambas cuentas hace fallar la prueba sin
  // que nada esté roto.
  const totalTarjetas = window.document.querySelectorAll('.product-card').length;
  check('Se pintó el catálogo', tarjetas.length > 0,
    tarjetas.length + ' con stock de ' + totalTarjetas + ' en total');
  check('Cada tarjeta lleva su id, para refrescarla sola',
    [...tarjetas].every(c => c.dataset.id));

  const primera = tarjetas[0];
  const idPrimera = primera.dataset.id;
  const stockAntes = parseInt(primera.querySelector('.stock').textContent.replace(/\D/g, ''), 10);

  click(primera);
  await esperar(60);
  check('Al añadir sale la insignia con las unidades',
    primera.querySelector('.cart-badge') && primera.querySelector('.cart-badge').textContent === '1');
  check('El stock de la tarjeta baja',
    parseInt(primera.querySelector('.stock').textContent.replace(/\D/g, ''), 10) === stockAntes - 1);
  check('La tarjeta es el mismo nodo: no se reconstruyó la rejilla',
    window.document.querySelector(`.product-card[data-id="${idPrimera}"]`) === primera);

  click(primera);
  click(tarjetas[1]);
  await esperar(80);
  check('La insignia se actualiza al repetir producto',
    primera.querySelector('.cart-badge').textContent === '2');

  // =======================================================================
  console.log(C.tit('\n  Carrito'));
  // =======================================================================
  check('El contador cuenta las líneas',
    id('cart-count').textContent === '2' && id('cart-count').classList.contains('tiene'));

  const fila = window.document.querySelector(`.cart-item[data-id="${idPrimera}"]`);
  check('Cada línea lleva su id', !!fila);
  click(fila.querySelector('.increase-btn'));
  await esperar(60);
  check('El + actualiza la línea en su sitio, sin recrearla',
    window.document.querySelector(`.cart-item[data-id="${idPrimera}"]`) === fila &&
    fila.querySelector('.qty').textContent === '3');
  click(fila.querySelector('.decrease-btn'));
  await esperar(60);
  check('El − también', fila.querySelector('.qty').textContent === '2');

  // =======================================================================
  console.log(C.tit('\n  Buscador'));
  // =======================================================================
  check('La ✕ está oculta con el campo vacío', !visible(id('search-clear-btn')));
  escribir(id('product-search'), 'cerveza');
  await esperar(60);
  check('Al escribir aparece la ✕', visible(id('search-clear-btn')));
  check('Filtrar no repite la cascada de entrada',
    [...window.document.querySelectorAll('.product-card')].every(c => !c.classList.contains('enter')));
  click(id('search-clear-btn'));
  await esperar(60);
  check('La ✕ limpia y devuelve el catálogo entero',
    id('product-search').value === '' &&
    window.document.querySelectorAll('.product-card').length === totalTarjetas,
    window.document.querySelectorAll('.product-card').length + ' de ' + totalTarjetas);
  check('El carrito sobrevive al filtrado', id('cart-count').textContent === '2');

  const total = parseFloat(id('cart-total-amount').textContent);

  // =======================================================================
  console.log(C.tit('\n  Cobro'));
  // =======================================================================
  check('El botón de cobrar se habilita con el carrito lleno', id('finalize-order-btn').disabled === false);
  click(id('finalize-order-btn'));
  await esperar(120);
  check('Se abre el modal de cobro', visible(id('payment-modal')));
  check('Muestra el total en grande', id('pay-total').textContent.startsWith(total.toFixed(2)));
  check('Trae las cinco formas de pago',
    window.document.querySelectorAll('.pay-tab').length === 5,
    [...window.document.querySelectorAll('.pay-tab span')].map(s => s.textContent).join(' · '));
  check('Arranca en Efectivo', $('.pay-tab.active').dataset.metodo === '1');

  click($('.quick-cash-btn[data-cash="200"]'));
  await esperar(80);
  check('Con un billete de 200 calcula el cambio',
    visible(id('pay-change-box')) &&
    id('pay-change-amount').textContent.startsWith((200 - total).toFixed(2)),
    id('pay-change-amount').textContent);
  click($('.quick-cash-btn.exact'));
  await esperar(80);
  check('Con "Justo" no hay cambio', !visible(id('pay-change-box')));

  click($('.pay-tab[data-metodo="mixto"]'));
  await esperar(60);
  check('Mixto abre el reparto en dos campos', visible(id('pay-panel-mixto')));
  escribir(id('pay-mixto-efectivo'), '10');
  await esperar(60);
  check('El resto se autocalcula',
    parseFloat(id('pay-mixto-resto').value).toFixed(2) === (total - 10).toFixed(2),
    'efectivo 10 → falta ' + id('pay-mixto-resto').value);
  id('pay-mixto-metodo').value = '4';
  id('pay-mixto-metodo').dispatchEvent(new window.Event('change', { bubbles: true }));
  await esperar(60);
  check('La etiqueta sigue al método elegido',
    id('pay-mixto-resto-label').textContent.includes('Transferencia'));

  escribir(id('pay-mixto-efectivo'), String(total + 50));
  await esperar(60);
  check('Avisa si el efectivo supera el total', visible(id('pay-error')), id('pay-error').textContent);
  escribir(id('pay-mixto-efectivo'), '10');
  await esperar(60);

  // =======================================================================
  console.log(C.tit('\n  Doble toque y ticket'));
  // =======================================================================
  const antes = await (await fetch(URL_BASE + '/api/admin/comandas')).json();
  const confirmar = id('pay-confirm-btn');
  click(confirmar);
  click(confirmar);   // el segundo y el tercero no deben llegar al servidor
  click(confirmar);
  await esperar(1400);
  const despues = await (await fetch(URL_BASE + '/api/admin/comandas')).json();
  check('Tres toques en CONFIRMAR crean UNA sola comanda',
    despues.length - antes.length === 1, 'creadas ' + (despues.length - antes.length));
  check('El modal se cierra al terminar', !visible(id('payment-modal')));

  const nueva = despues.find(c => !antes.some(a => a.id_comanda === c.id_comanda));
  const pagos = nueva.pagos || [];
  check('La venta quedó con dos pagos', pagos.length === 2,
    pagos.map(p => p.nombre_metodo + ' ' + p.monto).join(' + '));
  check('Los dos pagos suman el total',
    Math.abs(pagos.reduce((s, p) => s + Number(p.monto), 0) - Number(nueva.total)) < 0.01);

  const previa = id('ticket-cajero-body').textContent;
  // La referencia lleva el prefijo de la barra (N-47): con tres servidores
  // independientes el número solo no distingue una comanda de otra.
  check('El ticket lleva la marca y la referencia con prefijo de barra',
    previa.includes('MASTERDRINKS') && /COMANDA [A-Z0-9]{1,3}-\d+/.test(previa),
    (previa.match(/COMANDA [A-Z0-9-]+\d/) || [])[0]);
  check('El ticket imprime el precio unitario', / x \d+\.\d\d/.test(previa));
  check('El ticket refleja los dos métodos de pago',
    previa.includes('Efectivo') && previa.includes('Transferencia'));
  const previaMesero = id('ticket-mesero-body').textContent;
  check('El ticket de barra lleva casillas para tachar', previaMesero.includes('[ ]'));
  check('El ticket de barra avisa de que no es comprobante',
    previaMesero.includes('No es comprobante de pago'));

  // =======================================================================
  console.log(C.tit('\n  Reporte de cierre desde el panel'));
  // =======================================================================
  // Se entra como admin en la misma pantalla: el modal de impresión se cierra
  // y se cambia de sesión, igual que haría el encargado al terminar el turno.
  click(id('dismiss-print-btn'));
  await esperar(200);
  id('login-username').value = 'admin_evento';
  id('login-password').value = 'demo123';
  $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await esperar(500);
  check('El administrador entra al panel', visible(id('admin-view')));

  click(id('rep-hoy-btn'));
  await esperar(60);
  check('El botón "Hoy" rellena el rango con la fecha de hoy',
    /^\d{4}-\d{2}-\d{2}$/.test(id('rep-desde').value) &&
    id('rep-desde').value === id('rep-hasta').value, id('rep-desde').value);

  // Rango al revés: tiene que avisar sin llamar al servidor.
  id('rep-desde').value = '2026-12-31';
  id('rep-hasta').value = '2026-01-01';
  click(id('rep-ver-btn'));
  await esperar(120);
  check('Avisa si el rango está invertido',
    id('rep-preview').classList.contains('hide') ||
    !id('rep-preview').textContent.includes('Recaudado'));

  click(id('rep-todo-btn'));
  await esperar(60);
  check('"Todo el evento" limpia las fechas',
    id('rep-desde').value === '' && id('rep-hasta').value === '');

  click(id('rep-ver-btn'));
  await esperar(600);
  const resumen = id('rep-preview').textContent;
  check('El resumen en pantalla trae la recaudación',
    visible(id('rep-preview')) && /Recaudado/.test(resumen) && /Bs\./.test(resumen),
    (resumen.match(/Recaudado([\d.,]+ Bs\.)/) || []).slice(1).join(''));

  // La descarga: en jsdom no hay gestor de descargas, así que se comprueba que
  // la petición sale bien y devuelve un PDF de verdad.
  const resRep = await fetch(URL_BASE + '/api/admin/reporte.pdf');
  const buf = Buffer.from(await resRep.arrayBuffer());
  check('El panel puede descargar el PDF',
    resRep.ok && buf.toString('latin1', 0, 5) === '%PDF-',
    (buf.length / 1024).toFixed(1) + ' KB');

  console.log('');
  console.log(fallos === 0
    ? '  ' + C.ok('Todo correcto en la interfaz.') + '\n'
    : '  ' + C.mal(fallos + ' comprobación(es) fallidas.') + '\n');

  terminar(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(C.mal('  Error: '), e); process.exit(1); });
