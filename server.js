require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
// SQLite incorporado en Node (>= 22.5). A diferencia del paquete `sqlite3`, no es
// un binario nativo: no hay que compilar nada, así que el mismo código corre en
// Windows y en la tablet Android con Termux, que es la que hace de servidor.
const { DatabaseSync } = require('node:sqlite');
// Generador de PDF propio, sin dependencias: ver el comentario de lib/pdf.js.
const { construirPdfCierre, nombreArchivoReporte } = require('./lib/reporte-cierre');
const { construirPdfComandas, nombreArchivoComandas } = require('./lib/reporte-comandas');

const app = express();
const PORT = process.env.PORT || 3000;

// Límite amplio para permitir subir afiches de alta resolución e imágenes
app.use(express.json({ limit: '20mb' }));
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
// Sale de la fecha de los archivos de public/ y server.js. Sirve para responder de un
// vistazo a "¿la tablet tiene los cambios o sigue con los de ayer?", indicando fecha y hora clara.
function obtenerVersionUI() {
  let ultima = 0;
  for (const nombre of ['index.html', 'app.js', 'style.css', 'rawbt.js', 'sw.js']) {
    try {
      const st = fs.statSync(path.join(__dirname, 'public', nombre));
      if (st.mtimeMs > ultima) ultima = st.mtimeMs;
    } catch (e) { /* si falta uno, cuenta el resto */ }
  }
  try {
    const stServ = fs.statSync(path.join(__dirname, 'server.js'));
    if (stServ.mtimeMs > ultima) ultima = stServ.mtimeMs;
  } catch (e) {}

  const d = new Date(ultima || Date.now());
  const dos = n => String(n).padStart(2, '0');
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} - ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}
const VERSION_UI = obtenerVersionUI();

// Dynamic route to serve Wallpaper.jpg from the project root directory
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
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(ruta);
});

// Endpoint para consultar información del afiche activo
app.get('/api/admin/afiche', (req, res) => {
  const ruta = buscarAfiche();
  if (!ruta) {
    return res.json({ success: true, exists: false, existe: false, nombre: null, archivo: null });
  }
  const nombre = path.basename(ruta);
  const st = fs.statSync(ruta);
  const medida = medidaImagen(ruta);
  const tamano_kb = Math.round(st.size / 1024);
  return res.json({
    success: true,
    exists: true,
    existe: true,
    nombre: nombre,
    archivo: nombre,
    ancho: medida ? medida.ancho : null,
    alto: medida ? medida.alto : null,
    peso: st.size,
    tamano_kb: tamano_kb,
    fecha: st.mtimeMs,
    url: `/afiche?v=${st.mtimeMs}`
  });
});

// Endpoint para cambiar/subir un nuevo afiche desde el dashboard
app.post('/api/admin/afiche', (req, res) => {
  const imagen = req.body.imagen || req.body.foto;
  const nombre = req.body.nombre || req.body.nombre_archivo;
  const id_admin = req.body.id_admin;

  if (!imagen || typeof imagen !== 'string') {
    return res.status(400).json({ success: false, message: 'No se envió ninguna imagen.' });
  }

  const match = imagen.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!match) {
    return res.status(400).json({ success: false, message: 'Formato de imagen no válido. Usa JPG, PNG o WEBP.' });
  }

  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 15 * 1024 * 1024) {
    return res.status(400).json({ success: false, message: 'La imagen no puede pesar más de 15 MB.' });
  }

  const carpetaAfiche = path.join(__dirname, 'afiche');
  if (!fs.existsSync(carpetaAfiche)) {
    fs.mkdirSync(carpetaAfiche, { recursive: true });
  }

  const nombreLimpio = (nombre ? path.basename(nombre, path.extname(nombre)) : 'afiche_evento')
    .toLowerCase().replace(/[^a-z0-9_-]/g, '_') + '.' + ext;
  const rutaDestino = path.join(carpetaAfiche, nombreLimpio);

  try {
    fs.writeFileSync(rutaDestino, buffer);
    const ahora = Date.now();
    fs.utimesSync(rutaDestino, ahora / 1000, ahora / 1000);

    const medida = medidaImagen(rutaDestino);
    registrarAuditoria(id_admin, 'CAMBIAR_AFICHE', 'afiche', 1, `Nuevo afiche: ${nombreLimpio}`);

    return res.json({
      success: true,
      message: 'Afiche actualizado correctamente.',
      info: {
        nombre: nombreLimpio,
        archivo: nombreLimpio,
        ancho: medida ? medida.ancho : null,
        alto: medida ? medida.alto : null,
        peso: buffer.length,
        tamano_kb: Math.round(buffer.length / 1024),
        url: `/afiche?v=${ahora}`
      }
    });
  } catch (err) {
    console.error('Error al guardar el afiche:', err);
    return res.status(500).json({ success: false, message: 'Error al guardar el afiche en el servidor.' });
  }
});

// Endpoint para eliminar el afiche activo
app.delete('/api/admin/afiche', (req, res) => {
  const ruta = buscarAfiche();
  if (!ruta) {
    return res.json({ success: true, message: 'No había ningún afiche configurado.' });
  }

  try {
    fs.unlinkSync(ruta);
    registrarAuditoria(req.body && req.body.id_admin, 'ELIMINAR_AFICHE', 'afiche', 1, `Afiche eliminado: ${path.basename(ruta)}`);
    return res.json({ success: true, message: 'Afiche eliminado correctamente.' });
  } catch (err) {
    console.error('Error al eliminar el afiche:', err);
    return res.status(500).json({ success: false, message: 'No se pudo eliminar el afiche.' });
  }
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
// node:sqlite es SÍNCRONO, pero el resto del archivo está escrito con callbacks/Promises.
// Este envoltorio mantiene las firmas run/all/get/serialize.
// Como cada consulta se ejecuta al instante, la cola de transacciones (withTransaction)
// sigue siendo imprescindible, porque los `await` entre sentencias sí ceden el turno a otras peticiones.

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
      if (callback) {
        const resObj = { insertId: Number(info.lastInsertRowid), lastID: Number(info.lastInsertRowid), changes: Number(info.changes), affectedRows: Number(info.changes) };
        callback.call(resObj, null, resObj);
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
  serialize: fn => fn(),
  close: () => sqlite.close()
};

// Helper para consultas sencillas unificadas
function dbQuery(sql, params, cb) {
  const [rawParams, callback] = splitArgs(params, cb);
  const isSelect = String(sql).trim().toUpperCase().startsWith('SELECT');
  if (isSelect) {
    db.all(sql, rawParams, callback);
  } else {
    db.run(sql, rawParams, callback);
  }
}

// SQLite runtime tuning:
db.run('PRAGMA foreign_keys = ON');
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA busy_timeout = 5000');

// Promise wrappers used by transactional and async routes
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

// Single SQLite connection queue to serialize whole transactions.
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

// La hora del reloj de la barra local.
function nowSql(fecha) {
  const d = fecha || new Date();
  const dos = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) + ' ' +
         dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds());
}

/**
 * Deja constancia de lo que hace el encargado en auditoria_admin.
 */
function registrarAuditoria(id_admin, accion, entidad, id_registro, detalle) {
  return dbRun(
    `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle, fecha_hora)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
    [id_admin || 1, accion, entidad, id_registro, String(detalle).slice(0, 250), nowSql()]
  ).catch(err => console.error('No se pudo registrar en auditoría:', err.message));
}

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Reparte el precio de un paquete entre los productos que lleva dentro.
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

const MESERO_PIN_SCOPE = process.env.MESERO_PIN_SCOPE || 'servidor';
const BARRA_POR_DEFECTO = 'Barra 1';

const INSTANCIA = {
  nombre: BARRA_POR_DEFECTO,
  id_barra: null
};

/** Recoge el nombre de barra que haya guardado el panel. */
function refrescarIdentidad() {
  return dbGet("SELECT valor FROM instancia WHERE clave = 'nombre'")
    .then(() => dbGet('SELECT barra FROM configuracion WHERE id_configuracion = 1'))
    .then(cfg => {
      const puesto = (cfg && cfg.barra ? String(cfg.barra) : '').trim();
      INSTANCIA.nombre = puesto || BARRA_POR_DEFECTO;
      return Promise.all([
        dbRun(`INSERT INTO instancia (clave, valor) VALUES ('nombre', ?)
               ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [INSTANCIA.nombre]),
        sincronizarBarra(INSTANCIA.nombre)
      ]).then(() => INSTANCIA);
    })
    .catch(() => INSTANCIA);
}

/**
 * Deja la tabla `barra` de acuerdo con el nombre escrito en Datos del evento.
 */
function sincronizarBarra(nombre) {
  const limpio = String(nombre || '').trim();
  if (!limpio) return Promise.resolve(null);

  const normaliza = txt => String(txt || '').trim().replace(/^barra\s+/i, '').toLowerCase();

  return dbGet("SELECT valor FROM instancia WHERE clave = 'id_barra'")
    .then(fila => {
      const guardada = fila && Number(fila.valor);
      if (!guardada) return null;
      return dbGet('SELECT * FROM barra WHERE id_barra = ?', [guardada]);
    })
    .then(barra => {
      if (barra) return barra;
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
 */
function unificarBarras() {
  if (!INSTANCIA.id_barra) return Promise.resolve(null);

  const id = INSTANCIA.id_barra;
  return dbAll('SELECT id_barra, nombre_barra FROM barra WHERE id_barra <> ?', [id])
    .then(sobran => {
      if (sobran.length === 0) return null;

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

const CARPETA_RESPALDOS = path.join(path.dirname(dbFile), 'respaldos');
const RESPALDO = path.join(
  CARPETA_RESPALDOS,
  path.basename(dbFile).replace(/\.db$/, '') + '.antes-de-unificar.db'
);

function respaldarBase() {
  if (fs.existsSync(RESPALDO)) return Promise.resolve();
  fs.mkdirSync(CARPETA_RESPALDOS, { recursive: true });
  return dbRun(`VACUUM INTO '${RESPALDO.replace(/'/g, "''")}'`).then(() => {});
}

const refComanda = id => String(id);

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

// Datos semilla de inicio para bases de datos vacías
const mockDb = {
  evento: [
    { id_evento: 1, nombre_evento: 'Festival Sonidos de Verano 2026', fecha_evento: '2026-09-12', lugar: 'Estadio Central', descripcion: 'Evento musical con sistema POS distribuido', hora_inicio: '17:00:00', hora_fin: '02:00:00', activo: 1 }
  ],
  barra: [
    { id_barra: 1, id_evento: 1, nombre_barra: 'Barra Norte', descripcion: 'Barra ubicada en la curva norte', ubicacion: 'Curva Norte', activo: 1 }
  ],
  cajero: [
    { id_cajero: 1, id_barra: 1, nombre: 'Ana Torres', usuario: 'cajero_norte_1', password: 'demo123', activo: 1 },
    { id_cajero: 2, id_barra: 1, nombre: 'Luis Mendoza', usuario: 'cajero_norte_2', password: 'demo123', activo: 1 },
    { id_cajero: 3, id_barra: 1, nombre: 'Carla Rojas', usuario: 'cajero_norte_3', password: 'demo123', activo: 1 },
    { id_cajero: 4, id_barra: 1, nombre: 'Pedro Vargas', usuario: 'cajero_sur_1', password: 'demo123', activo: 1 },
    { id_cajero: 5, id_barra: 1, nombre: 'María Fernández', usuario: 'cajero_sur_2', password: 'demo123', activo: 1 },
    { id_cajero: 6, id_barra: 1, nombre: 'Diego López', usuario: 'cajero_sur_3', password: 'demo123', activo: 1 },
    { id_cajero: 7, id_barra: 1, nombre: 'Brisa Garcia', usuario: 'cajero_general_1', password: 'demo123', activo: 1 },
    { id_cajero: 8, id_barra: 1, nombre: 'Jorge Salinas', usuario: 'cajero_general_2', password: 'demo123', activo: 1 },
    { id_cajero: 9, id_barra: 1, nombre: 'Valeria Quiroga', usuario: 'cajero_general_3', password: 'demo123', activo: 1 }
  ],
  administrador_evento: [
    { id_admin: 1, id_evento: 1, nombre: 'Administrador Principal', usuario: 'admin', password: '123', rol: 'ADMINISTRADOR', activo: 1 },
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

// Generar meseros para la semilla
for (let i = 1; i <= 45; i++) {
  const cajeroId = Math.ceil(i / 5);
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

function ensureColumn(table, column, definition) {
  db.all(`PRAGMA table_info(${table})`, (err, cols) => {
    if (err) return console.error(`Migration check failed for ${table}.${column}:`, err.message);
    if (cols.some(c => c.name === column)) return;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, errAlter => {
      if (errAlter) return console.error(`Migration failed for ${table}.${column}:`, errAlter.message);
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

    db.run(`CREATE TABLE IF NOT EXISTS traspaso (
      id_traspaso INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT,
      motivo TEXT,
      contraparte TEXT,
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

    db.run(`CREATE TABLE IF NOT EXISTS promocion (
      id_promocion INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      descripcion TEXT,
      precio REAL,
      activa INTEGER DEFAULT 1,
      eliminada INTEGER DEFAULT 0,
      creada_por_admin INTEGER,
      fecha_creacion TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('ALTER TABLE promocion ADD COLUMN eliminada INTEGER DEFAULT 0', () => {});

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

    // Migraciones automáticas de columnas
    ensureColumn('producto', 'creado_por_admin', 'INTEGER');
    ensureColumn('producto', 'foto', 'TEXT');
    ensureColumn('producto', 'fecha_creacion', 'TEXT');
    ensureColumn('producto', 'requiere_acompanante', 'INTEGER DEFAULT 0');
    ensureColumn('producto', 'es_acompanante', 'INTEGER DEFAULT 0');
    ensureColumn('detalle_comanda', 'id_detalle_padre', 'INTEGER');
    ensureColumn('detalle_comanda', 'id_promocion', 'INTEGER');
    ensureColumn('promocion', 'foto', 'TEXT');
    ensureColumn('comanda', 'clave_idempotencia', 'TEXT');

    ['impresion_comanda_cajero', 'impresion_comanda_mesero'].forEach(tabla => {
      ensureColumn(tabla, 'id_cajero', 'INTEGER');
      ensureColumn(tabla, 'id_mesero', 'INTEGER');
    });

    // Índices de alto rendimiento para consultas, joins y cierres de caja
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comanda_idempotencia
            ON comanda(clave_idempotencia) WHERE clave_idempotencia IS NOT NULL`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_comanda_evento_fecha ON comanda(id_evento, fecha_hora)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_comanda_estatus ON comanda(estatus, fecha_hora)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_comanda_anulada ON comanda(anulada_por_admin)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_comanda_cajero ON comanda(id_cajero)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_comanda_barra ON comanda(id_barra)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_detalle_comanda_comanda ON detalle_comanda(id_comanda)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_detalle_comanda_producto ON detalle_comanda(id_producto)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pago_comanda_comanda ON pago_comanda(id_comanda)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pago_comanda_metodo ON pago_comanda(id_metodo_pago)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_movimiento_stock_producto ON movimiento_stock(id_producto)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_producto_categoria_activo ON producto(id_categoria, activo)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mesero_cajero_activo ON mesero(id_cajero, activo)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_cajero_login ON cajero(usuario, password, activo)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_admin_login ON administrador_evento(usuario, password, activo)`);

    db.run(`CREATE TABLE IF NOT EXISTS instancia (
      clave TEXT PRIMARY KEY,
      valor TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS configuracion (
      id_configuracion INTEGER PRIMARY KEY CHECK (id_configuracion = 1),
      evento TEXT,
      fecha TEXT,
      lugar TEXT,
      barra TEXT,
      responsable TEXT,
      logo_ticket TEXT
    )`);
    db.run(`ALTER TABLE configuracion ADD COLUMN logo_ticket TEXT`, () => {});

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

    db.run(`INSERT INTO instancia (clave, valor) VALUES ('nombre', ?)
            ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [INSTANCIA.nombre]);
    db.run(`INSERT INTO instancia (clave, valor) VALUES ('primer_arranque', ?)
            ON CONFLICT(clave) DO NOTHING`, [nowSql()]);

    db.get("SELECT COUNT(*) as count FROM evento", (err, row) => {
      if (err) {
        console.error("Error checking database initialization:", err);
        return;
      }

      if (row && row.count === 0) {
        const barrasASembrar = [Object.assign({}, mockDb.barra[0],
          { nombre_barra: BARRA_POR_DEFECTO, ubicacion: '' })];
        const idBarraUnica = barrasASembrar[0].id_barra;

        const cajerosASembrar = mockDb.cajero.map(c =>
          Object.assign({}, c, { id_barra: idBarraUnica }));
        const idsCajero = new Set(cajerosASembrar.map(c => c.id_cajero));
        const meserosASembrar = mockDb.mesero.filter(m => idsCajero.has(m.id_cajero));

        console.log(`💾 Sembrando la base: barra ${BARRA_POR_DEFECTO}, ` +
          `${cajerosASembrar.length} cajeros y ${meserosASembrar.length} meseros.`);

        db.run(`INSERT INTO evento (id_evento, nombre_evento, fecha_evento, lugar, descripcion, hora_inicio, hora_fin, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [mockDb.evento[0].id_evento, mockDb.evento[0].nombre_evento, mockDb.evento[0].fecha_evento, mockDb.evento[0].lugar, mockDb.evento[0].descripcion, mockDb.evento[0].hora_inicio, mockDb.evento[0].hora_fin, mockDb.evento[0].activo]);

        barrasASembrar.forEach(b => {
          db.run(`INSERT INTO barra (id_barra, id_evento, nombre_barra, descripcion, ubicacion, activo) VALUES (?, ?, ?, ?, ?, ?)`,
            [b.id_barra, b.id_evento, b.nombre_barra, b.descripcion, b.ubicacion, b.activo]);
        });

        cajerosASembrar.forEach(c => {
          db.run(`INSERT INTO cajero (id_cajero, id_barra, nombre, usuario, password, activo) VALUES (?, ?, ?, ?, ?, ?)`,
            [c.id_cajero, c.id_barra, c.nombre, c.usuario, c.password, c.activo]);
        });

        mockDb.administrador_evento.forEach(a => {
          db.run(`INSERT INTO administrador_evento (id_admin, id_evento, nombre, usuario, password, rol, activo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [a.id_admin, a.id_evento, a.nombre, a.usuario, a.password, a.rol, a.activo]);
        });

        meserosASembrar.forEach(m => {
          db.run(`INSERT INTO mesero (id_mesero, id_evento, id_cajero, nombre, usuario, password, activo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [m.id_mesero, m.id_evento, m.id_cajero, m.nombre, m.usuario, m.password, m.activo]);
        });

        mockDb.categoria_producto.forEach(cat => {
          db.run(`INSERT INTO categoria_producto (id_categoria, nombre, descripcion, tipo, activo, creado_por_admin, fecha_creacion) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [cat.id_categoria, cat.nombre, cat.descripcion, cat.tipo, cat.activo, cat.creado_por_admin, cat.fecha_creacion]);
        });

        mockDb.producto.forEach(p => {
          db.run(`INSERT INTO producto (id_producto, id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [p.id_producto, p.id_categoria, p.nombre, p.descripcion, p.tipo_producto, p.precio_venta, p.stock_actual, p.activo]);
        });

        mockDb.metodo_pago.forEach(mp => {
          db.run(`INSERT INTO metodo_pago (id_metodo_pago, nombre, descripcion, activo) VALUES (?, ?, ?, ?)`,
            [mp.id_metodo_pago, mp.nombre, mp.descripcion, mp.activo]);
        });

        mockDb.comanda.forEach(c => {
          db.run(`INSERT INTO comanda (id_comanda, id_evento, id_barra, id_cajero, id_mesero, fecha_hora, total, estado_pago, estatus, observaciones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [c.id_comanda, c.id_evento, idBarraUnica, c.id_cajero, c.id_mesero, c.fecha_hora, c.total, c.estado_pago, c.estatus, c.observaciones]);
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

      // Asegurar credenciales actualizadas del administrador principal (usuario: admin, password: 123)
      try {
        db.run(`UPDATE administrador_evento SET usuario = 'admin', password = '123' WHERE id_admin = 1 OR usuario = 'admin_evento'`);
      } catch (e) {
        // Ignorar si la tabla aún no existe en paso previo
      }
    });
  });
}

function connectDatabase() {
  console.log(`🔌 Connecting to local SQLite database at: ${dbFile}...`);
  initializeDatabase();
  console.log(`✅ SUCCESS: Fully connected to SQLite database: ${path.basename(dbFile)}!\n`);
  try {
    require('./tools/generar-iconos-pwa');
  } catch (e) {
    // Iconos opcionales
  }
}
connectDatabase();

// ==========================================
// 1. API: AUTHENTICATION
// ==========================================
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;

  const queryCajero = `
    SELECT c.id_cajero, c.nombre, c.id_barra, b.nombre_barra, b.id_evento, e.nombre_evento
    FROM cajero c
    JOIN barra b ON c.id_barra = b.id_barra
    JOIN evento e ON b.id_evento = e.id_evento
    WHERE c.usuario = ? AND c.password = ? AND c.activo = 1
  `;
  dbQuery(queryCajero, [usuario, password], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results && results.length > 0) {
      return res.json({ success: true, rol: 'CAJERO', user: results[0] });
    }

    const queryAdmin = `
      SELECT a.id_admin, a.nombre, a.id_evento, a.rol, e.nombre_evento
      FROM administrador_evento a
      JOIN evento e ON a.id_evento = e.id_evento
      WHERE a.usuario = ? AND a.password = ? AND a.activo = 1
    `;
    dbQuery(queryAdmin, [usuario, password], (err2, results2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (results2 && results2.length > 0) {
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
});

app.post('/api/login/mesero', (req, res) => {
  const { password, id_cajero, id_evento } = req.body;

  let query = `
    SELECT m.id_mesero, m.nombre, m.id_cajero, c.id_barra
    FROM mesero m
    JOIN cajero c ON m.id_cajero = c.id_cajero
    WHERE m.password = ? AND m.activo = 1
  `;
  const params = [password];
  let fueraDeAlcance = null;

  if (MESERO_PIN_SCOPE === 'cajero' && id_cajero) {
    query += ` AND m.id_cajero = ?`;
    params.push(id_cajero);
    fueraDeAlcance = 'Ese PIN es de un mesero de otra caja.';
  } else if (MESERO_PIN_SCOPE === 'evento' && id_evento) {
    query += ` AND m.id_evento = ?`;
    params.push(id_evento);
    fueraDeAlcance = 'Ese PIN es de un mesero de otro evento.';
  }

  dbQuery(query, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results && results.length === 1) {
      return res.json({ success: true, mesero: results[0] });
    }
    if (results && results.length > 1) {
      return res.status(409).json({
        success: false,
        message: 'PIN duplicado entre meseros. Avisa al administrador.'
      });
    }

    if (!fueraDeAlcance) {
      return res.status(401).json({ success: false, message: 'Contraseña del mesero incorrecta' });
    }
    dbQuery(
      `SELECT m.id_mesero FROM mesero m WHERE m.password = ? AND m.activo = 1`,
      [password],
      (errAny, anyRows) => {
        if (!errAny && anyRows && anyRows.length > 0) {
          return res.status(401).json({ success: false, message: fueraDeAlcance });
        }
        return res.status(401).json({ success: false, message: 'Contraseña del mesero incorrecta' });
      }
    );
  });
});

app.get('/api/instancia', (req, res) => {
  res.json({ nombre: INSTANCIA.nombre, id_barra: INSTANCIA.id_barra, version: obtenerVersionUI() });
});

// ==========================================
// 1d. API: CONFIGURACIÓN DEL EVENTO
// ==========================================
const CAMPOS_CONFIG = ['evento', 'fecha', 'lugar', 'barra', 'responsable'];

function leerConfiguracion() {
  return dbGet('SELECT evento, fecha, lugar, barra, responsable, CASE WHEN logo_ticket IS NOT NULL AND length(logo_ticket) > 0 THEN 1 ELSE 0 END AS tiene_logo_ticket FROM configuracion WHERE id_configuracion = 1')
    .then(fila => fila || { evento: '', fecha: '', lugar: '', barra: INSTANCIA.nombre, responsable: '', tiene_logo_ticket: 0 });
}

app.get('/api/configuracion', (req, res) => {
  leerConfiguracion()
    .then(cfg => res.json(cfg))
    .catch(err => {
      console.error('Error al leer la configuración:', err);
      res.status(500).json({ success: false, message: 'No se pudo leer la configuración.' });
    });
});

app.get('/api/configuracion/logo', (req, res) => {
  dbGet('SELECT logo_ticket FROM configuracion WHERE id_configuracion = 1')
    .then(fila => {
      const dato = fila && fila.logo_ticket;
      if (!dato) {
        const defaultLogo = path.join(__dirname, 'public', 'logo_euphoria.png');
        if (fs.existsSync(defaultLogo)) return res.sendFile(defaultLogo);
        return res.status(404).end();
      }

      const corte = dato.indexOf(';base64,');
      if (corte === -1) return res.status(404).end();
      const tipo = dato.slice(5, corte);
      const bytes = Buffer.from(dato.slice(corte + 8), 'base64');

      res.set('Content-Type', tipo);
      res.set('Cache-Control', 'no-cache');
      res.send(bytes);
    })
    .catch(err => {
      console.error('Error al servir logo de ticket:', err);
      res.status(500).end();
    });
});

app.put('/api/admin/configuracion/logo', (req, res) => {
  const foto = validarFoto(req.body ? req.body.logo : undefined);
  if (foto === false) {
    return res.status(400).json({
      success: false,
      message: 'La imagen no es válida. Usa una imagen PNG, JPG o WEBP (máx. 500 KB).'
    });
  }

  dbRun('UPDATE configuracion SET logo_ticket = ? WHERE id_configuracion = 1', [foto || null])
    .then(() => registrarAuditoria(
      req.body && req.body.id_admin, foto ? 'CAMBIAR_LOGO_TICKET' : 'QUITAR_LOGO_TICKET',
      'configuracion', 1, foto ? 'Nuevo logo para tickets' : 'Se quitó el logo de tickets'
    ))
    .then(() => res.json({
      success: true,
      tiene_logo_ticket: !!foto,
      message: foto ? 'Logo del ticket actualizado correctamente.' : 'Logo del ticket restablecido.'
    }))
    .catch(err => {
      console.error('Error al guardar logo de ticket:', err);
      res.status(500).json({ success: false, message: 'No se pudo guardar el logo.' });
    });
});

app.delete('/api/admin/configuracion/logo', (req, res) => {
  dbRun('UPDATE configuracion SET logo_ticket = NULL WHERE id_configuracion = 1')
    .then(() => registrarAuditoria(
      req.body && req.body.id_admin, 'QUITAR_LOGO_TICKET', 'configuracion', 1, 'Logo de tickets restablecido al predeterminado'
    ))
    .then(() => res.json({
      success: true,
      tiene_logo_ticket: 0,
      message: 'Logo del ticket restablecido al predeterminado.'
    }))
    .catch(err => {
      console.error('Error al eliminar logo de ticket:', err);
      res.status(500).json({ success: false, message: 'No se pudo restablecer el logo.' });
    });
});

app.put('/api/admin/configuracion-evento', (req, res) => {
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
// 2. API: GET PRODUCT DATA & STOCK
// ==========================================
app.get('/api/stock', (req, res) => {
  dbAll('SELECT id_producto AS id, stock_actual AS s FROM producto WHERE activo = 1')
    .then(filas => res.json({ stock: filas }))
    .catch(err => {
      console.error('Error al leer el stock:', err);
      res.status(500).json({ stock: [] });
    });
});

app.get('/api/productos', (req, res) => {
  const queryCats = `SELECT * FROM categoria_producto WHERE activo = 1`;
  const queryProds = `SELECT id_producto, id_categoria, nombre, descripcion, tipo_producto,
                             precio_venta, stock_actual, activo, fecha_creacion,
                             MAX(stock_actual,
                                 COALESCE((SELECT MAX(MAX(ms.stock_anterior), MAX(ms.stock_nuevo))
                                             FROM movimiento_stock ms
                                            WHERE ms.id_producto = producto.id_producto), 0)
                             ) AS stock_tope,
                             COALESCE(requiere_acompanante, 0) AS requiere_acompanante,
                             COALESCE(es_acompanante, 0) AS es_acompanante,
                             CASE WHEN foto IS NULL OR foto = '' THEN 0 ELSE 1 END AS tiene_foto,
                             LENGTH(COALESCE(foto, '')) AS foto_v
                        FROM producto 
                       WHERE activo = 1 
                         AND (id_categoria IS NULL OR id_categoria IN (SELECT id_categoria FROM categoria_producto WHERE activo = 1))`;
  const queryPromos = `SELECT id_promocion, nombre, descripcion, precio,
                              CASE WHEN foto IS NULL OR foto = '' THEN 0 ELSE 1 END AS tiene_foto,
                              LENGTH(COALESCE(foto, '')) AS foto_v
                         FROM promocion WHERE activa = 1 AND COALESCE(eliminada, 0) = 0 ORDER BY nombre`;
  const queryPromoDet = `SELECT pd.id_promocion, pd.id_producto, pd.cantidad
                           FROM promocion_detalle pd
                           JOIN producto p ON p.id_producto = pd.id_producto
                          WHERE p.activo = 1
                          ORDER BY pd.id_detalle_promocion`;

  dbQuery(queryCats, (err, cats) => {
    if (err) return res.status(500).json({ error: err.message });
    dbQuery(queryProds, (err2, prods) => {
      if (err2) return res.status(500).json({ error: err2.message });
      dbQuery(queryPromos, (err3, promos) => {
        if (err3) return res.status(500).json({ error: err3.message });
        dbQuery(queryPromoDet, (err4, detalles) => {
          if (err4) return res.status(500).json({ error: err4.message });

          const porPromo = new Map();
          for (const d of (detalles || [])) {
            if (!porPromo.has(d.id_promocion)) porPromo.set(d.id_promocion, []);
            porPromo.get(d.id_promocion).push({ id_producto: d.id_producto, cantidad: d.cantidad });
          }

          const listas = (promos || [])
            .map(pr => Object.assign({}, pr, { contenido: porPromo.get(pr.id_promocion) || [] }))
            .filter(pr => pr.contenido.length > 0);

          return res.json({ categorias: cats || [], productos: prods || [], promociones: listas });
        });
      });
    });
  });
});

app.get('/api/producto/:id/foto', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();

  dbGet('SELECT foto FROM producto WHERE id_producto = ?', [id])
    .then(fila => {
      const dato = fila && fila.foto;
      if (!dato) return res.status(404).end();

      const corte = dato.indexOf(';base64,');
      if (corte === -1) return res.status(404).end();
      const tipo = dato.slice(5, corte);
      const bytes = Buffer.from(dato.slice(corte + 8), 'base64');

      res.set('Content-Type', tipo);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(bytes);
    })
    .catch(err => {
      console.error('Error al servir la foto:', err);
      res.status(500).end();
    });
});

app.get('/api/promocion/:id/foto', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();

  dbGet('SELECT foto FROM promocion WHERE id_promocion = ?', [id])
    .then(fila => {
      const dato = fila && fila.foto;
      if (!dato) return res.status(404).end();

      const corte = dato.indexOf(';base64,');
      if (corte === -1) return res.status(404).end();
      const tipo = dato.slice(5, corte);
      const bytes = Buffer.from(dato.slice(corte + 8), 'base64');

      res.set('Content-Type', tipo);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(bytes);
    })
    .catch(err => {
      console.error('Error al servir la foto de la promoción:', err);
      res.status(500).end();
    });
});

// ==========================================
// 3. API: TRANSACTIONAL (SAVE ORDER)
// ==========================================
app.post('/api/comanda', (req, res) => {
  withTransaction(async () => {
    const clave = req.body.clave_idempotencia;
    if (clave) {
      const yaExiste = await dbGet(
        'SELECT id_comanda, total FROM comanda WHERE clave_idempotencia = ?', [String(clave)]
      );
      if (yaExiste) {
        const lineas = await dbAll(`
          SELECT d.id_detalle, d.id_producto, d.cantidad, d.precio_unitario, d.subtotal,
                 d.id_detalle_padre, d.id_promocion, p.nombre
          FROM detalle_comanda d
          LEFT JOIN producto p ON p.id_producto = d.id_producto
          WHERE d.id_comanda = ?
          ORDER BY d.id_detalle`, [yaExiste.id_comanda]);

        const hijos = new Map();
        lineas.filter(l => l.id_detalle_padre).forEach(l => {
          if (!hijos.has(l.id_detalle_padre)) hijos.set(l.id_detalle_padre, []);
          hijos.get(l.id_detalle_padre).push(l);
        });

        const itemsResp = lineas.filter(l => !l.id_detalle_padre).map(l => ({
          idProd: l.id_producto,
          id_producto: l.id_producto,
          qty: l.cantidad,
          cantidad: l.cantidad,
          precio: l.precio_unitario,
          precio_unitario: l.precio_unitario,
          subtotal: l.subtotal,
          nombre: l.nombre,
          id_promocion: l.id_promocion,
          acomps: (hijos.get(l.id_detalle) || []).map(h => ({
            idProd: h.id_producto,
            id_producto: h.id_producto,
            nombre: h.nombre,
            qty: h.cantidad,
            cantidad: h.cantidad
          })),
          acompanantes: (hijos.get(l.id_detalle) || []).map(h => ({
            id_producto: h.id_producto,
            nombre: h.nombre,
            cantidad: h.cantidad
          }))
        }));

        return {
          id_comanda: yaExiste.id_comanda,
          ref_comanda: String(yaExiste.id_comanda),
          total: yaExiste.total,
          repetida: true,
          items: itemsResp,
          lines: itemsResp
        };
      }
    }

    const promosPedidas = new Map();
    for (const p of (Array.isArray(req.body.promociones) ? req.body.promociones : [])) {
      const idPromo = parseInt(p && p.id_promocion, 10);
      const qty = Number(p && p.cantidad);
      if (!idPromo || !Number.isInteger(qty) || qty <= 0) {
        throw new BusinessError('Promoción inválida en la comanda.');
      }
      promosPedidas.set(idPromo, (promosPedidas.get(idPromo) || 0) + qty);
    }

    const promosDef = new Map();
    if (promosPedidas.size > 0) {
      const idsP = [...promosPedidas.keys()];
      const filasP = await dbAll(
        `SELECT id_promocion, nombre, precio, activa FROM promocion
          WHERE id_promocion IN (${idsP.map(() => '?').join(',')})`, idsP);
      filasP.forEach(pr => promosDef.set(pr.id_promocion, pr));
      for (const id of idsP) {
        const pr = promosDef.get(id);
        if (!pr || !pr.activa) throw new BusinessError('Una de las promociones ya no está disponible.');
      }

      const detP = await dbAll(
        `SELECT pd.id_promocion, pd.id_producto, pd.cantidad, p.nombre, p.precio_venta, p.activo
           FROM promocion_detalle pd
           JOIN producto p ON p.id_producto = pd.id_producto
          WHERE pd.id_promocion IN (${idsP.map(() => '?').join(',')})
          ORDER BY pd.id_detalle_promocion`, idsP);
      for (const pr of promosDef.values()) pr.items = [];
      for (const d of detP) {
        if (!d.activo) throw new BusinessError(`"${d.nombre}" está retirado y no se puede vender en paquete.`);
        promosDef.get(d.id_promocion).items.push(d);
      }
      for (const pr of promosDef.values()) {
        if (!pr.items || pr.items.length === 0) {
          throw new BusinessError(`La promoción "${pr.nombre}" no tiene productos válidos.`);
        }
      }
    }

    const { id_evento, id_barra, id_cajero, id_mesero, items, metodos_pago, observaciones } = req.body;
    if (!id_cajero || !id_mesero) throw new BusinessError('La comanda necesita cajero y mesero.');
    if (!id_barra) throw new BusinessError('La comanda no tiene barra asignada.');

    const sueltos = Array.isArray(items) ? items : [];
    if (sueltos.length === 0 && promosPedidas.size === 0) {
      throw new BusinessError('La comanda no tiene productos.');
    }
    if (!Array.isArray(metodos_pago) || metodos_pago.length === 0) {
      throw new BusinessError('La comanda no tiene formas de pago.');
    }

    for (const item of sueltos) {
      const cant = Number(item && item.cantidad);
      if (!Number.isFinite(cant) || !Number.isInteger(cant) || cant <= 0) {
        throw new BusinessError('Cantidad inválida en la comanda.');
      }
    }

    const parseItemAcomps = it => {
      if (Array.isArray(it.acompanantes)) {
        return it.acompanantes.map(a => typeof a === 'object' ? { id_producto: a.id_producto, cantidad: a.cantidad != null ? a.cantidad : 1 } : { id_producto: a, cantidad: 1 });
      }
      if (it.acompanante != null) {
        return [typeof it.acompanante === 'object' ? { id_producto: it.acompanante.id_producto, cantidad: it.acompanante.cantidad != null ? it.acompanante.cantidad : 1 } : { id_producto: it.acompanante, cantidad: 1 }];
      }
      if (it.id_acompanante != null) {
        return [{ id_producto: it.id_acompanante, cantidad: 1 }];
      }
      return [];
    };

    const productosIds = new Set();
    sueltos.forEach(i => {
      productosIds.add(parseInt(i.id_producto, 10));
      parseItemAcomps(i).forEach(a => productosIds.add(parseInt(a && a.id_producto, 10)));
    });
    for (const pr of promosDef.values()) {
      pr.items.forEach(it => productosIds.add(it.id_producto));
    }

    const idsLista = [...productosIds].filter(n => Number.isInteger(n) && n > 0);
    if (idsLista.length === 0) throw new BusinessError('Productos inválidos en la comanda.');

    const productosDb = await dbAll(
      `SELECT id_producto, nombre, precio_venta, stock_actual, activo,
              COALESCE(requiere_acompanante, 0) AS requiere_acompanante,
              COALESCE(es_acompanante, 0) AS es_acompanante
       FROM producto
       WHERE id_producto IN (${idsLista.map(() => '?').join(',')})`,
      idsLista
    );
    const dbProdMap = new Map(productosDb.map(p => [p.id_producto, p]));

    for (const id of idsLista) {
      const p = dbProdMap.get(id);
      if (!p || !p.activo) throw new BusinessError(`El producto #${id} ya no está a la venta.`);
    }

    const lineasSueltas = [];
    for (const item of sueltos) {
      const prod = dbProdMap.get(parseInt(item.id_producto, 10));
      const precio = Number(prod.precio_venta);
      const subtotal = round2(precio * item.cantidad);

      const acompanantes = parseItemAcomps(item)
        .map(a => {
          const idAcomp = parseInt(a && a.id_producto, 10);
          const pAcomp = dbProdMap.get(idAcomp);
          if (!pAcomp) throw new BusinessError(`El acompañante #${idAcomp} no existe.`);
          if (!pAcomp.es_acompanante) {
            throw new BusinessError(`${pAcomp.nombre} no está configurado como acompañante.`);
          }
          const cantA = Number((a && a.cantidad) != null ? a.cantidad : 1);
          if (!Number.isInteger(cantA) || cantA <= 0) {
            throw new BusinessError(`Cantidad de acompañante inválida para ${prod.nombre}.`);
          }
          return { id_producto: idAcomp, nombre: pAcomp.nombre, cantidad: cantA };
        });

      if (prod.requiere_acompanante && acompanantes.length === 0 && promosPedidas.size === 0) {
        throw new BusinessError(`${prod.nombre} necesita que elijas un acompañante.`);
      }

      lineasSueltas.push({
        id_producto: prod.id_producto,
        nombre: prod.nombre,
        cantidad: item.cantidad,
        precio_unitario: precio,
        subtotal: subtotal,
        id_promocion: null,
        acompanantes
      });
    }

    const lineasPromocion = [];
    for (const [idPromo, veces] of promosPedidas) {
      const pr = promosDef.get(idPromo);
      const partes = pr.items.map(it => ({
        idProd: it.id_producto,
        qty: it.cantidad,
        precioCatalogo: Number(it.precio_venta)
      }));
      const repartido = repartirPrecioPaquete(partes, Number(pr.precio));

      for (const r of repartido) {
        const pDb = dbProdMap.get(r.idProd);
        lineasPromocion.push({
          id_producto: r.idProd,
          nombre: pDb.nombre,
          cantidad: r.qty * veces,
          precio_unitario: r.precio,
          subtotal: round2(r.subtotal * veces),
          id_promocion: idPromo,
          acompanantes: []
        });
      }
    }

    const todasLasLineas = lineasSueltas.concat(lineasPromocion);
    const totalCalculado = round2(todasLasLineas.reduce((acc, i) => acc + i.subtotal, 0));

    const cantidadesPorProducto = new Map();
    for (const linea of todasLasLineas) {
      cantidadesPorProducto.set(linea.id_producto,
        (cantidadesPorProducto.get(linea.id_producto) || 0) + linea.cantidad);
      for (const ac of linea.acompanantes) {
        cantidadesPorProducto.set(ac.id_producto,
          (cantidadesPorProducto.get(ac.id_producto) || 0) + ac.cantidad * linea.cantidad);
      }
    }

    for (const [idProd, cantPedida] of cantidadesPorProducto) {
      const prod = dbProdMap.get(idProd);
      if (prod.stock_actual < cantPedida) {
        throw new BusinessError(
          `No hay stock suficiente de ${prod.nombre} (quedan ${prod.stock_actual}, pides ${cantPedida}).`
        );
      }
    }

    const metodosDb = await dbAll('SELECT id_metodo_pago, nombre FROM metodo_pago WHERE activo = 1');
    const metodoMap = new Map(metodosDb.map(m => [m.id_metodo_pago, m.nombre]));

    let totalPagos = 0;
    const pagosValidados = [];
    for (const pago of metodos_pago) {
      const idMetodo = parseInt(pago && pago.id_metodo_pago, 10);
      const monto = Number(pago && pago.monto);
      if (!metodoMap.has(idMetodo)) throw new BusinessError('Forma de pago desconocida en la comanda.');
      if (!Number.isFinite(monto) || monto <= 0) throw new BusinessError('Hay un monto de pago inválido en la comanda.');

      totalPagos = round2(totalPagos + monto);
      pagosValidados.push({
        id_metodo_pago: idMetodo,
        monto: round2(monto),
        referencia: String(pago.referencia || '').trim().slice(0, 80)
      });
    }

    if (totalPagos < totalCalculado) {
      throw new BusinessError(
        `Los pagos (${totalPagos.toFixed(2)}) no cubren el total de la comanda (${totalCalculado.toFixed(2)}).`
      );
    }

    const nowStr = nowSql();
    const comandaRes = await dbRun(
      `INSERT INTO comanda (id_evento, id_barra, id_cajero, id_mesero, fecha_hora, total, estado_pago, estatus, observaciones, clave_idempotencia)
       VALUES (?, ?, ?, ?, ?, ?, 'PAGADO', 'COMPLETADO', ?, ?)`,
      [id_evento || 1, id_barra, id_cajero, id_mesero, nowStr, totalCalculado,
       String(observaciones || '').trim().slice(0, 250), clave || null]
    );
    const idComanda = comandaRes.insertId;

    for (const linea of todasLasLineas) {
      const detPadre = await dbRun(
        `INSERT INTO detalle_comanda (id_comanda, id_producto, cantidad, precio_unitario, subtotal, id_promocion)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [idComanda, linea.id_producto, linea.cantidad, linea.precio_unitario, linea.subtotal, linea.id_promocion]
      );

      for (const acomp of linea.acompanantes) {
        await dbRun(
          `INSERT INTO detalle_comanda (id_comanda, id_producto, cantidad, precio_unitario, subtotal, id_detalle_padre)
           VALUES (?, ?, ?, 0.00, 0.00, ?)`,
          [idComanda, acomp.id_producto, acomp.cantidad, detPadre.insertId]
        );
      }
    }

    for (const pago of pagosValidados) {
      await dbRun(
        `INSERT INTO pago_comanda (id_comanda, id_metodo_pago, monto, fecha_hora, referencia, estado)
         VALUES (?, ?, ?, ?, ?, 'APROBADO')`,
        [idComanda, pago.id_metodo_pago, pago.monto, nowStr, pago.referencia]
      );
    }

    for (const [idProd, cant] of cantidadesPorProducto) {
      const prod = dbProdMap.get(idProd);
      const upd = await dbRun(
        `UPDATE producto SET stock_actual = stock_actual - ?
         WHERE id_producto = ? AND stock_actual >= ?`,
        [cant, idProd, cant]
      );
      if (upd.affectedRows === 0) {
        throw new BusinessError(
          `No se pudo reservar el stock de ${prod.nombre}: ya no quedan unidades suficientes.`
        );
      }
      await dbRun(
        `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, fecha_hora)
         VALUES (?, NULL, 'SALIDA', ?, ?, ?, ?, ?)`,
        [idProd, cant, prod.stock_actual, prod.stock_actual - cant, `Venta comanda #${idComanda}`, nowStr]
      );
    }

    await dbRun(
      `INSERT INTO impresion_comanda_cajero (id_comanda, fecha_hora_impresion, numero_copia, id_cajero, id_mesero)
       VALUES (?, ?, 1, ?, ?)`,
      [idComanda, nowStr, id_cajero, id_mesero]
    );
    await dbRun(
      `INSERT INTO impresion_comanda_mesero (id_comanda, fecha_hora_impresion, numero_copia, id_cajero, id_mesero)
       VALUES (?, ?, 1, ?, ?)`,
      [idComanda, nowStr, id_cajero, id_mesero]
    );

    const promosResp = [];
    for (const [idPromo, veces] of promosPedidas) {
      const pr = promosDef.get(idPromo);
      promosResp.push({
        id_promocion: pr.id_promocion,
        nombre: pr.nombre,
        precio: Number(pr.precio),
        cantidad: veces,
        subtotal: round2(Number(pr.precio) * veces),
        contenido: (pr.items || []).map(it => ({
          id_producto: it.id_producto,
          nombre: it.nombre,
          cantidad: it.cantidad
        }))
      });
    }

    return {
      id_comanda: idComanda,
      ref_comanda: String(idComanda),
      total: totalCalculado,
      items: todasLasLineas,
      promociones: promosResp,
      repetida: false
    };
  })
    .then(r => res.json(Object.assign({ success: true }, r)))
    .catch(err => {
      if (err instanceof BusinessError) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      if (String(err && err.message).includes('idx_comanda_idempotencia')) {
        return res.status(409).json({
          success: false,
          message: 'Esta venta ya fue cobrada. Revisa el historial si necesitas reimprimir el ticket.'
        });
      }
      console.error('Error procesando comanda:', err);
      res.status(500).json({ success: false, message: 'No se pudo guardar la comanda.' });
    });
});

// ==========================================
// 3b. API: TRASPASOS E INGRESOS DE MERCANCÍA
// ==========================================
const TIPOS_TRASPASO = ['SALIDA', 'ENTRADA'];
const MOTIVOS_TRASPASO = ['TRASPASO', 'COMPRA'];

app.post('/api/traspaso', (req, res) => {
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

app.get('/api/traspasos', (req, res) => {
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

app.get('/api/traspaso/:id', (req, res) => {
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
      if (!cabecera) return res.status(404).json({ success: false, message: 'Traspaso no encontrado.' });
      res.json({ success: true, traspaso: cabecera, items });
    })
    .catch(err => {
      console.error('Error al leer el traspaso:', err);
      res.status(500).json({ success: false, message: 'No se pudo leer el traspaso.' });
    });
});

// ==========================================
// 3c. API: PROMOCIONES (COMBOS Y BALDES)
// ==========================================
function cuantas(tabla, columna, id) {
  return dbGet(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${columna} = ?`, [id])
    .then(f => (f ? f.n : 0));
}

async function validarContenidoPromocion(contenido) {
  if (!Array.isArray(contenido) || contenido.length === 0) {
    throw new BusinessError('La promoción tiene que llevar al menos un producto.');
  }
  if (contenido.length > 20) {
    throw new BusinessError('Una promoción no puede llevar más de 20 productos distintos.');
  }

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

app.get('/api/admin/promociones', (req, res) => {
  dbAll(`SELECT id_promocion, nombre, descripcion, precio, activa,
                CASE WHEN foto IS NULL OR foto = '' THEN 0 ELSE 1 END AS tiene_foto,
                LENGTH(COALESCE(foto, '')) AS foto_v
         FROM promocion
         WHERE COALESCE(eliminada, 0) = 0
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
  Promise.resolve()
    .then(async () => {
      const datos = validarDatosPromocion(req.body || {});
      const lineas = await validarContenidoPromocion((req.body || {}).contenido);
      const foto = req.body && req.body.foto ? validarFoto(req.body.foto) : null;
      if (req.body && req.body.foto && foto === false) {
        throw new BusinessError('La foto no es válida. Usa una imagen PNG, JPG o WEBP.');
      }

      const id = await withTransaction(async () => {
        const r = await dbRun(
          `INSERT INTO promocion (nombre, descripcion, precio, activa, eliminada, creada_por_admin, foto)
           VALUES (?, ?, ?, 1, 0, ?, ?)`,
          [datos.nombre, datos.descripcion, datos.precio, req.body.id_admin || null, foto || null]
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
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Promoción no válida.' });
  }

  Promise.resolve()
    .then(async () => {
      const antes = await dbGet('SELECT nombre, descripcion, precio, activa FROM promocion WHERE id_promocion = ? AND COALESCE(eliminada, 0) = 0', [id]);
      if (!antes) {
        return res.status(404).json({ success: false, message: 'Esa promoción ya no existe.' });
      }

      const nombre = req.body && req.body.nombre !== undefined ? req.body.nombre : antes.nombre;
      const descripcion = req.body && req.body.descripcion !== undefined ? req.body.descripcion : antes.descripcion;
      const precio = req.body && req.body.precio !== undefined ? req.body.precio : antes.precio;
      const datos = validarDatosPromocion({ ...req.body, nombre, descripcion, precio });
      const cambiaContenido = Array.isArray((req.body || {}).contenido);
      const lineas = cambiaContenido
        ? await validarContenidoPromocion(req.body.contenido)
        : null;
      const activa = req.body.activa === undefined ? antes.activa : (req.body.activa ? 1 : 0);
      const actualizaFoto = req.body && req.body.foto !== undefined;
      const foto = actualizaFoto ? (req.body.foto ? validarFoto(req.body.foto) : null) : null;
      if (actualizaFoto && req.body.foto && foto === false) {
        throw new BusinessError('La foto no es válida. Usa una imagen PNG, JPG o WEBP.');
      }

      await withTransaction(async () => {
        if (actualizaFoto) {
          await dbRun(
            'UPDATE promocion SET nombre = ?, descripcion = ?, precio = ?, activa = ?, foto = ? WHERE id_promocion = ?',
            [datos.nombre, datos.descripcion, datos.precio, activa, foto || null, id]
          );
        } else {
          await dbRun(
            'UPDATE promocion SET nombre = ?, descripcion = ?, precio = ?, activa = ? WHERE id_promocion = ?',
            [datos.nombre, datos.descripcion, datos.precio, activa, id]
          );
        }
        if (lineas) {
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

      await withTransaction(async () => {
        // Desvincular de detalles de comandas históricas para que no rompa el cierre ni el historial
        await dbRun('UPDATE detalle_comanda SET id_promocion = NULL WHERE id_promocion = ?', [id]);
        // Eliminación física y completa de la base de datos
        await dbRun('DELETE FROM promocion_detalle WHERE id_promocion = ?', [id]);
        await dbRun('DELETE FROM promocion WHERE id_promocion = ?', [id]);
      });

      await registrarAuditoria(req.body && req.body.id_admin, 'ELIMINAR_PROMOCION',
        'promocion', id, `"${promo.nombre}" eliminada por completo de la base de datos`);
      res.json({ success: true, message: `"${promo.nombre}" eliminada correctamente.` });
    })
    .catch(err => {
      console.error('Error al eliminar la promoción:', err);
      res.status(500).json({ success: false, message: friendlyDbError(err, 'promoción') });
    });
});

app.put('/api/admin/promociones/:id/foto', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Promoción no válida.' });
  }

  const foto = validarFoto(req.body ? req.body.foto : undefined);
  if (foto === false) {
    return res.status(400).json({
      success: false,
      message: 'La foto no es válida. Usa una imagen PNG, JPG o WEBP.'
    });
  }

  dbGet('SELECT id_promocion, nombre FROM promocion WHERE id_promocion = ?', [id])
    .then(promo => {
      if (!promo) return { estado: 404, cuerpo: { success: false, message: 'Esa promoción ya no existe.' } };
      return dbRun('UPDATE promocion SET foto = ? WHERE id_promocion = ?', [foto || null, id])
        .then(() => registrarAuditoria(
          req.body && req.body.id_admin, foto ? 'PONER_FOTO' : 'QUITAR_FOTO', 'promocion', id,
          (foto ? 'Se puso foto a la promoción "' : 'Se quitó la foto de la promoción "') + promo.nombre + '"')
        ).then(() => ({
          estado: 200,
          cuerpo: {
            success: true,
            foto: foto || null,
            message: foto ? `Foto de "${promo.nombre}" guardada.` : `Foto de "${promo.nombre}" quitada.`
          }
        }));
    })
    .then(r => res.status(r.estado).json(r.cuerpo))
    .catch(err => {
      console.error('Error al guardar la foto de la promoción:', err);
      res.status(500).json({ success: false, message: 'No se pudo guardar la foto.' });
    });
});

// ---- Categoría -------------------------------------------------------------
app.delete('/api/admin/categorias/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Categoría no válida.' });
  }

  withTransaction(async () => {
    const cat = await dbGet('SELECT id_categoria, nombre FROM categoria_producto WHERE id_categoria = ?', [id]);
    if (!cat) return { estado: 404, cuerpo: { success: false, message: 'Esa categoría ya no existe.' } };

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

app.put('/api/admin/categorias/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Categoría no válida.' });
  }

  withTransaction(async () => {
    const cat = await dbGet('SELECT id_categoria, nombre, descripcion, tipo, activo FROM categoria_producto WHERE id_categoria = ?', [id]);
    if (!cat) return { estado: 404, cuerpo: { success: false, message: 'Esa categoría ya no existe.' } };

    const nuevoActivo = req.body.activo !== undefined ? (req.body.activo ? 1 : 0) : cat.activo;
    const nuevoNombre = req.body.nombre !== undefined ? String(req.body.nombre).trim() : cat.nombre;
    const nuevaDesc = req.body.descripcion !== undefined ? String(req.body.descripcion).trim() : (cat.descripcion || '');
    const nuevoTipo = req.body.tipo !== undefined ? String(req.body.tipo).trim() : (cat.tipo || 'BEBIDA');

    if (!nuevoNombre) {
      return { estado: 400, cuerpo: { success: false, message: 'La categoría necesita un nombre.' } };
    }

    await dbRun(
      'UPDATE categoria_producto SET nombre = ?, descripcion = ?, tipo = ?, activo = ? WHERE id_categoria = ?',
      [nuevoNombre, nuevaDesc, nuevoTipo, nuevoActivo, id]
    );

    const cambioEstado = cat.activo !== nuevoActivo;
    const mensaje = cambioEstado
      ? (nuevoActivo ? `Categoría "${nuevoNombre}" activada.` : `Categoría "${nuevoNombre}" desactivada.`)
      : `Categoría "${nuevoNombre}" actualizada.`;

    return {
      estado: 200,
      cuerpo: {
        success: true,
        activo: nuevoActivo,
        cambioEstado: cambioEstado,
        message: mensaje
      }
    };
  })
    .then(r => {
      if (r.cuerpo && r.cuerpo.success) {
        const accion = r.cuerpo.cambioEstado
          ? (r.cuerpo.activo ? 'ACTIVAR_CATEGORIA' : 'DESACTIVAR_CATEGORIA')
          : 'EDITAR_CATEGORIA';
        registrarAuditoria(
          req.body && req.body.id_admin,
          accion,
          'categoria_producto',
          id,
          r.cuerpo.message
        );
      }
      res.status(r.estado).json(r.cuerpo);
    })
    .catch(err => {
      console.error('Error al actualizar categoría:', err);
      res.status(500).json({ success: false, message: 'No se pudo actualizar la categoría.' });
    });
});

app.put('/api/admin/categorias/:id/estado', (req, res) => {
  req.url = `/api/admin/categorias/${req.params.id}`;
  app._router.handle(req, res);
});

// ---- Cajero ----------------------------------------------------------------
app.delete('/api/admin/cajeros/:id', (req, res) => {
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

// ---- Personal Completo -----------------------------------------------------
app.get('/api/admin/personal', (req, res) => {
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

// ---- Catálogo Completo -----------------------------------------------------
app.get('/api/admin/catalogo', (req, res) => {
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
// 4b. API: FOTO Y GESTIÓN DE PRODUCTO
// ==========================================
const FOTO_MAX_BYTES = 400 * 1024;
const FOTO_PATRON = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function validarFoto(valor) {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor);
  if (!texto) return '';
  if (!FOTO_PATRON.test(texto)) return false;
  if (texto.length > FOTO_MAX_BYTES * 1.4) return false;
  return texto;
}

app.delete('/api/admin/productos/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Producto no válido.' });
  }

  withTransaction(async () => {
    const prod = await dbGet('SELECT id_producto, nombre FROM producto WHERE id_producto = ?', [id]);
    if (!prod) return { estado: 404, cuerpo: { success: false, message: 'Ese producto ya no existe.' } };

    const vendido = await cuantas('detalle_comanda', 'id_producto', id);
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

app.put('/api/admin/productos/:id/estado', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Producto no válido.' });
  }

  withTransaction(async () => {
    const prod = await dbGet('SELECT id_producto, nombre, activo FROM producto WHERE id_producto = ?', [id]);
    if (!prod) return { estado: 404, cuerpo: { success: false, message: 'Ese producto ya no existe.' } };

    const nuevoActivo = req.body.activo !== undefined ? (req.body.activo ? 1 : 0) : (prod.activo ? 0 : 1);
    await dbRun('UPDATE producto SET activo = ? WHERE id_producto = ?', [nuevoActivo, id]);

    return {
      estado: 200,
      cuerpo: {
        success: true,
        activo: nuevoActivo,
        message: nuevoActivo ? `"${prod.nombre}" activado.` : `"${prod.nombre}" desactivado.`
      }
    };
  })
    .then(r => {
      if (r.cuerpo.success) {
        registrarAuditoria(
          req.body && req.body.id_admin,
          r.cuerpo.activo ? 'ACTIVAR_PRODUCTO' : 'DESACTIVAR_PRODUCTO',
          'producto',
          id,
          r.cuerpo.message
        );
      }
      res.status(r.estado).json(r.cuerpo);
    })
    .catch(err => {
      console.error('Error al cambiar estado del producto:', err);
      res.status(500).json({ success: false, message: 'No se pudo cambiar el estado del producto.' });
    });
});

app.put('/api/admin/productos/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Producto no válido.' });
  }

  if (req.body.activo !== undefined && req.body.nombre === undefined) {
    req.url = `/api/admin/productos/${id}/estado`;
    return app._router.handle(req, res, next);
  }

  const nombre = String(req.body.nombre == null ? '' : req.body.nombre).trim().slice(0, 120);
  const descripcion = String(req.body.descripcion == null ? '' : req.body.descripcion).trim().slice(0, 250);
  const precio = Number(req.body.precio_venta);
  const idCategoria = parseInt(req.body.id_categoria, 10);

  if (!nombre) {
    return res.status(400).json({ success: false, message: 'El producto necesita un nombre.' });
  }
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

app.put('/api/admin/productos/:id/acompanamiento', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Producto no válido.' });
  }

  const requiere = req.body && req.body.requiere_acompanante ? 1 : 0;
  const esAcomp = req.body && req.body.es_acompanante ? 1 : 0;

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
  dbQuery(query, (err, comandas) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const queryDetails = `
      SELECT dc.*, COALESCE(p.nombre, 'Producto eliminado') AS nombre_producto
      FROM detalle_comanda dc
      LEFT JOIN producto p ON dc.id_producto = p.id_producto
    `;
    dbQuery(queryDetails, (err2, details) => {
      if (err2) return res.status(500).json({ error: err2.message });

      const queryPayments = `
        SELECT pc.*, COALESCE(mp.nombre, 'Método desconocido') AS nombre_metodo
        FROM pago_comanda pc
        LEFT JOIN metodo_pago mp ON pc.id_metodo_pago = mp.id_metodo_pago
      `;
      dbQuery(queryPayments, (err3, payments) => {
        if (err3) return res.status(500).json({ error: err3.message });

        const mapped = (comandas || []).map(c => {
          return {
            ...c,
            detalles: (details || []).filter(d => d.id_comanda === c.id_comanda),
            pagos: (payments || []).filter(p => p.id_comanda === c.id_comanda)
          };
        });
        return res.json(mapped);
      });
    });
  });
});

// VOID / CANCEL ORDER
app.post('/api/admin/comandas/anular', (req, res) => {
  const { id_comanda, id_admin, motivo_anulacion } = req.body;

  withTransaction(async () => {
    const comanda = await dbGet(
      'SELECT id_comanda, id_evento, estado_pago FROM comanda WHERE id_comanda = ?',
      [id_comanda]
    );
    if (!comanda) throw new BusinessError('Comanda no encontrada.', 404);
    if (comanda.estado_pago === 'ANULADO') {
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
});

// CREATE CATEGORY
app.post('/api/admin/categorias', (req, res) => {
  const { nombre, descripcion, tipo, id_admin, id_evento } = req.body;
  const nowStr = nowSql();

  const query = `INSERT INTO categoria_producto (nombre, descripcion, tipo, creado_por_admin, fecha_creacion) VALUES (?, ?, ?, ?, ?)`;
  dbQuery(query, [nombre, descripcion, tipo, id_admin, nowStr], (err, result) => {
    if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'categoría') });
    const newCatId = result.insertId;

    const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_CATEGORIA', 'categoria_producto', ?, ?)`;
    dbQuery(queryAudit, [id_admin, id_evento || 1, newCatId, `Se creó la categoría ${nombre}`], (errAudit) => {
      if (errAudit) console.error(errAudit);
      return res.json({ success: true, id_categoria: newCatId });
    });
  });
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

  const query = `INSERT INTO producto (id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual, foto, requiere_acompanante, es_acompanante, creado_por_admin, fecha_creacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  dbQuery(query, [id_categoria, String(nombre).trim(), descripcion, tipo_producto, round2(precio), stockInicial, fotoNueva || null, requiere, esAcomp, id_admin, nowStr], (err, result) => {
    if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'producto') });
    const newProdId = result.insertId;

    if (stockInicial > 0) {
      const queryMov = `INSERT INTO movimiento_stock (id_producto, id_admin, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo) VALUES (?, ?, 'ENTRADA', ?, 0, ?, 'Carga inicial de stock')`;
      dbQuery(queryMov, [newProdId, id_admin, stockInicial, stockInicial], (errMov) => {
        if (errMov) console.error(errMov);
      });
    }

    const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_PRODUCTO', 'producto', ?, ?)`;
    dbQuery(queryAudit, [id_admin, id_evento || 1, newProdId, `Se creó el producto ${nombre} con stock inicial de ${stock_actual || 0}`], (errAudit) => {
      if (errAudit) console.error(errAudit);
      return res.json({ success: true, id_producto: newProdId });
    });
  });
});

// CREATE CAJERO
app.post('/api/admin/cajeros', (req, res) => {
  const { nombre, usuario, password, id_admin, id_evento } = req.body;
  const id_barra = INSTANCIA.id_barra || req.body.id_barra;

  const query = `INSERT INTO cajero (id_barra, nombre, usuario, password) VALUES (?, ?, ?, ?)`;
  dbQuery(query, [id_barra, nombre, usuario, password], (err, result) => {
    if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'cajero') });
    const newCajeroId = result.insertId;

    const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_CAJERO', 'cajero', ?, ?)`;
    dbQuery(queryAudit, [id_admin, id_evento || 1, newCajeroId, `Se registró al cajero ${nombre} con usuario ${usuario}`], (errAudit) => {
      if (errAudit) console.error(errAudit);
      return res.json({ success: true, id_cajero: newCajeroId });
    });
  });
});

// CREATE MESERO
app.post('/api/admin/meseros', (req, res) => {
  const { id_evento, id_cajero, nombre, usuario, password, id_admin } = req.body;

  let scopeSql;
  let scopeParams;
  if (MESERO_PIN_SCOPE === 'cajero') {
    scopeSql = 'SELECT id_mesero FROM mesero WHERE password = ? AND id_cajero = ? AND activo = 1';
    scopeParams = [password, id_cajero];
  } else {
    scopeSql = 'SELECT id_mesero FROM mesero WHERE password = ? AND activo = 1';
    scopeParams = [password];
  }

  dbQuery(scopeSql, scopeParams, (errDup, dup) => {
    if (errDup) return res.status(500).json({ success: false, message: errDup.message });
    if (dup && dup.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Ese PIN ya está en uso por otro mesero. Elige uno distinto.'
      });
    }

    const query = `INSERT INTO mesero (id_evento, id_cajero, nombre, usuario, password) VALUES (?, ?, ?, ?, ?)`;
    dbQuery(query, [id_evento || 1, id_cajero, nombre, usuario, password], (err, result) => {
      if (err) return res.status(400).json({ success: false, message: friendlyDbError(err, 'mesero') });
      const newMeseroId = result.insertId;

      const queryAudit = `INSERT INTO auditoria_admin (id_admin, id_evento, accion, entidad, id_registro, detalle) VALUES (?, ?, 'CREAR_MESERO', 'mesero', ?, ?)`;
      dbQuery(queryAudit, [id_admin, id_evento || 1, newMeseroId, `Se registró al mesero ${nombre} asignado al cajero ID ${id_cajero}`], (errAudit) => {
        if (errAudit) console.error(errAudit);
        return res.json({ success: true, id_mesero: newMeseroId });
      });
    });
  });
});

// REGISTER STOCK MOVEMENT (MANUAL)
app.post('/api/admin/stock/movimiento', (req, res) => {
  const { id_producto, tipo_movimiento, cantidad, motivo, id_admin, id_evento } = req.body;

  withTransaction(async () => {
    const tipo = String(tipo_movimiento || '').toUpperCase();
    if (!['ENTRADA', 'SALIDA', 'AJUSTE'].includes(tipo)) {
      throw new BusinessError('Tipo de movimiento no válido.');
    }

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
function rangoFechas(query) {
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/;
  const desde = soloFecha.test(query.desde || '') ? query.desde + ' 00:00:00' : '0000-01-01 00:00:00';
  const hasta = soloFecha.test(query.hasta || '') ? query.hasta + ' 23:59:59' : '9999-12-31 23:59:59';
  return { desde, hasta, todo: !soloFecha.test(query.desde || '') && !soloFecha.test(query.hasta || '') };
}

async function construirReporte(query) {
  const { desde, hasta, todo } = rangoFechas(query);
  const P = [desde, hasta];

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

  const cobrosDigitales = await dbAll(`
    SELECT c.id_comanda, mp.nombre AS metodo, p.monto, p.referencia, p.fecha_hora
    FROM pago_comanda p
    JOIN comanda c      ON c.id_comanda = p.id_comanda
    JOIN metodo_pago mp ON mp.id_metodo_pago = p.id_metodo_pago
    WHERE p.estado = 'APROBADO' AND c.estado_pago != 'ANULADO'
      AND mp.nombre != 'EFECTIVO' AND c.fecha_hora BETWEEN ? AND ?
    ORDER BY c.id_comanda
  `, P);

  const reimpresiones = await leerReimpresiones(P[0], P[1]);

  const validas = Number(resumen.validas) || 0;
  return {
    evento,
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
  construirReporte(req.query)
    .then(datos => res.json(datos))
    .catch(err => {
      console.error('Error al construir el reporte:', err);
      res.status(500).json({ success: false, message: 'No se pudo generar el reporte.' });
    });
});

app.get('/api/admin/reporte.pdf', (req, res) => {
  construirReporte(req.query)
    .then(datos => {
      const pdf = construirPdfCierre(datos);
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

app.get('/api/admin/comandas.pdf', async (req, res) => {
  try {
    const config = await leerConfiguracion();
    const sembrado = await dbGet('SELECT nombre_evento, fecha_evento, lugar FROM evento LIMIT 1');
    const evento = {
      nombre_evento: config.evento || (sembrado && sembrado.nombre_evento) || 'Evento',
      fecha_evento: config.fecha || (sembrado && sembrado.fecha_evento) || '',
      lugar: config.lugar || (sembrado && sembrado.lugar) || '',
      responsable: config.responsable || '',
      barra: config.barra || INSTANCIA.nombre
    };

    const queryComandas = `
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
    const comandas = await dbAll(queryComandas);

    const queryDetails = `
      SELECT dc.*, COALESCE(p.nombre, 'Producto eliminado') AS nombre_producto
      FROM detalle_comanda dc
      LEFT JOIN producto p ON dc.id_producto = p.id_producto
    `;
    const details = await dbAll(queryDetails);

    const queryPayments = `
      SELECT pc.*, COALESCE(mp.nombre, 'Método desconocido') AS nombre_metodo
      FROM pago_comanda pc
      LEFT JOIN metodo_pago mp ON pc.id_metodo_pago = mp.id_metodo_pago
    `;
    const payments = await dbAll(queryPayments);

    let mapped = (comandas || []).map(c => ({
      ...c,
      detalles: (details || []).filter(d => d.id_comanda === c.id_comanda),
      pagos: (payments || []).filter(p => p.id_comanda === c.id_comanda)
    }));

    const filtro = (req.query.q || '').trim();
    if (filtro) {
      const qNum = filtro.replace(/[^0-9]/g, '');
      if (qNum) {
        mapped = mapped.filter(c => c.id_comanda.toString().includes(qNum));
      } else {
        mapped = [];
      }
    }

    const estado = (req.query.estado || '').trim().toLowerCase();
    if (estado === 'completadas') {
      mapped = mapped.filter(c => c.estado_pago !== 'ANULADO');
    } else if (estado === 'anuladas') {
      mapped = mapped.filter(c => c.estado_pago === 'ANULADO');
    }

    const mesero = (req.query.mesero || '').trim().toLowerCase();
    if (mesero) {
      mapped = mapped.filter(c => (c.nombre_mesero || '').toLowerCase() === mesero);
    }

    const desde = (req.query.desde || '').trim();
    const hasta = (req.query.hasta || '').trim();
    if (desde) {
      mapped = mapped.filter(c => (c.fecha_hora || '').slice(0, 10) >= desde);
    }
    if (hasta) {
      mapped = mapped.filter(c => (c.fecha_hora || '').slice(0, 10) <= hasta);
    }

    const datos = {
      evento,
      instancia: INSTANCIA,
      generado: nowSql(),
      filtro: filtro || null,
      comandas: mapped
    };

    const pdf = construirPdfComandas(datos);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoComandas(datos)}"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) {
    console.error('Error al generar el PDF de comandas:', err);
    res.status(500).send('No se pudo generar el PDF de comandas.');
  }
});

// GET AUDIT LOG & STOCK LOGS & BARRAS
app.get('/api/admin/auditoria', (req, res) => {
  const qAudit = `
    SELECT au.*, COALESCE(a.nombre, 'Sistema') AS nombre_admin
    FROM auditoria_admin au
    LEFT JOIN administrador_evento a ON au.id_admin = a.id_admin
    ORDER BY au.id_auditoria DESC
  `;
  dbQuery(qAudit, (err, audits) => {
    if (err) return res.status(500).json({ error: err.message });
    
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
    dbQuery(qMovs, (err2, movs) => {
      if (err2) return res.status(500).json({ error: err2.message });

      dbQuery('SELECT * FROM barra', (err3, barras) => {
        if (err3) return res.status(500).json({ error: err3.message });
        
        dbQuery('SELECT * FROM cajero', (err4, cajeros) => {
          if (err4) return res.status(500).json({ error: err4.message });

          dbQuery('SELECT * FROM metodo_pago', (err5, metodos) => {
            if (err5) return res.status(500).json({ error: err5.message });
            return res.json({ auditoria: audits || [], movimientos: movs || [], barras: barras || [], cajeros: cajeros || [], metodos_pago: metodos || [] });
          });
        });
      });
    });
  });
});

// ==========================================
// 5. API: PRINT LOG & REPRINTS
// ==========================================
app.post('/api/impresion', (req, res) => {
  const { id_comanda, tipo, id_cajero, id_mesero } = req.body;
  const table = tipo === 'mesero' ? 'impresion_comanda_mesero' : 'impresion_comanda_cajero';

  Promise.all([
    dbGet(`SELECT COALESCE(MAX(numero_copia), 0) AS ultima FROM ${table} WHERE id_comanda = ?`, [id_comanda]),
    dbGet('SELECT id_cajero, id_mesero FROM comanda WHERE id_comanda = ?', [id_comanda])
  ])
    .then(([row, duenos]) => {
      const copia = (row ? row.ultima : 0) + 1;
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
      res.status(200).json({ success: false, message: 'No se pudo registrar la impresión.' });
    });
});

function leerReimpresiones(desde, hasta) {
  const rango = desde && hasta ? 'AND i.fecha_hora_impresion BETWEEN ? AND ?' : '';
  const args = desde && hasta ? [desde, hasta] : [];

  return dbAll(`
    SELECT i.id_comanda AS id_comanda, i.numero_copia - 1 AS numero_reimpresion,
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
  leerReimpresiones(req.query.desde, req.query.hasta)
    .then(reimpresiones => res.json({ success: true, reimpresiones }))
    .catch(err => {
      console.error('Error al leer las reimpresiones:', err.message);
      res.status(500).json({ success: false, message: 'No se pudieron leer las reimpresiones.' });
    });
});

app.get('/api/admin/configuracion', (req, res) => {
  dbQuery('SELECT * FROM barra WHERE activo = 1', (err, barras) => {
    if (err) return res.status(500).json({ error: err.message });
    dbQuery('SELECT * FROM cajero WHERE activo = 1', (err2, cajeros) => {
      if (err2) return res.status(500).json({ error: err2.message });
      dbQuery('SELECT * FROM evento WHERE activo = 1', (err3, eventos) => {
        if (err3) return res.status(500).json({ error: err3.message });
        return res.json({ barras: barras || [], cajeros: cajeros || [], eventos: eventos || [] });
      });
    });
  });
});

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

let cerrando = false;
function cerrarOrdenado(senal) {
  if (cerrando) return;
  cerrando = true;
  console.log(`\n${senal} recibido: guardando la base...`);
  try {
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
const servidor = app.listen(PORT, '0.0.0.0', async () => {
  await refrescarIdentidad();
  await unificarBarras();
  const ips = localAddresses();
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
  informarDelAfiche();
  console.log(`\n   Nombre de la barra: Dashboard → Datos del evento → Barra.`);
  console.log(`   Versión de la interfaz: ${VERSION_UI}` +
    `   (debe coincidir con la que sale abajo en la tablet)`);
  console.log(`\n   Ctrl+C para detener.`);
  console.log(`==================================================\n`);
});

servidor.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`
==================================================
   ⛔ EL PUERTO ${PORT} YA ESTÁ OCUPADO
==================================================
   MasterDrinks ya está encendido en otra ventana,
   o quedó abierto de una vez anterior.

   Qué hacer:
   1. Mira si ya funciona:  http://localhost:${PORT}
      Si abre, no hace falta nada más: ya estaba encendido.
   2. Si quieres cerrarlo y volver a empezar, en Windows:
         npx kill-port ${PORT}
      o cierra la otra ventana negra con Ctrl+C.
   3. Si prefieres otro puerto, cambia PORT en el .env
==================================================
`);
  process.exit(1);
});
