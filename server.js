require('dotenv').config();
const express = require('express');
const path = require('path');
// SQLite incorporado en Node (>= 22.5). A diferencia del paquete `sqlite3`, no es
// un binario nativo: no hay que compilar nada, así que el mismo código corre en
// Windows y en la tablet Android con Termux, que es la que hace de servidor.
const { DatabaseSync } = require('node:sqlite');
// Generador de PDF propio, sin dependencias: ver el comentario de lib/pdf.js.
const { construirPdfCierre, nombreArchivoReporte } = require('./lib/reporte-cierre');

const app = express();
const PORT = process.env.PORT || 3000;

// Holgado a propósito: el límite por defecto de Express son 100 KB y una
// comanda larga con muchas líneas los rozaba, devolviendo un 413 que en la
// tablet se veía como "no se pudo cobrar" sin más explicación.
app.use(express.json({ limit: '3mb' }));
// La tablet tiene que preguntar SIEMPRE si el archivo cambió.
//
// Con 'max-age=0' Chrome puede servir de su caché sin consultar en cuanto la
// red parpadea, y en una tablet con la página añadida a la pantalla de inicio
// eso se queda pegado durante horas: se arreglan cosas en el servidor y en la
// barra sigue corriendo el código de anoche. Con 'no-cache' sigue guardando el
// archivo, pero pregunta antes de usarlo; en red local la respuesta es un 304
// de nada.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: res => res.set('Cache-Control', 'no-cache')
}));

// Las respuestas de la API no se guardan NUNCA en el disco del navegador.
//
// A los archivos de public/ les basta con el 'no-cache' de arriba: preguntan
// antes de usar su copia. Con la API no vale, porque Express les pone un ETag
// pero ninguna instrucción de frescura, y entonces el navegador es libre de
// decidir por su cuenta que la copia sigue valiendo y ni preguntar.
//
// Lo que hay detrás son las existencias y la identidad de la barra: datos que
// cambian mientras la tablet está abierta. Una respuesta vieja servida desde el
// disco de la tablet es un rótulo equivocado en el ticket, o stock que no está.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Sello de versión de la interfaz que está sirviendo este servidor.
//
// Sale de la fecha de los archivos de public/. Sirve para responder de un
// vistazo a "¿la tablet tiene los cambios o sigue con los de ayer?", que sin
// esto sólo se averigua probando y discutiendo.
const VERSION_UI = (() => {
  const fsv = require('fs');
  let ultima = 0;
  for (const nombre of ['index.html', 'app.js', 'style.css', 'rawbt.js']) {
    try {
      const st = fsv.statSync(path.join(__dirname, 'public', nombre));
      if (st.mtimeMs > ultima) ultima = st.mtimeMs;
    } catch (e) { /* si falta uno, cuenta el resto */ }
  }
  const d = new Date(ultima || Date.now());
  const dos = n => String(n).padStart(2, '0');
  return dos(d.getDate()) + dos(d.getMonth() + 1) + '-' + dos(d.getHours()) + dos(d.getMinutes());
})();

// Dynamic route to serve Wallpaper.jpg from the project root directory
const fs = require('fs');
app.get('/Wallpaper.jpg', (req, res) => {
  const filePath = path.join(__dirname, 'Wallpaper.jpg');
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  const lowerPath = path.join(__dirname, 'wallpaper.jpg');
  if (fs.existsSync(lowerPath)) {
    return res.sendFile(lowerPath);
  }
  const publicPath = path.join(__dirname, 'public', 'wallpaper.png');
  if (fs.existsSync(publicPath)) {
    return res.sendFile(publicPath);
  }
  res.status(404).send('Wallpaper file not found in root.');
});

// Case insensitive aliases
app.get('/wallpaper.jpg', (req, res) => {
  res.redirect('/Wallpaper.jpg');
});
app.get('/wallpaper.png', (req, res) => {
  res.redirect('/Wallpaper.jpg');
});

// El afiche del evento, para la pantalla de clave de mesero. De su color sale
// toda la paleta de esa pantalla, así que ponerlo es lo primero que hay que
// hacer al montar un evento nuevo.
//
// Se busca de dos maneras, y a propósito las dos son perezosas: nadie va a
// renombrar un archivo con la barra llena.
//   1. Un archivo llamado afiche/cartel/evento/poster (jpg, jpeg, png o webp)
//      aquí mismo o en public/.
//   2. Cualquier imagen dentro de una carpeta 'afiche'. Si hay varias, la más
//      reciente: así se cambia de evento arrastrando la nueva dentro, sin
//      borrar la anterior ni tocar nombres.
// Si no aparece ninguna se responde 404 y la pantalla enseña el nombre del
// evento en el hueco del cartel.
const AFICHE_EXT = /[.](jpe?g|png|webp)$/i;
const AFICHE_NOMBRES = /^(afiche|cartel|evento|poster)[.](jpe?g|png|webp)$/i;

function buscarAfiche() {
  for (const carpeta of [__dirname, path.join(__dirname, 'public')]) {
    let entradas;
    try { entradas = fs.readdirSync(carpeta); } catch (e) { continue; }
    const suelto = entradas.find(n => AFICHE_NOMBRES.test(n));
    if (suelto) return path.join(carpeta, suelto);
  }

  for (const carpeta of [path.join(__dirname, 'afiche'), path.join(__dirname, 'public', 'afiche')]) {
    let entradas;
    try { entradas = fs.readdirSync(carpeta); } catch (e) { continue; }
    const imagenes = entradas
      .filter(n => AFICHE_EXT.test(n))
      .map(n => {
        const ruta = path.join(carpeta, n);
        return { ruta: ruta, cuando: fs.statSync(ruta).mtimeMs };
      })
      .sort((a, b) => b.cuando - a.cuando);
    if (imagenes.length) return imagenes[0].ruta;
  }

  return null;
}

app.get('/afiche', (req, res) => {
  const ruta = buscarAfiche();
  if (!ruta) return res.status(404).end();
  res.sendFile(ruta);
});

// Cuánto mide una imagen, leyendo sus cabeceras. No hace falta ninguna
// librería: el ancho y el alto de un JPEG y de un PNG están en los primeros
// bytes del archivo, y aquí sólo se quiere eso.
function medidaImagen(ruta) {
  let b;
  try { b = fs.readFileSync(ruta); } catch (e) { return null; }

  // PNG: los cuatro y cuatro bytes que siguen a la cabecera IHDR.
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504E47) {
    return { ancho: b.readUInt32BE(16), alto: b.readUInt32BE(20) };
  }

  // JPEG: se salta de marca en marca hasta el "start of frame", que es donde
  // están las medidas. Las marcas de longitud fija (C4, C8, CC) no lo son.
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const marca = b[i + 1];
      if (marca >= 0xC0 && marca <= 0xCF && marca !== 0xC4 && marca !== 0xC8 && marca !== 0xCC) {
        return { alto: b.readUInt16BE(i + 5), ancho: b.readUInt16BE(i + 7) };
      }
      const largo = b.readUInt16BE(i + 2);
      if (largo < 2) break;
      i += 2 + largo;
    }
  }

  return null;
}

// El cartel se ve a media pantalla en la tablet, y esa media pantalla son unos
// 700 píxeles de verdad en cuanto la pantalla es medianamente fina. Por debajo
// de 1000 de ancho el navegador tiene que estirar la imagen y se nota.
const AFICHE_ANCHO_MINIMO = 1000;

function informarDelAfiche() {
  const ruta = buscarAfiche();
  if (!ruta) {
    console.log('\n   Cartel del evento: no hay ninguno.');
    console.log('   Deja la imagen en la carpeta "afiche" (cualquier nombre).');
    return;
  }

  const nombre = path.relative(__dirname, ruta);
  const medida = medidaImagen(ruta);
  const peso = (fs.statSync(ruta).size / 1024).toFixed(0) + ' KB';

  if (!medida) {
    console.log(`\n   Cartel del evento: ${nombre}  (${peso})`);
    return;
  }

  console.log(`\n   Cartel del evento: ${nombre}  (${medida.ancho}×${medida.alto}, ${peso})`);
  if (medida.ancho < AFICHE_ANCHO_MINIMO) {
    console.log(`   ⚠ Se va a ver borroso: ocupa media pantalla y para eso hace`);
    console.log(`     falta una imagen de ${AFICHE_ANCHO_MINIMO} px de ancho o más.`);
  }
}

// DB_FILE permite arrancar contra otra base sin tocar la del evento: es lo que
// usa la prueba de carga (tools/stress-test.js) para castigar una copia.
const dbFile = process.env.DB_FILE
  ? path.resolve(__dirname, process.env.DB_FILE)
  : path.join(__dirname, 'pos_evento.db');
const sqlite = new DatabaseSync(dbFile);

// ---------------------------------------------------------------------------
// Adaptador node:sqlite -> API estilo node-sqlite3
// ---------------------------------------------------------------------------
// node:sqlite es SÍNCRONO, pero el resto del archivo está escrito con callbacks.
// Este envoltorio mantiene las firmas run/all/get/serialize para no reescribir
// ninguna ruta. Ojo: como cada consulta se ejecuta al instante, la cola de
// transacciones (withTransaction) sigue siendo imprescindible, porque los
// `await` entre sentencias sí ceden el turno a otras peticiones.

const stmtCache = new Map();
function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = sqlite.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// node:sqlite solo admite null, number, bigint, string y Uint8Array. Un
// `undefined` (campo de formulario ausente) o un booleano lanzarían excepción.
function normalizeParams(params) {
  return (params || []).map(value => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return nowSql(value);
    return value;
  });
}

// Admite tanto (sql, params, cb) como (sql, cb).
function splitArgs(params, cb) {
  return typeof params === 'function' ? [[], params] : [params || [], cb];
}

function invoke(sql, params, cb, mode) {
  const [rawParams, callback] = splitArgs(params, cb);
  try {
    const stmt = prepare(sql);
    const args = normalizeParams(rawParams);

    if (mode === 'run') {
      const info = stmt.run(...args);
      // `this.lastID` / `this.changes`, igual que en node-sqlite3.
      if (callback) {
        callback.call({ lastID: Number(info.lastInsertRowid), changes: Number(info.changes) }, null);
      }
      return;
    }

    const rows = mode === 'get' ? stmt.get(...args) : stmt.all(...args);
    if (callback) callback.call({}, null, mode === 'get' ? (rows === undefined ? undefined : rows) : rows);
  } catch (err) {
    if (callback) callback.call({}, err, null);
    else console.error('SQLite error:', err.message, '| SQL:', sql);
  }
}

const db = {
  run: (sql, params, cb) => invoke(sql, params, cb, 'run'),
  all: (sql, params, cb) => invoke(sql, params, cb, 'all'),
  get: (sql, params, cb) => invoke(sql, params, cb, 'get'),
  exec: sql => sqlite.exec(sql),
  // node:sqlite ya es secuencial: no hay nada que serializar.
  serialize: fn => fn(),
  close: () => sqlite.close()
};

// SQLite runtime tuning:
// - foreign_keys is OFF by default in SQLite, so every FK/ON DELETE CASCADE in the
//   schema was purely decorative until now.
// - WAL keeps reads from blocking while a sale is being written.
// - busy_timeout avoids SQLITE_BUSY if two requests land at the same instant.
db.run('PRAGMA foreign_keys = ON');
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA busy_timeout = 5000');

// Promise wrappers used by the transactional routes below.
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve({ insertId: this.lastID, affectedRows: this.changes });
  });
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

// There is a single SQLite connection, so two overlapping BEGIN/COMMIT blocks would
// interleave and corrupt each other. This queue serialises whole transactions.
let txChain = Promise.resolve();
function withTransaction(work) {
  const run = txChain.then(async () => {
    await dbRun('BEGIN IMMEDIATE');
    try {
      const result = await work();
      await dbRun('COMMIT');
      return result;
    } catch (err) {
      try { await dbRun('ROLLBACK'); } catch (_) { /* nothing left to roll back */ }
      throw err;
    }
  });
  txChain = run.then(() => {}, () => {});
  return run;
}

// Error thrown for validation problems that should surface to the cashier as 400s.
class BusinessError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// La hora del reloj de la barra, no la de Greenwich.
//
// Esto guardaba toISOString(), que es UTC. En Bolivia son cuatro horas de más:
// una venta de las 21:30 quedaba anotada a la 01:30 del día siguiente. Además
// de que ninguna hora del ticket cuadraba con lo que había pasado, el cierre
// por rango partía la noche en dos días y las ventas de después de las 20:00
// se caían del reporte del evento.
//
// Un evento va de las 17:00 a las 02:00: la fecha de la venta tiene que ser la
// que diría cualquiera que estuviera en la barra mirando el reloj.
function nowSql(fecha) {
  const d = fecha || new Date();
  const dos = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) + ' ' +
         dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds());
}

/**
 * Deja constancia de lo que hace el encargado.
 *
 * Se registra TODO lo que cambia el montaje: altas, bajas, marcas, fotos,
 * traspasos y los datos del evento. Al día siguiente, cuando alguien pregunte
 * por qué faltan doce cervezas o quién cambió el precio, el log es lo único
 * que puede responder.
 *
 * Nunca corta la operación: si el apunte falla, la acción ya se hizo y no
 * tiene sentido deshacerla por no poder anotarla. Se avisa por consola.
 */
function registrarAuditoria(id_admin, accion, entidad, id_registro, detalle) {
  return dbRun(
    `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle, fecha_hora)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
    [id_admin || 1, accion, entidad, id_registro, String(detalle).slice(0, 250), nowSql()]
  ).catch(err => console.error('No se pudo registrar en auditoría:', err.message));
}
// Money is stored as REAL; rounding every intermediate step keeps 0.1 + 0.2 artefacts
// out of the totals that end up printed on the ticket.
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Reparte el precio de un paquete entre los productos que lleva dentro.
 *
 * Un combo "1 whisky y 2 cervezas por 60" no se guarda como una línea suelta
 * de 60 sin producto: se guarda como las tres bebidas que de verdad salieron,
 * cada una con su parte del precio. Así el reporte de cierre, que agrupa por
 * producto y suma subtotales, sigue diciendo la verdad sobre cuánto se vendió
 * de cada cosa, y el stock cuadra sin ningún caso especial.
 *
 * El reparto es proporcional al precio de catálogo: la bebida cara absorbe más
 * rebaja que la barata, que es lo que espera cualquiera que mire el ticket.
 *
 * Los céntimos que sobran al redondear van a la línea más cara, y van al
 * SUBTOTAL, no al precio unitario. Es deliberado: la suma de los subtotales
 * tiene que dar el precio del paquete EXACTO —hay una prueba que lo comprueba
 * en cada venta—, y forzar el cuadre repartiendo céntimos entre precios
 * unitarios de dos decimales no siempre tiene solución. En el ticket no se ve:
 * el paquete se imprime con su nombre y su precio, no con la aritmética.
 *
 * @param {Array<{idProd:number, qty:number, precioCatalogo:number}>} partes
 * @param {number} precioPaquete
 * @returns {Array<{idProd:number, qty:number, precio:number, subtotal:number}>}
 */
function repartirPrecioPaquete(partes, precioPaquete) {
  const suelto = partes.reduce((s, p) => s + p.precioCatalogo * p.qty, 0);
  if (!(suelto > 0)) {
    throw new BusinessError('La promoción no tiene productos con precio.');
  }
  const factor = precioPaquete / suelto;

  const lineas = partes.map(p => {
    const precio = round2(p.precioCatalogo * factor);
    return { idProd: p.idProd, qty: p.qty, precio, subtotal: round2(precio * p.qty) };
  });

  // El descuadre no pasa de unos céntimos, pero tiene que desaparecer: si no,
  // el total de la comanda no sería la suma de sus líneas.
  const sumado = round2(lineas.reduce((s, l) => s + l.subtotal, 0));
  const sobra = round2(precioPaquete - sumado);
  if (sobra !== 0) {
    let masCara = 0;
    for (let i = 1; i < lineas.length; i++) {
      if (lineas[i].subtotal > lineas[masCara].subtotal) masCara = i;
    }
    lineas[masCara].subtotal = round2(lineas[masCara].subtotal + sobra);
  }
  return lineas;
}

// Meseros authenticate with a short PIN only. 'servidor' (default) accepts any active
// waiter in this database: every cashier and every tablet hanging off this server is
// the same bar, so splitting them by till only locks out waiters who happen to be
// serving at another tablet. The narrower scopes are still available: 'cajero' (only
// the waiters assigned to that cashier) and 'evento'. Note that a PIN must be unique
// inside whatever scope is chosen — /api/admin/meseros enforces exactly that same scope.
const MESERO_PIN_SCOPE = process.env.MESERO_PIN_SCOPE || 'servidor';

// Identidad de la barra: su nombre.
//
// Hay UNA barra por instalación. El nombre sale de la tabla `configuracion`,
// es decir, de lo que el encargado escribe en el panel (Datos del evento), y
// suele cambiar de un evento a otro. Por eso no vive en ningún archivo de
// configuración: se edita en pantalla y ya.

// Nombre de partida, hasta que alguien lo cambie desde el panel.
const BARRA_POR_DEFECTO = 'Barra 1';

const INSTANCIA = {
  nombre: BARRA_POR_DEFECTO,
  // Fila de `barra` en la base. Es siempre la misma: sólo cambia su nombre.
  id_barra: null
};

/** Recoge el nombre de barra que haya guardado el panel. */
function refrescarIdentidad() {
  return dbGet("SELECT valor FROM instancia WHERE clave = 'nombre'")
    .then(() => dbGet('SELECT barra FROM configuracion WHERE id_configuracion = 1'))
    .then(cfg => {
      // Manda lo que diga el panel; si aún no se ha tocado, el de partida.
      const puesto = (cfg && cfg.barra ? String(cfg.barra) : '').trim();
      INSTANCIA.nombre = puesto || BARRA_POR_DEFECTO;
      // Se copia también a la tabla `instancia` para que el archivo .db siga
      // sabiendo de qué barra es aunque el nombre se haya cambiado desde el
      // panel: es lo que lo identifica si un día se copia a otro equipo.
      return Promise.all([
        dbRun(`INSERT INTO instancia (clave, valor) VALUES ('nombre', ?)
               ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [INSTANCIA.nombre]),
        sincronizarBarra(INSTANCIA.nombre)
      ]).then(() => INSTANCIA);
    })
    .catch(() => INSTANCIA);   // base aún sin crear: se queda el valor de partida
}

/**
 * Deja la tabla `barra` de acuerdo con el nombre escrito en Datos del evento.
 *
 * Con un servidor por evento hay UNA barra, así que no se crea una fila nueva
 * cada vez que se corrige el rótulo: se recuerda cuál es en la tabla
 * `instancia` y se le cambia el nombre. Así las comandas ya cobradas siguen
 * colgando de la misma barra y el resumen de ventas no se parte en dos.
 */
function sincronizarBarra(nombre) {
  const limpio = String(nombre || '').trim();
  if (!limpio) return Promise.resolve(null);

  // Se compara sin el "Barra " de delante: está en todas y no distingue nada,
  // de modo que "General" reconoce a la "Barra General" ya sembrada.
  const normaliza = txt => String(txt || '').trim().replace(/^barra\s+/i, '').toLowerCase();

  return dbGet("SELECT valor FROM instancia WHERE clave = 'id_barra'")
    .then(fila => {
      const guardada = fila && Number(fila.valor);
      if (!guardada) return null;
      return dbGet('SELECT * FROM barra WHERE id_barra = ?', [guardada]);
    })
    .then(barra => {
      if (barra) return barra;
      // Primer arranque: engancha a la que ya exista con ese nombre antes de
      // inventar una, o el panel acabaría con barras repetidas.
      return dbAll('SELECT * FROM barra ORDER BY id_barra').then(filas =>
        filas.find(b => normaliza(b.nombre_barra) === normaliza(limpio)) || null);
    })
    .then(barra => {
      if (!barra) {
        return dbRun(
          `INSERT INTO barra (id_evento, nombre_barra, descripcion, ubicacion, activo)
           VALUES (1, ?, '', '', 1)`, [limpio]
        ).then(r => ({ id_barra: r.insertId, nombre_barra: limpio }));
      }
      if (barra.nombre_barra === limpio) return barra;
      return dbRun('UPDATE barra SET nombre_barra = ? WHERE id_barra = ?', [limpio, barra.id_barra])
        .then(() => Object.assign({}, barra, { nombre_barra: limpio }));
    })
    .then(barra => {
      INSTANCIA.id_barra = barra.id_barra;
      return dbRun(`INSERT INTO instancia (clave, valor) VALUES ('id_barra', ?)
                    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`,
                   [String(barra.id_barra)]).then(() => barra);
    });
}

/**
 * Deja UNA sola barra en la base: la de este servidor.
 *
 * Las bases antiguas venían sembradas con Norte, Sur y General, de una versión
 * anterior en la que se preveían varias. Eso engañaba: el resumen del panel
 * enseñaba barras que en ese evento no existían, y una venta hecha aquí podía
 * quedar apuntada a "Barra Sur".
 *
 * No se borra nada de lo vendido. Los cajeros y las comandas de las otras
 * barras pasan a la barra buena, y sólo entonces se quitan las filas vacías.
 * Antes de tocar nada se deja una copia del archivo, porque esto no se puede
 * deshacer desde el panel.
 */
function unificarBarras() {
  if (!INSTANCIA.id_barra) return Promise.resolve(null);

  const id = INSTANCIA.id_barra;
  return dbAll('SELECT id_barra, nombre_barra FROM barra WHERE id_barra <> ?', [id])
    .then(sobran => {
      if (sobran.length === 0) return null;      // ya está unificada

      return respaldarBase()
        .then(() => withTransaction(async () => {
          const caj = await dbRun('UPDATE cajero  SET id_barra = ? WHERE id_barra <> ?', [id, id]);
          const com = await dbRun('UPDATE comanda SET id_barra = ? WHERE id_barra <> ?', [id, id]);
          await dbRun('DELETE FROM barra WHERE id_barra <> ?', [id]);
          return { cajeros: caj.affectedRows, comandas: com.affectedRows };
        }))
        .then(r => {
          console.log(`\n  ⚙ Barras unificadas en "${INSTANCIA.nombre}".`);
          console.log(`    Se retiraron: ${sobran.map(b => b.nombre_barra).join(', ')}`);
          console.log(`    Se trasladaron ${r.cajeros} cajeros y ${r.comandas} comandas.`);
          console.log(`    Copia previa: ${path.basename(RESPALDO)}\n`);
          return r;
        });
    })
    .catch(err => {
      console.error('  ⚠ No se pudieron unificar las barras:', err.message);
      return null;
    });
}

// Copia del archivo antes de la unificación. VACUUM INTO la hace desde dentro
// de SQLite, así que incluye lo que aún esté en el -wal; copiar el .db a mano
// se dejaría fuera las últimas ventas.
//
// Va a su carpeta y no al lado de la base buena. Sueltas en la raíz del
// proyecto, las copias parecen tres bases de datos distintas y no queda claro
// cuál es la del evento; en `respaldos/` se ve de un vistazo qué son y se
// borran de una vez cuando ya no hacen falta.
const CARPETA_RESPALDOS = path.join(path.dirname(dbFile), 'respaldos');
const RESPALDO = path.join(
  CARPETA_RESPALDOS,
  path.basename(dbFile).replace(/\.db$/, '') + '.antes-de-unificar.db'
);

function respaldarBase() {
  if (fs.existsSync(RESPALDO)) return Promise.resolve();   // ya hay una, no se pisa
  fs.mkdirSync(CARPETA_RESPALDOS, { recursive: true });
  return dbRun(`VACUUM INTO '${RESPALDO.replace(/'/g, "''")}'`).then(() => {});
}

// El número de comanda es el número y nada más. Llevó un prefijo de barra
// mientras se preveían varias; con una sola sólo añadía ruido a lo que el
// mesero tiene que cantar en voz alta y el cliente leer en el ticket.
const refComanda = id => String(id);

// Turns raw SQLite errors into something a cashier can act on.
function friendlyDbError(err, entidad) {
  const msg = String(err && err.message ? err.message : err);
  if (msg.includes('UNIQUE constraint failed')) {
    if (msg.includes('.usuario')) return 'Ese usuario ya existe. Elige otro nombre de usuario.';
    if (msg.includes('.nombre')) return `Ya existe una ${entidad} con ese nombre.`;
    return `Ese registro de ${entidad} ya existe.`;
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return `La ${entidad} apunta a un registro que no existe (categoría, barra o cajero).`;
  }
  if (msg.includes('NOT NULL constraint failed')) return `Faltan datos obligatorios de la ${entidad}.`;
  console.error(`Error de base de datos al guardar ${entidad}:`, msg);
  return `No se pudo guardar la ${entidad}.`;
}

// Wrapper that mimics mysql pool and connection methods to support existing routes
const pool = {
  query: (sql, params, callback) => {
    let realParams = params;
    let realCallback = callback;
    if (typeof params === 'function') {
      realCallback = params;
      realParams = [];
    }

    // Convert MySQL queries to SQLite compatibility
    let sqliteSql = sql
      .replace(/NOW\(\)/gi, "datetime('now', 'localtime')")
      .replace(/GREATEST\(0,\s*stock_actual\s*-\s*\?\)/gi, "MAX(0, stock_actual - ?)");

    const isSelect = sqliteSql.trim().toUpperCase().startsWith('SELECT');
    
    if (isSelect) {
      db.all(sqliteSql, realParams, (err, rows) => {
        if (err) {
          console.error("SQLite Pool Query Error:", err, "SQL:", sqliteSql);
          realCallback(err, null);
        } else {
          realCallback(null, rows);
        }
      });
    } else {
      db.run(sqliteSql, realParams, function(err) {
        if (err) {
          console.error("SQLite Pool Run Error:", err, "SQL:", sqliteSql);
          realCallback(err, null);
        } else {
          realCallback(null, { insertId: this.lastID, affectedRows: this.changes });
        }
      });
    }
  },
  
  // ⚠ NO USAR para escribir. Este adaptador expone beginTransaction/commit tal
  // como los pedía el código de MySQL, pero aquí sólo hay UNA conexión SQLite:
  // abrir una transacción por fuera de withTransaction() la mete dentro de la
  // que esté corriendo, y el COMMIT de una acaba confirmando el trabajo a medias
  // de la otra. Para cualquier escritura transaccional usa withTransaction().
  getConnection: (callback) => {
    const conn = {
      query: (sql, params, cb) => {
        let realParams = params;
        let realCb = cb;
        if (typeof params === 'function') {
          realCb = params;
          realParams = [];
        }

        let sqliteSql = sql
          .replace(/NOW\(\)/gi, "datetime('now', 'localtime')")
          .replace(/GREATEST\(0,\s*stock_actual\s*-\s*\?\)/gi, "MAX(0, stock_actual - ?)");

        const isSelect = sqliteSql.trim().toUpperCase().startsWith('SELECT');
        if (isSelect) {
          db.all(sqliteSql, realParams, (err, rows) => {
            if (err) {
              console.error("SQLite Conn Query Error:", err, "SQL:", sqliteSql);
              realCb(err, null);
            } else {
              realCb(null, rows);
            }
          });
        } else {
          db.run(sqliteSql, realParams, function(err) {
            if (err) {
              console.error("SQLite Conn Run Error:", err, "SQL:", sqliteSql);
              realCb(err, null);
            } else {
              realCb(null, { insertId: this.lastID, affectedRows: this.changes });
            }
          });
        }
      },
      beginTransaction: (cb) => {
        db.run('BEGIN TRANSACTION', cb);
      },
      commit: (cb) => {
        db.run('COMMIT', cb);
      },
      rollback: (cb) => {
        db.run('ROLLBACK', cb);
      },
      release: () => {
        // No-op for SQLite
      }
    };
    callback(null, conn);
  }
};

let useMockDb = false;

// Pre-populate Mock Database with original SQL Dump data as a resilient fallback
const mockDb = {
  evento: [
    { id_evento: 1, nombre_evento: 'Festival Sonidos de Verano 2026', fecha_evento: '2026-09-12', lugar: 'Estadio Central', descripcion: 'Evento musical con sistema POS distribuido', hora_inicio: '17:00:00', hora_fin: '02:00:00', activo: 1 }
  ],
  barra: [
    { id_barra: 1, id_evento: 1, nombre_barra: 'Barra Norte', descripcion: 'Barra ubicada en la curva norte', ubicacion: 'Curva Norte', activo: 1 },
    { id_barra: 2, id_evento: 1, nombre_barra: 'Barra Sur', descripcion: 'Barra ubicada en la curva sur', ubicacion: 'Curva Sur', activo: 1 },
    { id_barra: 3, id_evento: 1, nombre_barra: 'Barra General', descripcion: 'Barra principal del sector general', ubicacion: 'General', activo: 1 }
  ],
  cajero: [
    { id_cajero: 1, id_barra: 1, nombre: 'Ana Torres', usuario: 'cajero_norte_1', password: 'demo123', activo: 1 },
    { id_cajero: 2, id_barra: 1, nombre: 'Luis Mendoza', usuario: 'cajero_norte_2', password: 'demo123', activo: 1 },
    { id_cajero: 3, id_barra: 1, nombre: 'Carla Rojas', usuario: 'cajero_norte_3', password: 'demo123', activo: 1 },
    { id_cajero: 4, id_barra: 2, nombre: 'Pedro Vargas', usuario: 'cajero_sur_1', password: 'demo123', activo: 1 },
    { id_cajero: 5, id_barra: 2, nombre: 'María Fernández', usuario: 'cajero_sur_2', password: 'demo123', activo: 1 },
    { id_cajero: 6, id_barra: 2, nombre: 'Diego López', usuario: 'cajero_sur_3', password: 'demo123', activo: 1 },
    { id_cajero: 7, id_barra: 3, nombre: 'Brisa Garcia', usuario: 'cajero_general_1', password: 'demo123', activo: 1 },
    { id_cajero: 8, id_barra: 3, nombre: 'Jorge Salinas', usuario: 'cajero_general_2', password: 'demo123', activo: 1 },
    { id_cajero: 9, id_barra: 3, nombre: 'Valeria Quiroga', usuario: 'cajero_general_3', password: 'demo123', activo: 1 }
  ],
  administrador_evento: [
    { id_admin: 1, id_evento: 1, nombre: 'Administrador Principal', usuario: 'admin_evento', password: 'demo123', rol: 'ADMINISTRADOR', activo: 1 },
    { id_admin: 2, id_evento: 1, nombre: 'Supervisor Operativo', usuario: 'supervisor_evento', password: 'demo123', rol: 'SUPERVISOR', activo: 1 }
  ],
  mesero: [],
  categoria_producto: [
    { id_categoria: 1, nombre: 'Cervezas', descripcion: 'Cervezas nacionales e importadas', tipo: 'BEBIDA', activo: 1, creado_por_admin: 1, fecha_creacion: '2026-08-15 11:53:57' },
    { id_categoria: 2, nombre: 'Whiskys', descripcion: 'Whiskys servidos por medida o vaso', tipo: 'BEBIDA', activo: 1, creado_por_admin: 1, fecha_creacion: '2026-08-15 11:53:57' },
    { id_categoria: 3, nombre: 'Comida', descripcion: 'Comidas rápidas para el evento', tipo: 'COMIDA', activo: 1, creado_por_admin: 1, fecha_creacion: '2026-08-15 11:53:57' }
  ],
  producto: [
    { id_producto: 1, id_categoria: 1, nombre: 'Cerveza Paceña 350 ml', descripcion: 'Lata individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 18.00, stock_actual: 120, activo: 1, creado_por_admin: 1 },
    { id_producto: 2, id_categoria: 1, nombre: 'Cerveza Huari 330 ml', descripcion: 'Botella individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 22.00, stock_actual: 95, activo: 1, creado_por_admin: 1 },
    { id_producto: 3, id_categoria: 1, nombre: 'Cerveza Corona 355 ml', descripcion: 'Botella individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 28.00, stock_actual: 70, activo: 1, creado_por_admin: 1 },
    { id_producto: 4, id_categoria: 1, nombre: 'Cerveza Stella Artois 330 ml', descripcion: 'Botella individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 30.00, stock_actual: 60, activo: 1, creado_por_admin: 1 },
    { id_producto: 5, id_categoria: 1, nombre: 'Cerveza Heineken 330 ml', descripcion: 'Botella individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 29.00, stock_actual: 85, activo: 1, creado_por_admin: 1 },
    { id_producto: 6, id_categoria: 1, nombre: 'Cerveza Budweiser 355 ml', descripcion: 'Lata individual', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 24.00, stock_actual: 90, activo: 1, creado_por_admin: 1 },
    { id_producto: 7, id_categoria: 1, nombre: 'Cerveza artesanal IPA', descripcion: 'Vaso 400 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 32.00, stock_actual: 45, activo: 1, creado_por_admin: 1 },
    { id_producto: 8, id_categoria: 2, nombre: 'Johnnie Walker Red Label', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 35.00, stock_actual: 38, activo: 1, creado_por_admin: 1 },
    { id_producto: 9, id_categoria: 2, nombre: 'Johnnie Walker Black Label', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 55.00, stock_actual: 30, activo: 1, creado_por_admin: 1 },
    { id_producto: 10, id_categoria: 2, nombre: 'Chivas Regal 12 años', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 52.00, stock_actual: 24, activo: 1, creado_por_admin: 1 },
    { id_producto: 11, id_categoria: 2, nombre: 'Jack Daniel\'s', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 48.00, stock_actual: 32, activo: 1, creado_por_admin: 1 },
    { id_producto: 12, id_categoria: 2, nombre: 'Ballantine\'s Finest', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 38.00, stock_actual: 36, activo: 1, creado_por_admin: 1 },
    { id_producto: 13, id_categoria: 2, nombre: 'Jameson Irish Whiskey', descripcion: 'Medida 50 ml', tipo_producto: 'BEBIDA_ALCOHOLICA', precio_venta: 45.00, stock_actual: 28, activo: 1, creado_por_admin: 1 },
    { id_producto: 14, id_categoria: 3, nombre: 'Hamburguesa clásica', descripcion: 'Carne, queso, lechuga y tomate', tipo_producto: 'COMIDA', precio_venta: 38.00, stock_actual: 55, activo: 1, creado_por_admin: 1 },
    { id_producto: 15, id_categoria: 3, nombre: 'Hamburguesa doble', descripcion: 'Doble carne y doble queso', tipo_producto: 'COMIDA', precio_venta: 52.00, stock_actual: 42, activo: 1, creado_por_admin: 1 },
    { id_producto: 16, id_categoria: 3, nombre: 'Hot Dog', descripcion: 'Salchicha, papas y salsas', tipo_producto: 'COMIDA', precio_venta: 25.00, stock_actual: 65, activo: 1, creado_por_admin: 1 },
    { id_producto: 17, id_categoria: 3, nombre: 'Papas fritas', descripcion: 'Porción mediana', tipo_producto: 'COMIDA', precio_venta: 18.00, stock_actual: 80, activo: 1, creado_por_admin: 1 },
    { id_producto: 18, id_categoria: 3, nombre: 'Nachos con queso', descripcion: 'Nachos con salsa de queso', tipo_producto: 'COMIDA', precio_venta: 28.00, stock_actual: 50, activo: 1, creado_por_admin: 1 },
    { id_producto: 19, id_categoria: 3, nombre: 'Sándwich de pollo', descripcion: 'Pollo, lechuga y aderezos', tipo_producto: 'COMIDA', precio_venta: 32.00, stock_actual: 48, activo: 1, creado_por_admin: 1 },
    { id_producto: 20, id_categoria: 3, nombre: 'Pizza personal', descripcion: 'Pizza individual de queso y jamón', tipo_producto: 'COMIDA', precio_venta: 40.00, stock_actual: 40, activo: 1, creado_por_admin: 1 }
  ],
  // Sin ventas de muestra. Antes venía una comanda de demostración, pero sus
  // líneas no llevaban el movimiento de stock correspondiente: toda base nueva
  // nacía con las existencias descuadradas y el panel marcando 500 Bs. de una
  // venta que nunca ocurrió.
  comanda: [],
  detalle_comanda: [],
  pago_comanda: [],
  metodo_pago: [
    { id_metodo_pago: 1, nombre: 'EFECTIVO', descripcion: 'Pago en efectivo', activo: 1 },
    { id_metodo_pago: 2, nombre: 'TARJETA', descripcion: 'Pago con tarjeta', activo: 1 },
    { id_metodo_pago: 3, nombre: 'QR', descripcion: 'Pago con código QR', activo: 1 },
    { id_metodo_pago: 4, nombre: 'TRANSFERENCIA', descripcion: 'Transferencia bancaria', activo: 1 }
  ],
  movimiento_stock: [],
  auditoria_admin: [
    { id_auditoria: 1, id_admin: 1, id_evento: 1, accion: 'CREAR_CATEGORIA', entidad: 'categoria_producto', id_registro: 1, detalle: 'Se creó la categoría Cervezas', fecha_hora: '2026-08-15 11:53:58' },
    { id_auditoria: 2, id_admin: 1, id_evento: 1, accion: 'CREAR_PRODUCTO', entidad: 'producto', id_registro: 1, detalle: 'Se creó el producto Cerveza Paceña 350 ml', fecha_hora: '2026-08-15 11:53:58' },
    { id_auditoria: 3, id_admin: 1, id_evento: 1, accion: 'AGREGAR_STOCK', entidad: 'producto', id_registro: 1, detalle: 'Carga inicial de 120 unidades', fecha_hora: '2026-08-15 11:53:58' }
  ],
  impresion_comanda_cajero: [],
  impresion_comanda_mesero: []
};

// Generate 45 waiters to match original SQL dump
for (let i = 1; i <= 45; i++) {
  const cajeroId = Math.ceil(i / 5); // 5 waiters per cashier
  const names = [
    'Juan Pérez', 'Miguel Flores', 'Sofía Álvarez', 'René Castro', 'Lucía Molina',
    'Mario Gutiérrez', 'Gabriela Soto', 'Andrés Vega', 'Paola Méndez', 'David Arce',
    'Fernando Paz', 'Daniela Cruz', 'Rodrigo Silva', 'Camila Romero', 'Nicolás Suárez',
    'Mateo Ríos', 'Andrea Villarroel', 'Óscar Paredes', 'Natalia León', 'Hugo Cabrera',
    'Marco Aguilar', 'Elena Zamora', 'Pablo Serrano', 'Rocío Chávez', 'Cristian Núñez',
    'Alejandro Ortiz', 'Verónica Lima', 'Martín Céspedes', 'Lorena Ponce', 'Samuel Rocha',
    'Kevin Miranda', 'Isabel Arias', 'Franco Velasco', 'Mónica Durán', 'Esteban Cuéllar',
    'Raúl Guzmán', 'Claudia Peña', 'Iván Mercado', 'Laura Terán', 'Álvaro Rivero',
    'Sergio Blanco', 'Mariana Prado', 'José Valdez', 'Tatiana Roca', 'Carlos Méndez'
  ];
  mockDb.mesero.push({
    id_mesero: i,
    id_evento: 1,
    id_cajero: cajeroId,
    nombre: names[i - 1],
    usuario: `mesero_${i < 10 ? '0' + i : i}`,
    password: (1000 + i).toString(),
    activo: 1
  });
}

// Un movimiento de ENTRADA por cada producto que nace con existencias.
//
// Antes la semilla traía tres movimientos sueltos para veinte productos con
// stock. El reporte de stock cuadra existencias contra movimientos, así que los
// otros diecisiete aparecían con unidades que nadie había metido nunca. Ahora
// cada unidad que hay en la base tiene su movimiento detrás.
mockDb.producto
  .filter(p => Number(p.stock_actual) > 0)
  .forEach((p, i) => {
    mockDb.movimiento_stock.push({
      id_movimiento: i + 1,
      id_producto: p.id_producto,
      id_admin: 1,
      tipo_movimiento: 'ENTRADA',
      cantidad: p.stock_actual,
      stock_anterior: 0,
      stock_nuevo: p.stock_actual,
      motivo: 'Carga inicial de stock para el evento',
      fecha_hora: '2026-08-15 11:53:58'
    });
  });

// Adds a column to an existing table only when it is missing (idempotent migration).
function ensureColumn(table, column, definition) {
  db.all(`PRAGMA table_info(${table})`, (err, cols) => {
    if (err) return console.error(`Migration check failed for ${table}.${column}:`, err.message);
    if (cols.some(c => c.name === column)) return;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, errAlter => {
      if (errAlter) return console.error(`Migration failed for ${table}.${column}:`, errAlter.message);
      // Las sentencias ya preparadas apuntan al esquema anterior: se descartan.
      stmtCache.clear();
      console.log(`🛠️  Migración aplicada: ${table}.${column} añadida.`);
    });
  });
}

// Database Schema Initialization (SQLite)
function initializeDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS evento (
      id_evento INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre_evento TEXT,
      fecha_evento TEXT,
      lugar TEXT,
      descripcion TEXT,
      hora_inicio TEXT,
      hora_fin TEXT,
      activo INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS barra (
      id_barra INTEGER PRIMARY KEY AUTOINCREMENT,
      id_evento INTEGER,
      nombre_barra TEXT,
      descripcion TEXT,
      ubicacion TEXT,
      activo INTEGER DEFAULT 1,
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cajero (
      id_cajero INTEGER PRIMARY KEY AUTOINCREMENT,
      id_barra INTEGER,
      nombre TEXT,
      usuario TEXT UNIQUE,
      password TEXT,
      activo INTEGER DEFAULT 1,
      FOREIGN KEY(id_barra) REFERENCES barra(id_barra)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS administrador_evento (
      id_admin INTEGER PRIMARY KEY AUTOINCREMENT,
      id_evento INTEGER,
      nombre TEXT,
      usuario TEXT UNIQUE,
      password TEXT,
      rol TEXT,
      activo INTEGER DEFAULT 1,
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS mesero (
      id_mesero INTEGER PRIMARY KEY AUTOINCREMENT,
      id_evento INTEGER,
      id_cajero INTEGER,
      nombre TEXT,
      usuario TEXT UNIQUE,
      password TEXT,
      activo INTEGER DEFAULT 1,
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento),
      FOREIGN KEY(id_cajero) REFERENCES cajero(id_cajero)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS categoria_producto (
      id_categoria INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT UNIQUE,
      descripcion TEXT,
      tipo TEXT,
      activo INTEGER DEFAULT 1,
      creado_por_admin INTEGER,
      fecha_creacion TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS producto (
      id_producto INTEGER PRIMARY KEY AUTOINCREMENT,
      id_categoria INTEGER,
      nombre TEXT,
      descripcion TEXT,
      tipo_producto TEXT,
      precio_venta REAL,
      stock_actual INTEGER,
      activo INTEGER DEFAULT 1,
      creado_por_admin INTEGER,
      fecha_creacion TEXT,
      FOREIGN KEY(id_categoria) REFERENCES categoria_producto(id_categoria)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS comanda (
      id_comanda INTEGER PRIMARY KEY AUTOINCREMENT,
      id_evento INTEGER,
      id_barra INTEGER,
      id_cajero INTEGER,
      id_mesero INTEGER,
      fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
      total REAL,
      estado_pago TEXT,
      estatus TEXT,
      observaciones TEXT,
      anulada_por_admin INTEGER NULL,
      fecha_anulacion TEXT NULL,
      motivo_anulacion TEXT NULL,
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento),
      FOREIGN KEY(id_barra) REFERENCES barra(id_barra),
      FOREIGN KEY(id_cajero) REFERENCES cajero(id_cajero),
      FOREIGN KEY(id_mesero) REFERENCES mesero(id_mesero)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS detalle_comanda (
      id_detalle INTEGER PRIMARY KEY AUTOINCREMENT,
      id_comanda INTEGER,
      id_producto INTEGER,
      cantidad INTEGER,
      precio_unitario REAL,
      subtotal REAL,
      FOREIGN KEY(id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE,
      FOREIGN KEY(id_producto) REFERENCES producto(id_producto)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS metodo_pago (
      id_metodo_pago INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT UNIQUE,
      descripcion TEXT,
      activo INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pago_comanda (
      id_pago INTEGER PRIMARY KEY AUTOINCREMENT,
      id_comanda INTEGER,
      id_metodo_pago INTEGER,
      monto REAL,
      fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
      referencia TEXT,
      estado TEXT,
      FOREIGN KEY(id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE,
      FOREIGN KEY(id_metodo_pago) REFERENCES metodo_pago(id_metodo_pago)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS movimiento_stock (
      id_movimiento INTEGER PRIMARY KEY AUTOINCREMENT,
      id_producto INTEGER,
      id_admin INTEGER,
      tipo_movimiento TEXT,
      cantidad INTEGER,
      stock_anterior INTEGER,
      stock_nuevo INTEGER,
      motivo TEXT,
      fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(id_producto) REFERENCES producto(id_producto),
      FOREIGN KEY(id_admin) REFERENCES administrador_evento(id_admin)
    )`);

    // Traspasos e ingresos de mercancía.
    //
    // Van en su propia tabla y no sólo en movimiento_stock porque un traspaso
    // es un documento: tiene número, se imprime para el bartender que entrega
    // la mercancía, y al día siguiente hay que poder decir qué salió, a dónde
    // y quién lo mandó. `movimiento_stock` sigue llevando el apunte contable
    // de cada producto; esto lleva el papel.
    db.run(`CREATE TABLE IF NOT EXISTS traspaso (
      id_traspaso INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT,             -- 'SALIDA' (se va) | 'ENTRADA' (llega)
      motivo TEXT,           -- 'TRASPASO' | 'COMPRA'
      contraparte TEXT,      -- a dónde va, o de dónde viene / a quién se compró
      observaciones TEXT,
      id_cajero INTEGER,
      id_admin INTEGER,
      fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS traspaso_detalle (
      id_detalle_traspaso INTEGER PRIMARY KEY AUTOINCREMENT,
      id_traspaso INTEGER,
      id_producto INTEGER,
      cantidad INTEGER,
      FOREIGN KEY(id_traspaso) REFERENCES traspaso(id_traspaso) ON DELETE CASCADE,
      FOREIGN KEY(id_producto) REFERENCES producto(id_producto)
    )`);

    // ---- Promociones ----------------------------------------------------
    //
    // Una promoción es un PAQUETE: un conjunto de productos con sus cantidades
    // a un precio cerrado. "1 whisky y 2 cervezas por 60" o "balde de 6
    // Paceñas por 90" son la misma cosa con distinto contenido.
    //
    // No es un producto. No tiene stock propio ni se le hace inventario: al
    // venderla salen de la nevera los productos que lleva dentro, uno por uno.
    // Es sólo una regla de precio con nombre.
    db.run(`CREATE TABLE IF NOT EXISTS promocion (
      id_promocion INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      descripcion TEXT,
      precio REAL,
      activa INTEGER DEFAULT 1,
      creada_por_admin INTEGER,
      fecha_creacion TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS promocion_detalle (
      id_detalle_promocion INTEGER PRIMARY KEY AUTOINCREMENT,
      id_promocion INTEGER,
      id_producto INTEGER,
      cantidad INTEGER,
      FOREIGN KEY(id_promocion) REFERENCES promocion(id_promocion) ON DELETE CASCADE,
      FOREIGN KEY(id_producto) REFERENCES producto(id_producto)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS auditoria_admin (
      id_auditoria INTEGER PRIMARY KEY AUTOINCREMENT,
      id_admin INTEGER,
      id_evento INTEGER,
      accion TEXT,
      entidad TEXT,
      id_registro INTEGER,
      detalle TEXT,
      fecha_hora TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(id_admin) REFERENCES administrador_evento(id_admin),
      FOREIGN KEY(id_evento) REFERENCES evento(id_evento)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS impresion_comanda_cajero (
      id_impresion_cajero INTEGER PRIMARY KEY AUTOINCREMENT,
      id_comanda INTEGER,
      fecha_hora_impresion TEXT DEFAULT CURRENT_TIMESTAMP,
      numero_copia INTEGER,
      FOREIGN KEY(id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS impresion_comanda_mesero (
      id_impresion_mesero INTEGER PRIMARY KEY AUTOINCREMENT,
      id_comanda INTEGER,
      fecha_hora_impresion TEXT DEFAULT CURRENT_TIMESTAMP,
      numero_copia INTEGER,
      FOREIGN KEY(id_comanda) REFERENCES comanda(id_comanda) ON DELETE CASCADE
    )`);

    // Migration: databases created before this fix lack these two columns on `producto`,
    // which made every "Crear Producto" call fail with "no such column: creado_por_admin".
    ensureColumn('producto', 'creado_por_admin', 'INTEGER');
    // Foto del producto, guardada como data URI dentro de la propia base.
    // Va en la base y no como archivo suelto para que viaje con ella: el .db
    // se copia a otra tablet y las fotos siguen ahí, sin una carpeta aparte
    // que se olvide al hacer la copia de seguridad.
    ensureColumn('producto', 'foto', 'TEXT');
    ensureColumn('producto', 'fecha_creacion', 'TEXT');

    // Acompañamientos.
    //
    // Una botella se vende con su refresco incluido. Son dos marcas distintas:
    //
    //   requiere_acompanante  la botella: al ponerla en el carrito hay que
    //                         elegir con qué va
    //   es_acompanante        el refresco: puede ir de acompañante
    //
    // No son excluyentes ni simétricas. El mismo refresco se vende suelto y
    // cobrado, y va gratis dentro de una botella: es el mismo producto y el
    // mismo stock, sólo cambia si se cobra o no.
    ensureColumn('producto', 'requiere_acompanante', 'INTEGER DEFAULT 0');
    ensureColumn('producto', 'es_acompanante', 'INTEGER DEFAULT 0');

    // La línea del acompañante cuelga de la de su botella. Sin esto, en el
    // ticket y en el cierre saldrían como dos productos sueltos y no se sabría
    // cuál iba con cuál ni por qué uno vale cero.
    ensureColumn('detalle_comanda', 'id_detalle_padre', 'INTEGER');

    // De qué promoción salió esta línea. La línea sigue siendo un producto de
    // verdad con su precio de verdad —el del paquete, repartido—, así que el
    // stock, el reporte por producto y el cierre siguen cuadrando solos. Esto
    // sólo sirve para volver a juntarlas en el ticket y poder imprimir "Combo
    // Amigos 60.00" en vez de tres líneas con precios raros.
    ensureColumn('detalle_comanda', 'id_promocion', 'INTEGER');

    // Identificador único del intento de cobro, para no guardar dos veces la
    // misma venta. La tablet lo genera al abrir el modal de cobro y lo repite
    // si tiene que reintentar; el servidor, al reconocerlo, devuelve la comanda
    // que ya guardó en vez de crear otra.
    //
    // Sin esto, una respuesta perdida por el WiFi hacía que el cajero volviera
    // a pulsar y la venta se guardara dos veces: se cobraba una y el stock
    // bajaba dos.
    ensureColumn('comanda', 'clave_idempotencia', 'TEXT');

    // Quién pidió cada impresión. Reimprimir es la puerta de atrás de la barra:
    // con el ticket en la mano se puede cobrar dos veces la misma venta.
    //
    // Se apuntan los DOS, cajero y mesero, y no sólo quien tocó la pantalla. Si
    // se ponen de acuerdo para reimprimir y cobrar aparte, con un solo nombre
    // en el registro el otro queda limpio y no hay forma de reconstruirlo.
    ['impresion_comanda_cajero', 'impresion_comanda_mesero'].forEach(tabla => {
      ensureColumn(tabla, 'id_cajero', 'INTEGER');
      ensureColumn(tabla, 'id_mesero', 'INTEGER');
    });
    // El índice es la red de seguridad: aunque la comprobación fallara, la base
    // no aceptaría dos comandas con la misma clave.
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comanda_idempotencia
            ON comanda(clave_idempotencia) WHERE clave_idempotencia IS NOT NULL`);

    // Identidad de la barra, grabada DENTRO de la propia base.
    //
    // Los archivos .db de dos eventos son idénticos por fuera. Guardando aquí el
    // nombre de la barra, un archivo suelto se explica solo aunque aparezca
    // meses después en una copia de seguridad.
    db.run(`CREATE TABLE IF NOT EXISTS instancia (
      clave TEXT PRIMARY KEY,
      valor TEXT
    )`);

    // Datos del evento que se imprimen en tickets y reportes. Van en su propia
    // tabla, y no en el .env, porque los cambia el encargado desde el panel sin
    // tocar archivos ni reiniciar nada: el nombre real del evento, la fecha, el
    // sitio, cómo se llama esta barra de cara al público y quién responde de ella.
    //
    // Es una sola fila (id = 1). Se crea al arrancar si no está, tomando lo que
    // haya del evento sembrado y el nombre de esta instancia, de modo que nunca
    // queda vacía aunque nadie la toque.
    db.run(`CREATE TABLE IF NOT EXISTS configuracion (
      id_configuracion INTEGER PRIMARY KEY CHECK (id_configuracion = 1),
      evento TEXT,
      fecha TEXT,
      lugar TEXT,
      barra TEXT,
      responsable TEXT
    )`);
    db.get('SELECT COUNT(*) AS n FROM configuracion', (errCfg, filaCfg) => {
      if (errCfg || (filaCfg && filaCfg.n > 0)) return;
      db.get('SELECT nombre_evento, fecha_evento, lugar FROM evento LIMIT 1', (errEv, ev) => {
        db.run(
          `INSERT INTO configuracion (id_configuracion, evento, fecha, lugar, barra, responsable)
           VALUES (1, ?, ?, ?, ?, '')`,
          [
            (ev && ev.nombre_evento) || 'Evento',
            (ev && ev.fecha_evento) || nowSql().slice(0, 10),
            (ev && ev.lugar) || '',
            INSTANCIA.nombre
          ]
        );
      });
    });

    // La base deja constancia de cómo se llama la barra. No lo usa el servidor
    // para decidir nada: sirve para saber de qué evento es un archivo .db
    // cuando aparece suelto en una copia de seguridad.
    db.run(`INSERT INTO instancia (clave, valor) VALUES ('nombre', ?)
            ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [INSTANCIA.nombre]);
    db.run(`INSERT INTO instancia (clave, valor) VALUES ('primer_arranque', ?)
            ON CONFLICT(clave) DO NOTHING`, [nowSql()]);

    // Check if database is empty by querying events count
    db.get("SELECT COUNT(*) as count FROM evento", (err, row) => {
      if (err) {
        console.error("Error checking database initialization:", err);
        return;
      }

      if (row && row.count === 0) {
        // Una sola barra, con el nombre de partida. El encargado lo cambia
        // luego en el panel. Antes se sembraban tres (Norte, Sur y General) y
        // el resumen del panel enseñaba barras que en ese evento no existían.
        const barrasASembrar = [Object.assign({}, mockDb.barra[0],
          { nombre_barra: BARRA_POR_DEFECTO, ubicacion: '' })];
        const idBarraUnica = barrasASembrar[0].id_barra;

        // Todo el personal de muestra cuelga de esa barra: si se quedara
        // apuntando a una que no existe, esos cajeros no podrían ni entrar.
        const cajerosASembrar = mockDb.cajero.map(c =>
          Object.assign({}, c, { id_barra: idBarraUnica }));
        const idsCajero = new Set(cajerosASembrar.map(c => c.id_cajero));
        const meserosASembrar = mockDb.mesero.filter(m => idsCajero.has(m.id_cajero));

        console.log(`💾 Sembrando la base: barra ${BARRA_POR_DEFECTO}, ` +
          `${cajerosASembrar.length} cajeros y ${meserosASembrar.length} meseros.`);

        // Seed Evento
        db.run(`INSERT INTO evento (id_evento, nombre_evento, fecha_evento, lugar, descripcion, hora_inicio, hora_fin, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [mockDb.evento[0].id_evento, mockDb.evento[0].nombre_evento, mockDb.evento[0].fecha_evento, mockDb.evento[0].lugar, mockDb.evento[0].descripcion, mockDb.evento[0].hora_inicio, mockDb.evento[0].hora_fin, mockDb.evento[0].activo]);

        // Seed Barras
        barrasASembrar.forEach(b => {
          db.run(`INSERT INTO barra (id_barra, id_evento, nombre_barra, descripcion, ubicacion, activo) VALUES (?, ?, ?, ?, ?, ?)`,
            [b.id_barra, b.id_evento, b.nombre_barra, b.descripcion, b.ubicacion, b.activo]);
        });

        // Seed Cajeros
        cajerosASembrar.forEach(c => {
          db.run(`INSERT INTO cajero (id_cajero, id_barra, nombre, usuario, password, activo) VALUES (?, ?, ?, ?, ?, ?)`,
            [c.id_cajero, c.id_barra, c.nombre, c.usuario, c.password, c.activo]);
        });

        // Seed Admins — el administrador entra en todas las barras: es quien
        // carga el stock y saca el cierre de cada una.
        mockDb.administrador_evento.forEach(a => {
          db.run(`INSERT INTO administrador_evento (id_admin, id_evento, nombre, usuario, password, rol, activo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [a.id_admin, a.id_evento, a.nombre, a.usuario, a.password, a.rol, a.activo]);
        });

        // Seed Meseros
        meserosASembrar.forEach(m => {
          db.run(`INSERT INTO mesero (id_mesero, id_evento, id_cajero, nombre, usuario, password, activo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [m.id_mesero, m.id_evento, m.id_cajero, m.nombre, m.usuario, m.password, m.activo]);
        });

        // Seed Categorias
        mockDb.categoria_producto.forEach(cat => {
          db.run(`INSERT INTO categoria_producto (id_categoria, nombre, descripcion, tipo, activo, creado_por_admin, fecha_creacion) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [cat.id_categoria, cat.nombre, cat.descripcion, cat.tipo, cat.activo, cat.creado_por_admin, cat.fecha_creacion]);
        });

        // Seed Productos
        mockDb.producto.forEach(p => {
          db.run(`INSERT INTO producto (id_producto, id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [p.id_producto, p.id_categoria, p.nombre, p.descripcion, p.tipo_producto, p.precio_venta, p.stock_actual, p.activo]);
        });

        // Seed Metodos Pago
        mockDb.metodo_pago.forEach(mp => {
          db.run(`INSERT INTO metodo_pago (id_metodo_pago, nombre, descripcion, activo) VALUES (?, ?, ?, ?)`,
            [mp.id_metodo_pago, mp.nombre, mp.descripcion, mp.activo]);
        });

        // Seed Comandas, Detalle, Pagos, Movs
        mockDb.comanda.forEach(c => {
          // La comanda de muestra tiene que colgar de la barra que existe.
          const idBarra = idBarraUnica;
          db.run(`INSERT INTO comanda (id_comanda, id_evento, id_barra, id_cajero, id_mesero, fecha_hora, total, estado_pago, estatus, observaciones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [c.id_comanda, c.id_evento, idBarra, c.id_cajero, c.id_mesero, c.fecha_hora, c.total, c.estado_pago, c.estatus, c.observaciones]);
        });

        mockDb.detalle_comanda.forEach(d => {
          db.run(`INSERT INTO detalle_comanda (id_detalle, id_comanda, id_producto, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?, ?)`,
            [d.id_detalle, d.id_comanda, d.id_producto, d.cantidad, d.precio_unitario, d.subtotal]);
        });

        mockDb.pago_comanda.forEach(p => {
          db.run(`INSERT INTO pago_comanda (id_pago, id_comanda, id_metodo_pago, monto, fecha_hora, referencia, estado) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [p.id_pago, p.id_comanda, p.id_metodo_pago, p.monto, p.fecha_hora, p.referencia, p.estado]);
        });

        mockDb.movimiento_stock.forEach(m => {
          db.run(`INSERT INTO movimiento_stock (id_movimiento, id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [m.id_movimiento, m.id_producto, m.id_admin, m.tipo_movimiento, m.cantidad, m.stock_anterior, m.stock_nuevo, m.motivo, m.fecha_hora]);
        });

        mockDb.auditoria_admin.forEach(a => {
          db.run(`INSERT INTO auditoria_admin (id_auditoria, id_admin, id_evento, accion, entidad, id_registro, detalle, fecha_hora) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [a.id_auditoria, a.id_admin, a.id_evento, a.accion, a.entidad, a.id_registro, a.detalle, a.fecha_hora]);
        });

        mockDb.impresion_comanda_cajero.forEach(i => {
          db.run(`INSERT INTO impresion_comanda_cajero (id_impresion_cajero, id_comanda, fecha_hora_impresion, numero_copia) VALUES (?, ?, ?, ?)`,
            [i.id_impresion_cajero, i.id_comanda, i.fecha_hora_impresion, i.numero_copia]);
        });

        mockDb.impresion_comanda_mesero.forEach(i => {
          db.run(`INSERT INTO impresion_comanda_mesero (id_impresion_mesero, id_comanda, fecha_hora_impresion, numero_copia) VALUES (?, ?, ?, ?)`,
            [i.id_impresion_mesero, i.id_comanda, i.fecha_hora_impresion, i.numero_copia]);
        });

        console.log("✅ SQLite database successfully seeded!");
      } else {
        console.log("💾 SQLite database already exists with data. Seeding skipped.");
      }
    });
  });
}

// Database Connection Attempt
function connectDatabase() {
  console.log(`🔌 Connecting to local SQLite database at: ${dbFile}...`);
  initializeDatabase();
  console.log(`✅ SUCCESS: Fully connected to SQLite database: pos_evento.db!\n`);
}
connectDatabase();

// Utility for executing query with automatic mock database fallback
function executeQuery(query, params, callback) {
  if (useMockDb) {
    // If mock DB is active, we bypass and let the specific router function handle logic locally.
    callback(new Error("MOCK_DB_ACTIVE"), null);
  } else {
    pool.query(query, params, (err, results) => {
      if (err) {
        console.error("Database Query Error:", err);
        callback(err, null);
      } else {
        callback(null, results);
      }
    });
  }
}

// ==========================================
// 1. API: AUTHENTICATION
// ==========================================
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;

  if (useMockDb) {
    // Check Cajeros
    const cajero = mockDb.cajero.find(c => c.usuario === usuario && c.password === password && c.activo === 1);
    if (cajero) {
      const barra = mockDb.barra.find(b => b.id_barra === cajero.id_barra);
      const evento = mockDb.evento.find(e => e.id_evento === barra.id_evento);
      return res.json({
        success: true,
        rol: 'CAJERO',
        user: {
          id_cajero: cajero.id_cajero,
          nombre: cajero.nombre,
          id_barra: cajero.id_barra,
          nombre_barra: barra.nombre_barra,
          id_evento: barra.id_evento,
          nombre_evento: evento.nombre_evento
        }
      });
    }

    // Check Admins
    const admin = mockDb.administrador_evento.find(a => a.usuario === usuario && a.password === password && a.activo === 1);
    if (admin) {
      const evento = mockDb.evento.find(e => e.id_evento === admin.id_evento);
      return res.json({
        success: true,
        rol: admin.rol, // ADMINISTRADOR or SUPERVISOR
        user: {
          id_admin: admin.id_admin,
          nombre: admin.nombre,
          id_evento: admin.id_evento,
          nombre_evento: evento.nombre_evento
        }
      });
    }

    return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
  } else {
    // Real MySQL Auth
    const queryCajero = `
      SELECT c.id_cajero, c.nombre, c.id_barra, b.nombre_barra, b.id_evento, e.nombre_evento
      FROM cajero c
      JOIN barra b ON c.id_barra = b.id_barra
      JOIN evento e ON b.id_evento = e.id_evento
      WHERE c.usuario = ? AND c.password = ? AND c.activo = 1
    `;
    pool.query(queryCajero, [usuario, password], (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.length > 0) {
        return res.json({ success: true, rol: 'CAJERO', user: results[0] });
      }

      // Check Admin
      const queryAdmin = `
        SELECT a.id_admin, a.nombre, a.id_evento, a.rol, e.nombre_evento
        FROM administrador_evento a
        JOIN evento e ON a.id_evento = e.id_evento
        WHERE a.usuario = ? AND a.password = ? AND a.activo = 1
      `;
      pool.query(queryAdmin, [usuario, password], (err2, results2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        if (results2.length > 0) {
          return res.json({
            success: true,
            rol: results2[0].rol,
            user: {
              id_admin: results2[0].id_admin,
              nombre: results2[0].nombre,
              id_evento: results2[0].id_evento,
              nombre_evento: results2[0].nombre_evento
            }
          });
        }
        return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
      });
    });
  }
});

app.post('/api/login/mesero', (req, res) => {
  const { password } = req.body;

  if (useMockDb) {
    const mesero = mockDb.mesero.find(m => m.password === password && m.activo === 1);
    if (mesero) {
      return res.json({ success: true, mesero: { id_mesero: mesero.id_mesero, nombre: mesero.nombre } });
    }
    return res.status(401).json({ success: false, message: 'Contraseña del mesero incorrecta' });
  } else {
    const { id_cajero, id_barra, id_evento } = req.body;

    // mesero has no id_barra of its own: the bar is the one of the cashier it reports to.
    let query = `
      SELECT m.id_mesero, m.nombre, m.id_cajero, c.id_barra
      FROM mesero m
      JOIN cajero c ON m.id_cajero = c.id_cajero
      WHERE m.password = ? AND m.activo = 1
    `;
    const params = [password];
    // Tells the failure branch below whether a rejection could mean "right PIN, wrong
    // tablet" (a scope was applied) or simply "no such PIN" (the default, unscoped).
    let fueraDeAlcance = null;

    if (MESERO_PIN_SCOPE === 'cajero' && id_cajero) {
      // A waiter reports to one cashier (mesero.id_cajero); only their PINs open this till.
      query += ` AND m.id_cajero = ?`;
      params.push(id_cajero);
      fueraDeAlcance = 'Ese PIN es de un mesero de otra caja.';
    } else if (MESERO_PIN_SCOPE === 'evento' && id_evento) {
      query += ` AND m.id_evento = ?`;
      params.push(id_evento);
      fueraDeAlcance = 'Ese PIN es de un mesero de otro evento.';
    }

    pool.query(query, params, (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.length === 1) {
        return res.json({ success: true, mesero: results[0] });
      }
      if (results.length > 1) {
        // Two waiters share a PIN: refusing beats attributing the sale to the wrong person.
        return res.status(409).json({
          success: false,
          message: 'PIN duplicado entre meseros. Avisa al administrador.'
        });
      }

      // Nothing matched. Under the default scope that can only mean the PIN does not
      // exist; under a narrower one it may be a valid PIN typed on the wrong tablet,
      // and saying so saves the cashier from retyping a PIN that was never going to work.
      if (!fueraDeAlcance) {
        return res.status(401).json({ success: false, message: 'Contraseña del mesero incorrecta' });
      }
      pool.query(
        `SELECT m.id_mesero FROM mesero m WHERE m.password = ? AND m.activo = 1`,
        [password],
        (errAny, anyRows) => {
          if (!errAny && anyRows.length > 0) {
            return res.status(401).json({ success: false, message: fueraDeAlcance });
          }
          return res.status(401).json({ success: false, message: 'Contraseña del mesero incorrecta' });
        }
      );
    });
  }
});

// Quién es este servidor. Lo consulta la tablet nada más cargar para saber qué
// barra está atendiendo y cómo numerar sus comandas. Es público a propósito:
// lo necesita el POS antes de que nadie inicie sesión.
app.get('/api/instancia', (req, res) => {
  res.json({ nombre: INSTANCIA.nombre, id_barra: INSTANCIA.id_barra, version: VERSION_UI });
});

// ==========================================
// 1d. API: CONFIGURACIÓN DEL EVENTO
// ==========================================
// Los datos que se imprimen en tickets y reportes: evento, fecha, lugar, barra
// y responsable. Se leen en abierto porque la caja los necesita para el ticket
// antes de que ningún administrador entre; sólo escribirlos exige el panel.
const CAMPOS_CONFIG = ['evento', 'fecha', 'lugar', 'barra', 'responsable'];

function leerConfiguracion() {
  return dbGet('SELECT evento, fecha, lugar, barra, responsable FROM configuracion WHERE id_configuracion = 1')
    .then(fila => fila || { evento: '', fecha: '', lugar: '', barra: INSTANCIA.nombre, responsable: '' });
}

app.get('/api/configuracion', (req, res) => {
  if (useMockDb) {
    return res.json({ evento: '', fecha: '', lugar: '', barra: INSTANCIA.nombre, responsable: '' });
  }
  leerConfiguracion()
    .then(cfg => res.json(cfg))
    .catch(err => {
      console.error('Error al leer la configuración:', err);
      res.status(500).json({ success: false, message: 'No se pudo leer la configuración.' });
    });
});

app.put('/api/admin/configuracion-evento', (req, res) => {
  if (useMockDb) {
    return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });
  }

  // Se recorta en lugar de rechazar: son datos de rótulo, no cifras. Lo único
  // que se exige es que el evento y la barra tengan algo, porque encabezan
  // todos los tickets y el cierre de caja.
  const limpio = {};
  for (const campo of CAMPOS_CONFIG) {
    limpio[campo] = String(req.body[campo] == null ? '' : req.body[campo]).trim().slice(0, 120);
  }
  if (!limpio.evento) {
    return res.status(400).json({ success: false, message: 'El evento necesita un nombre.' });
  }
  if (!limpio.barra) {
    return res.status(400).json({ success: false, message: 'La barra necesita un nombre.' });
  }
  if (limpio.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(limpio.fecha)) {
    return res.status(400).json({ success: false, message: 'La fecha debe tener el formato AAAA-MM-DD.' });
  }

  dbRun(
    `INSERT INTO configuracion (id_configuracion, evento, fecha, lugar, barra, responsable)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id_configuracion) DO UPDATE SET
       evento = excluded.evento, fecha = excluded.fecha, lugar = excluded.lugar,
       barra = excluded.barra, responsable = excluded.responsable`,
    [limpio.evento, limpio.fecha, limpio.lugar, limpio.barra, limpio.responsable]
  )
    // El nombre de la barra es la identidad: al cambiarlo aquí, cambia también
    // lo que se ve en la caja y lo que se imprime, sin reiniciar.
    .then(() => refrescarIdentidad())
    .then(() => unificarBarras())
    .then(() => registrarAuditoria(
      req.body && req.body.id_admin, 'CAMBIAR_DATOS_EVENTO', 'configuracion', 1,
      `Evento "${limpio.evento}", barra "${limpio.barra}", ${limpio.lugar || 'sin lugar'}, ` +
      `responsable ${limpio.responsable || 'sin asignar'}`))
    .then(() => res.json({
      success: true,
      configuracion: limpio,
      instancia: { nombre: INSTANCIA.nombre, id_barra: INSTANCIA.id_barra }
    }))
    .catch(err => {
      console.error('Error al guardar la configuración:', err);
      res.status(500).json({ success: false, message: 'No se pudo guardar la configuración.' });
    });
});

// ==========================================
// 2. API: GET PRODUCT DATA
// ==========================================
// Sólo las existencias. Es lo que cada tablet pregunta cada doce segundos para
// enterarse de lo que han vendido las demás.
//
// Antes reutilizaba /api/productos, que devuelve el catálogo entero. Con una
// foto por producto eso son 600 KB por sondeo y por tablet: sobre el WiFi de un
// teléfono, y con tres tablets, medio megabyte por segundo compitiendo con las
// ventas por la misma antena. Lo único que cambia entre sondeo y sondeo es un
// número por producto, y eso cabe en dos kilobytes.
app.get('/api/stock', (req, res) => {
  if (useMockDb) {
    return res.json({
      stock: mockDb.producto.filter(p => p.activo === 1)
        .map(p => ({ id: p.id_producto, s: p.stock_actual }))
    });
  }
  // Nombres de campo de una letra: con veinte productos ahorra poco, pero esto
  // viaja miles de veces por noche.
  dbAll('SELECT id_producto AS id, stock_actual AS s FROM producto WHERE activo = 1')
    .then(filas => res.json({ stock: filas }))
    .catch(err => {
      console.error('Error al leer el stock:', err);
      res.status(500).json({ stock: [] });
    });
});

app.get('/api/productos', (req, res) => {
  if (useMockDb) {
    const activeCats = mockDb.categoria_producto.filter(c => c.activo === 1);
    const activeProds = mockDb.producto.filter(p => p.activo === 1);
    return res.json({ categorias: activeCats, productos: activeProds });
  } else {
    const queryCats = `SELECT * FROM categoria_producto WHERE activo = 1`;
    // La foto NO viaja aquí: sólo si la hay. Metida dentro del JSON, veinte
    // fotos convertían esta respuesta en 600 KB y la rejilla no se pintaba
    // hasta que llegaba la última. Ahora el catálogo pesa unos 5 KB, las
    // tarjetas aparecen enseguida y cada foto llega por su cuenta a
    // /api/producto/:id/foto, donde el navegador puede guardarla en caché.
    // stock_tope es el nivel más alto al que llegó cada producto: lo que hubo
    // cuando estaba lleno. Sale de los movimientos, que guardan el stock antes
    // y después de cada entrada y de cada venta, así que no hace falta ninguna
    // columna nueva. Es la referencia de la barrita de las tarjetas: sin ella,
    // "queda poco" no significa nada —veinte botellas de whisky son muchas y
    // veinte cervezas no son nada—, y con ella cada producto se mide consigo
    // mismo. Si un producto nunca tuvo movimientos, su tope es su stock.
    const queryProds = `SELECT id_producto, id_categoria, nombre, descripcion, tipo_producto,
                               precio_venta, stock_actual, activo,
                               MAX(stock_actual,
                                   COALESCE((SELECT MAX(MAX(ms.stock_anterior), MAX(ms.stock_nuevo))
                                               FROM movimiento_stock ms
                                              WHERE ms.id_producto = producto.id_producto), 0)
                               ) AS stock_tope,
                               COALESCE(requiere_acompanante, 0) AS requiere_acompanante,
                               COALESCE(es_acompanante, 0) AS es_acompanante,
                               CASE WHEN foto IS NULL OR foto = '' THEN 0 ELSE 1 END AS tiene_foto,
                               LENGTH(COALESCE(foto, '')) AS foto_v
                          FROM producto WHERE activo = 1`;
    // Las promociones viajan con el catálogo, con su contenido dentro. Son
    // pocas y pesan poco, y la caja las necesita a la vez que los productos:
    // pedirlas aparte haría que las tarjetas de combo aparecieran un instante
    // después que las demás, saltando la rejilla justo cuando el cajero ya
    // está apuntando con el dedo.
    const queryPromos = `SELECT id_promocion, nombre, descripcion, precio
                           FROM promocion WHERE activa = 1 ORDER BY nombre`;
    const queryPromoDet = `SELECT pd.id_promocion, pd.id_producto, pd.cantidad
                             FROM promocion_detalle pd
                             JOIN producto p ON p.id_producto = pd.id_producto
                            WHERE p.activo = 1
                            ORDER BY pd.id_detalle_promocion`;

    pool.query(queryCats, (err, cats) => {
      if (err) return res.status(500).json({ error: err.message });
      pool.query(queryProds, (err2, prods) => {
        if (err2) return res.status(500).json({ error: err2.message });
        pool.query(queryPromos, (err3, promos) => {
          if (err3) return res.status(500).json({ error: err3.message });
          pool.query(queryPromoDet, (err4, detalles) => {
            if (err4) return res.status(500).json({ error: err4.message });

            const porPromo = new Map();
            for (const d of detalles) {
              if (!porPromo.has(d.id_promocion)) porPromo.set(d.id_promocion, []);
              porPromo.get(d.id_promocion).push({ id_producto: d.id_producto, cantidad: d.cantidad });
            }

            // Una promoción cuyo contenido se quedó sin productos activos no
            // se manda: la tarjeta saldría vacía y al tocarla no pasaría nada.
            const listas = promos
              .map(pr => Object.assign({}, pr, { contenido: porPromo.get(pr.id_promocion) || [] }))
              .filter(pr => pr.contenido.length > 0);

            return res.json({ categorias: cats, productos: prods, promociones: listas });
          });
        });
      });
    });
  }
});

// La foto de un producto, como imagen de verdad y no como texto dentro de un
// JSON. Así el navegador la guarda en caché y no vuelve a pedirla en toda la
// noche, y con loading="lazy" sólo baja las que se ven.
//
// `foto_v` (el tamaño del dato) va en la dirección: al cambiar la foto cambia
// la dirección y el navegador se entera. Sin eso seguiría enseñando la vieja.
app.get('/api/producto/:id/foto', (req, res) => {
  if (useMockDb) return res.status(404).end();

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();

  dbGet('SELECT foto FROM producto WHERE id_producto = ?', [id])
    .then(fila => {
      const dato = fila && fila.foto;
      if (!dato) return res.status(404).end();

      const corte = dato.indexOf(';base64,');
      if (corte === -1) return res.status(404).end();
      const tipo = dato.slice(5, corte);            // "image/jpeg"
      const bytes = Buffer.from(dato.slice(corte + 8), 'base64');

      // Un año e "immutable": la dirección lleva el tamaño dentro, así que una
      // foto distinta es otra dirección. El navegador no tiene que preguntar.
      res.set('Content-Type', tipo);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(bytes);
    })
    .catch(err => {
      console.error('Error al servir la foto:', err);
      res.status(500).end();
    });
});

// ==========================================
// 3. API: TRANSACTIONAL (SAVE ORDER)
// ==========================================
app.post('/api/comanda', (req, res) => {
  const { id_evento, id_barra, id_cajero, id_mesero, total, items, metodos_pago, observaciones } = req.body;

  if (useMockDb) {
    const newComandaId = mockDb.comanda.length + 1;
    const nowStr = nowSql();

    // 1. Create comanda
    mockDb.comanda.push({
      id_comanda: newComandaId,
      id_evento,
      id_barra,
      id_cajero,
      id_mesero,
      fecha_hora: nowStr,
      total: parseFloat(total),
      estado_pago: 'PAGADO',
      estatus: 'EN_PROCESO',
      observaciones: observaciones || '',
      anulada_por_admin: null,
      fecha_anulacion: null,
      motivo_anulacion: null
    });

    // 2. Detail comanda & Stock decrease
    (Array.isArray(items) ? items : []).forEach((item, idx) => {
      const dbProd = mockDb.producto.find(p => p.id_producto === item.id_producto);
      if (dbProd) {
        dbProd.stock_actual = Math.max(0, dbProd.stock_actual - item.cantidad);
      }
      mockDb.detalle_comanda.push({
        id_detalle: mockDb.detalle_comanda.length + 1,
        id_comanda: newComandaId,
        id_producto: item.id_producto,
        cantidad: item.cantidad,
        precio_unitario: parseFloat(item.precio_unitario),
        subtotal: parseFloat(item.subtotal)
      });
    });

    // 3. Payment details
    metodos_pago.forEach(pay => {
      mockDb.pago_comanda.push({
        id_pago: mockDb.pago_comanda.length + 1,
        id_comanda: newComandaId,
        id_metodo_pago: pay.id_metodo_pago,
        monto: parseFloat(pay.monto),
        fecha_hora: nowStr,
        referencia: pay.referencia || '',
        estado: 'APROBADO'
      });
    });

    // 4. Print entries
    mockDb.impresion_comanda_cajero.push({
      id_impresion_cajero: mockDb.impresion_comanda_cajero.length + 1,
      id_comanda: newComandaId,
      fecha_hora_impresion: nowStr,
      numero_copia: 1
    });

    mockDb.impresion_comanda_mesero.push({
      id_impresion_mesero: mockDb.impresion_comanda_mesero.length + 1,
      id_comanda: newComandaId,
      fecha_hora_impresion: nowStr,
      numero_copia: 2
    });

    return res.json({ success: true, id_comanda: newComandaId });
  } else {
    // Real transactional sale.
    //
    // Everything that decides money or stock is recomputed here from the database:
    // the browser only says *what* was ordered, never at which price. The whole thing
    // runs inside one serialised transaction, so a sale is all-or-nothing.
    withTransaction(async () => {
      // Lo primero: ¿esta venta ya se guardó? Si la tablet reintenta porque se
      // perdió la respuesta, se le devuelve la comanda original en vez de crear
      // otra. Va dentro de la transacción y la cola las serializa, así que dos
      // reintentos simultáneos tampoco pueden colarse los dos.
      const clave = req.body.clave_idempotencia;
      if (clave) {
        const yaExiste = await dbGet(
          'SELECT id_comanda, total FROM comanda WHERE clave_idempotencia = ?', [String(clave)]
        );
        if (yaExiste) {
          // Sólo las líneas de verdad, con su acompañante dentro. Devolverlas
          // todas planas haría que en la reimpresión el refresco saliera como
          // una línea suelta de 0.00 Bs., como si se hubiera regalado sin más.
          const lineas = await dbAll(`
            SELECT d.id_detalle, d.id_producto, d.cantidad, d.precio_unitario, d.subtotal,
                   d.id_detalle_padre, p.nombre
            FROM detalle_comanda d
            LEFT JOIN producto p ON p.id_producto = d.id_producto
            WHERE d.id_comanda = ?
            ORDER BY d.id_detalle`, [yaExiste.id_comanda]);

          const hijos = new Map();
          lineas.filter(l => l.id_detalle_padre).forEach(l => {
            if (!hijos.has(l.id_detalle_padre)) hijos.set(l.id_detalle_padre, []);
            hijos.get(l.id_detalle_padre).push(l);
          });

          return {
            id_comanda: yaExiste.id_comanda,
            total: yaExiste.total,
            repetida: true,
            lines: lineas.filter(l => !l.id_detalle_padre).map(l => ({
              idProd: l.id_producto, qty: l.cantidad,
              precio: l.precio_unitario, subtotal: l.subtotal, nombre: l.nombre,
              acomps: (hijos.get(l.id_detalle) || []).map(h => ({
                idProd: h.id_producto, nombre: h.nombre, qty: h.cantidad
              }))
            }))
          };
        }
      }

      // Las promociones que pide la tablet: sólo el identificador y cuántas.
      // El contenido y el precio los pone la base, igual que con los productos:
      // si vinieran de la tablet, cualquiera podría inventarse un combo de un
      // whisky por un boliviano.
      const promosPedidas = new Map();
      for (const p of (Array.isArray(req.body.promociones) ? req.body.promociones : [])) {
        const idPromo = parseInt(p && p.id_promocion, 10);
        const qty = Number(p && p.cantidad);
        if (!Number.isInteger(idPromo) || idPromo <= 0 ||
            !Number.isInteger(qty) || qty <= 0) {
          throw new BusinessError('Promoción inválida en la comanda.');
        }
        promosPedidas.set(idPromo, (promosPedidas.get(idPromo) || 0) + qty);
      }

      const hayItems = Array.isArray(items) && items.length > 0;
      if (!hayItems && promosPedidas.size === 0) {
        throw new BusinessError('La comanda no tiene productos.');
      }
      if (!Array.isArray(metodos_pago) || metodos_pago.length === 0) {
        throw new BusinessError('La comanda no tiene pagos registrados.');
      }
      if (!id_barra || !id_cajero || !id_mesero) {
        throw new BusinessError('Falta la barra, el cajero o el mesero de la comanda.');
      }

      // Agrupar las líneas.
      //
      // Una línea es "una botella con su acompañante". Dos líneas se funden
      // sólo si coinciden EN LAS DOS COSAS: mismo producto y mismo
      // acompañante. Si el cliente pide dos whiskys, uno con Coca y otro con
      // Sprite, son dos líneas distintas aunque el whisky sea el mismo.
      const grupos = new Map();
      for (const item of items) {
        const idProd = parseInt(item.id_producto, 10);
        // Number en vez de parseInt: parseInt('1.5') daba 1 y la comanda se
        // guardaba con una unidad menos sin avisar a nadie. Aquí no se vende
        // media cerveza: si la cantidad no es entera, la comanda no pasa.
        const qty = Number(item.cantidad);
        if (!idProd || !Number.isInteger(qty) || qty <= 0) {
          throw new BusinessError('Cantidad inválida en la comanda.');
        }
        // El acompañamiento es una LISTA con cantidades, no un producto suelto.
        // Si se acabó la Coca de 2 litros se pueden dar dos pequeñas, y eso son
        // dos unidades de otro producto: con un solo id no cabía.
        //
        // Las cantidades son POR BOTELLA. Si se piden dos whiskys con dos
        // colas pequeñas cada uno, salen cuatro colas.
        const acomps = [];
        const crudos = Array.isArray(item.acompanantes) ? item.acompanantes
          : (item.acompanante ? [{ id_producto: item.acompanante, cantidad: 1 }] : []);
        for (const a of crudos) {
          const idA = parseInt(a && a.id_producto, 10);
          const qtyA = Number(a && a.cantidad);
          if (!idA || !Number.isInteger(qtyA) || qtyA <= 0) {
            throw new BusinessError('Acompañante inválido en la comanda.');
          }
          const ya = acomps.find(x => x.idProd === idA);
          if (ya) ya.qty += qtyA;
          else acomps.push({ idProd: idA, qty: qtyA });
        }
        // Orden estable para poder comparar dos líneas: sin esto, elegir
        // "2 colas + 1 tónica" y "1 tónica + 2 colas" serían líneas distintas.
        acomps.sort((a, b) => a.idProd - b.idProd);

        const clave = idProd + '|' + acomps.map(a => a.idProd + 'x' + a.qty).join(',');
        const ya = grupos.get(clave);
        if (ya) ya.qty += qty;
        else grupos.set(clave, { idProd, qty, acomps });
      }

      // Lo que hay que descontar del almacén, sumando botellas y acompañantes.
      // El acompañante va gratis, pero sale de la nevera igual: si no se
      // descontara, el stock diría que quedan refrescos que ya no están.
      const wanted = new Map();
      for (const g of grupos.values()) {
        wanted.set(g.idProd, (wanted.get(g.idProd) || 0) + g.qty);
        // Cantidad por botella x botellas de la línea.
        g.acomps.forEach(a => {
          wanted.set(a.idProd, (wanted.get(a.idProd) || 0) + a.qty * g.qty);
        });
      }

      // Las promociones, leídas de la base. Un paquete no tiene stock propio:
      // lo que sale del almacén son los productos que lleva dentro, y por eso
      // se suman aquí, al mismo saco que todo lo demás. Así el combo compite
      // por las mismas existencias que las ventas sueltas y no hay forma de
      // vender la misma cerveza dos veces.
      const paquetes = [];
      for (const [idPromo, veces] of promosPedidas) {
        const promo = await dbGet(
          'SELECT id_promocion, nombre, precio, activa FROM promocion WHERE id_promocion = ?',
          [idPromo]
        );
        if (!promo) throw new BusinessError(`La promoción #${idPromo} ya no existe.`);
        if (!promo.activa) {
          throw new BusinessError(`La promoción "${promo.nombre}" está apagada.`);
        }

        const contenido = await dbAll(
          `SELECT pd.id_producto, pd.cantidad
             FROM promocion_detalle pd
             JOIN producto p ON p.id_producto = pd.id_producto
            WHERE pd.id_promocion = ? AND p.activo = 1
            ORDER BY pd.id_detalle_promocion`,
          [idPromo]
        );
        if (contenido.length === 0) {
          throw new BusinessError(`La promoción "${promo.nombre}" se quedó sin productos.`);
        }

        for (const c of contenido) {
          wanted.set(c.id_producto, (wanted.get(c.id_producto) || 0) + c.cantidad * veces);
        }
        paquetes.push({ promo, contenido, veces });
      }

      // Cada pago se valida por separado ANTES de sumarlos. Sumar a ciegas dejaba
      // pasar dos cosas: un monto no numérico convertía el total pagado en NaN, y
      // como toda comparación con NaN es falsa, la comprobación de "los pagos
      // cubren el total" no saltaba y la venta se guardaba con un pago NaN; y un
      // monto negativo podía compensar a otro inflado para cuadrar la suma.
      const metodosValidos = new Set(
        (await dbAll('SELECT id_metodo_pago FROM metodo_pago WHERE activo = 1'))
          .map(m => m.id_metodo_pago)
      );
      const pagosLimpios = [];
      for (const pay of metodos_pago) {
        const idMetodo = parseInt(pay && pay.id_metodo_pago, 10);
        const monto = Number(pay && pay.monto);
        if (!metodosValidos.has(idMetodo)) {
          throw new BusinessError('Forma de pago desconocida en la comanda.');
        }
        if (!Number.isFinite(monto) || monto <= 0) {
          throw new BusinessError('Hay un monto de pago inválido en la comanda.');
        }
        pagosLimpios.push({
          id_metodo_pago: idMetodo,
          monto: round2(monto),
          referencia: pay.referencia ? String(pay.referencia).slice(0, 120) : ''
        });
      }

      const ids = [...wanted.keys()];
      const rows = await dbAll(
        `SELECT id_producto, nombre, precio_venta, stock_actual,
                COALESCE(requiere_acompanante, 0) AS requiere_acompanante,
                COALESCE(es_acompanante, 0) AS es_acompanante
           FROM producto
          WHERE activo = 1 AND id_producto IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      const byId = new Map(rows.map(r => [r.id_producto, r]));

      // El precio lo pone SIEMPRE la base, nunca lo que mande la tablet. Y el
      // acompañante vale cero: es lo que hace que sea un acompañante y no una
      // segunda venta.
      let total = 0;
      const lines = [];
      for (const g of grupos.values()) {
        const prod = byId.get(g.idProd);
        if (!prod) throw new BusinessError(`El producto #${g.idProd} ya no está disponible.`);

        const acompanantes = g.acomps.map(a => {
          const prodA = byId.get(a.idProd);
          if (!prodA) {
            throw new BusinessError(`El acompañante #${a.idProd} ya no está disponible.`);
          }
          if (!prodA.es_acompanante) {
            throw new BusinessError(`${prodA.nombre} no está marcado como acompañante.`);
          }
          return { idProd: a.idProd, nombre: prodA.nombre, qty: a.qty * g.qty };
        });

        // Si la botella lo exige, no se puede cobrar sin nada: la caja abriría
        // el cuadro igualmente, pero una petición hecha a mano se colaría y el
        // cliente se quedaría sin su refresco.
        if (prod.requiere_acompanante && acompanantes.length === 0) {
          throw new BusinessError(`${prod.nombre} necesita que elijas un acompañante.`);
        }

        const precio = Number(prod.precio_venta);
        const subtotal = round2(precio * g.qty);
        total = round2(total + subtotal);
        lines.push({
          idProd: g.idProd, qty: g.qty, precio, subtotal, nombre: prod.nombre,
          acomps: acompanantes
        });
      }

      // Las promociones se convierten en líneas normales de producto, con el
      // precio del paquete repartido entre ellas. No se guarda "un combo de
      // 60": se guardan las tres bebidas que salieron, cada una con su parte.
      // Por eso el reporte de cierre sigue sabiendo cuánto se vendió de cada
      // producto sin enterarse de que existen los combos.
      const paquetesVendidos = [];
      for (const paq of paquetes) {
        const partes = paq.contenido.map(c => {
          const prod = byId.get(c.id_producto);
          if (!prod) {
            throw new BusinessError(`Un producto de "${paq.promo.nombre}" ya no está disponible.`);
          }
          return {
            idProd: c.id_producto,
            nombre: prod.nombre,
            // Las veces que se lleva el paquete multiplican todo su contenido.
            qty: c.cantidad * paq.veces,
            precioCatalogo: Number(prod.precio_venta)
          };
        });

        const precioTotal = round2(Number(paq.promo.precio) * paq.veces);
        const repartidas = repartirPrecioPaquete(partes, precioTotal);
        total = round2(total + precioTotal);

        repartidas.forEach((r, i) => {
          lines.push({
            idProd: r.idProd, qty: r.qty, precio: r.precio, subtotal: r.subtotal,
            nombre: partes[i].nombre, acomps: [],
            idPromo: paq.promo.id_promocion
          });
        });

        paquetesVendidos.push({
          id_promocion: paq.promo.id_promocion,
          nombre: paq.promo.nombre,
          cantidad: paq.veces,
          precio_unitario: round2(Number(paq.promo.precio)),
          subtotal: precioTotal,
          contenido: partes.map(p => ({ nombre: p.nombre, cantidad: p.qty }))
        });
      }

      const pagado = round2(pagosLimpios.reduce((sum, p) => sum + p.monto, 0));
      if (pagado + 0.001 < total) {
        throw new BusinessError(
          `Los pagos (${pagado.toFixed(2)} Bs.) no cubren el total (${total.toFixed(2)} Bs.).`
        );
      }

      const comanda = await dbRun(
        `INSERT INTO comanda (id_evento, id_barra, id_cajero, id_mesero, fecha_hora, total, estado_pago, estatus, observaciones, clave_idempotencia)
         VALUES (?, ?, ?, ?, ?, ?, 'PAGADO', 'EN_PROCESO', ?, ?)`,
        [id_evento, id_barra, id_cajero, id_mesero, nowSql(), total, observaciones || '',
         clave ? String(clave).slice(0, 64) : null]
      );
      const comId = comanda.insertId;

      // 1. El almacén, producto a producto.
      //
      // Se descuenta agrupado y no línea a línea: si el mismo refresco va suelto
      // en una línea y de acompañante en otra, son dos líneas del ticket pero
      // una sola salida de la nevera, y así queda un movimiento por producto en
      // vez de dos que hay que sumar a mano para saber cuántos salieron.
      for (const [idProd, qty] of wanted) {
        const prod = byId.get(idProd);
        if (!prod) throw new BusinessError(`El producto #${idProd} ya no está disponible.`);

        // Conditional update: if another till sold the last unit a moment earlier,
        // affectedRows is 0 and the sale rolls back instead of pushing stock negative.
        const upd = await dbRun(
          'UPDATE producto SET stock_actual = stock_actual - ? WHERE id_producto = ? AND stock_actual >= ?',
          [qty, idProd, qty]
        );
        if (upd.affectedRows === 0) {
          throw new BusinessError(
            `Stock insuficiente de ${prod.nombre} (quedan ${prod.stock_actual}).`
          );
        }

        const after = await dbGet('SELECT stock_actual FROM producto WHERE id_producto = ?', [idProd]);
        await dbRun(
          `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora)
           VALUES (?, NULL, 'SALIDA', ?, ?, ?, ?, ?)`,
          [idProd, qty, after.stock_actual + qty, after.stock_actual, `Venta comanda #${comId}`, nowSql()]
        );
      }

      // 2. Las líneas del ticket. El acompañante se guarda colgando de su
      // botella (id_detalle_padre) y con importe cero, que es como se imprime y
      // como lo lee después el reporte de cierre.
      for (const line of lines) {
        const det = await dbRun(
          'INSERT INTO detalle_comanda (id_comanda, id_producto, cantidad, precio_unitario, subtotal, id_detalle_padre, id_promocion) VALUES (?, ?, ?, ?, ?, NULL, ?)',
          [comId, line.idProd, line.qty, line.precio, line.subtotal, line.idPromo || null]
        );

        for (const a of line.acomps) {
          await dbRun(
            'INSERT INTO detalle_comanda (id_comanda, id_producto, cantidad, precio_unitario, subtotal, id_detalle_padre) VALUES (?, ?, ?, 0, 0, ?)',
            [comId, a.idProd, a.qty, det.insertId]
          );
        }
      }

      for (const pay of pagosLimpios) {
        await dbRun(
          `INSERT INTO pago_comanda (id_comanda, id_metodo_pago, monto, fecha_hora, referencia, estado)
           VALUES (?, ?, ?, ?, ?, 'APROBADO')`,
          [comId, pay.id_metodo_pago, pay.monto, nowSql(), pay.referencia]
        );
      }

      await dbRun(
        'INSERT INTO impresion_comanda_cajero (id_comanda, fecha_hora_impresion, numero_copia) VALUES (?, ?, 1)',
        [comId, nowSql()]
      );
      await dbRun(
        'INSERT INTO impresion_comanda_mesero (id_comanda, fecha_hora_impresion, numero_copia) VALUES (?, ?, 1)',
        [comId, nowSql()]
      );

      return { id_comanda: comId, total, lines, paquetes: paquetesVendidos };
    })
      .then(result => {
        // The ticket is printed from these values, so it always matches what was stored.
        res.json({
          success: true,
          id_comanda: result.id_comanda,
          // Referencia que se canta en la barra y se imprime en el ticket.
          ref_comanda: refComanda(result.id_comanda),
          instancia: INSTANCIA.nombre,
          // La tablet lo usa para avisar de que era un reintento y no una venta
          // nueva, y así el cajero no cree que ha cobrado dos veces.
          repetida: result.repetida === true,
          total: result.total,
          items: result.lines.map(l => ({
            id_producto: l.idProd,
            nombre: l.nombre,
            cantidad: l.qty,
            precio_unitario: l.precio,
            subtotal: l.subtotal,
            // Va dentro de su botella y no como línea aparte: el ticket lo
            // imprime sangrado debajo y sin importe.
            acompanantes: (l.acomps || []).map(a => ({ nombre: a.nombre, cantidad: a.qty })),
            // De qué paquete salió, si salió de alguno. El ticket las junta
            // por esto para imprimir "Combo Amigos 60.00" en vez de tres
            // líneas con precios repartidos que nadie sabría explicar.
            id_promocion: l.idPromo || null
          })),
          promociones: result.paquetes || []
        });
      })
      .catch(err => {
        if (err instanceof BusinessError) {
          return res.status(err.status).json({ success: false, message: err.message });
        }
        console.error('Error al guardar comanda:', err);
        res.status(500).json({ success: false, message: 'Error al guardar la comanda.' });
      });
  }
});

// ==========================================
// 3b. API: TRASPASOS E INGRESOS DE MERCANCÍA
// ==========================================
// Dos direcciones, un solo endpoint:
//
//   SALIDA   la mercancía se va a otra barra. Descuenta stock y devuelve el
//            documento para imprimírselo al bartender que la entrega.
//   ENTRADA  llega mercancía, por compra a un proveedor o por traspaso que
//            manda otra barra. Suma stock.
//
// Todo dentro de la misma transacción serializada que las ventas: mientras se
// mueve una caja de cerveza no se puede vender esa misma caja.

const TIPOS_TRASPASO = ['SALIDA', 'ENTRADA'];
const MOTIVOS_TRASPASO = ['TRASPASO', 'COMPRA'];

app.post('/api/traspaso', (req, res) => {
  if (useMockDb) {
    return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });
  }

  const tipo = String(req.body.tipo || '').toUpperCase();
  const motivo = String(req.body.motivo || '').toUpperCase();
  const contraparte = String(req.body.contraparte || '').trim().slice(0, 120);
  const observaciones = String(req.body.observaciones || '').trim().slice(0, 250);
  const items = req.body.items;

  if (!TIPOS_TRASPASO.includes(tipo)) {
    return res.status(400).json({ success: false, message: 'Tipo de movimiento no válido.' });
  }
  if (!MOTIVOS_TRASPASO.includes(motivo)) {
    return res.status(400).json({ success: false, message: 'Motivo no válido.' });
  }
  // Una salida sin destino es mercancía perdida: dentro de tres horas nadie
  // sabrá a qué barra fue ni a quién reclamársela.
  if (!contraparte) {
    return res.status(400).json({
      success: false,
      message: tipo === 'SALIDA' ? 'Falta decir a dónde va.' : 'Falta decir de dónde viene.'
    });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'No hay ningún producto en el movimiento.' });
  }

  withTransaction(async () => {
    // Se agrupa por producto: si el mismo aparece dos veces, es una sola salida
    // del almacén y un solo apunte.
    const pedido = new Map();
    for (const item of items) {
      const idProd = parseInt(item && item.id_producto, 10);
      const qty = Number(item && item.cantidad);
      if (!idProd || !Number.isInteger(qty) || qty <= 0) {
        throw new BusinessError('Cantidad inválida en el movimiento.');
      }
      pedido.set(idProd, (pedido.get(idProd) || 0) + qty);
    }

    const ids = [...pedido.keys()];
    const filas = await dbAll(
      `SELECT id_producto, nombre, stock_actual FROM producto
        WHERE activo = 1 AND id_producto IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const porId = new Map(filas.map(f => [f.id_producto, f]));

    const cabecera = await dbRun(
      `INSERT INTO traspaso (tipo, motivo, contraparte, observaciones, id_cajero, id_admin, fecha_hora)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tipo, motivo, contraparte, observaciones,
       req.body.id_cajero || null, req.body.id_admin || null, nowSql()]
    );
    const idTraspaso = cabecera.insertId;

    const lineas = [];
    for (const [idProd, qty] of pedido) {
      const prod = porId.get(idProd);
      if (!prod) throw new BusinessError(`El producto #${idProd} ya no está disponible.`);

      if (tipo === 'SALIDA') {
        // Condicional: si otra tablet acaba de vender lo último, la resta no
        // entra y el traspaso entero se deshace en vez de dejar stock negativo.
        const upd = await dbRun(
          'UPDATE producto SET stock_actual = stock_actual - ? WHERE id_producto = ? AND stock_actual >= ?',
          [qty, idProd, qty]
        );
        if (upd.affectedRows === 0) {
          throw new BusinessError(
            `No hay ${qty} de ${prod.nombre} para mover (quedan ${prod.stock_actual}).`
          );
        }
      } else {
        await dbRun('UPDATE producto SET stock_actual = stock_actual + ? WHERE id_producto = ?',
          [qty, idProd]);
      }

      await dbRun(
        'INSERT INTO traspaso_detalle (id_traspaso, id_producto, cantidad) VALUES (?, ?, ?)',
        [idTraspaso, idProd, qty]
      );

      // El apunte por producto, con el motivo escrito de forma que se entienda
      // solo al leer el reporte de stock tres días después.
      const despues = await dbGet('SELECT stock_actual FROM producto WHERE id_producto = ?', [idProd]);
      const antes = tipo === 'SALIDA' ? despues.stock_actual + qty : despues.stock_actual - qty;
      const texto = tipo === 'SALIDA'
        ? `Traspaso #${idTraspaso} a ${contraparte}`
        : (motivo === 'COMPRA'
            ? `Compra #${idTraspaso} a ${contraparte}`
            : `Traspaso #${idTraspaso} recibido de ${contraparte}`);

      await dbRun(
        `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [idProd, req.body.id_admin || null, tipo, qty, antes, despues.stock_actual, texto, nowSql()]
      );

      lineas.push({
        id_producto: idProd, nombre: prod.nombre, cantidad: qty,
        stock_despues: despues.stock_actual
      });
    }

    return { idTraspaso, lineas };
  })
    .then(r => {
      // El traspaso deja constancia: al día siguiente, cuando falten doce
      // cervezas, el log es lo único que puede decir a dónde fueron.
      registrarAuditoria(
        req.body.id_admin,
        tipo === 'SALIDA' ? 'TRASPASO_SALIDA'
          : (motivo === 'COMPRA' ? 'COMPRA_MERCANCIA' : 'TRASPASO_ENTRADA'),
        'traspaso', r.idTraspaso,
        (tipo === 'SALIDA' ? 'Salieron ' : 'Entraron ') +
        r.lineas.reduce((n, l) => n + l.cantidad, 0) + ' unidades ' +
        (tipo === 'SALIDA' ? 'a ' : 'de ') + contraparte + ': ' +
        r.lineas.map(l => l.cantidad + ' x ' + l.nombre).join(', ')
      );
      return res.json({
        success: true,
        id_traspaso: r.idTraspaso,
        tipo, motivo, contraparte, observaciones,
        items: r.lineas,
        message: tipo === 'SALIDA'
          ? `Traspaso #${r.idTraspaso} a ${contraparte} registrado.`
          : (motivo === 'COMPRA'
              ? `Compra #${r.idTraspaso} registrada: el stock ya está actualizado.`
              : `Traspaso #${r.idTraspaso} recibido de ${contraparte}.`)
      });
    })
    .catch(err => {
      if (err instanceof BusinessError) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      console.error('Error al registrar el traspaso:', err);
      res.status(500).json({ success: false, message: 'No se pudo registrar el movimiento.' });
    });
});

// Los últimos movimientos, para el historial y para sugerir destinos.
//
// Las sugerencias importan más de lo que parece: escribir "Barra VIP" a mano en
// cada traspaso acaba dando "barra vip", "Barra Vip" y "VIP", y luego no hay
// forma de sumar cuánto se mandó allí en toda la noche.
app.get('/api/traspasos', (req, res) => {
  if (useMockDb) return res.json({ traspasos: [], destinos: [] });

  Promise.all([
    dbAll(`SELECT t.id_traspaso, t.tipo, t.motivo, t.contraparte, t.observaciones, t.fecha_hora,
                  c.nombre AS cajero,
                  (SELECT COUNT(*) FROM traspaso_detalle d WHERE d.id_traspaso = t.id_traspaso) AS lineas,
                  (SELECT COALESCE(SUM(d.cantidad), 0) FROM traspaso_detalle d WHERE d.id_traspaso = t.id_traspaso) AS unidades
             FROM traspaso t
             LEFT JOIN cajero c ON c.id_cajero = t.id_cajero
            ORDER BY t.id_traspaso DESC LIMIT 60`),
    dbAll(`SELECT contraparte, tipo, MAX(id_traspaso) AS ultimo
             FROM traspaso WHERE contraparte <> ''
            GROUP BY contraparte, tipo ORDER BY ultimo DESC LIMIT 20`)
  ])
    .then(([traspasos, destinos]) => res.json({ traspasos, destinos }))
    .catch(err => {
      console.error('Error al leer los traspasos:', err);
      res.status(500).json({ traspasos: [], destinos: [] });
    });
});

// El detalle de uno, para reimprimir su comanda.
app.get('/api/traspaso/:id', (req, res) => {
  if (useMockDb) return res.status(404).json({ success: false });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Traspaso no válido.' });
  }

  Promise.all([
    dbGet(`SELECT t.*, c.nombre AS cajero FROM traspaso t
             LEFT JOIN cajero c ON c.id_cajero = t.id_cajero
            WHERE t.id_traspaso = ?`, [id]),
    dbAll(`SELECT d.id_producto, d.cantidad, COALESCE(p.nombre, 'Producto eliminado') AS nombre
             FROM traspaso_detalle d
             LEFT JOIN producto p ON p.id_producto = d.id_producto
            WHERE d.id_traspaso = ?`, [id])
  ])
    .then(([cabecera, items]) => {
      if (!cabecera) return res.status(404).json({ success: false, message: 'Ese traspaso no existe.' });
      res.json({ success: true, traspaso: cabecera, items });
    })
    .catch(err => {
      console.error('Error al leer el traspaso:', err);
      res.status(500).json({ success: false });
    });
});

// ==========================================
// 4. API: ADMIN OPERATIONS
// ==========================================

// ==========================================
// 4a. API: ELIMINAR DEL CATÁLOGO Y DE LA PLANTILLA
// ==========================================
// Eliminar tiene dos comportamientos, y la diferencia importa:
//
//   · Sin historial  -> se borra de verdad. Es el caso del montaje: quitas los
//     productos de ejemplo que no vas a vender y no dejan rastro.
//
//   · Con historial  -> se retira (activo = 0). Desaparece de la caja y de las
//     listas, pero las ventas ya cobradas siguen nombrándolo. Borrarlo del todo
//     dejaría el cierre de caja con líneas sin producto y descuadrado, que es
//     justo el documento con el que se cuenta el dinero al final de la noche.
//
// La respuesta dice cuál de los dos ocurrió, para poder decírselo a quien pulsa.

/** ¿Cuántas veces aparece este id en una tabla? */
function cuantas(tabla, columna, id) {
  return dbGet(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${columna} = ?`, [id])
    .then(f => (f ? f.n : 0));
}


// ---- Producto --------------------------------------------------------------
app.delete('/api/admin/productos/:id', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Producto no válido.' });
  }

  withTransaction(async () => {
    const prod = await dbGet('SELECT id_producto, nombre FROM producto WHERE id_producto = ?', [id]);
    if (!prod) return { estado: 404, cuerpo: { success: false, message: 'Ese producto ya no existe.' } };

    const vendido = await cuantas('detalle_comanda', 'id_producto', id);
    // También cuenta haberse movido entre barras: el documento del traspaso lo
    // nombra, y borrarlo dejaría ese papel apuntando a un producto que ya no
    // existe. Antes ni se comprobaba, y la clave foránea del traspaso hacía
    // fallar el borrado con un 500 que no explicaba nada.
    const movido = await cuantas('traspaso_detalle', 'id_producto', id);

    if (vendido > 0 || movido > 0) {
      await dbRun('UPDATE producto SET activo = 0 WHERE id_producto = ?', [id]);
      const motivo = vendido > 0
        ? `ya se vendió ${vendido} ${vendido === 1 ? 'vez' : 'veces'}`
        : `ya se movió en ${movido} ${movido === 1 ? 'traspaso' : 'traspasos'}`;
      return {
        estado: 200,
        cuerpo: {
          success: true, retirado: true,
          message: `"${prod.nombre}" se retiró del catálogo. Como ${motivo}, ` +
                   `se conserva para que el historial cuadre.`
        }
      };
    }

    // Nunca se vendió: se va entero, con sus movimientos de stock, que sin él
    // no significan nada.
    await dbRun('DELETE FROM movimiento_stock WHERE id_producto = ?', [id]);
    await dbRun('DELETE FROM producto WHERE id_producto = ?', [id]);
    return {
      estado: 200,
      cuerpo: { success: true, retirado: false, message: `"${prod.nombre}" se eliminó.` }
    };
  })
    .then(r => {
      if (r.cuerpo.success) {
        registrarAuditoria(req.body && req.body.id_admin, 'ELIMINAR_PRODUCTO', 'producto', id,
          r.cuerpo.retirado ? 'Producto retirado del catálogo' : 'Producto eliminado');
      }
      res.status(r.estado).json(r.cuerpo);
    })
    .catch(err => {
      console.error('Error al eliminar producto:', err);
      res.status(500).json({ success: false, message: 'No se pudo eliminar el producto.' });
    });
});

// ---- Promociones -----------------------------------------------------------
//
// Un paquete de productos a precio cerrado. Las tres operaciones comparten la
// misma validación, así que vive aparte.

/**
 * Comprueba y limpia el contenido de una promoción.
 * Devuelve las líneas listas, o lanza BusinessError con algo que el admin
 * pueda arreglar.
 */
async function validarContenidoPromocion(contenido) {
  if (!Array.isArray(contenido) || contenido.length === 0) {
    throw new BusinessError('La promoción tiene que llevar al menos un producto.');
  }
  if (contenido.length > 20) {
    throw new BusinessError('Una promoción no puede llevar más de 20 productos distintos.');
  }

  // Se agrupan por producto: si el admin añade dos veces la misma cerveza,
  // son cuatro cervezas en una línea y no dos líneas iguales que después
  // descontarían el stock por separado.
  const porProducto = new Map();
  for (const linea of contenido) {
    const idProd = parseInt(linea && linea.id_producto, 10);
    const qty = parseInt(linea && linea.cantidad, 10);
    if (!Number.isInteger(idProd) || idProd <= 0) {
      throw new BusinessError('Hay un producto no válido en la promoción.');
    }
    if (!Number.isInteger(qty) || qty <= 0 || qty > 99) {
      throw new BusinessError('Las cantidades tienen que ser de 1 a 99.');
    }
    porProducto.set(idProd, (porProducto.get(idProd) || 0) + qty);
  }

  const lineas = [];
  for (const [idProd, qty] of porProducto) {
    const prod = await dbGet(
      'SELECT id_producto, nombre, precio_venta, activo FROM producto WHERE id_producto = ?',
      [idProd]
    );
    if (!prod) throw new BusinessError('Uno de los productos de la promoción ya no existe.');
    if (!prod.activo) {
      throw new BusinessError(`"${prod.nombre}" está retirado del catálogo y no puede ir en una promoción.`);
    }
    if (!(Number(prod.precio_venta) > 0)) {
      throw new BusinessError(`"${prod.nombre}" no tiene precio, así que no se puede repartir el del paquete.`);
    }
    lineas.push({ idProd, qty, nombre: prod.nombre, precioCatalogo: Number(prod.precio_venta) });
  }
  return lineas;
}

function validarDatosPromocion(body) {
  const nombre = String(body.nombre == null ? '' : body.nombre).trim().slice(0, 120);
  const descripcion = String(body.descripcion == null ? '' : body.descripcion).trim().slice(0, 250);
  const precio = Number(body.precio);

  if (!nombre) throw new BusinessError('La promoción necesita un nombre.');
  if (!Number.isFinite(precio) || precio <= 0) {
    throw new BusinessError('El precio del paquete debe ser un número mayor que cero.');
  }
  return { nombre, descripcion, precio: round2(precio) };
}

// Listado para el panel: cada promoción con lo que lleva dentro.
app.get('/api/admin/promociones', (req, res) => {
  if (useMockDb) return res.json({ promociones: [] });

  dbAll(`SELECT id_promocion, nombre, descripcion, precio, activa FROM promocion
         ORDER BY activa DESC, nombre`)
    .then(async promos => {
      const detalles = await dbAll(`
        SELECT pd.id_promocion, pd.id_producto, pd.cantidad,
               p.nombre, p.precio_venta, p.stock_actual, p.activo
        FROM promocion_detalle pd
        JOIN producto p ON p.id_producto = pd.id_producto
        ORDER BY pd.id_detalle_promocion`);

      const porPromo = new Map();
      for (const d of detalles) {
        if (!porPromo.has(d.id_promocion)) porPromo.set(d.id_promocion, []);
        porPromo.get(d.id_promocion).push(d);
      }

      res.json({
        promociones: promos.map(pr => {
          const contenido = porPromo.get(pr.id_promocion) || [];
          const suelto = round2(contenido.reduce(
            (s, c) => s + Number(c.precio_venta) * c.cantidad, 0));
          return Object.assign({}, pr, {
            contenido,
            precio_suelto: suelto,
            ahorro: round2(suelto - Number(pr.precio))
          });
        })
      });
    })
    .catch(err => res.status(500).json({ error: err.message }));
});

app.post('/api/admin/promociones', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  Promise.resolve()
    .then(async () => {
      const datos = validarDatosPromocion(req.body || {});
      const lineas = await validarContenidoPromocion((req.body || {}).contenido);

      const id = await withTransaction(async () => {
        const r = await dbRun(
          `INSERT INTO promocion (nombre, descripcion, precio, activa, creada_por_admin)
           VALUES (?, ?, ?, 1, ?)`,
          [datos.nombre, datos.descripcion, datos.precio, req.body.id_admin || null]
        );
        for (const l of lineas) {
          await dbRun(
            'INSERT INTO promocion_detalle (id_promocion, id_producto, cantidad) VALUES (?, ?, ?)',
            [r.insertId, l.idProd, l.qty]
          );
        }
        return r.insertId;
      });

      const suelto = round2(lineas.reduce((s, l) => s + l.precioCatalogo * l.qty, 0));
      await registrarAuditoria(req.body.id_admin, 'CREAR_PROMOCION', 'promocion', id,
        `"${datos.nombre}" a ${datos.precio.toFixed(2)} (sueltos ${suelto.toFixed(2)}): ` +
        lineas.map(l => `${l.qty} x ${l.nombre}`).join(' + '));

      res.json({
        success: true, id_promocion: id,
        message: `"${datos.nombre}" creada. Ahorra ${round2(suelto - datos.precio).toFixed(2)} Bs.`
      });
    })
    .catch(err => {
      if (err instanceof BusinessError) {
        return res.status(err.status || 400).json({ success: false, message: err.message });
      }
      console.error('Error al crear la promoción:', err);
      res.status(500).json({ success: false, message: friendlyDbError(err, 'promoción') });
    });
});

app.put('/api/admin/promociones/:id', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Promoción no válida.' });
  }

  Promise.resolve()
    .then(async () => {
      const antes = await dbGet('SELECT nombre, precio FROM promocion WHERE id_promocion = ?', [id]);
      if (!antes) {
        return res.status(404).json({ success: false, message: 'Esa promoción ya no existe.' });
      }

      const datos = validarDatosPromocion(req.body || {});
      // El contenido sólo se toca si viene: así el interruptor de activar y
      // apagar puede mandar el nombre y el precio sin reenviar la lista.
      const cambiaContenido = Array.isArray((req.body || {}).contenido);
      const lineas = cambiaContenido
        ? await validarContenidoPromocion(req.body.contenido)
        : null;
      const activa = req.body.activa === undefined ? 1 : (req.body.activa ? 1 : 0);

      await withTransaction(async () => {
        await dbRun(
          'UPDATE promocion SET nombre = ?, descripcion = ?, precio = ?, activa = ? WHERE id_promocion = ?',
          [datos.nombre, datos.descripcion, datos.precio, activa, id]
        );
        if (lineas) {
          // Se reemplaza entero. Las ventas ya hechas no dependen de esto:
          // guardan sus propias líneas con su propio precio, así que cambiar
          // el paquete hoy no reescribe lo que se cobró ayer.
          await dbRun('DELETE FROM promocion_detalle WHERE id_promocion = ?', [id]);
          for (const l of lineas) {
            await dbRun(
              'INSERT INTO promocion_detalle (id_promocion, id_producto, cantidad) VALUES (?, ?, ?)',
              [id, l.idProd, l.qty]
            );
          }
        }
      });

      const cambioPrecio = Number(antes.precio) !== datos.precio
        ? ` · precio ${Number(antes.precio).toFixed(2)} -> ${datos.precio.toFixed(2)}`
        : '';
      await registrarAuditoria(req.body.id_admin, 'EDITAR_PROMOCION', 'promocion', id,
        `"${antes.nombre}" -> "${datos.nombre}"` + cambioPrecio +
        (activa ? '' : ' · apagada') + (cambiaContenido ? ' · contenido cambiado' : ''));

      res.json({ success: true, message: `"${datos.nombre}" actualizada.` });
    })
    .catch(err => {
      if (err instanceof BusinessError) {
        return res.status(err.status || 400).json({ success: false, message: err.message });
      }
      console.error('Error al editar la promoción:', err);
      res.status(500).json({ success: false, message: friendlyDbError(err, 'promoción') });
    });
});

app.delete('/api/admin/promociones/:id', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Promoción no válida.' });
  }

  Promise.resolve()
    .then(async () => {
      const promo = await dbGet('SELECT nombre FROM promocion WHERE id_promocion = ?', [id]);
      if (!promo) {
        return res.status(404).json({ success: false, message: 'Esa promoción ya no existe.' });
      }

      // Si ya se vendió, no se borra: se apaga. Borrarla dejaría las líneas de
      // las comandas apuntando a una promoción que no existe, y el ticket
      // reimpreso de una venta de ayer no sabría cómo agruparlas.
      const vendida = await dbGet(
        'SELECT COUNT(*) AS n FROM detalle_comanda WHERE id_promocion = ?', [id]);
      if (vendida && vendida.n > 0) {
        await dbRun('UPDATE promocion SET activa = 0 WHERE id_promocion = ?', [id]);
        await registrarAuditoria(req.body && req.body.id_admin, 'APAGAR_PROMOCION',
          'promocion', id, `"${promo.nombre}" se apagó (ya se había vendido ${vendida.n} veces)`);
        return res.json({
          success: true, retirada: true,
          message: `"${promo.nombre}" se apagó. Como ya se vendió, se conserva para que el historial cuadre.`
        });
      }

      await withTransaction(async () => {
        await dbRun('DELETE FROM promocion_detalle WHERE id_promocion = ?', [id]);
        await dbRun('DELETE FROM promocion WHERE id_promocion = ?', [id]);
      });
      await registrarAuditoria(req.body && req.body.id_admin, 'ELIMINAR_PROMOCION',
        'promocion', id, `"${promo.nombre}"`);
      res.json({ success: true, message: `"${promo.nombre}" eliminada.` });
    })
    .catch(err => {
      console.error('Error al eliminar la promoción:', err);
      res.status(500).json({ success: false, message: friendlyDbError(err, 'promoción') });
    });
});

// ---- Categoría -------------------------------------------------------------
app.delete('/api/admin/categorias/:id', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Categoría no válida.' });
  }

  withTransaction(async () => {
    const cat = await dbGet('SELECT id_categoria, nombre FROM categoria_producto WHERE id_categoria = ?', [id]);
    if (!cat) return { estado: 404, cuerpo: { success: false, message: 'Esa categoría ya no existe.' } };

    // Una categoría con productos dentro no se toca: borrarla dejaría esos
    // productos sin pestaña donde aparecer en la caja.
    const dentro = await dbGet(
      'SELECT COUNT(*) AS n FROM producto WHERE id_categoria = ? AND activo = 1', [id]);
    if (dentro && dentro.n > 0) {
      return {
        estado: 400,
        cuerpo: {
          success: false,
          message: `"${cat.nombre}" todavía tiene ${dentro.n} ` +
                   `${dentro.n === 1 ? 'producto' : 'productos'}. Elimínalos o cámbialos de categoría primero.`
        }
      };
    }

    await dbRun('DELETE FROM categoria_producto WHERE id_categoria = ?', [id]);
    return { estado: 200, cuerpo: { success: true, message: `"${cat.nombre}" se eliminó.` } };
  })
    .then(r => {
      if (r.cuerpo.success) {
        registrarAuditoria(req.body && req.body.id_admin, 'ELIMINAR_CATEGORIA', 'categoria_producto', id,
          'Categoría eliminada');
      }
      res.status(r.estado).json(r.cuerpo);
    })
    .catch(err => {
      console.error('Error al eliminar categoría:', err);
      res.status(500).json({ success: false, message: 'No se pudo eliminar la categoría.' });
    });
});

// ---- Cajero ----------------------------------------------------------------
app.delete('/api/admin/cajeros/:id', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Cajero no válido.' });
  }

  withTransaction(async () => {
    const caj = await dbGet('SELECT id_cajero, nombre FROM cajero WHERE id_cajero = ?', [id]);
    if (!caj) return { estado: 404, cuerpo: { success: false, message: 'Ese cajero ya no existe.' } };

    const cobradas = await cuantas('comanda', 'id_cajero', id);
    const susMeseros = await cuantas('mesero', 'id_cajero', id);

    if (cobradas > 0) {
      await dbRun('UPDATE cajero SET activo = 0 WHERE id_cajero = ?', [id]);
      return {
        estado: 200,
        cuerpo: {
          success: true, retirado: true,
          message: `${caj.nombre} ya no podrá entrar. Se conserva porque cobró ` +
                   `${cobradas} ${cobradas === 1 ? 'comanda' : 'comandas'} y el cierre las lleva a su nombre.`
        }
      };
    }

    if (susMeseros > 0) {
      return {
        estado: 400,
        cuerpo: {
          success: false,
          message: `${caj.nombre} todavía tiene ${susMeseros} ` +
                   `${susMeseros === 1 ? 'mesero' : 'meseros'} a su cargo. Elimínalos o pásalos a otro cajero primero.`
        }
      };
    }

    await dbRun('DELETE FROM cajero WHERE id_cajero = ?', [id]);
    return { estado: 200, cuerpo: { success: true, retirado: false, message: `${caj.nombre} se eliminó.` } };
  })
    .then(r => {
      if (r.cuerpo.success) {
        registrarAuditoria(req.body && req.body.id_admin, 'ELIMINAR_CAJERO', 'cajero', id,
          r.cuerpo.retirado ? 'Cajero dado de baja' : 'Cajero eliminado');
      }
      res.status(r.estado).json(r.cuerpo);
    })
    .catch(err => {
      console.error('Error al eliminar cajero:', err);
      res.status(500).json({ success: false, message: 'No se pudo eliminar el cajero.' });
    });
});

// ---- Mesero ----------------------------------------------------------------
app.delete('/api/admin/meseros/:id', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Mesero no válido.' });
  }

  withTransaction(async () => {
    const mes = await dbGet('SELECT id_mesero, nombre FROM mesero WHERE id_mesero = ?', [id]);
    if (!mes) return { estado: 404, cuerpo: { success: false, message: 'Ese mesero ya no existe.' } };

    const suyas = await cuantas('comanda', 'id_mesero', id);

    if (suyas > 0) {
      await dbRun('UPDATE mesero SET activo = 0 WHERE id_mesero = ?', [id]);
      return {
        estado: 200,
        cuerpo: {
          success: true, retirado: true,
          message: `${mes.nombre} ya no podrá entrar con su PIN. Se conserva porque tiene ` +
                   `${suyas} ${suyas === 1 ? 'comanda' : 'comandas'} a su nombre en el cierre.`
        }
      };
    }

    await dbRun('DELETE FROM mesero WHERE id_mesero = ?', [id]);
    return { estado: 200, cuerpo: { success: true, retirado: false, message: `${mes.nombre} se eliminó.` } };
  })
    .then(r => {
      if (r.cuerpo.success) {
        registrarAuditoria(req.body && req.body.id_admin, 'ELIMINAR_MESERO', 'mesero', id,
          r.cuerpo.retirado ? 'Mesero dado de baja' : 'Mesero eliminado');
      }
      res.status(r.estado).json(r.cuerpo);
    })
    .catch(err => {
      console.error('Error al eliminar mesero:', err);
      res.status(500).json({ success: false, message: 'No se pudo eliminar el mesero.' });
    });
});

// ---- Plantilla completa, para poder verla ----------------------------------
// El panel dejaba crear cajeros y meseros pero no enseñaba los que ya había:
// se daba de alta a la misma persona dos veces sin saberlo, y no había forma de
// consultar un PIN olvidado en mitad del evento.
app.get('/api/admin/personal', (req, res) => {
  if (useMockDb) return res.json({ cajeros: [], meseros: [] });

  Promise.all([
    dbAll(`SELECT c.id_cajero, c.nombre, c.usuario, c.activo,
                  (SELECT COUNT(*) FROM mesero m WHERE m.id_cajero = c.id_cajero AND m.activo = 1) AS meseros,
                  (SELECT COUNT(*) FROM comanda k WHERE k.id_cajero = c.id_cajero) AS comandas
             FROM cajero c ORDER BY c.activo DESC, c.nombre`),
    dbAll(`SELECT m.id_mesero, m.nombre, m.usuario, m.password AS pin, m.activo, m.id_cajero,
                  c.nombre AS cajero,
                  (SELECT COUNT(*) FROM comanda k WHERE k.id_mesero = m.id_mesero) AS comandas
             FROM mesero m
             LEFT JOIN cajero c ON c.id_cajero = m.id_cajero
            ORDER BY m.activo DESC, m.nombre`)
  ])
    .then(([cajeros, meseros]) => res.json({ cajeros, meseros }))
    .catch(err => {
      console.error('Error al leer el personal:', err);
      res.status(500).json({ cajeros: [], meseros: [] });
    });
});

// ---- Catálogo completo, para poder verlo -----------------------------------
app.get('/api/admin/catalogo', (req, res) => {
  if (useMockDb) return res.json({ categorias: [], productos: [] });

  Promise.all([
    dbAll(`SELECT c.id_categoria, c.nombre, c.descripcion, c.tipo, c.activo,
                  (SELECT COUNT(*) FROM producto p WHERE p.id_categoria = c.id_categoria AND p.activo = 1) AS productos
             FROM categoria_producto c ORDER BY c.activo DESC, c.nombre`),
    dbAll(`SELECT p.id_producto, p.nombre, p.precio_venta, p.stock_actual, p.activo,
                  p.id_categoria, c.nombre AS categoria,
                  COALESCE(p.requiere_acompanante, 0) AS requiere_acompanante,
                  COALESCE(p.es_acompanante, 0) AS es_acompanante,
                  CASE WHEN p.foto IS NULL OR p.foto = '' THEN 0 ELSE 1 END AS tiene_foto,
                  LENGTH(COALESCE(p.foto, '')) AS foto_v,
                  (SELECT COUNT(*) FROM detalle_comanda d WHERE d.id_producto = p.id_producto) AS vendido
             FROM producto p
             LEFT JOIN categoria_producto c ON c.id_categoria = p.id_categoria
            ORDER BY p.activo DESC, c.nombre, p.nombre`)
  ])
    .then(([categorias, productos]) => res.json({ categorias, productos }))
    .catch(err => {
      console.error('Error al leer el catálogo:', err);
      res.status(500).json({ categorias: [], productos: [] });
    });
});

// ==========================================
// 4b. API: FOTO DE PRODUCTO
// ==========================================
// La foto entra ya reducida desde el navegador (unos 400 px de lado, JPEG).
// Aquí sólo se comprueba que sea de verdad una imagen y que no pese de más:
// veinte productos con fotos de 8 MP convertirían el .db en un archivo que no
// cabe en la tarjeta de la tablet ni se copia en un rato.
//
// Sólo se acepta el contenido de la imagen, nunca una dirección: en el evento
// no hay internet, así que una URL remota se vería como un hueco roto, y
// además dejaría meter cualquier cosa dentro de la pantalla de la caja.
const FOTO_MAX_BYTES = 400 * 1024;
const FOTO_PATRON = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * Devuelve la foto lista para guardar, '' para borrarla, o false si no vale.
 * Se distingue el "no viene" (undefined -> null, no tocar) del "viene vacía"
 * (borrar), porque son dos intenciones distintas del panel.
 */
function validarFoto(valor) {
  if (valor === undefined || valor === null) return null;   // no se toca
  const texto = String(valor);
  if (!texto) return '';                                    // borrar
  if (!FOTO_PATRON.test(texto)) return false;
  // base64 crece un tercio sobre el binario; se mide lo que se va a guardar.
  if (texto.length > FOTO_MAX_BYTES * 1.4) return false;
  return texto;
}

// Editar un producto que ya existe.
//
// El catálogo se monta con prisa y siempre hay algo que corregir: un precio
// mal tecleado, un nombre a medias, una categoría equivocada. Sin esto había
// que borrar el producto y volver a crearlo, y si ya se había vendido eso ni
// siquiera era posible.
//
// El stock NO se toca aquí: se mueve con entradas y salidas, que dejan su
// apunte. Cambiarlo a mano desde una ficha rompería el cuadre del inventario.
app.put('/api/admin/productos/:id', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Producto no válido.' });
  }

  const nombre = String(req.body.nombre == null ? '' : req.body.nombre).trim().slice(0, 120);
  const descripcion = String(req.body.descripcion == null ? '' : req.body.descripcion).trim().slice(0, 250);
  const precio = Number(req.body.precio_venta);
  const idCategoria = parseInt(req.body.id_categoria, 10);

  if (!nombre) {
    return res.status(400).json({ success: false, message: 'El producto necesita un nombre.' });
  }
  // Las mismas reglas que al crearlo: un precio con letras se colaba como NaN
  // y dejaba el producto invendible; uno negativo restaría del total.
  if (!Number.isFinite(precio) || precio <= 0) {
    return res.status(400).json({ success: false, message: 'El precio debe ser un número mayor que cero.' });
  }
  if (!Number.isInteger(idCategoria) || idCategoria <= 0) {
    return res.status(400).json({ success: false, message: 'Elige una categoría.' });
  }

  dbGet('SELECT id_producto, nombre, precio_venta FROM producto WHERE id_producto = ?', [id])
    .then(antes => {
      if (!antes) return { estado: 404, cuerpo: { success: false, message: 'Ese producto ya no existe.' } };

      return dbGet('SELECT id_categoria FROM categoria_producto WHERE id_categoria = ?', [idCategoria])
        .then(cat => {
          if (!cat) {
            return { estado: 400, cuerpo: { success: false, message: 'Esa categoría no existe.' } };
          }
          return dbRun(
            'UPDATE producto SET nombre = ?, descripcion = ?, precio_venta = ?, id_categoria = ? WHERE id_producto = ?',
            [nombre, descripcion, round2(precio), idCategoria, id]
          ).then(() => {
            // El cambio de precio se detalla: es el dato que después explica
            // por qué dos comandas del mismo producto no valen lo mismo.
            const cambioPrecio = Number(antes.precio_venta) !== round2(precio)
              ? ` · precio ${Number(antes.precio_venta).toFixed(2)} -> ${round2(precio).toFixed(2)}`
              : '';
            return registrarAuditoria(req.body.id_admin, 'EDITAR_PRODUCTO', 'producto', id,
              `"${antes.nombre}" -> "${nombre}"` + cambioPrecio);
          }).then(() => ({
            estado: 200,
            cuerpo: { success: true, message: `"${nombre}" actualizado.` }
          }));
        });
    })
    .then(r => res.status(r.estado).json(r.cuerpo))
    .catch(err => {
      console.error('Error al editar el producto:', err);
      res.status(500).json({ success: false, message: friendlyDbError(err, 'producto') });
    });
});

// Marcar un producto que ya existe. Hace falta porque el catálogo se montó
// antes de que existieran los acompañamientos: sin esto habría que borrar los
// veinte productos y volver a crearlos.
app.put('/api/admin/productos/:id/acompanamiento', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Producto no válido.' });
  }

  const requiere = req.body && req.body.requiere_acompanante ? 1 : 0;
  const esAcomp = req.body && req.body.es_acompanante ? 1 : 0;

  // Un producto que necesita acompañante no puede ser a la vez acompañante de
  // otro: se llamarían el uno al otro y el cuadro no tendría fin.
  if (requiere && esAcomp) {
    return res.status(400).json({
      success: false,
      message: 'Un producto no puede necesitar acompañante y ser acompañante a la vez.'
    });
  }

  dbGet('SELECT id_producto, nombre FROM producto WHERE id_producto = ?', [id])
    .then(prod => {
      if (!prod) return { estado: 404, cuerpo: { success: false, message: 'Ese producto ya no existe.' } };
      return dbRun(
        'UPDATE producto SET requiere_acompanante = ?, es_acompanante = ? WHERE id_producto = ?',
        [requiere, esAcomp, id]
      ).then(() => registrarAuditoria(
        req.body && req.body.id_admin, 'MARCAR_ACOMPANAMIENTO', 'producto', id,
        `"${prod.nombre}": pide acompañante = ${requiere ? 'sí' : 'no'}, ` +
        `puede serlo = ${esAcomp ? 'sí' : 'no'}`)
      ).then(() => ({
        estado: 200,
        cuerpo: {
          success: true, requiere_acompanante: requiere, es_acompanante: esAcomp,
          message: requiere ? `"${prod.nombre}" pedirá acompañante al venderse.`
            : esAcomp ? `"${prod.nombre}" ya se puede elegir como acompañante.`
            : `"${prod.nombre}" se vende suelto, sin acompañamiento.`
        }
      }));
    })
    .then(r => res.status(r.estado).json(r.cuerpo))
    .catch(err => {
      console.error('Error al marcar el acompañamiento:', err);
      res.status(500).json({ success: false, message: 'No se pudo guardar.' });
    });
});

app.put('/api/admin/productos/:id/foto', (req, res) => {
  if (useMockDb) return res.status(503).json({ success: false, message: 'Necesita la base de datos real.' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Producto no válido.' });
  }

  const foto = validarFoto(req.body ? req.body.foto : undefined);
  if (foto === false) {
    return res.status(400).json({
      success: false,
      message: 'La foto no es válida. Usa una imagen PNG, JPG o WEBP.'
    });
  }

  dbGet('SELECT id_producto, nombre FROM producto WHERE id_producto = ?', [id])
    .then(prod => {
      if (!prod) return { estado: 404, cuerpo: { success: false, message: 'Ese producto ya no existe.' } };
      return dbRun('UPDATE producto SET foto = ? WHERE id_producto = ?', [foto || null, id])
        .then(() => registrarAuditoria(
          req.body && req.body.id_admin, foto ? 'PONER_FOTO' : 'QUITAR_FOTO', 'producto', id,
          (foto ? 'Se puso foto a "' : 'Se quitó la foto de "') + prod.nombre + '"')
        ).then(() => ({
          estado: 200,
          cuerpo: {
            success: true,
            foto: foto || null,
            message: foto ? `Foto de "${prod.nombre}" guardada.` : `Foto de "${prod.nombre}" quitada.`
          }
        }));
    })
    .then(r => res.status(r.estado).json(r.cuerpo))
    .catch(err => {
      console.error('Error al guardar la foto:', err);
      res.status(500).json({ success: false, message: 'No se pudo guardar la foto.' });
    });
});

// GET ALL COMMANDAS (WITH JOIN DETAILS)
app.get('/api/admin/comandas', (req, res) => {
  if (useMockDb) {
    const result = mockDb.comanda.map(c => {
      const cajero = mockDb.cajero.find(cj => cj.id_cajero === c.id_cajero);
      const mesero = mockDb.mesero.find(m => m.id_mesero === c.id_mesero);
      const barra = mockDb.barra.find(b => b.id_barra === c.id_barra);
      const details = mockDb.detalle_comanda.filter(d => d.id_comanda === c.id_comanda).map(d => {
        const prod = mockDb.producto.find(p => p.id_producto === d.id_producto);
        return { ...d, nombre_producto: prod ? prod.nombre : 'Producto Eliminado' };
      });
      const payments = mockDb.pago_comanda.filter(p => p.id_comanda === c.id_comanda).map(p => {
        const met = mockDb.metodo_pago.find(m => m.id_metodo_pago === p.id_metodo_pago);
        return { ...p, nombre_metodo: met ? met.nombre : 'Método Desconocido' };
      });
      return {
        ...c,
        nombre_cajero: cajero ? cajero.nombre : 'Cajero Desconocido',
        nombre_mesero: mesero ? mesero.nombre : 'Mesero Desconocido',
        nombre_barra: barra ? barra.nombre_barra : 'Barra Desconocida',
        detalles: details,
        pagos: payments
      };
    });
    // Order newest first
    result.sort((a, b) => b.id_comanda - a.id_comanda);
    return res.json(result);
  } else {
    // LEFT JOIN: an inner join dropped the whole order from the history (and from the
    // sales totals) if its cashier, waiter or bar row was ever removed.
    const query = `
      SELECT c.*,
             COALESCE(cj.nombre, 'Cajero eliminado')  AS nombre_cajero,
             COALESCE(m.nombre,  'Mesero eliminado')  AS nombre_mesero,
             COALESCE(b.nombre_barra, 'Barra eliminada') AS nombre_barra
      FROM comanda c
      LEFT JOIN cajero cj ON c.id_cajero = cj.id_cajero
      LEFT JOIN mesero m ON c.id_mesero = m.id_mesero
      LEFT JOIN barra b ON c.id_barra = b.id_barra
      ORDER BY c.id_comanda DESC
    `;
    pool.query(query, (err, comandas) => {
      if (err) return res.status(500).json({ error: err.message });
      
      const queryDetails = `
        SELECT dc.*, COALESCE(p.nombre, 'Producto eliminado') AS nombre_producto
        FROM detalle_comanda dc
        LEFT JOIN producto p ON dc.id_producto = p.id_producto
      `;
      pool.query(queryDetails, (err2, details) => {
        if (err2) return res.status(500).json({ error: err2.message });

        const queryPayments = `
          SELECT pc.*, COALESCE(mp.nombre, 'Método desconocido') AS nombre_metodo
          FROM pago_comanda pc
          LEFT JOIN metodo_pago mp ON pc.id_metodo_pago = mp.id_metodo_pago
        `;
        pool.query(queryPayments, (err3, payments) => {
          if (err3) return res.status(500).json({ error: err3.message });

          const mapped = comandas.map(c => {
            return {
              ...c,
              detalles: details.filter(d => d.id_comanda === c.id_comanda),
              pagos: payments.filter(p => p.id_comanda === c.id_comanda)
            };
          });
          return res.json(mapped);
        });
      });
    });
  }
});

// VOID / CANCEL ORDER
app.post('/api/admin/comandas/anular', (req, res) => {
  const { id_comanda, id_admin, motivo_anulacion } = req.body;
  const nowStr = nowSql();

  if (useMockDb) {
    const com = mockDb.comanda.find(c => c.id_comanda === parseInt(id_comanda));
    if (!com) return res.status(404).json({ success: false, message: 'Comanda no encontrada' });

    com.estado_pago = 'ANULADO';
    com.estatus = 'CANCELADA';
    com.anulada_por_admin = parseInt(id_admin);
    com.fecha_anulacion = nowStr;
    com.motivo_anulacion = motivo_anulacion;

    // Restore stocks
    const details = mockDb.detalle_comanda.filter(d => d.id_comanda === com.id_comanda);
    details.forEach(det => {
      const prod = mockDb.producto.find(p => p.id_producto === det.id_producto);
      if (prod) {
        prod.stock_actual += det.cantidad;
      }
    });

    // Update payment states
    mockDb.pago_comanda.filter(p => p.id_comanda === com.id_comanda).forEach(p => {
      p.estado = 'ANULADO';
    });

    // Write audit log
    const admin = mockDb.administrador_evento.find(a => a.id_admin === parseInt(id_admin));
    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: com.id_evento,
      accion: 'ANULAR_COMANDA',
      entidad: 'comanda',
      id_registro: com.id_comanda,
      detalle: `Comanda #${com.id_comanda} anulada por ${admin ? admin.nombre : 'Admin'}. Motivo: ${motivo_anulacion}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true });
  } else {
    withTransaction(async () => {
      const comanda = await dbGet(
        'SELECT id_comanda, id_evento, estado_pago FROM comanda WHERE id_comanda = ?',
        [id_comanda]
      );
      if (!comanda) throw new BusinessError('Comanda no encontrada.', 404);
      if (comanda.estado_pago === 'ANULADO') {
        // Without this guard a second click returned the stock to inventory twice.
        throw new BusinessError('Esta comanda ya estaba anulada.', 409);
      }
      if (!motivo_anulacion || !String(motivo_anulacion).trim()) {
        throw new BusinessError('Debes indicar el motivo de la anulación.');
      }

      const detalles = await dbAll(
        'SELECT id_producto, cantidad FROM detalle_comanda WHERE id_comanda = ?',
        [id_comanda]
      );

      await dbRun(
        `UPDATE comanda SET estado_pago = 'ANULADO', estatus = 'CANCELADA',
         anulada_por_admin = ?, fecha_anulacion = ?, motivo_anulacion = ?
         WHERE id_comanda = ?`,
        [id_admin, nowSql(), motivo_anulacion, id_comanda]
      );
      await dbRun("UPDATE pago_comanda SET estado = 'ANULADO' WHERE id_comanda = ?", [id_comanda]);

      for (const det of detalles) {
        await dbRun('UPDATE producto SET stock_actual = stock_actual + ? WHERE id_producto = ?', [
          det.cantidad,
          det.id_producto
        ]);
        // Returning stock is a real inventory movement; the report was silently missing it.
        const after = await dbGet('SELECT stock_actual FROM producto WHERE id_producto = ?', [det.id_producto]);
        await dbRun(
          `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora)
           VALUES (?, ?, 'ENTRADA', ?, ?, ?, ?, ?)`,
          [
            det.id_producto,
            id_admin,
            det.cantidad,
            after.stock_actual - det.cantidad,
            after.stock_actual,
            `Devolución por anulación de comanda #${id_comanda}`,
            nowSql()
          ]
        );
      }

      const admin = await dbGet('SELECT nombre FROM administrador_evento WHERE id_admin = ?', [id_admin]);
      await dbRun(
        `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle, fecha_hora)
         VALUES (?, ?, 'ANULAR_COMANDA', 'comanda', ?, ?, ?)`,
        [
          id_admin,
          comanda.id_evento,
          id_comanda,
          `Comanda #${id_comanda} anulada por ${admin ? admin.nombre : 'Admin'}. Motivo: ${motivo_anulacion}`,
          nowSql()
        ]
      );

      return true;
    })
      .then(() => res.json({ success: true }))
      .catch(err => {
        if (err instanceof BusinessError) {
          return res.status(err.status).json({ success: false, message: err.message });
        }
        console.error('Error al anular comanda:', err);
        res.status(500).json({ success: false, message: 'Error al anular la comanda.' });
      });
  }
});

// CREATE CATEGORY
app.post('/api/admin/categorias', (req, res) => {
  const { nombre, descripcion, tipo, id_admin, id_evento } = req.body;
  const nowStr = nowSql();

  if (useMockDb) {
    const newCatId = mockDb.categoria_producto.length + 1;
    mockDb.categoria_producto.push({
      id_categoria: newCatId,
      nombre,
      descripcion,
      tipo,
      activo: 1,
      creado_por_admin: parseInt(id_admin),
      fecha_creacion: nowStr
    });

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'CREAR_CATEGORIA',
      entidad: 'categoria_producto',
      id_registro: newCatId,
      detalle: `Se creó la categoría ${nombre}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, id_categoria: newCatId });
  } else {
    const query = `INSERT INTO categoria_producto (nombre, descripcion, tipo, creado_por_admin, fecha_creacion) VALUES (?, ?, ?, ?, ?)`;
    pool.query(query, [nombre, descripcion, tipo, id_admin, nowStr], (err, result) => {
      if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'categoría') });
      const newCatId = result.insertId;

      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_CATEGORIA', 'categoria_producto', ?, ?)`;
      pool.query(queryAudit, [id_admin, id_evento || 1, newCatId, `Se creó la categoría ${nombre}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_categoria: newCatId });
      });
    });
  }
});

// CREATE PRODUCT
app.post('/api/admin/productos', (req, res) => {
  const { id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual, id_admin, id_evento } = req.body;
  const requiere = req.body.requiere_acompanante ? 1 : 0;
  const esAcomp = req.body.es_acompanante ? 1 : 0;
  const fotoNueva = validarFoto(req.body.foto);
  if (fotoNueva === false) {
    return res.status(400).json({ success: false, message: 'La foto no es una imagen válida.' });
  }
  const nowStr = nowSql();

  if (useMockDb) {
    const newProdId = mockDb.producto.length + 1;
    mockDb.producto.push({
      id_producto: newProdId,
      id_categoria: parseInt(id_categoria),
      nombre,
      descripcion,
      tipo_producto,
      precio_venta: parseFloat(precio_venta),
      stock_actual: parseInt(stock_actual || 0),
      activo: 1,
      creado_por_admin: parseInt(id_admin),
      fecha_creacion: nowStr
    });

    // Stock Movement Log
    if (parseInt(stock_actual) > 0) {
      mockDb.movimiento_stock.push({
        id_movimiento: mockDb.movimiento_stock.length + 1,
        id_producto: newProdId,
        id_admin: parseInt(id_admin),
        tipo_movimiento: 'ENTRADA',
        cantidad: parseInt(stock_actual),
        stock_anterior: 0,
        stock_nuevo: parseInt(stock_actual),
        motivo: 'Carga inicial de stock',
        fecha_hora: nowStr
      });
    }

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'CREAR_PRODUCTO',
      entidad: 'producto',
      id_registro: newProdId,
      detalle: `Se creó el producto ${nombre} con stock inicial de ${stock_actual || 0}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, id_producto: newProdId });
  } else {
    // Un precio con letras se colaba como NaN y el producto quedaba invendible:
    // toda comanda que lo incluyera daba un total NaN. Y un precio negativo
    // habría restado del total de la comanda.
    const precio = Number(precio_venta);
    const stockInicial = Number(stock_actual || 0);
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ success: false, message: 'El producto necesita un nombre.' });
    }
    if (!Number.isFinite(precio) || precio <= 0) {
      return res.status(400).json({ success: false, message: 'El precio debe ser un número mayor que cero.' });
    }
    if (!Number.isInteger(stockInicial) || stockInicial < 0) {
      return res.status(400).json({ success: false, message: 'El stock inicial debe ser un número entero de 0 o más.' });
    }

    // Real MySQL Insertion
    const query = `INSERT INTO producto (id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual, foto, requiere_acompanante, es_acompanante, creado_por_admin, fecha_creacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    pool.query(query, [id_categoria, String(nombre).trim(), descripcion, tipo_producto, round2(precio), stockInicial, fotoNueva || null, requiere, esAcomp, id_admin, nowStr], (err, result) => {
      if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'producto') });
      const newProdId = result.insertId;

      // Log Stock movement
      if (stockInicial > 0) {
        const queryMov = `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo) VALUES (?, ?, 'ENTRADA', ?, 0, ?, 'Carga inicial de stock')`;
        pool.query(queryMov, [newProdId, id_admin, stockInicial, stockInicial], (errMov) => {
          if (errMov) console.error(errMov);
        });
      }

      // Audit Log
      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_PRODUCTO', 'producto', ?, ?)`;
      pool.query(queryAudit, [id_admin, id_evento || 1, newProdId, `Se creó el producto ${nombre} con stock inicial de ${stock_actual || 0}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_producto: newProdId });
      });
    });
  }
});

// CREATE BARRA
// CREATE CAJERO
app.post('/api/admin/cajeros', (req, res) => {
  // La barra no la elige el formulario: es la de este servidor, la que se
  // rotula en Datos del evento. Con un desplegable era fácil asignarlo a otra
  // fila y que ese cajero no pudiera cobrar aquí.
  const { nombre, usuario, password, id_admin, id_evento } = req.body;
  const id_barra = INSTANCIA.id_barra || req.body.id_barra;
  const nowStr = nowSql();

  if (useMockDb) {
    const newCajeroId = mockDb.cajero.length + 1;
    mockDb.cajero.push({
      id_cajero: newCajeroId,
      id_barra: parseInt(id_barra),
      nombre,
      usuario,
      password,
      activo: 1
    });

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'CREAR_CAJERO',
      entidad: 'cajero',
      id_registro: newCajeroId,
      detalle: `Se registró al cajero ${nombre} con usuario ${usuario}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, id_cajero: newCajeroId });
  } else {
    const query = `INSERT INTO cajero (id_barra, nombre, usuario, password) VALUES (?, ?, ?, ?)`;
    pool.query(query, [id_barra, nombre, usuario, password], (err, result) => {
      if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'cajero') });
      const newCajeroId = result.insertId;

      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_CAJERO', 'cajero', ?, ?)`;
      pool.query(queryAudit, [id_admin, id_evento || 1, newCajeroId, `Se registró al cajero ${nombre} con usuario ${usuario}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_cajero: newCajeroId });
      });
    });
  }
});

// CREATE MESERO
app.post('/api/admin/meseros', (req, res) => {
  const { id_evento, id_cajero, nombre, usuario, password, id_admin } = req.body;
  const nowStr = nowSql();

  if (useMockDb) {
    const newMeseroId = mockDb.mesero.length + 1;
    mockDb.mesero.push({
      id_mesero: newMeseroId,
      id_evento: parseInt(id_evento || 1),
      id_cajero: parseInt(id_cajero),
      nombre,
      usuario,
      password,
      activo: 1
    });

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'CREAR_MESERO',
      entidad: 'mesero',
      id_registro: newMeseroId,
      detalle: `Se registró al mesero ${nombre} asignado al cajero ID ${id_cajero}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, id_mesero: newMeseroId });
  } else {
    // The PIN is the waiter's only credential, so it has to be unique within the scope
    // that /api/login/mesero searches, otherwise sales get attributed to the wrong person.
    let scopeSql;
    let scopeParams;
    if (MESERO_PIN_SCOPE === 'cajero') {
      scopeSql = 'SELECT id_mesero FROM mesero WHERE password = ? AND id_cajero = ? AND activo = 1';
      scopeParams = [password, id_cajero];
    } else {
      scopeSql = 'SELECT id_mesero FROM mesero WHERE password = ? AND activo = 1';
      scopeParams = [password];
    }

    pool.query(scopeSql, scopeParams, (errDup, dup) => {
      if (errDup) return res.status(500).json({ success: false, message: errDup.message });
      if (dup.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Ese PIN ya está en uso por otro mesero. Elige uno distinto.'
        });
      }

    const query = `INSERT INTO mesero (id_evento, id_cajero, nombre, usuario, password) VALUES (?, ?, ?, ?, ?)`;
    pool.query(query, [id_evento || 1, id_cajero, nombre, usuario, password], (err, result) => {
      if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'mesero') });
      const newMeseroId = result.insertId;

      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_MESERO', 'mesero', ?, ?)`;
      pool.query(queryAudit, [id_admin, id_evento || 1, newMeseroId, `Se registró al mesero ${nombre} asignado al cajero ID ${id_cajero}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_mesero: newMeseroId });
      });
    });
    });
  }
});

// REGISTER STOCK MOVEMENT (MANUAL)
app.post('/api/admin/stock/movimiento', (req, res) => {
  const { id_producto, tipo_movimiento, cantidad, motivo, id_admin, id_evento } = req.body;
  const nowStr = nowSql();

  if (useMockDb) {
    const prod = mockDb.producto.find(p => p.id_producto === parseInt(id_producto));
    if (!prod) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    const prevStock = prod.stock_actual;
    let newStock = prevStock;

    if (tipo_movimiento === 'ENTRADA') newStock += parseInt(cantidad);
    else if (tipo_movimiento === 'SALIDA') newStock = Math.max(0, newStock - parseInt(cantidad));
    else if (tipo_movimiento === 'AJUSTE') newStock = parseInt(cantidad);

    prod.stock_actual = newStock;
    const diff = newStock - prevStock;

    const newMovId = mockDb.movimiento_stock.length + 1;
    mockDb.movimiento_stock.push({
      id_movimiento: newMovId,
      id_producto: parseInt(id_producto),
      id_admin: parseInt(id_admin),
      tipo_movimiento,
      cantidad: Math.abs(diff),
      stock_anterior: prevStock,
      stock_nuevo: newStock,
      motivo,
      fecha_hora: nowStr
    });

    mockDb.auditoria_admin.push({
      id_auditoria: mockDb.auditoria_admin.length + 1,
      id_admin: parseInt(id_admin),
      id_evento: parseInt(id_evento || 1),
      accion: 'MODIFICAR_STOCK',
      entidad: 'producto',
      id_registro: prod.id_producto,
      detalle: `Ajuste manual de stock de ${prod.nombre} (${tipo_movimiento}): stock cambió de ${prevStock} a ${newStock}. Motivo: ${motivo}`,
      fecha_hora: nowStr
    });

    return res.json({ success: true, stock_nuevo: newStock });
  } else {
    // Ajuste manual de stock.
    //
    // Antes esta ruta abría su propia transacción con pool.getConnection() +
    // beginTransaction, saltándose la cola de withTransaction. Con una sola
    // conexión SQLite eso era una bomba: si un admin ajustaba stock mientras una
    // caja estaba cerrando una venta, el BEGIN de aquí caía dentro de la
    // transacción de la venta y el COMMIT (o el ROLLBACK) de una se llevaba por
    // delante el trabajo a medias de la otra. Ahora hace cola como todo lo demás.
    withTransaction(async () => {
      const tipo = String(tipo_movimiento || '').toUpperCase();
      if (!['ENTRADA', 'SALIDA', 'AJUSTE'].includes(tipo)) {
        throw new BusinessError('Tipo de movimiento no válido.');
      }

      // Sin esto, una cantidad vacía o con letras dejaba stock_actual en NaN y
      // el producto quedaba invendible hasta corregirlo a mano en la base.
      const cant = Number(cantidad);
      if (!Number.isFinite(cant) || !Number.isInteger(cant) || cant < 0) {
        throw new BusinessError('La cantidad debe ser un número entero de 0 o más.');
      }
      if (tipo !== 'AJUSTE' && cant === 0) {
        throw new BusinessError('La cantidad tiene que ser mayor que cero.');
      }
      if (!motivo || !String(motivo).trim()) {
        throw new BusinessError('Indica el motivo del movimiento.');
      }

      const prod = await dbGet('SELECT stock_actual, nombre FROM producto WHERE id_producto = ?', [id_producto]);
      if (!prod) throw new BusinessError('Producto no encontrado.', 404);

      const prevStock = prod.stock_actual;
      let newStock = prevStock;
      if (tipo === 'ENTRADA') newStock = prevStock + cant;
      else if (tipo === 'SALIDA') newStock = Math.max(0, prevStock - cant);
      else newStock = cant;

      await dbRun('UPDATE producto SET stock_actual = ? WHERE id_producto = ?', [newStock, id_producto]);

      await dbRun(
        `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id_producto, id_admin, tipo, Math.abs(newStock - prevStock), prevStock, newStock, motivo, nowSql()]
      );

      await dbRun(
        `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle, fecha_hora)
         VALUES (?, ?, 'MODIFICAR_STOCK', 'producto', ?, ?, ?)`,
        [
          id_admin,
          id_evento || 1,
          id_producto,
          `Ajuste manual de stock de ${prod.nombre} (${tipo}): stock cambió de ${prevStock} a ${newStock}. Motivo: ${motivo}`,
          nowSql()
        ]
      );

      return newStock;
    })
      .then(stock_nuevo => res.json({ success: true, stock_nuevo }))
      .catch(err => {
        if (err instanceof BusinessError) {
          return res.status(err.status).json({ success: false, message: err.message });
        }
        console.error('Error al ajustar stock:', err);
        res.status(500).json({ success: false, message: 'No se pudo ajustar el stock.' });
      });
  }
});

// GET MOVIMIENTOS DE UN PRODUCTO ESPECÍFICO
app.get('/api/admin/productos/:id/movimientos', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'ID de producto no válido.' });
  }

  const sql = `
    SELECT ms.*,
           COALESCE(p.nombre, 'Producto eliminado') AS nombre_producto,
           m.nombre AS nombre_mesero,
           COALESCE(cj.nombre, tc.nombre) AS nombre_cajero,
           COALESCE(a.nombre, ta.nombre, 'Venta POS') AS nombre_admin
    FROM movimiento_stock ms
    LEFT JOIN producto p ON ms.id_producto = p.id_producto
    LEFT JOIN administrador_evento a ON ms.id_admin = a.id_admin
    LEFT JOIN comanda c ON (ms.motivo LIKE 'Venta comanda #' || c.id_comanda OR ms.motivo LIKE 'Anulación%#' || c.id_comanda)
    LEFT JOIN mesero m ON c.id_mesero = m.id_mesero
    LEFT JOIN cajero cj ON c.id_cajero = cj.id_cajero
    LEFT JOIN traspaso t ON (ms.motivo LIKE 'Traspaso #' || t.id_traspaso || '%' OR ms.motivo LIKE 'Compra #' || t.id_traspaso || '%')
    LEFT JOIN cajero tc ON t.id_cajero = tc.id_cajero
    LEFT JOIN administrador_evento ta ON t.id_admin = ta.id_admin
    WHERE ms.id_producto = ?
    ORDER BY ms.id_movimiento DESC
    LIMIT 60
  `;
  dbAll(sql, [id])
    .then(movimientos => res.json({ success: true, movimientos }))
    .catch(err => {
      console.error('Error al consultar movimientos del producto:', err);
      res.status(500).json({ success: false, message: 'No se pudieron consultar los movimientos.' });
    });
});

// ==========================================
// 4b. API: REPORTE DE CIERRE
// ==========================================
// Todas las cifras salen de SQL, no de lo que tenga cargado el navegador: el
// panel de admin sólo trae las comandas de una en una y sumar allí daría
// números distintos según cuándo se abrió la pestaña.
//
// Las comandas anuladas quedan fuera de la recaudación pero se listan aparte,
// que es justo lo que se revisa al cuadrar la caja.

// Rango de fechas en el formato en que se guarda fecha_hora ('AAAA-MM-DD HH:MM:SS').
function rangoFechas(query) {
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/;
  const desde = soloFecha.test(query.desde || '') ? query.desde + ' 00:00:00' : '0000-01-01 00:00:00';
  const hasta = soloFecha.test(query.hasta || '') ? query.hasta + ' 23:59:59' : '9999-12-31 23:59:59';
  return { desde, hasta, todo: !soloFecha.test(query.desde || '') && !soloFecha.test(query.hasta || '') };
}

async function construirReporte(query) {
  const { desde, hasta, todo } = rangoFechas(query);
  const P = [desde, hasta];

  // La cabecera del cierre sale de la tabla `configuracion`, que es lo que el
  // encargado escribió para esta barra. Si aún no la tocó, se usa el evento
  // sembrado para que el informe nunca salga sin encabezado.
  const config = await leerConfiguracion();
  const sembrado = await dbGet('SELECT nombre_evento, fecha_evento, lugar FROM evento LIMIT 1');
  const evento = {
    nombre_evento: config.evento || (sembrado && sembrado.nombre_evento) || 'Evento',
    fecha_evento: config.fecha || (sembrado && sembrado.fecha_evento) || '',
    lugar: config.lugar || (sembrado && sembrado.lugar) || '',
    responsable: config.responsable || '',
    barra: config.barra || INSTANCIA.nombre
  };

  const resumen = await dbGet(`
    SELECT
      COUNT(*)                                                     AS comandas,
      COALESCE(SUM(CASE WHEN estado_pago != 'ANULADO' THEN total END), 0)      AS recaudado,
      SUM(CASE WHEN estado_pago != 'ANULADO' THEN 1 ELSE 0 END)    AS validas,
      SUM(CASE WHEN estado_pago  = 'ANULADO' THEN 1 ELSE 0 END)    AS anuladas,
      COALESCE(SUM(CASE WHEN estado_pago  = 'ANULADO' THEN total END), 0)      AS importe_anulado
    FROM comanda WHERE fecha_hora BETWEEN ? AND ?
  `, P);

  const unidades = await dbGet(`
    SELECT COALESCE(SUM(d.cantidad), 0) AS n
    FROM detalle_comanda d JOIN comanda c ON c.id_comanda = d.id_comanda
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
  `, P);

  const porMetodo = await dbAll(`
    SELECT mp.nombre AS metodo, COUNT(*) AS operaciones, COALESCE(SUM(p.monto), 0) AS importe
    FROM pago_comanda p
    JOIN comanda c    ON c.id_comanda = p.id_comanda
    JOIN metodo_pago mp ON mp.id_metodo_pago = p.id_metodo_pago
    WHERE p.estado = 'APROBADO' AND c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY mp.id_metodo_pago ORDER BY importe DESC
  `, P);

  const porBarra = await dbAll(`
    SELECT b.nombre_barra AS barra, COUNT(*) AS comandas, COALESCE(SUM(c.total), 0) AS importe
    FROM comanda c JOIN barra b ON b.id_barra = c.id_barra
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY b.id_barra ORDER BY importe DESC
  `, P);

  const porCajero = await dbAll(`
    SELECT cj.nombre AS cajero, b.nombre_barra AS barra,
           COUNT(*) AS comandas, COALESCE(SUM(c.total), 0) AS importe
    FROM comanda c
    JOIN cajero cj ON cj.id_cajero = c.id_cajero
    JOIN barra b   ON b.id_barra   = cj.id_barra
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY cj.id_cajero ORDER BY importe DESC
  `, P);

  const porMesero = await dbAll(`
    SELECT m.nombre AS mesero, COUNT(*) AS comandas, COALESCE(SUM(c.total), 0) AS importe
    FROM comanda c JOIN mesero m ON m.id_mesero = c.id_mesero
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY m.id_mesero ORDER BY importe DESC
  `, P);

  const productos = await dbAll(`
    SELECT p.nombre AS producto, cat.nombre AS categoria,
           SUM(d.cantidad) AS unidades, COALESCE(SUM(d.subtotal), 0) AS importe
    FROM detalle_comanda d
    JOIN comanda c  ON c.id_comanda  = d.id_comanda
    JOIN producto p ON p.id_producto = d.id_producto
    LEFT JOIN categoria_producto cat ON cat.id_categoria = p.id_categoria
    WHERE c.estado_pago != 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    GROUP BY p.id_producto ORDER BY importe DESC
  `, P);

  const anuladas = await dbAll(`
    SELECT c.id_comanda, c.total, c.fecha_anulacion, c.motivo_anulacion,
           a.nombre AS admin, m.nombre AS mesero
    FROM comanda c
    LEFT JOIN administrador_evento a ON a.id_admin = c.anulada_por_admin
    LEFT JOIN mesero m ON m.id_mesero = c.id_mesero
    WHERE c.estado_pago = 'ANULADO' AND c.fecha_hora BETWEEN ? AND ?
    ORDER BY c.id_comanda DESC
  `, P);

  const stock = await dbAll(`
    SELECT p.nombre AS producto, cat.nombre AS categoria, p.stock_actual, p.precio_venta
    FROM producto p
    LEFT JOIN categoria_producto cat ON cat.id_categoria = p.id_categoria
    WHERE p.activo = 1 ORDER BY p.stock_actual ASC, p.nombre ASC
  `);

  // Cobros que no son en efectivo, uno a uno con su referencia. Es la lista que
  // se va tachando contra el extracto del banco: el sistema no puede confirmar
  // esos pagos por su cuenta, así que el cuadre se hace aquí.
  const cobrosDigitales = await dbAll(`
    SELECT c.id_comanda, mp.nombre AS metodo, p.monto, p.referencia, p.fecha_hora
    FROM pago_comanda p
    JOIN comanda c      ON c.id_comanda = p.id_comanda
    JOIN metodo_pago mp ON mp.id_metodo_pago = p.id_metodo_pago
    WHERE p.estado = 'APROBADO' AND c.estado_pago != 'ANULADO'
      AND mp.nombre != 'EFECTIVO' AND c.fecha_hora BETWEEN ? AND ?
    ORDER BY c.id_comanda
  `, P);

  // Reimpresiones del rango. Van en el cierre porque es donde el encargado
  // mira las cifras de la noche, y una comanda reimpresa tres veces es la
  // señal de que alguien pudo cobrarla más de una vez.
  const reimpresiones = await leerReimpresiones(P[0], P[1]);

  const validas = Number(resumen.validas) || 0;
  return {
    evento,
    // El cierre lleva la barra en la cabecera y en el nombre del archivo: con
    // tres instancias, tres PDFs iguales sin identificar son inservibles.
    instancia: INSTANCIA,
    rango: { desde: query.desde || null, hasta: query.hasta || null, todo },
    generado: nowSql(),
    resumen: {
      comandas: Number(resumen.comandas) || 0,
      validas,
      anuladas: Number(resumen.anuladas) || 0,
      recaudado: round2(resumen.recaudado),
      importe_anulado: round2(resumen.importe_anulado),
      unidades: Number(unidades.n) || 0,
      ticket_medio: validas > 0 ? round2(Number(resumen.recaudado) / validas) : 0
    },
    porMetodo, porBarra, porCajero, porMesero, productos, anuladas, stock, cobrosDigitales,
    reimpresiones
  };
}

app.get('/api/admin/reporte', (req, res) => {
  if (useMockDb) {
    return res.status(503).json({ success: false, message: 'El reporte necesita la base de datos real.' });
  }
  construirReporte(req.query)
    .then(datos => res.json(datos))
    .catch(err => {
      console.error('Error al construir el reporte:', err);
      res.status(500).json({ success: false, message: 'No se pudo generar el reporte.' });
    });
});

app.get('/api/admin/reporte.pdf', (req, res) => {
  if (useMockDb) {
    return res.status(503).send('El reporte necesita la base de datos real.');
  }
  construirReporte(req.query)
    .then(datos => {
      const pdf = construirPdfCierre(datos);
      // 'attachment' para que Android lo guarde como archivo y se pueda mandar
      // por WhatsApp, en vez de abrirlo dentro de la pestaña del POS.
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoReporte(datos)}"`);
      res.setHeader('Content-Length', pdf.length);
      res.send(pdf);
    })
    .catch(err => {
      console.error('Error al generar el PDF:', err);
      res.status(500).send('No se pudo generar el PDF.');
    });
});

// GET AUDIT LOG & STOCK LOGS & BARRAS
app.get('/api/admin/auditoria', (req, res) => {
  if (useMockDb) {
    const sortedAudits = [...mockDb.auditoria_admin].sort((a, b) => b.id_auditoria - a.id_auditoria);
    const sortedMovs = [...mockDb.movimiento_stock].map(m => {
      const prod = mockDb.producto.find(p => p.id_producto === m.id_producto);
      const admin = mockDb.administrador_evento.find(a => a.id_admin === m.id_admin);
      return {
        ...m,
        nombre_producto: prod ? prod.nombre : 'Producto Eliminado',
        nombre_admin: admin ? admin.nombre : 'Admin'
      };
    }).sort((a, b) => b.id_movimiento - a.id_movimiento);
    
    return res.json({
      auditoria: sortedAudits,
      movimientos: sortedMovs,
      barras: mockDb.barra,
      cajeros: mockDb.cajero,
      metodos_pago: mockDb.metodo_pago
    });
  } else {
    // Real MySQL audit fetching
    const qAudit = `
      SELECT au.*, COALESCE(a.nombre, 'Sistema') AS nombre_admin
      FROM auditoria_admin au
      LEFT JOIN administrador_evento a ON au.id_admin = a.id_admin
      ORDER BY au.id_auditoria DESC
    `;
    pool.query(qAudit, (err, audits) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Stock movements with product name, waiter, cashier, and admin details
      const qMovs = `
        SELECT ms.*,
               COALESCE(p.nombre, 'Producto eliminado') AS nombre_producto,
               m.nombre AS nombre_mesero,
               COALESCE(cj.nombre, tc.nombre) AS nombre_cajero,
               COALESCE(a.nombre, ta.nombre, 'Venta POS') AS nombre_admin
        FROM movimiento_stock ms
        LEFT JOIN producto p ON ms.id_producto = p.id_producto
        LEFT JOIN administrador_evento a ON ms.id_admin = a.id_admin
        LEFT JOIN comanda c ON (ms.motivo LIKE 'Venta comanda #' || c.id_comanda OR ms.motivo LIKE 'Anulación%#' || c.id_comanda)
        LEFT JOIN mesero m ON c.id_mesero = m.id_mesero
        LEFT JOIN cajero cj ON c.id_cajero = cj.id_cajero
        LEFT JOIN traspaso t ON (ms.motivo LIKE 'Traspaso #' || t.id_traspaso || '%' OR ms.motivo LIKE 'Compra #' || t.id_traspaso || '%')
        LEFT JOIN cajero tc ON t.id_cajero = tc.id_cajero
        LEFT JOIN administrador_evento ta ON t.id_admin = ta.id_admin
        ORDER BY ms.id_movimiento DESC
        LIMIT 500
      `;
      pool.query(qMovs, (err2, movs) => {
        if (err2) return res.status(500).json({ error: err2.message });

        pool.query('SELECT * FROM barra', (err3, barras) => {
          if (err3) return res.status(500).json({ error: err3.message });
          
          pool.query('SELECT * FROM cajero', (err4, cajeros) => {
            if (err4) return res.status(500).json({ error: err4.message });

            pool.query('SELECT * FROM metodo_pago', (err5, metodos) => {
              if (err5) return res.status(500).json({ error: err5.message });
              return res.json({ auditoria: audits, movimientos: movs, barras, cajeros, metodos_pago: metodos });
            });
          });
        });
      });
    });
  }
});

// ==========================================
// 5. API: PRINT LOG
// ==========================================
// impresion_comanda_cajero / _mesero existed in the schema but nothing ever wrote a
// reprint, so numero_copia was meaningless. Every physical print now lands here.
app.post('/api/impresion', (req, res) => {
  const { id_comanda, tipo, id_cajero, id_mesero } = req.body;
  const table = tipo === 'mesero' ? 'impresion_comanda_mesero' : 'impresion_comanda_cajero';

  // Los responsables salen de la COMANDA, no de quien tenga la sesión abierta.
  //
  // Una reimpresión desde el panel la pide un administrador: ahí no hay cajero
  // ni mesero conectados y el navegador no tiene ids que mandar, así que el
  // registro se quedaba en blanco, que es justo cuando más falta hace. Y como
  // los ids ya no vienen del cliente, tampoco se pueden falsear desde él.
  Promise.all([
    dbGet(`SELECT COALESCE(MAX(numero_copia), 0) AS ultima FROM ${table} WHERE id_comanda = ?`, [id_comanda]),
    dbGet('SELECT id_cajero, id_mesero FROM comanda WHERE id_comanda = ?', [id_comanda])
  ])
    .then(([row, duenos]) => {
      const copia = (row ? row.ultima : 0) + 1;
      // De la segunda copia en adelante ya no es la venta: es una reimpresión,
      // y eso es lo que hay que poder auditar después.
      const reimpresion = copia > 1;
      const responsableCajero = (duenos && duenos.id_cajero) || id_cajero || null;
      const responsableMesero = (duenos && duenos.id_mesero) || id_mesero || null;

      return dbRun(
        `INSERT INTO ${table} (id_comanda, fecha_hora_impresion, numero_copia, id_cajero, id_mesero)
         VALUES (?, ?, ?, ?, ?)`,
        [id_comanda, nowSql(), copia, responsableCajero, responsableMesero]
      ).then(() => res.json({ success: true, numero_copia: copia, reimpresion }));
    })
    .catch(err => {
      console.error('Error al registrar impresión:', err.message);
      // A failed print log must never block the cashier from printing.
      res.status(200).json({ success: false, message: 'No se pudo registrar la impresión.' });
    });
});

// Reimpresiones: de la copia 2 en adelante, con quién las pidió.
//
// La copia 1 es la venta y no interesa aquí: lo que se audita es lo que se
// imprimió DESPUÉS, que es lo que permitiría cobrar dos veces el mismo ticket.
// Admite el mismo rango de fechas que el reporte de cierre, para poder mirar
// una noche concreta y no todo el histórico.
function leerReimpresiones(desde, hasta) {
  const rango = desde && hasta ? 'AND i.fecha_hora_impresion BETWEEN ? AND ?' : '';
  const args = desde && hasta ? [desde, hasta] : [];

  // Se lee UNA sola tabla, la del cajero.
  //
  // Cada impresión saca dos papeles -el del cobro y el de la barra- y los dos
  // quedan registrados, cada uno en la suya. Pero lo que se audita aquí es el
  // acto de reimprimir, no cuántos papeles salieron: leyendo las dos, una sola
  // reimpresión aparecía por duplicado y la lista engañaba al contarla.
  return dbAll(`
    SELECT i.id_comanda AS id_comanda, i.numero_copia AS numero_copia,
           i.fecha_hora_impresion AS fecha,
           COALESCE(caj.nombre, 'sin registrar') AS cajero,
           COALESCE(mes.nombre, 'sin registrar') AS mesero,
           COALESCE(c.total, 0) AS total
    FROM impresion_comanda_cajero i
    LEFT JOIN comanda c ON c.id_comanda = i.id_comanda
    LEFT JOIN cajero  caj ON caj.id_cajero = i.id_cajero
    LEFT JOIN mesero  mes ON mes.id_mesero = i.id_mesero
    WHERE i.numero_copia > 1 ${rango}
    ORDER BY fecha DESC, id_comanda DESC`,
    args
  );
}

app.get('/api/admin/reimpresiones', (req, res) => {
  if (useMockDb) {
    return res.json({ success: true, reimpresiones: [] });
  }
  leerReimpresiones(req.query.desde, req.query.hasta)
    .then(reimpresiones => res.json({ success: true, reimpresiones }))
    .catch(err => {
      console.error('Error al leer las reimpresiones:', err.message);
      res.status(500).json({ success: false, message: 'No se pudieron leer las reimpresiones.' });
    });
});

// GET BARRAS & CAJEROS DIRECTLY (for selectors)
app.get('/api/admin/configuracion', (req, res) => {
  if (useMockDb) {
    return res.json({
      barras: mockDb.barra,
      cajeros: mockDb.cajero,
      eventos: mockDb.evento
    });
  } else {
    pool.query('SELECT * FROM barra WHERE activo = 1', (err, barras) => {
      if (err) return res.status(500).json({ error: err.message });
      pool.query('SELECT * FROM cajero WHERE activo = 1', (err2, cajeros) => {
        if (err2) return res.status(500).json({ error: err2.message });
        pool.query('SELECT * FROM evento WHERE activo = 1', (err3, eventos) => {
          if (err3) return res.status(500).json({ error: err3.message });
          return res.json({ barras, cajeros, eventos });
        });
      });
    });
  }
});

// Devuelve las IPv4 de la red local (WiFi) de este equipo.
function localAddresses() {
  const nets = require('os').networkInterfaces();
  const found = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  return found;
}

// Cierre ordenado (Ctrl+C en Termux, o cuando Android mata el proceso).
// Sin esto el archivo -wal se queda con ventas dentro y el .db por sí solo
// está incompleto: copiarlo para respaldo daría una base a medias.
let cerrando = false;
function cerrarOrdenado(senal) {
  if (cerrando) return;
  cerrando = true;
  console.log(`\n${senal} recibido: guardando la base...`);
  try {
    // Vuelca el WAL dentro del .db y lo deja como archivo único y completo.
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('✅ Base cerrada. Ya puedes copiar pos_evento.db sin riesgo.');
  } catch (err) {
    console.error('⚠ Error al cerrar la base:', err.message);
  }
  process.exit(0);
}

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(senal => {
  process.on(senal, () => cerrarOrdenado(senal));
});

// Server Initialization
// 0.0.0.0 explícito: la tablet que hace de servidor tiene que aceptar las
// conexiones de las demás por WiFi, no solo las de sí misma.
const servidor = app.listen(PORT, '0.0.0.0', async () => {
  // La barra puede venir del panel, así que se lee de la base antes de
  // rotularla: si no, el cartel diría el valor de partida y no el real.
  await refrescarIdentidad();
  await unificarBarras();
  const ips = localAddresses();
  // La barra va lo primero y en grande. Con dos o tres tablets servidor
  // idénticas encima de la mesa, este cartel es la forma más rápida de saber
  // cuál tienes delante antes de tocar nada.
  const rotulo = INSTANCIA.nombre.toUpperCase();
  console.log(`\n==================================================`);
  console.log(`   B A R R A :   ${rotulo}`);
  console.log(`==================================================`);
  console.log(`🚀 MasterDrinks POS iniciado`);
  console.log(`   En esta misma tablet:  http://localhost:${PORT}`);
  if (ips.length) {
    console.log(`\n   👉 En las OTRAS tablets de la barra ${INSTANCIA.nombre}:`);
    ips.forEach(ip => console.log(`      http://${ip}:${PORT}`));
  } else {
    console.log(`\n   ⚠ Sin red detectada: enciende el WiFi/hotspot y reinicia.`);
  }
  // El nombre encabeza los tickets y el cierre. Se recuerda dónde se cambia,
  // porque el de partida sirve para arrancar pero rara vez es el definitivo.
  informarDelAfiche();
  console.log(`\n   Nombre de la barra: Dashboard → Datos del evento → Barra.`);
  console.log(`   Versión de la interfaz: ${VERSION_UI}` +
    `   (debe coincidir con la que sale abajo en la tablet)`);
  console.log(`\n   Ctrl+C para detener.`);
  console.log(`==================================================\n`);
});

// Si el puerto está tomado, Node lanza un volcado de pila que no dice nada a
// quien está montando la barra con el evento a punto de empezar. Casi siempre
// es el propio servidor, que ya quedó abierto en otra ventana.
servidor.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`
==================================================`);
  console.error(`   ⛔ EL PUERTO ${PORT} YA ESTÁ OCUPADO`);
  console.error(`==================================================`);
  console.error(`   MasterDrinks ya está encendido en otra ventana,`);
  console.error(`   o quedó abierto de una vez anterior.`);
  console.error(`
   Qué hacer:`);
  console.error(`   1. Mira si ya funciona:  http://localhost:${PORT}`);
  console.error(`      Si abre, no hace falta nada más: ya estaba encendido.`);
  console.error(`   2. Si quieres cerrarlo y volver a empezar, en Windows:`);
  console.error(`         npx kill-port ${PORT}`);
  console.error(`      o cierra la otra ventana negra con Ctrl+C.`);
  console.error(`   3. Si prefieres otro puerto, cambia PORT en el .env`);
  console.error(`==================================================
`);
  process.exit(1);
});
