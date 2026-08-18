/* ==========================================================================
 * MasterDrinks — Capturas de pantalla de la interfaz
 * ==========================================================================
 *
 * Levanta un servidor sobre una copia de la base, abre la app en Chrome sin
 * ventana y guarda una imagen de cada pantalla en tools/capturas/.
 *
 * Existe porque la interfaz no se puede juzgar leyendo CSS. La primera vez que
 * se miraron estas capturas apareció un fallo que llevaba tiempo ahí y que
 * nadie había visto: el analizador de color del fondo dejaba el degradado de
 * marca en blanco, y los botones de "Iniciar Sesión" y "CONFIRMAR PAGO" salían
 * blancos sobre blanco, con pinta de estar desactivados.
 *
 *   node tools/capturas.js
 *   node tools/capturas.js --ancho 900 --alto 1400     (tablet en vertical)
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = path.join(__dirname, '..');
const BASE = path.join(RAIZ, 'pos_evento.shot.db');
const SALIDA = path.join(__dirname, 'capturas');
const PUERTO = 3900;
const URL = 'http://127.0.0.1:' + PUERTO;

const arg = (nombre, pordefecto) => {
  const i = process.argv.indexOf('--' + nombre);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
};
const ANCHO = arg('ancho', '1280');
const ALTO = arg('alto', '800');

const esperar = ms => new Promise(r => setTimeout(r, ms));

// Chrome o Edge, donde suelen instalarse en Windows.
function buscarNavegador() {
  const candidatos = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  ];
  return candidatos.find(c => c && fs.existsSync(c)) || null;
}

/**
 * Genera public/_shot.html: la app con un piloto automático que la deja en la
 * pantalla que se quiere fotografiar. Es temporal y se borra al terminar.
 */
function crearPaginaPiloto() {
  const html = fs.readFileSync(path.join(RAIZ, 'public/index.html'), 'utf8');
  const piloto = `
<script>
(function () {
  var paso = new URLSearchParams(location.search).get('paso') || 'pos';
  var q = function (s) { return document.querySelector(s); };
  var id = function (x) { return document.getElementById(x); };
  var click = function (el) { if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };

  window.addEventListener('load', function () {
    if (paso === 'login') return;
    setTimeout(function () {
      var esAdmin = paso === 'admin' || paso === 'personal';
      id('login-username').value = esAdmin ? 'admin_evento' : 'cajero_norte_1';
      id('login-password').value = 'demo123';
      q('#login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      if (paso === 'pin' || paso === 'admin') return;
      if (paso === 'personal') {
        setTimeout(function () { click(q('[data-tab="tab-crear-personal"]')); }, 600);
        return;
      }

      setTimeout(function () {
        '1009'.split('').forEach(function (d) { click(q('.pin-btn[data-key="' + d + '"]')); });
        setTimeout(function () {
          var cards = document.querySelectorAll('.product-card:not(.out-of-stock)');
          click(cards[0]); click(cards[0]); click(cards[2]); click(cards[5]);
          id('cart-observations').value = 'Sin hielo en los whiskys';
          if (paso === 'pos') return;
          setTimeout(function () {
            click(id('finalize-order-btn'));
            if (paso === 'cobro') return;
            setTimeout(function () {
              click(q('.pay-tab[data-metodo="' + (paso === 'qr' ? '3' : 'mixto') + '"]'));
            }, 400);
          }, 400);
        }, 1000);
      }, 800);
    }, 300);
  });
})();
<\/script>
`;
  fs.writeFileSync(path.join(RAIZ, 'public/_shot.html'), html.replace('</body>', piloto + '</body>'));
}

(async () => {
  const navegador = buscarNavegador();
  if (!navegador) {
    console.error('\n  No encuentro Chrome ni Edge. Las capturas necesitan uno de los dos.\n');
    process.exit(1);
  }

  const origen = new DatabaseSync(path.join(RAIZ, 'pos_evento.db'));
  origen.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  origen.close();
  ['', '-wal', '-shm'].forEach(s => { if (fs.existsSync(BASE + s)) fs.unlinkSync(BASE + s); });
  fs.copyFileSync(path.join(RAIZ, 'pos_evento.db'), BASE);
  fs.mkdirSync(SALIDA, { recursive: true });
  crearPaginaPiloto();

  const servidor = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, {
      PORT: String(PUERTO), DB_FILE: BASE
    }),
    stdio: 'ignore'
  });

  let arriba = false;
  for (let i = 0; i < 40 && !arriba; i++) {
    try { arriba = (await fetch(URL + '/api/productos')).ok; } catch (e) { /* aún no */ }
    if (!arriba) await esperar(250);
  }

  const limpiar = async () => {
    servidor.kill('SIGKILL');
    try { fs.unlinkSync(path.join(RAIZ, 'public/_shot.html')); } catch (e) {}
  // Windows no suelta el archivo en el mismo instante en que muere el
  // proceso, así que se espera un momento antes de borrar; si no, el
  // unlink falla en silencio y la base se queda en la carpeta igual.
    await esperar(400);
    ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(BASE + s); } catch (e) {} });
  };

  if (!arriba) { console.error('  El servidor no arrancó.'); await limpiar(); process.exit(1); }

  console.log('\n  Capturando a ' + ANCHO + '×' + ALTO + '...\n');
  for (const paso of ['login', 'pin', 'pos', 'cobro', 'qr', 'mixto', 'admin', 'personal']) {
    const destino = path.join(SALIDA, paso + '.png');
    spawnSync(navegador, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
      '--user-data-dir=' + path.join(require('os').tmpdir(), 'md-capturas'),
      '--virtual-time-budget=9000',
      '--window-size=' + ANCHO + ',' + ALTO,
      '--screenshot=' + destino,
      URL + '/_shot.html?paso=' + paso
    ], { stdio: 'ignore' });
    const ok = fs.existsSync(destino);
    console.log('  ' + (ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m') + ' ' + paso +
      (ok ? '\x1b[90m  ' + (fs.statSync(destino).size / 1024).toFixed(0) + ' KB\x1b[0m' : ''));
  }

  console.log('\n  Guardadas en tools/capturas/\n');
  await limpiar();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
