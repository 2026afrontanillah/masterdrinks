/* ==========================================================================
 * MasterDrinks — Prueba del rastro de reimpresiones
 * ==========================================================================
 *
 * Reimprimir una comanda es la puerta de atrás de una barra: con el ticket en
 * la mano se puede cobrar dos veces la misma venta. Por eso cada reimpresión
 * tiene que dejar dicho QUIÉN la pidió, y no basta con el cajero: si el cajero
 * y el mesero se ponen de acuerdo, con un solo nombre apuntado el otro queda
 * limpio. Se guardan los dos.
 *
 * Y el ticket reimpreso tiene que decirlo en el papel. Uno que salga idéntico
 * al original vale para cobrar de nuevo; uno que lleva REIMPRESIÓN encima, no.
 *
 *   npm run test:reimpresion
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = path.join(__dirname, '..');
const BASE = path.join(RAIZ, 'pos_evento.reimp.db');
const PUERTO = 3812;
const URL = 'http://127.0.0.1:' + PUERTO;
const esperar = ms => new Promise(r => setTimeout(r, ms));

let fallos = 0;
const check = (n, ok, extra) => {
  console.log('  ' + (ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m') + ' ' + n +
    (extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''));
  if (!ok) fallos++;
};

const post = (ruta, cuerpo) => fetch(URL + ruta, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cuerpo)
}).then(r => r.json());

(async () => {
  const o = new DatabaseSync(path.join(RAIZ, 'pos_evento.db'));
  o.exec('PRAGMA wal_checkpoint(TRUNCATE)'); o.close();
  ['', '-wal', '-shm'].forEach(s => { if (fs.existsSync(BASE + s)) fs.unlinkSync(BASE + s); });
  fs.copyFileSync(path.join(RAIZ, 'pos_evento.db'), BASE);

  const srv = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    cwd: RAIZ, env: Object.assign({}, process.env, { PORT: String(PUERTO), DB_FILE: BASE }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(URL + '/api/instancia')).ok) break; } catch (e) { /* aún no */ }
    await esperar(250);
  }

  console.log('\n\x1b[1m\x1b[36m  Quién reimprimió, y que el papel lo diga\x1b[0m');
  console.log('\x1b[90m  Reimprimir es por donde se cobra dos veces la misma venta.\x1b[0m\n');

  const db = new DatabaseSync(BASE);
  const comanda = db.prepare(
    "SELECT id_comanda, id_cajero, id_mesero FROM comanda WHERE estado_pago != 'ANULADO' ORDER BY id_comanda LIMIT 1"
  ).get();
  // La copia de la base trae las impresiones de aquel día. Se limpian las de
  // ESTA comanda para que la cuenta de copias empiece donde empieza de verdad.
  db.prepare('DELETE FROM impresion_comanda_cajero WHERE id_comanda = ?').run(comanda.id_comanda);
  db.prepare('DELETE FROM impresion_comanda_mesero WHERE id_comanda = ?').run(comanda.id_comanda);
  db.close();

  // ---- El log tiene sitio para los dos responsables ----
  const cols = t => {
    const d = new DatabaseSync(BASE);
    const c = d.prepare('PRAGMA table_info(' + t + ')').all().map(x => x.name);
    d.close(); return c;
  };
  for (const t of ['impresion_comanda_cajero', 'impresion_comanda_mesero']) {
    const c = cols(t);
    check(t + ' apunta al cajero y al mesero',
      c.includes('id_cajero') && c.includes('id_mesero'), c.join(', '));
  }

  // ---- La primera impresión es la original ----
  const primera = await post('/api/impresion', {
    id_comanda: comanda.id_comanda, tipo: 'cajero',
    id_cajero: comanda.id_cajero, id_mesero: comanda.id_mesero
  });
  check('La primera copia no es una reimpresión',
    primera.numero_copia === 1 && primera.reimpresion === false,
    'copia ' + primera.numero_copia);

  // ---- La segunda ya lo es, y queda con nombre y apellido ----
  const segunda = await post('/api/impresion', {
    id_comanda: comanda.id_comanda, tipo: 'cajero',
    id_cajero: comanda.id_cajero, id_mesero: comanda.id_mesero
  });
  check('La segunda copia se marca como reimpresión',
    segunda.numero_copia === 2 && segunda.reimpresion === true,
    'copia ' + segunda.numero_copia);

  const d2 = new DatabaseSync(BASE);
  const fila = d2.prepare(
    'SELECT id_cajero, id_mesero FROM impresion_comanda_cajero WHERE id_comanda = ? AND numero_copia = 2'
  ).get(comanda.id_comanda);
  d2.close();
  check('Y deja apuntados a los dos, no solo a uno',
    fila && fila.id_cajero === comanda.id_cajero && fila.id_mesero === comanda.id_mesero,
    fila ? 'cajero ' + fila.id_cajero + ', mesero ' + fila.id_mesero : 'no se guardó');

  // ---- Reimpresión desde el panel de administración ----
  //
  // Aquí no hay sesión de cajero ni de mesero: quien la pide es un admin, y el
  // navegador no tiene esos ids que mandar. El registro no puede quedarse en
  // blanco por eso: los responsables de esa comanda están en la propia comanda,
  // y es el servidor quien los pone.
  const desdePanel = await post('/api/impresion', {
    id_comanda: comanda.id_comanda, tipo: 'cajero'
  });
  check('Una reimpresión desde el panel también se registra',
    desdePanel.success === true && desdePanel.reimpresion === true,
    'copia ' + desdePanel.numero_copia);

  const d3 = new DatabaseSync(BASE);
  const sinSesion = d3.prepare(
    'SELECT id_cajero, id_mesero FROM impresion_comanda_cajero WHERE id_comanda = ? AND numero_copia = 3'
  ).get(comanda.id_comanda);
  d3.close();
  check('Y NO se queda sin responsables aunque el navegador no los mande',
    sinSesion && sinSesion.id_cajero === comanda.id_cajero &&
    sinSesion.id_mesero === comanda.id_mesero,
    sinSesion ? 'cajero ' + sinSesion.id_cajero + ', mesero ' + sinSesion.id_mesero : 'no se guardó');

  // ---- La hora que se guarda es la del reloj de la barra ----
  //
  // Se guardaba en UTC. En Bolivia son cuatro horas de más: una venta de las
  // 21:30 quedaba anotada a las 01:30 del día siguiente. Además de que ninguna
  // hora del ticket cuadraba, el cierre por rango partía la noche en dos días
  // y las ventas de después de las 20:00 se caían del reporte.
  const antes = new Date();
  const marca = await post('/api/impresion', { id_comanda: comanda.id_comanda, tipo: 'cajero' });
  const d4 = new DatabaseSync(BASE);
  const guardada = d4.prepare(
    'SELECT fecha_hora_impresion f FROM impresion_comanda_cajero WHERE id_comanda = ? AND numero_copia = ?'
  ).get(comanda.id_comanda, marca.numero_copia);
  d4.close();

  const dos = n => String(n).padStart(2, '0');
  const horaLocal = dos(antes.getHours()) + ':' + dos(antes.getMinutes());
  check('La hora que se guarda es la local, no UTC',
    String(guardada.f).slice(11, 16) === horaLocal,
    'guardó ' + String(guardada.f).slice(11, 16) + ', el reloj marca ' + horaLocal);
  check('Y el día también es el local',
    String(guardada.f).slice(0, 10) ===
      antes.getFullYear() + '-' + dos(antes.getMonth() + 1) + '-' + dos(antes.getDate()),
    String(guardada.f).slice(0, 10));

  // ---- Una reimpresión, una línea ----
  //
  // Cada impresión saca dos papeles, el del cajero y el de la barra, y los dos
  // se registran. Pero para auditar lo que importa es el acto de reimprimir,
  // no cuántos papeles salieron: en el log tiene que aparecer una sola vez.
  // Se usa otra comanda limpia, y se imita al cliente: en cada impresión
  // registra los DOS papeles, el del cajero y el de la barra.
  const d5 = new DatabaseSync(BASE);
  const otra = d5.prepare(
    "SELECT id_comanda FROM comanda WHERE estado_pago != 'ANULADO' AND id_comanda <> ? ORDER BY id_comanda LIMIT 1"
  ).get(comanda.id_comanda);
  d5.prepare('DELETE FROM impresion_comanda_cajero WHERE id_comanda = ?').run(otra.id_comanda);
  d5.prepare('DELETE FROM impresion_comanda_mesero WHERE id_comanda = ?').run(otra.id_comanda);
  d5.close();

  const imprimir = async () => {
    for (const tipo of ['cajero', 'mesero']) {
      await post('/api/impresion', { id_comanda: otra.id_comanda, tipo });
    }
  };
  const cuantas = async () => {
    const r = await (await fetch(URL + '/api/admin/reimpresiones')).json();
    return (r.reimpresiones || []).filter(x => x.id_comanda === otra.id_comanda).length;
  };

  await imprimir();                       // la venta: copia 1 de cada papel
  check('La impresión de la venta no ensucia el log', await cuantas() === 0,
    await cuantas() + ' líneas');

  await imprimir();                       // una reimpresión: copia 2 de cada papel
  const trasUna = await cuantas();
  check('Una reimpresión aparece UNA vez en el log, no dos',
    trasUna === 1, trasUna + ' líneas para una sola reimpresión');

  await imprimir();                       // otra más
  const trasDos = await cuantas();
  check('Y dos reimpresiones son dos líneas', trasDos === 2, trasDos + ' líneas');

  // ---- El reporte las saca ----
  const rep = await (await fetch(URL + '/api/admin/reimpresiones')).json();
  check('El reporte de reimpresiones responde', rep.success === true,
    rep.message || '');
  const nuestra = (rep.reimpresiones || []).find(r =>
    r.id_comanda === comanda.id_comanda && r.numero_reimpresion === 1);
  check('Y la reimpresión sale en él', !!nuestra,
    (rep.reimpresiones || []).length + ' reimpresiones listadas');
  check('Con el nombre del cajero y el del mesero, no solo sus números',
    nuestra && nuestra.cajero && nuestra.mesero,
    nuestra ? nuestra.cajero + ' / ' + nuestra.mesero : '');
  check('La copia original NO se cuenta como reimpresión',
    !(rep.reimpresiones || []).some(r =>
      r.id_comanda === comanda.id_comanda && r.numero_reimpresion === 0),
    'la venta no es una reimpresión');

  // ---- La cuenta empieza en 1, no en "copia 2" ----
  //
  // Antes la primera vez que se repetía un ticket salía como "copia 2" y había
  // que restar de cabeza para saber cuántas veces se había repetido.
  const todas = (rep.reimpresiones || []).filter(r => r.id_comanda === otra.id_comanda)
    .map(r => r.numero_reimpresion).sort((a, b) => a - b);
  check('La primera vez que se repite un ticket es la reimpresión 1',
    todas[0] === 1, 'salió como la ' + todas[0]);
  check('Y la siguiente es la 2', todas[1] === 2, 'salió como la ' + todas[1]);

  // ---- Ordenado por fecha, lo más reciente arriba ----
  const fechas = (rep.reimpresiones || []).map(r => r.fecha);
  const ordenadas = [...fechas].sort().reverse();
  check('El log viene ordenado por fecha, de lo más nuevo a lo más viejo',
    JSON.stringify(fechas) === JSON.stringify(ordenadas),
    fechas.length + ' líneas');

  // ---- Si la impresora falla, el apunte NO se pierde ----
  //
  // El registro estaba detrás de printToRawBT y dentro del mismo try: con la
  // impresora caída -RawBT sin instalar, sin papel, sin permiso- se perdía
  // también el rastro. Al revés de lo que hace falta: lo que se audita es que
  // alguien PIDIÓ la copia, salga el papel o no.
  const appjs = fs.readFileSync(path.join(RAIZ, 'public/app.js'), 'utf8');
  const cuerpo = appjs.slice(appjs.indexOf('function sendToPrinter'));
  const finCuerpo = cuerpo.slice(0, cuerpo.indexOf('\n    }'));
  check('El registro se hace antes de mandar el papel, no después',
    finCuerpo.indexOf('logPrint(') < finCuerpo.indexOf('printToRawBT('),
    'así una impresora caída no borra el rastro');
  check('Y queda fuera del try de la impresora',
    finCuerpo.indexOf('logPrint(') < finCuerpo.indexOf('try {'),
    'un fallo al imprimir no puede saltárselo');

  // ---- El apunte sobrevive a que la tablet se vaya a segundo plano ----
  //
  // Abrir RawBT saca al navegador de primer plano y Android cancela los fetch
  // a medias, así que el registro se perdía justo al reimprimir. En un PC no
  // se ve: no hay app externa a la que saltar.
  check('El apunte se manda con sendBeacon, que sobrevive al cambio de app',
    /navigator\.sendBeacon\(/.test(appjs), 'no basta un fetch normal');
  check('Y el respaldo lleva keepalive, por si no hay sendBeacon',
    /keepalive:\s*true/.test(appjs), 'para navegadores sin beacon');

  // ---- El papel lo dice ----
  const rawbt = fs.readFileSync(path.join(RAIZ, 'public/rawbt.js'), 'utf8');
  check('El ticket sabe rotularse como reimpresión',
    /REIMPRESI[ÓO]N/.test(rawbt), 'rawbt.js');

  console.log('');
  console.log(fallos === 0
    ? '  \x1b[32mCada reimpresión deja rastro de los dos responsables.\x1b[0m\n'
    : '  \x1b[31m' + fallos + ' fallidas.\x1b[0m\n');

  srv.kill('SIGTERM');
  await esperar(600);
  srv.kill('SIGKILL');
  ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(BASE + s); } catch (e) {} });
  process.exit(fallos === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
