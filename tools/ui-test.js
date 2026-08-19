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
    env: Object.assign({}, process.env, { PORT: String(PUERTO), DB_FILE: BASE }),
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
    setTimeout(() => {
      servidor.kill('SIGKILL');
      // Windows no suelta el archivo en el mismo instante en que muere el
      // proceso, así que se espera un momento antes de borrar; si no, el
      // unlink falla en silencio y la base se queda en la carpeta igual.
      // Se borra la base de la prueba al acabar. Antes se quedaba en la carpeta
      // del proyecto junto a su -wal y su -shm, y acababan conviviendo cuatro
      // juegos de archivos que parecían bases de verdad.
      ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(BASE + s); } catch (e) {} });
      setTimeout(() => process.exit(codigo), 300);
    }, 500);
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

  // Volver a pulsar un producto que YA está en el carrito tiene que señalar su
  // línea, no la última. Si el whisky está arriba del todo y la lista se fuera
  // al final, el cajero miraría un sitio donde no ha pasado nada.
  click(window.document.querySelector(`.product-card[data-id="${idPrimera}"]`));
  await esperar(120);
  const senalada = window.document.querySelector('.cart-item.tocada');
  check('Repetir un producto resalta SU línea, no la última',
    senalada && senalada.dataset.id === String(idPrimera),
    senalada ? 'resaltó ' + senalada.dataset.id : 'no resaltó ninguna');
  click(fila.querySelector('.decrease-btn'));
  await esperar(60);

  // El botón "Vaciar" limpiaba la lista pero dejaba el contador y el total con
  // las cifras de antes: la pantalla decía 3 productos sobre un carrito vacío.
  click(id('clear-cart'));
  await esperar(80);
  check('"Vaciar" deja también el contador y el total en cero',
    id('cart-count').textContent === '0' &&
    parseFloat(id('cart-total-amount').textContent) === 0,
    id('cart-count').textContent + ' / ' + id('cart-total-amount').textContent);

  const idSeg = tarjetas[1].dataset.id;
  click(window.document.querySelector(`.product-card[data-id="${idPrimera}"]`));
  click(window.document.querySelector(`.product-card[data-id="${idPrimera}"]`));
  click(window.document.querySelector(`.product-card[data-id="${idSeg}"]`));
  await esperar(120);
  check('Y se puede volver a montar el pedido', id('cart-count').textContent === '2');

  // Salir sin cobrar tiene que dejar la caja en blanco. Si no, el siguiente
  // mesero entra con su PIN y se encuentra el pedido a medias del anterior.
  const antesDeSalir = id('cart-count').textContent;
  click(id('lock-pos-btn'));
  await esperar(120);
  check('Cambiar de mesero sin cobrar vacía el carrito',
    id('cart-count').textContent === '0' &&
    !id('cart-count').classList.contains('tiene'),
    'estaba en ' + antesDeSalir);
  check('Y el total vuelve a cero',
    parseFloat(id('cart-total-amount').textContent) === 0,
    id('cart-total-amount').textContent);
  check('Y las tarjetas ya no marcan unidades en el carrito',
    window.document.querySelectorAll('.product-card .cart-badge').length === 0);
  check('Y se avisa de lo que se descartó',
    (id('toast-stack').textContent || '').includes('sin cobrar'));

  // Se vuelve a entrar y se rehace el carrito: el resto de la prueba sigue
  // desde aquí, así que hay que dejarlo como estaba.
  for (const d of '1009') click($('.pin-btn[data-key="' + d + '"]'));
  await esperar(300);
  const idSegunda = tarjetas[1].dataset.id;
  click(window.document.querySelector(`.product-card[data-id="${idPrimera}"]`));
  click(window.document.querySelector(`.product-card[data-id="${idPrimera}"]`));
  click(window.document.querySelector(`.product-card[data-id="${idSegunda}"]`));
  await esperar(120);
  check('Tras volver a entrar, el carrito se rehace',
    id('cart-count').textContent === '2', id('cart-count').textContent);

  // -- la salida al login ya no es un botón visible ---------------------
  // Se quitó la flecha que devolvía al login desde la pantalla del PIN: con
  // cola en la barra, pulsarla por error obligaba a teclear otra vez usuario y
  // contraseña. La salida sigue existiendo para el encargado, escondida tras
  // una pulsación larga en el candado.
  check('Ya no hay botón de volver al login en la pantalla del PIN',
    !id('logout-cajero-btn'));
  check('Pero el candado sigue ahí para la pulsación larga',
    !!id('salida-oculta'));

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
  // El número de comanda va solo, sin letras delante: es lo que el mesero
  // canta en la barra y lo que el cliente busca en su ticket.
  check('El ticket lleva la marca y el número de comanda, sólo numérico',
    previa.includes('MASTERDRINKS') && /COMANDA \d/.test(previa)
      && !/COMANDA [A-Z]+\d*-/.test(previa),
    (previa.match(/COMANDA \d+/) || [])[0]);
  // El nombre de la barra lo escribe el encargado en Datos del evento y tiene
  // que llegar tal cual a la cabecera del ticket: es lo que lee el cliente y lo
  // que distingue un comprobante de otro si se juntan varias cajas.
  const cfgTicket = await (await fetch(URL_BASE + '/api/configuracion')).json();
  check('El ticket lleva impreso el nombre de la barra del panel',
    previa.includes(cfgTicket.barra), cfgTicket.barra);
  check('El ticket imprime el precio unitario', / x \d+\.\d\d/.test(previa));
  check('El ticket refleja los dos métodos de pago',
    previa.includes('Efectivo') && previa.includes('Transferencia'));
  const previaMesero = id('ticket-mesero-body').textContent;
  check('El ticket de barra lleva casillas para tachar', previaMesero.includes('[ ]'));
  check('El ticket de barra avisa de que no es comprobante',
    previaMesero.includes('No es comprobante de pago'));
  // El maquetado del ticket se comprueba aparte, sobre un modelo hecho a mano:
  // así se puede meter una observación y nombres largos sin ensuciar la venta
  // de prueba, y el texto viene con saltos de línea de verdad para poder medir
  // el ancho.
  const TP = window.ThermalPrinter;
  const ajustes = TP.getSettings();
  const maqueta = TP.buildTickets({
    id: 47, ref: '47', barra: 'Chivas', evento: 'Festival Sonidos de Verano 2026',
    fecha: '18/08/2026 22:41', fechaDia: '18/08/2026', hora: '22:41',
    cajero: 'Ana Torres', mesero: 'Paola Mendez', total: 186, recibido: 200,
    items: [
      { nombre: 'Cerveza Pacena 350 ml', cantidad: 3, precio_unitario: 18, subtotal: 54 },
      { nombre: 'Johnnie Walker Black Label', cantidad: 2, precio_unitario: 55, subtotal: 110 },
      { nombre: 'Papas fritas', cantidad: 1, precio_unitario: 22, subtotal: 22 }
    ],
    pagos: [{ etiqueta: 'Efectivo', monto: 186 }],
    observaciones: 'Sin hielo en los whiskys'
  }, ajustes);
  const textoCajero = TP.renderText(maqueta.cajero);
  const textoMesero = TP.renderText(maqueta.mesero);

  check('El ticket de cobro destaca el total a pagar',
    textoCajero.includes('TOTAL A PAGAR') && textoCajero.includes('186.00 Bs.'));
  check('Y lleva la observación del cliente, que es con lo que reclama',
    textoCajero.includes('NOTA') && textoCajero.includes('Sin hielo'));
  check('El ticket de barra destaca la observación aparte',
    textoMesero.includes('OJO') && textoMesero.includes('Sin hielo'));
  check('El vuelto sale cuando el cliente paga con un billete mayor',
    textoCajero.includes('CAMBIO') && textoCajero.includes('14.00'));

  // Los dos son el mismo papel: si una copia gastara más columnas que la otra,
  // saldría desbordada de la impresora.
  const anchoDe = txt => Math.max.apply(null, txt.split('\n').map(l => l.length));
  check('Ninguna copia se pasa del ancho del papel',
    anchoDe(textoCajero) <= ajustes.width && anchoDe(textoMesero) <= ajustes.width,
    anchoDe(textoCajero) + ' y ' + anchoDe(textoMesero) + ' de ' + ajustes.width + ' columnas');

  // Un pedido sin nota no debe gastar papel diciendo que no hay nota.
  const sinNota = TP.buildTickets({
    id: 48, ref: '48', barra: 'Chivas', fecha: '18/08/2026 22:45', hora: '22:45',
    cajero: 'Ana Torres', mesero: 'Paola Mendez', total: 18,
    items: [{ nombre: 'Cerveza', cantidad: 1, precio_unitario: 18, subtotal: 18 }],
    pagos: [{ etiqueta: 'Efectivo', monto: 18 }],
    observaciones: 'Sin observaciones'
  }, ajustes);
  // Los tickets se dibujan con caracteres de línea de CP850, no con guiones.
  // Es lo que separa un ticket que parece de máquina de escribir de uno que
  // parece impreso.
  check('Los tickets usan líneas continuas, no filas de guiones',
    textoCajero.includes('═') && textoCajero.includes('─') &&
    !/^-{10,}$/m.test(textoCajero) && !/^={10,}$/m.test(textoCajero),
    'CP850 los trae; en modo ascii vuelven a - y =');

  // Y si la impresora no habla CP850, tienen que volver a ASCII legible en vez
  // de imprimir símbolos raros.
  const enAscii = TP.renderText(maqueta.cajero, Object.assign({}, ajustes, { encoding: 'ascii' }));
  check('Sin CP850 vuelven a guiones, no a basura',
    enAscii.includes('===') && enAscii.includes('---') &&
    !enAscii.includes('═') && !enAscii.includes('─'));

  check('Sin observaciones, el ticket no imprime la sección',
    !TP.renderText(sinNota.cajero).includes('NOTA') &&
    !TP.renderText(sinNota.mesero).includes('OJO'));

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

  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Altas y listas del panel'));
  // =======================================================================
  // Las nueve observaciones del equipo, comprobadas ejecutándolas. Antes de
  // esto sólo se podía decir "está en el código", que no es lo mismo que
  // "funciona al pulsarlo".
  click($('[data-tab="tab-crear-personal"]'));
  await esperar(500);

  // -- 2. el cajero nuevo aparece sin recargar ------------------------------
  const cajerosAntes = window.document.querySelectorAll('#lista-cajeros .lista-fila').length;
  const sufijo = Date.now().toString().slice(-6);
  escribir(id('caj-name'), 'Cajero Prueba ' + sufijo);
  escribir(id('caj-user'), 'cajero_p' + sufijo);
  escribir(id('caj-pass'), 'demo123');
  $('#form-create-cajero').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await esperar(700);
  check('El cajero recién creado aparece en la lista SIN recargar la página',
    window.document.querySelectorAll('#lista-cajeros .lista-fila').length === cajerosAntes + 1,
    cajerosAntes + ' -> ' + window.document.querySelectorAll('#lista-cajeros .lista-fila').length);

  // -- 4. el cajero elegido se queda puesto ---------------------------------
  const selCajero = id('mes-cajero');
  selCajero.value = selCajero.options[1].value;
  const cajeroElegido = selCajero.value;

  const meserosAntes = window.document.querySelectorAll('#lista-meseros .lista-fila').length;
  escribir(id('mes-name'), 'Mesero Prueba ' + sufijo);
  escribir(id('mes-user'), 'mesero_p' + sufijo);
  escribir(id('mes-pass'), '9' + sufijo.slice(-3));
  $('#form-create-mesero').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await esperar(700);

  // -- 3. el mesero nuevo también aparece -----------------------------------
  check('El mesero recién creado aparece en la lista SIN recargar',
    window.document.querySelectorAll('#lista-meseros .lista-fila').length === meserosAntes + 1,
    meserosAntes + ' -> ' + window.document.querySelectorAll('#lista-meseros .lista-fila').length);

  check('Y el cajero elegido sigue puesto, para dar de alta varios seguidos',
    id('mes-cajero').value === cajeroElegido,
    'quedó en ' + (id('mes-cajero').selectedOptions[0] || {}).textContent);
  check('Pero el nombre y el usuario sí se limpian',
    id('mes-name').value === '' && id('mes-user').value === '');

  // -- 5. meseros agrupados por cajero --------------------------------------
  const gruposMeseros = window.document.querySelectorAll('#lista-meseros .lista-grupo');
  check('Los meseros salen agrupados por cajero',
    gruposMeseros.length > 1,
    gruposMeseros.length + ' grupos: ' +
    [...gruposMeseros].slice(0, 3).map(g => g.textContent.trim()).join(' / '));

  // -- 6 y 7. catálogo ------------------------------------------------------
  click($('[data-tab="tab-crear-producto"]'));
  await esperar(600);

  const gruposProd = window.document.querySelectorAll('#lista-productos .lista-grupo');
  check('Los productos salen agrupados por categoría',
    gruposProd.length > 1,
    [...gruposProd].map(g => g.textContent.trim()).join(' / '));

  const nombres = window.document.querySelectorAll('#lista-productos .lista-nombre');
  check('El nombre del producto se lee entero, sin recortar',
    [...nombres].every(n => !n.textContent.endsWith('…') && n.textContent.trim().length > 0),
    (nombres[0] || {}).textContent);

  // -- 8. botones de inventario ---------------------------------------------
  click($('[data-tab="tab-stock"]'));
  await esperar(600);
  check('El botón de añadir dice qué hace',
    id('ingreso-otro').textContent.includes('Añadir a la lista'),
    id('ingreso-otro').textContent.trim());
  check('Y el de guardar también',
    id('ingreso-guardar').textContent.includes('Guardar ingreso'),
    id('ingreso-guardar').textContent.trim());
  check('Con una línea que explica que se pueden meter varios',
    (window.document.querySelector('.acciones-pista') || {}).textContent.includes('varios'));



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

  // =======================================================================
  console.log(C.tit(String.fromCharCode(10) + '  Ningún cuadro se queda invisible'));
  // =======================================================================
  // Un modal que no se ve es el peor fallo que puede tener una caja: el cajero
  // toca "Cobrar", no pasa nada visible, vuelve a tocar, y no hay ningún aviso
  // de que algo falló. Pasó de verdad: la hoja de cobro llevaba una clase de
  // entrada cuyo estado de reposo es `opacity: 0`, confiando en que la
  // animación lo deshiciera. En cuanto otra regla le cambió la animación, la
  // hoja dejó de verse y siguió respondiendo a los toques desde el vacío.
  //
  // La regla es: lo que va dentro de un velo se ve por defecto, y la animación
  // sólo lo adorna.
  const RIESGO = ['animate-pop', 'animate-slide-up'];
  const velos = [...window.document.querySelectorAll('.modal-overlay')];
  check('Hay cuadros que revisar', velos.length > 0, velos.length + ' velos');

  const culpables = [];
  for (const velo of velos) {
    for (const hijo of velo.children) {
      for (const clase of RIESGO) {
        if (hijo.classList.contains(clase)) {
          culpables.push((velo.id || '(sin id)') + ' → .' + clase);
        }
      }
    }
  }
  check('Ninguna hoja de modal se apoya en una animación para poder verse',
    culpables.length === 0,
    culpables.length ? culpables.join(', ') : 'la entrada la pone la hoja de estilos, sin opacidad cero de reposo');

  // Y ninguno nace abierto. Se mira el HTML tal como lo sirve el servidor, no
  // el de ahora: a estas alturas de la prueba hay una sesión empezada y el
  // cuadro del PIN está abierto con toda la razón.
  const htmlCrudo = await (await fetch(URL_BASE + '/index.html')).text();
  const naceAbierto = [...htmlCrudo.matchAll(/<div([^>]*class="[^"]*modal-overlay[^"]*"[^>]*)>/g)]
    .map(m => m[1])
    .filter(attr => !/class="[^"]*\bhide\b/.test(attr))
    .map(attr => (attr.match(/id="([^"]+)"/) || [, '(sin id)'])[1]);
  check('Y ninguno nace abierto en el HTML',
    naceAbierto.length === 0,
    naceAbierto.length ? naceAbierto.join(', ') : 'todos con .hide puesta');

  console.log('');
  console.log(fallos === 0
    ? '  ' + C.ok('Todo correcto en la interfaz.') + '\n'
    : '  ' + C.mal(fallos + ' comprobación(es) fallidas.') + '\n');

  terminar(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(C.mal('  Error: '), e); process.exit(1); });
