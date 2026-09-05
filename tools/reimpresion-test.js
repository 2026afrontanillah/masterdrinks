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

  // ---- El reporte las saca ----
  const rep = await (await fetch(URL + '/api/admin/reimpresiones')).json();
  check('El reporte de reimpresiones responde', rep.success === true,
    rep.message || '');
  const nuestra = (rep.reimpresiones || []).find(r =>
    r.id_comanda === comanda.id_comanda && r.numero_copia === 2);
  check('Y la reimpresión sale en él', !!nuestra,
    (rep.reimpresiones || []).length + ' reimpresiones listadas');
  check('Con el nombre del cajero y el del mesero, no solo sus números',
    nuestra && nuestra.cajero && nuestra.mesero,
    nuestra ? nuestra.cajero + ' / ' + nuestra.mesero : '');
  check('La copia original NO se cuenta como reimpresión',
    !(rep.reimpresiones || []).some(r =>
      r.id_comanda === comanda.id_comanda && r.numero_copia === 1),
    'solo cuentan de la copia 2 en adelante');

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
