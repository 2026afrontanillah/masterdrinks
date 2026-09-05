/* ==========================================================================
 * MasterDrinks — Prueba de identidad de la barra
 * ==========================================================================
 *
 * El encargado renombra la barra desde el panel, en SU tablet. El resto de
 * tablets ya estaban abiertas y nadie las va a tocar: están cobrando.
 *
 * Esta prueba comprueba que esas otras tablets se enteran del cambio solas.
 * Antes no lo hacían: el nombre se leía una única vez al abrir la página, así
 * que una tablet abierta por la mañana seguía rotulando la barra vieja toda la
 * noche, en pantalla y en los tickets impresos.
 *
 * También vigila que las respuestas de la API no se puedan quedar en la caché
 * del navegador. Si se quedan, recargar la tablet no arregla nada: le vuelven
 * a servir la identidad antigua desde su propio disco.
 *
 *   npm run test:identidad
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { JSDOM, VirtualConsole } = require('jsdom');

const RAIZ = path.join(__dirname, '..');
const BASE = path.join(RAIZ, 'pos_evento.ident.db');
const PUERTO = 3811;
const URL = 'http://127.0.0.1:' + PUERTO;
const esperar = ms => new Promise(r => setTimeout(r, ms));

const VIEJO = 'Barra 1';
const NUEVO = 'Chivas';

let fallos = 0;
const check = (n, ok, extra) => {
  console.log('  ' + (ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m') + ' ' + n +
    (extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''));
  if (!ok) fallos++;
};

// Una tablet cualquiera de la barra: abre la página y se queda en el login.
// No hace falta entrar para ver el rótulo, que es justo el punto: el nombre de
// la barra se enseña antes de que nadie inicie sesión.
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
  await esperar(300);
  return window;
}

// Lo que el cajero lee en el rótulo, sea cual sea la pantalla en la que esté.
const rotulo = window => {
  const el = [...window.document.querySelectorAll('.instancia-badge')]
    .find(x => x.textContent.trim());
  return el ? el.textContent.trim() : '';
};

(async () => {
  // ---- Una copia con el nombre de fábrica, como estaba antes del cambio ----
  const o = new DatabaseSync(path.join(RAIZ, 'pos_evento.db'));
  o.exec('PRAGMA wal_checkpoint(TRUNCATE)'); o.close();
  ['', '-wal', '-shm'].forEach(s => { if (fs.existsSync(BASE + s)) fs.unlinkSync(BASE + s); });
  fs.copyFileSync(path.join(RAIZ, 'pos_evento.db'), BASE);
  const db = new DatabaseSync(BASE);
  db.prepare('UPDATE barra SET nombre_barra = ?').run(VIEJO);
  db.prepare('UPDATE configuracion SET barra = ? WHERE id_configuracion = 1').run(VIEJO);
  db.prepare("UPDATE instancia SET valor = ? WHERE clave = 'nombre'").run(VIEJO);
  db.close();

  const srv = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ, env: Object.assign({}, process.env, { PORT: String(PUERTO), DB_FILE: BASE }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(URL + '/api/instancia')).ok) break; } catch (e) { /* aún no */ }
    await esperar(250);
  }

  console.log('\n\x1b[1m\x1b[36m  La barra cambia de nombre a media noche\x1b[0m');
  console.log('\x1b[90m  Una tablet ya abierta tiene que enterarse sin que nadie la recargue.\x1b[0m\n');

  // ---- La caché del navegador no puede guardar la identidad ----
  // Sin esto, recargar la tablet no sirve de nada: el navegador le devuelve la
  // respuesta vieja desde su disco sin llegar a preguntar al servidor.
  for (const ruta of ['/api/instancia', '/api/configuracion']) {
    const cc = (await fetch(URL + ruta)).headers.get('cache-control') || '';
    check('La respuesta de ' + ruta + ' se marca como no guardable',
      /no-store/.test(cc), cc ? 'Cache-Control: ' + cc : 'sin Cache-Control');
  }

  // ---- La tablet lleva abierta desde antes del cambio ----
  const tablet = await abrirTablet();
  check('La tablet arranca rotulando la barra que había', rotulo(tablet) === VIEJO, rotulo(tablet));

  // ---- El encargado la renombra desde otro aparato ----
  const guardado = await (await fetch(URL + '/api/admin/configuracion-evento', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      evento: 'Jessy & Joy', fecha: '2026-09-12', lugar: 'Fexco Arena',
      barra: NUEVO, responsable: ''
    })
  })).json();
  check('El panel guarda el nombre nuevo', guardado.success === true &&
    guardado.instancia.nombre === NUEVO, JSON.stringify(guardado.instancia || {}));

  // El servidor ya lo sabe; la tablet todavía no, porque nadie la ha tocado.
  const servidorDice = await (await fetch(URL + '/api/instancia')).json();
  check('El servidor ya sirve el nombre nuevo', servidorDice.nombre === NUEVO, servidorDice.nombre);

  // ---- Aquí estaba el fallo: la tablet no se enteraba nunca ----
  // El cajero vuelve a la pantalla (deja el móvil, mira la tablet). Ese gesto
  // es el que tiene que refrescar la identidad, sin esperar al temporizador.
  tablet.document.dispatchEvent(new tablet.Event('visibilitychange'));
  await esperar(400);
  check('La tablet abierta se entera al volver a la pantalla',
    rotulo(tablet) === NUEVO, 'rotula "' + rotulo(tablet) + '"');

  // ---- Y también sola, sin que nadie la toque ----
  const otra = await abrirTablet();
  check('Una tablet recién abierta rotula el nombre nuevo', rotulo(otra) === NUEVO, rotulo(otra));

  console.log('');
  console.log(fallos === 0
    ? '  \x1b[32mLa identidad de la barra viaja a todas las tablets.\x1b[0m\n'
    : '  \x1b[31m' + fallos + ' fallidas.\x1b[0m\n');

  srv.kill('SIGTERM');
  await esperar(600);
  srv.kill('SIGKILL');
  ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(BASE + s); } catch (e) {} });
  process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
