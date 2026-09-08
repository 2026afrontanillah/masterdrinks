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
// Las capturas de cada tamaño van a su propia carpeta, para poder comparar la
// misma pantalla en tablet y en escritorio sin que una pise a la otra.
const SALIDA = path.join(__dirname, 'capturas');
const PUERTO = 3900;
const URL = 'http://127.0.0.1:' + PUERTO;

const arg = (nombre, pordefecto) => {
  const i = process.argv.indexOf('--' + nombre);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
};
const ANCHO = arg('ancho', '1280');
const ALTO = arg('alto', '800');
const SUFIJO = process.argv.indexOf('--ancho') !== -1 ? '-' + ANCHO + 'x' + ALTO : '';

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
  // Los errores del navegador se escriben en el propio documento: con
  // --dump-dom se leen desde fuera, que es la única forma de enterarse de un
  // fallo de JavaScript en una captura sin consola.
  window.addEventListener('error', function (e) {
    var caja = document.getElementById('_fallo') || document.createElement('div');
    caja.id = '_fallo';
    caja.textContent += ' || ' + e.message + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno;
    document.documentElement.appendChild(caja);
  });
  var q = function (s) { return document.querySelector(s); };
  var id = function (x) { return document.getElementById(x); };
  var click = function (el) { if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };

  window.addEventListener('load', function () {
    if (paso === 'login') return;
    setTimeout(function () {
      var esAdmin = paso === 'admin' || paso === 'personal' || paso === 'catalogo' ||
        paso === 'productos' || paso === 'editar' || paso === 'stock' ||
        paso === 'promo-admin';
      id('login-username').value = esAdmin ? 'admin' : 'cajero_norte_1';
      id('login-password').value = esAdmin ? '123' : 'demo123';
      q('#login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      if (paso === 'pin' || paso === 'admin') return;
      if (paso === 'personal') {
        setTimeout(function () { click(q('[data-tab="tab-crear-personal"]')); }, 600);
        return;
      }
      if (paso === 'mover' || paso === 'mover-producto' || paso === 'agregar') {
        setTimeout(function () {
          '1009'.split('').forEach(function (d) { click(q('.pin-btn[data-key="' + d + '"]')); });
          setTimeout(function () {
            click(id(paso === 'agregar' ? 'agregar-stock-btn' : 'mover-stock-btn'));
            if (paso === 'mover' || paso === 'agregar') return;
            setTimeout(function () {
              id('mover-destino').value = 'Barra VIP';
              click(id('mover-a-producto'));
            }, 400);
          }, 1000);
        }, 800);
        return;
      }
      if (paso === 'acompanante' || paso === 'carrito-acomp') {
        setTimeout(function () {
          '1009'.split('').forEach(function (d) { click(q('.pin-btn[data-key="' + d + '"]')); });
          setTimeout(function () {
            // La botella marcada: al tocarla tiene que abrirse el cuadro.
            click(q('.product-card[data-id="9"]'));
            if (paso === 'acompanante') return;
            // Y para la otra captura, se elige uno y se mira el carrito.
            setTimeout(function () {
              // Dos de uno y uno de otro, que es el caso nuevo: se acabó la
              // grande y se dan dos pequeñas.
              var filas = document.querySelectorAll('.acomp-opcion:not(.agotada)');
              click(filas[0].querySelector('.acomp-opcion-texto'));
              click(filas[0].querySelector('.acomp-control button:last-child'));
              click(filas[filas.length - 1].querySelector('.acomp-opcion-texto'));
              setTimeout(function () {
                click(id('acomp-aceptar'));
                setTimeout(function () { click(q('.product-card[data-id="1"]')); }, 400);
              }, 400);
            }, 500);
          }, 1000);
        }, 800);
        return;
      }
      if (paso === 'catalogo') {
        setTimeout(function () { click(q('[data-tab="tab-crear-producto"]')); }, 600);
        return;
      }
      if (paso === 'editar') {
        // El cuadro de cambiar precio: lo que faltaba para corregir un
        // producto ya dado de alta sin borrarlo.
        setTimeout(function () {
          click(q('[data-tab="tab-crear-producto"]'));
          setTimeout(function () { click(q('#lista-productos .lista-editar')); }, 800);
        }, 600);
        return;
      }
      if (paso === 'promo-caja') {
        // El combo en la rejilla, y metido en el carrito.
        setTimeout(function () {
          '1009'.split('').forEach(function (d) { click(q('.pin-btn[data-key="' + d + '"]')); });
          setTimeout(function () {
            click(q('.promo-card'));
            setTimeout(function () { click(q('.promo-card')); }, 350);
          }, 900);
        }, 800);
        return;
      }
      if (paso === 'promo-admin') {
        setTimeout(function () {
          click(q('[data-tab="tab-promociones"]'));
          setTimeout(function () {
            // Se arma una para retratar el formulario a medio llenar.
            id('promo-nombre').value = 'Combo Fiesta';
            id('promo-desc').value = 'Un whisky y cuatro cervezas';
            var sel = id('promo-producto');
            sel.value = '10';
            click(id('promo-anadir'));
            setTimeout(function () {
              sel.value = '3';
              id('promo-cantidad').value = 4;
              click(id('promo-anadir'));
              id('promo-precio').value = 95;
              id('promo-precio').dispatchEvent(new Event('input', { bubbles: true }));
            }, 300);
          }, 800);
        }, 600);
        return;
      }
      if (paso === 'promo-ticket') {
        setTimeout(function () {
          '1009'.split('').forEach(function (d) { click(q('.pin-btn[data-key="' + d + '"]')); });
          setTimeout(function () {
            click(q('.promo-card'));
            setTimeout(function () {
              click(id('finalize-order-btn'));
              setTimeout(function () { click(id('pay-confirm-btn')); }, 600);
            }, 500);
          }, 900);
        }, 800);
        return;
      }
      if (paso === 'productos') {
        // La lista, no el formulario: es donde se vio el nombre recortado.
        setTimeout(function () {
          click(q('[data-tab="tab-crear-producto"]'));
          setTimeout(function () {
            var lista = id('lista-productos');
            if (lista) lista.scrollIntoView({ block: 'start' });
          }, 700);
        }, 600);
        return;
      }
      if (paso === 'stock') {
        setTimeout(function () { click(q('[data-tab="tab-stock"]')); }, 600);
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
            if (paso === 'ticket') {
              // Cobro en efectivo y adelante: lo que se quiere retratar es la
              // vista previa del ticket, no el modal de pago.
              setTimeout(function () { click(id('pay-confirm-btn')); }, 500);
              return;
            }
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


  // Un par de fotos de muestra, para que las capturas enseñen la rejilla como
  // se ve con el catálogo montado. Va DESPUÉS de arrancar el servidor: es él
  // quien crea la columna `foto` al migrar la base. La base real no se toca.
  try {
    const { DatabaseSync } = require('node:sqlite');
    const muestra = new DatabaseSync(BASE);
    // PNG de 1x1 opaco; object-fit: cover lo estira a toda la tarjeta.
    const PIX = {
      ambar: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mM04' +
             'p9VDwAEzQGpqZyIVwAAAABJRU5ErkJggg==',
      rojo:  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
             'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    };
    const poner = muestra.prepare('UPDATE producto SET foto = ? WHERE id_producto = ?');
    poner.run('data:image/png;base64,' + PIX.ambar, 1);
    poner.run('data:image/png;base64,' + PIX.rojo, 3);

    // Una botella con acompañante y tres refrescos que puedan serlo, para que
    // las capturas enseñen el cuadro de elegir como se ve en el evento.
    // Se parte de cero: la base del evento tiene marcados los productos que el
    // bar marcó ese día, y si uno de ellos cae entre los primeros de la rejilla
    // la captura del punto de venta sale tapada por el cuadro de acompañante.
    muestra.exec('UPDATE producto SET requiere_acompanante = 0, es_acompanante = 0');
    muestra.exec('UPDATE producto SET requiere_acompanante = 1 WHERE id_producto = 9');

    // Un combo de muestra: un whisky y dos cervezas, que es el caso que pidió
    // el bar. Se borra y se rehace en cada tanda para que la captura salga
    // igual aunque la base del evento ya tenga promociones propias.
    muestra.exec('DELETE FROM promocion_detalle');
    muestra.exec('DELETE FROM promocion');
    muestra.exec(`INSERT INTO promocion (id_promocion, nombre, descripcion, precio, activa)
                  VALUES (1, 'Combo Amigos', 'Para compartir entre tres', 60, 1)`);
    muestra.exec(`INSERT INTO promocion_detalle (id_promocion, id_producto, cantidad)
                  VALUES (1, 8, 1), (1, 1, 2)`);
    muestra.exec('UPDATE producto SET es_acompanante = 1 WHERE id_producto IN (15,16,17)');
    // Uno agotado a propósito: tiene que salir en la lista marcado, no
    // esconderse. Es justo el caso que hay que poder retratar.
    muestra.exec('UPDATE producto SET stock_actual = 0 WHERE id_producto = 16');
    muestra.close();
  } catch (e) {
    console.warn('  (sin fotos de muestra:', e.message + ')');
  }
  console.log('\n  Capturando a ' + ANCHO + '×' + ALTO + '...\n');
  for (const paso of ['login', 'pin', 'pos', 'cobro', 'qr', 'mixto', 'admin', 'personal', 'catalogo', 'productos', 'editar', 'promo-admin', 'promo-caja', 'promo-ticket', 'ticket', 'acompanante', 'carrito-acomp', 'mover', 'mover-producto', 'agregar', 'stock']) {
    const destino = path.join(SALIDA, paso + SUFIJO + '.png');
    spawnSync(navegador, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
      '--user-data-dir=' + path.join(require('os').tmpdir(), 'md-capturas'),
      // 9 s se quedaban cortos con el catálogo entero: la captura salía a
      // medias de la cascada de entrada y parecía que sólo había un producto.
      // Y 40 s tampoco bastan desde que los cuadros entran animados: el reloj
      // virtual corre mucho más rápido que la ida y vuelta de verdad al
      // servidor, así que el modal se abría cuando ya casi no quedaba tiempo y
      // la foto lo pillaba a medio aparecer.
      '--virtual-time-budget=' + arg('tiempo', '60000'),
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
