/* ==========================================================================
 * MasterDrinks — Prueba de stock compartido entre tablets
 * ==========================================================================
 *
 * Abre DOS tablets simuladas contra el MISMO servidor. La A cobra una venta y
 * se comprueba que la B se entera sola, sin que nadie la toque: ajusta su
 * carrito a lo que queda de verdad y avisa al cajero.
 *
 * Es lo que evita el peor momento de la barra: descubrir que no hay stock al
 * cobrar, con el pedido ya tomado y el cliente delante.
 *
 *   npm run test:sync
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { JSDOM, VirtualConsole } = require('jsdom');

const RAIZ = path.join(__dirname, '..');
const BASE = path.join(RAIZ, 'pos_evento.dos.db');
const PUERTO = 3810;
const URL = 'http://127.0.0.1:' + PUERTO;
const esperar = ms => new Promise(r => setTimeout(r, ms));

let fallos = 0;
const check = (n, ok, extra) => {
  console.log('  ' + (ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m') + ' ' + n +
    (extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''));
  if (!ok) fallos++;
};

async function abrirTablet(nombre) {
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
  await esperar(150);

  const t = {
    nombre, window,
    $: s => window.document.querySelector(s),
    id: x => window.document.getElementById(x),
    click: el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  };

  // Sesión de cajero + PIN de mesero
  t.id('login-username').value = nombre === 'A' ? 'cajero_norte_1' : 'cajero_norte_2';
  t.id('login-password').value = 'demo123';
  t.$('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 40; i++) {
    if (!t.id('waiter-lock-modal').classList.contains('hide')) break;
    await esperar(100);
  }
  for (const d of '1009') {
    const btn = t.$('.pin-btn[data-key="' + d + '"]');
    if (btn) t.click(btn);
  }
  for (let i = 0; i < 40; i++) {
    if (!t.id('pos-view').classList.contains('hide')) break;
    await esperar(100);
  }
  return t;
}

const stockEnPantalla = (t, idProd) => {
  const card = t.window.document.querySelector(`.product-card[data-id="${idProd}"]`);
  return card ? parseInt(card.querySelector('.stock').textContent.replace(/\D/g, ''), 10) : null;
};

(async () => {
  // ---- servidor sobre una copia, con poco stock para forzar el caso ----
  const o = new DatabaseSync(path.join(RAIZ, 'pos_evento.db'));
  o.exec('PRAGMA wal_checkpoint(TRUNCATE)'); o.close();
  ['', '-wal', '-shm'].forEach(s => { if (fs.existsSync(BASE + s)) fs.unlinkSync(BASE + s); });
  fs.copyFileSync(path.join(RAIZ, 'pos_evento.db'), BASE);
  const db = new DatabaseSync(BASE);
  const targetProd = db.prepare('SELECT id_producto FROM producto WHERE activo = 1 AND COALESCE(requiere_acompanante, 0) = 0 AND COALESCE(es_acompanante, 0) = 0 LIMIT 1').get() || { id_producto: 1 };
  const targetId = targetProd.id_producto;
  db.prepare('UPDATE producto SET stock_actual = 6 WHERE id_producto = ?').run(targetId);
  db.close();

  const srv = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ, env: Object.assign({}, process.env, { PORT: String(PUERTO), DB_FILE: BASE }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(URL + '/api/productos')).ok) break; } catch (e) { /* aún no */ }
    await esperar(250);
  }

  console.log('\n\x1b[1m\x1b[36m  Dos tablets, un servidor\x1b[0m');
  console.log(`\x1b[90m  Producto ${targetId} con 6 unidades. La tablet A vende; la B no toca nada.\x1b[0m\n`);

  const A = await abrirTablet('A');
  const B = await abrirTablet('B');

  const dCat = new DatabaseSync(BASE);
  const catTarget = dCat.prepare('SELECT c.nombre FROM categoria_producto c JOIN producto p ON p.id_categoria = c.id_categoria WHERE p.id_producto = ?').get(targetId);
  dCat.close();
  if (catTarget) {
    const irACat = t => {
      const btn = [...t.window.document.querySelectorAll('#category-list .category-btn')].find(b => b.textContent.toLowerCase().includes(catTarget.nombre.toLowerCase()));
      if (btn) t.click(btn);
    };
    irACat(A);
    irACat(B);
    await esperar(150);
  }

  check('Las dos arrancan viendo el mismo stock',
    stockEnPantalla(A, targetId) === 6 && stockEnPantalla(B, targetId) === 6,
    'A=' + stockEnPantalla(A, targetId) + '  B=' + stockEnPantalla(B, targetId));

  // ---- La tablet B mete 4 unidades en su carrito (sin cobrar) ----
  const cardB = B.window.document.querySelector(`.product-card[data-id="${targetId}"]`);
  for (let i = 0; i < 4; i++) B.click(cardB);
  await esperar(100);
  check('B ve bajar su tarjeta al llenar el carrito (cuenta local)',
    stockEnPantalla(B, targetId) === 2, 'B muestra ' + stockEnPantalla(B, targetId));

  const stockReal = () => {
    const d = new DatabaseSync(BASE);
    const r = d.prepare('SELECT stock_actual FROM producto WHERE id_producto = ?').get(targetId);
    d.close(); return r.stock_actual;
  };
  check('Meter algo en el carrito NO reserva nada en el servidor',
    stockReal() === 6, 'en la base siguen ' + stockReal());

  // ---- La tablet A vende 5 unidades de verdad ----
  const cardA = A.window.document.querySelector(`.product-card[data-id="${targetId}"]`);
  for (let i = 0; i < 5; i++) A.click(cardA);
  await esperar(100);
  A.click(A.id('finalize-order-btn'));
  const exactBtn = A.$('.quick-cash-btn.exact');
  if (exactBtn) A.click(exactBtn);
  await esperar(100);
  A.click(A.id('pay-confirm-btn'));
  await esperar(1500);
  check('A cobra 5 unidades', stockReal() === 1, 'quedan ' + stockReal() + ' en la base');

  // ---- B no ha tocado nada. ¿Se entera sola? ----
  console.log('\x1b[90m\n  Esperando a que B se dé cuenta sola (sondeo cada 12 s)...\x1b[0m');
  const t0 = Date.now();
  let avisada = false;
  while (Date.now() - t0 < 20000) {
    const toasts = [...B.window.document.querySelectorAll('#toast-stack .toast-text')]
      .map(x => x.textContent);
    if (toasts.some(x => /quedan|vendió/i.test(x))) { avisada = true; break; }
    await esperar(500);
  }
  const segundos = ((Date.now() - t0) / 1000).toFixed(1);

  check('B se entera sola, sin que nadie la toque', avisada, 'tardó ' + segundos + ' s');
  check('B ajustó su carrito a lo que queda de verdad',
    B.window.document.querySelectorAll('.cart-item').length === 1 &&
    B.window.document.querySelector('.cart-item .qty').textContent === '1',
    'llevaba 4, ahora ' + (B.window.document.querySelector('.cart-item .qty') || {}).textContent);

  // La tarjeta muestra lo que queda MENOS lo que ya llevas en el carrito, así
  // que con 1 en la base y 1 en el carrito tiene que decir "Agotado".
  const textoTarjetaB = B.window.document
    .querySelector(`.product-card[data-id="${targetId}"] .stock`).textContent;
  check('B muestra "Agotado" porque su única unidad ya está en su carrito',
    /agotado/i.test(textoTarjetaB), textoTarjetaB);

  // Al vaciar el carrito debe reaparecer la unidad que sí existe.
  B.click(B.window.document.querySelector('.cart-item .remove-item-btn'));
  await esperar(150);
  check('Al vaciar el carrito, B muestra la unidad real que queda',
    stockEnPantalla(B, targetId) === 1,
    'B muestra ' + stockEnPantalla(B, targetId) + ', en la base hay ' + stockReal());
  const aviso = [...B.window.document.querySelectorAll('#toast-stack .toast-text')]
    .map(x => x.textContent).find(x => /quedan|vendió/i.test(x));
  check('B avisa al cajero con un mensaje claro', !!aviso, aviso);

  console.log('');
  console.log(fallos === 0
    ? '  \x1b[32mEl stock se comparte entre tablets.\x1b[0m\n'
    : '  \x1b[31m' + fallos + ' fallidas.\x1b[0m\n');

  srv.kill('SIGTERM');
  await esperar(600);
  try { srv.kill('SIGKILL'); } catch (e) {}
  ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(BASE + s); } catch (e) {} });
  process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
