/* ==========================================================================
 * MasterDrinks — Prueba del cobro
 * ==========================================================================
 *
 * Tres cosas que se arreglaron aquí y que la caja nota al cerrar:
 *
 *  1. El pago mixto admite cualquier combinación. Antes era fijo "efectivo +
 *     un método", y tres personas pagando la misma comanda con tarjeta, QR y
 *     efectivo —que en una barra pasa todas las noches— no cabía.
 *
 *  2. No se puede cobrar de menos. El campo "¿con cuánto paga?" sólo servía
 *     para calcular el cambio: se podía escribir 20 en una venta de 50 y la
 *     comanda se guardaba como pagada entera. El descuadre salía al cerrar.
 *
 *  3. No quedan atajos que rellenen cifras solos. Un botón que escribe el
 *     importe por ti se pulsa sin mirar.
 *
 *   npm run test:pagos
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { JSDOM, VirtualConsole } = require('jsdom');

const RAIZ = path.join(__dirname, '..');
const BASE = path.join(RAIZ, 'pos_evento.pagos.db');
const PUERTO = 3814;
const URL = 'http://127.0.0.1:' + PUERTO;
const esperar = ms => new Promise(r => setTimeout(r, ms));

let fallos = 0;
const check = (n, ok, extra) => {
  console.log('  ' + (ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m') + ' ' + n +
    (extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''));
  if (!ok) fallos++;
};

async function abrirTablet() {
  const dom = new JSDOM(fs.readFileSync(path.join(RAIZ, 'public/index.html'), 'utf8'), {
    url: URL + '/', runScripts: 'outside-only', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  window.fetch = (u, o) => fetch(String(u).startsWith('http') ? u : URL + u, o);
  window.alert = m => { throw new Error('alert(): ' + m); };
  window.HTMLCanvasElement.prototype.getContext = () => null;
  await new Promise(r => {
    if (window.document.readyState === 'complete') return r();
    window.addEventListener('load', r, { once: true });
  });
  window.eval(fs.readFileSync(path.join(RAIZ, 'public/rawbt.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(RAIZ, 'public/app.js'), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await esperar(250);

  const t = {
    window,
    $: s => window.document.querySelector(s),
    $$: s => [...window.document.querySelectorAll(s)],
    id: x => window.document.getElementById(x),
    click: el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    escribir: (el, v) => {
      el.value = v;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
  };

  t.id('login-username').value = 'cajero_norte_1';
  t.id('login-password').value = 'demo123';
  t.$('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await esperar(400);
  for (const d of '1009') t.click(t.$('.pin-btn[data-key="' + d + '"]'));
  await esperar(600);
  return t;
}

(async () => {
  const o = new DatabaseSync(path.join(RAIZ, 'pos_evento.db'));
  o.exec('PRAGMA wal_checkpoint(TRUNCATE)'); o.close();
  ['', '-wal', '-shm'].forEach(s => { if (fs.existsSync(BASE + s)) fs.unlinkSync(BASE + s); });
  fs.copyFileSync(path.join(RAIZ, 'pos_evento.db'), BASE);
  const dbInit = new DatabaseSync(BASE);
  dbInit.exec('UPDATE producto SET stock_actual = 20 WHERE id_producto IN (4, 33)');
  dbInit.close();

  const srv = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ, env: Object.assign({}, process.env, { PORT: String(PUERTO), DB_FILE: BASE }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(URL + '/api/productos')).ok) break; } catch (e) { /* aún no */ }
    await esperar(250);
  }

  console.log('\n\x1b[1m\x1b[36m  El cobro\x1b[0m');
  console.log('\x1b[90m  Cualquier mezcla de pagos, y ni un céntimo de menos.\x1b[0m\n');

  const t = await abrirTablet();

  // ---- No quedan atajos que rellenen cifras solos ----
  check('No queda ningún atajo de billetes en el cobro',
    t.$$('.quick-cash-btn').length === 0,
    t.$$('.quick-cash-btn').length + ' encontrados');
  check('Ni el ajuste de "esperar a que pulse Imprimir"',
    !t.id('cfg-auto'), 'la comanda sale sola al cobrar');
  check('Ni el botón de imprimir comanda de prueba',
    !t.id('printer-test-btn') && !t.id('printer-config-btn'),
    'la barra del POS ya no tiene botón de impresora');
  check('Los ajustes de impresora viven en el panel',
    !!t.id('printer-settings'),
    'en el panel de admin');

  // ---- Una venta cualquiera en el carrito ----
  // Un producto que se venda solo: los que piden acompañante abren otro modal
  // y aquí lo que se prueba es el cobro, no esa pantalla.
  const db0 = new DatabaseSync(BASE);
  const sueltos = db0.prepare(`SELECT id_producto FROM producto
      WHERE activo = 1 AND stock_actual > 3
        AND COALESCE(requiere_acompanante, 0) = 0
        AND COALESCE(es_acompanante, 0) = 0`).all().map(r => String(r.id_producto));
  db0.close();

  // La rejilla enseña una categoría cada vez, así que se coge el primero de
  // los que estén pintados ahora mismo y se venda solo.
  const card = t.$$('.product-card').find(c => sueltos.includes(c.dataset.id));
  check('Hay un producto que se vende solo en pantalla', !!card,
    sueltos.length + ' candidatos en la base');
  t.click(card);
  await esperar(150);
  t.click(t.id('finalize-order-btn'));
  await esperar(250);

  const total = parseFloat(t.id('pay-total').textContent);
  check('El modal de cobro se abre con su total', total > 0, total + ' Bs.');

  // ---- No se puede pagar de menos en efectivo ----
  t.escribir(t.id('pay-recibido'), (total - 1).toFixed(2));
  t.click(t.id('pay-confirm-btn'));
  await esperar(250);
  const err = t.id('pay-error');
  check('Pagar con menos de lo que cuesta se rechaza',
    !err.classList.contains('hide') && /falta/i.test(err.textContent),
    err.textContent);

  // ---- Mixto: cualquier combinación, no sólo efectivo + uno ----
  t.click(t.$('.pay-tab[data-metodo="mixto"]'));
  await esperar(150);

  const selects = () => t.$$('#pay-lineas select');
  const montos = () => t.$$('#pay-lineas input');
  check('El mixto arranca con dos líneas de pago', selects().length === 2,
    selects().length + ' líneas');

  const opciones = [...selects()[0].options].map(o => o.textContent);
  check('Cada línea puede ser cualquier método, también efectivo',
    opciones.length === 4 && opciones.some(x => /efectivo/i.test(x)),
    opciones.join(', '));

  t.click(t.id('pay-add-linea'));
  await esperar(100);
  check('Se pueden añadir más de dos', selects().length === 3,
    selects().length + ' líneas');

  // Tarjeta + QR + transferencia, sin una sola línea de efectivo: el caso que
  // antes era imposible de cobrar.
  const tercio = Math.floor((total / 3) * 100) / 100;
  const resto = Math.round((total - tercio * 2) * 100) / 100;
  [2, 3, 4].forEach((m, i) => { selects()[i].value = String(m); });
  selects().forEach(s => s.dispatchEvent(new t.window.Event('change', { bubbles: true })));
  t.escribir(montos()[0], tercio.toFixed(2));
  t.escribir(montos()[1], tercio.toFixed(2));
  t.escribir(montos()[2], resto.toFixed(2));
  await esperar(150);

  check('Con las líneas cuadradas, el "falta" se pone a cero',
    Math.abs(parseFloat(t.id('pay-falta').textContent)) < 0.005,
    t.id('pay-falta').textContent);

  t.click(t.id('pay-confirm-btn'));
  await esperar(900);

  const db = new DatabaseSync(BASE);
  const ultima = db.prepare('SELECT MAX(id_comanda) id FROM comanda').get().id;
  const pagos = db.prepare(
    `SELECT mp.nombre, p.monto FROM pago_comanda p
     JOIN metodo_pago mp ON mp.id_metodo_pago = p.id_metodo_pago
     WHERE p.id_comanda = ? ORDER BY mp.id_metodo_pago`).all(ultima);
  db.close();

  check('La venta se guarda repartida en las tres formas de pago',
    pagos.length === 3, pagos.map(p => p.nombre + ' ' + p.monto).join(' | '));
  check('Y sin una sola línea de efectivo',
    pagos.length === 3 && !pagos.some(p => /efectivo/i.test(p.nombre)),
    pagos.map(p => p.nombre).join(', '));
  const sumado = Math.round(pagos.reduce((s, p) => s + p.monto, 0) * 100) / 100;
  check('Los importes suman exactamente el total', Math.abs(sumado - total) < 0.005,
    sumado + ' de ' + total);

  // ---- Tras cobrar: vista previa de comandas y botón Continuar ----
  check('Se abre la ventana de vista previa de comandas',
    !t.id('print-modal').classList.contains('hide'), 'modal de vista previa visible');
  check('La previsualización de las dos comandas está presente',
    !!t.id('ticket-cajero-body') && !!t.id('ticket-mesero-body'),
    'cajero y mesero');

  t.click(t.id('dismiss-print-btn'));
  await esperar(100);

  check('La tablet vuelve a la pantalla del PIN al continuar',
    !t.id('waiter-lock-modal').classList.contains('hide'),
    'sin que nadie pulse Continuar');
  check('Y el carrito queda vacío para la siguiente venta',
    t.$$('.cart-item').length === 0,
    t.$$('.cart-item').length + ' líneas en el carrito');

  console.log('');
  console.log(fallos === 0
    ? '  \x1b[32mEl cobro admite cualquier mezcla y no acepta de menos.\x1b[0m\n'
    : '  \x1b[31m' + fallos + ' fallidas.\x1b[0m\n');

  srv.kill('SIGTERM');
  await esperar(600);
  srv.kill('SIGKILL');
  ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(BASE + s); } catch (e) {} });
  process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
