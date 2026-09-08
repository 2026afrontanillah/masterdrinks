/* ==========================================================================
 * MasterDrinks — Impresión térmica vía RawBT
 * ==========================================================================
 *
 * La tablet se conecta por cable (USB OTG) a la impresora y RawBT es quien
 * habla con ella. Esta app le entrega un trabajo ESC/POS ya armado usando el
 * esquema de URL `rawbt:base64,<datos>`.
 *
 * El ticket se describe UNA sola vez como una lista de "ops" (líneas con
 * alineación / negrita / tamaño). De ahí salen tres salidas distintas:
 *
 *   ops ──┬──> ESC/POS  (impresora real, vía RawBT)
 *         ├──> texto plano (vista previa en pantalla y respaldo del navegador)
 *         └──> HTML      (impresión por el diálogo del navegador)
 *
 * Por eso lo que se ve en la vista previa al cerrar una venta es exactamente
 * lo que sale por la impresora: no hay dos maquetados que puedan desalinearse.
 * ========================================================================== */

window.ThermalPrinter = (function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Configuración persistente (se guarda en la tablet)
  // ---------------------------------------------------------------------
  const SETTINGS_KEY = 'masterdrinks.printer.v1';

  // Preparar el bitmap del logo Euphoria para impresoras térmicas ESC/POS
  let logoRasterEscPos = null;

  function prepararLogoRaster() {
    if (typeof Image === 'undefined' || typeof document === 'undefined') return;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          const targetWidth = 240;
          const targetHeight = Math.round((img.naturalHeight / img.naturalWidth) * targetWidth);
          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, targetWidth, targetHeight);
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

          const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
          const pixels = imgData.data;

          const bytesWidth = Math.ceil(targetWidth / 8);
          const rasterData = [];

          const xL = bytesWidth % 256;
          const xH = Math.floor(bytesWidth / 256);
          const yL = targetHeight % 256;
          const yH = Math.floor(targetHeight / 256);

          for (let y = 0; y < targetHeight; y++) {
            for (let b = 0; b < bytesWidth; b++) {
              let byteVal = 0;
              for (let bit = 0; bit < 8; bit++) {
                const x = b * 8 + bit;
                if (x < targetWidth) {
                  const idx = (y * targetWidth + x) * 4;
                  const r = pixels[idx];
                  const g = pixels[idx + 1];
                  const b_val = pixels[idx + 2];
                  const a = pixels[idx + 3];
                  const lum = (0.299 * r + 0.587 * g + 0.114 * b_val);
                  if (lum < 170 && a > 80) {
                    byteVal |= (1 << (7 - bit));
                  }
                }
              }
              rasterData.push(byteVal);
            }
          }

          logoRasterEscPos = {
            header: [0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH],
            data: rasterData
          };
        } catch (e) {
          console.warn('No se pudo procesar el raster del logo Euphoria:', e);
        }
      };
      img.src = 'logo_euphoria.png';
    } catch (err) {
      console.warn('Error al cargar imagen del logo Euphoria:', err);
    }
  }

  if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', prepararLogoRaster);
    } else {
      prepararLogoRaster();
    }
  }

  const DEFAULTS = {
    width: 32,          // 32 columnas = papel 58 mm · 48 columnas = papel 80 mm
    encoding: 'cp850',  // 'cp850' (con acentos) | 'ascii' (sin acentos)
    mode: 'rawbt',      // 'rawbt' (rawbt:base64,…) | 'intent' (intent://…)
    singleJob: true,    // los dos tickets en un solo trabajo de impresión
    cut: true,          // enviar corte de papel al final de cada ticket
    feed: 3,            // líneas en blanco antes del corte
    // La comanda sale por el papel en cuanto se cobra, sin que nadie pulse
    // nada. En una barra con cola, esperar a que el cajero se acuerde de pulsar
    // Imprimir es una comanda que no llega a la cocina.
    autoPrint: true
  };

  function getSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings(patch) {
    const next = Object.assign(getSettings(), patch);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn('No se pudo guardar la configuración de impresora:', e);
    }
    return next;
  }

  // ---------------------------------------------------------------------
  // Codificación de caracteres
  // ---------------------------------------------------------------------
  // Las impresoras térmicas no entienden UTF-8. Con CP850 (página de códigos 2)
  // salen bien los acentos, la ñ y los signos ¿ ¡. Si la impresora no la
  // soporta, el modo 'ascii' quita los acentos en vez de imprimir basura.
  const CP850 = {
    'Ç': 128, 'ü': 129, 'é': 130, 'â': 131, 'ä': 132, 'à': 133, 'å': 134, 'ç': 135,
    'ê': 136, 'ë': 137, 'è': 138, 'ï': 139, 'î': 140, 'ì': 141, 'Ä': 142, 'Å': 143,
    'É': 144, 'æ': 145, 'Æ': 146, 'ô': 147, 'ö': 148, 'ò': 149, 'û': 150, 'ù': 151,
    'ÿ': 152, 'Ö': 153, 'Ü': 154, 'ø': 155, '£': 156, 'Ø': 157, '×': 158, 'ƒ': 159,
    'á': 160, 'í': 161, 'ó': 162, 'ú': 163, 'ñ': 164, 'Ñ': 165, 'ª': 166, 'º': 167,
    '¿': 168, '®': 169, '¬': 170, '½': 171, '¼': 172, '¡': 173, '«': 174, '»': 175,
    'Á': 181, 'Â': 182, 'À': 183, '©': 184, 'ã': 198, 'Ã': 199,
    'ð': 208, 'Ð': 209, 'Ê': 210, 'Ë': 211, 'È': 212, 'Í': 214, 'Î': 215, 'Ï': 216,
    'Ó': 224, 'ß': 225, 'Ô': 226, 'Ò': 227, 'õ': 228, 'Õ': 229, 'µ': 230,
    'Ú': 233, 'Û': 234, 'Ù': 235, 'ý': 236, 'Ý': 237, '´': 239,
    '±': 241, '¾': 243, '¶': 244, '§': 245, '÷': 246, '°': 248, '¨': 249, '·': 250,

    // Caracteres de dibujo. CP850 los conserva en las mismas posiciones que
    // CP437, y son lo que separa un ticket que parece escrito con una máquina
    // de escribir de uno que parece impreso: una línea continua en vez de una
    // fila de guiones sueltos.
    '│': 179, '┤': 180, '╣': 185, '║': 186, '╗': 187, '╝': 188, '┐': 191,
    '└': 192, '┴': 193, '┬': 194, '├': 195, '─': 196, '┼': 197,
    '╚': 200, '╔': 201, '╩': 202, '╦': 203, '╠': 204, '═': 205, '╬': 206,
    '┘': 217, '┌': 218, '█': 219, '▄': 220, '▀': 223,
    '░': 176, '▒': 177, '▓': 178
  };

  const ASCII_FOLD = {
    'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a', 'ã': 'a', 'å': 'a',
    'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
    'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i',
    'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o', 'õ': 'o',
    'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u',
    'Á': 'A', 'À': 'A', 'Ä': 'A', 'Â': 'A', 'Ã': 'A',
    'É': 'E', 'È': 'E', 'Ë': 'E', 'Ê': 'E',
    'Í': 'I', 'Ì': 'I', 'Ï': 'I', 'Î': 'I',
    'Ó': 'O', 'Ò': 'O', 'Ö': 'O', 'Ô': 'O', 'Õ': 'O',
    'Ú': 'U', 'Ù': 'U', 'Ü': 'U', 'Û': 'U',
    'ñ': 'n', 'Ñ': 'N', 'ç': 'c', 'Ç': 'C',
    '¿': '?', '¡': '!', '°': 'o', 'º': 'o', 'ª': 'a', '€': 'EUR',
    '–': '-', '—': '-', '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...',

    // Si la impresora no habla CP850 se vuelve a los guiones de siempre: un
    // ticket más pobre, pero legible. Mejor eso que una fila de símbolos raros.
    '─': '-', '═': '=', '│': '|', '║': '|',
    '┌': '+', '┐': '+', '└': '+', '┘': '+', '├': '+', '┤': '+',
    '┬': '+', '┴': '+', '┼': '+',
    '╔': '+', '╗': '+', '╚': '+', '╝': '+', '╠': '+', '╣': '+',
    '╦': '+', '╩': '+', '╬': '+',
    '█': '#', '▓': '#', '▒': ':', '░': '.', '▄': '_', '▀': '-'
  };

  function encodeText(str, encoding) {
    const out = [];
    for (const ch of String(str)) {
      const code = ch.codePointAt(0);
      if (code < 0x80) { out.push(code); continue; }
      if (encoding === 'cp850' && CP850[ch] !== undefined) { out.push(CP850[ch]); continue; }
      const folded = ASCII_FOLD[ch];
      if (folded) { for (const f of folded) out.push(f.charCodeAt(0)); continue; }
      out.push(0x3F); // '?' para cualquier símbolo que la impresora no tenga
    }
    return out;
  }

  // Quita acentos también del texto plano, para que la vista previa y el
  // respaldo del navegador muestren lo mismo que imprimirá la impresora.
  function foldForDisplay(str, encoding) {
    if (encoding !== 'ascii') return String(str);
    return String(str).split('').map(ch => (ASCII_FOLD[ch] !== undefined ? ASCII_FOLD[ch] : ch)).join('');
  }

  // ---------------------------------------------------------------------
  // Maquetado en columnas fijas
  // ---------------------------------------------------------------------
  // Parte el texto respetando un ancho distinto para la primera línea y para
  // las siguientes (así se puede sangrar la continuación de un producto largo).
  function wrapLines(text, firstWidth, restWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    // El ancho disponible cambia al pasar de la primera línea a las siguientes,
    // así que se vuelve a consultar después de cada salto.
    const widthFor = () => Math.max(1, lines.length === 0 ? firstWidth : restWidth);
    const flush = () => { lines.push(cur); cur = ''; };

    for (const word of words) {
      let rest = word;
      while (rest.length) {
        const w = widthFor();
        if (!cur) {
          if (rest.length <= w) {
            cur = rest;
            rest = '';
          } else {
            // Palabra más larga que el papel: se parte a la fuerza.
            cur = rest.slice(0, w);
            rest = rest.slice(w);
            flush();
          }
        } else if (cur.length + 1 + rest.length <= w) {
          cur += ' ' + rest;
          rest = '';
        } else {
          flush(); // se reintenta en una línea nueva, con su propio ancho
        }
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function wrap(text, width) {
    return wrapLines(text, width, width);
  }

  // Igual que wrap, pero sangrando las líneas de continuación: "1 x Johnnie
  // Walker Black / ····Label" se lee como un producto y no como dos.
  function wrapIndent(text, width, indent) {
    const rest = Math.max(4, width - indent);
    const pad = ' '.repeat(indent);
    return wrapLines(text, width, rest).map((l, i) => (i === 0 ? l : pad + l));
  }

  // Etiqueta a la izquierda, importe pegado a la derecha. Si la etiqueta no
  // entra, se parte en varias líneas y el importe queda en la última.
  function twoCol(left, right, width, indent) {
    right = String(right);
    const room = width - right.length - 1;

    if (room < 4) {
      return wrap(left, width).concat([right.padStart(width)]);
    }

    const wrapped = wrapIndent(left, room, indent || 0);
    const lines = wrapped.slice(0, -1);
    const last = wrapped[wrapped.length - 1];
    const gap = width - last.length - right.length;

    // Red de seguridad: si el importe ya no cabe junto a la última línea,
    // se manda a una línea propia en vez de romper el maquetado.
    if (gap < 1) {
      lines.push(last);
      lines.push(right.padStart(width));
    } else {
      lines.push(last + ' '.repeat(gap) + right);
    }
    return lines;
  }

  // Pareja etiqueta/importe en una sola línea, sin re-partir el texto. A
  // diferencia de twoCol respeta los espacios de sangría, porque no pasa por
  // el troceado en palabras; se usa cuando ya se sabe que la etiqueta es corta.
  function padPair(left, right, width) {
    left = String(left);
    right = String(right);
    const gap = width - left.length - right.length;
    return gap >= 1 ? left + ' '.repeat(gap) + right : left + ' ' + right;
  }

  const divider = width => '─'.repeat(width);
  // Separador fuerte: marca el principio y el final de un bloque, mientras que
  // el de guiones separa filas dentro del mismo bloque. Con dos grosores el
  // ticket se lee de un vistazo aunque esté impreso en papel barato.
  const rule = width => '═'.repeat(width);

  // Etiqueta a la izquierda y valor alineado en una columna fija. Si el valor
  // no cabe, sigue debajo sangrado hasta esa misma columna.
  function kv(label, value, width, labelWidth) {
    const lw = labelWidth || 9;
    const pad = ' '.repeat(lw);
    return wrap(String(value), width - lw)
      .map((line, i) => (i === 0 ? String(label).padEnd(lw) : pad) + line);
  }

  // Título de sección: el texto seguido de guiones hasta el borde, para que se
  // distinga de una línea normal sin gastar una línea entera en un separador.
  function sectionTitle(text, width) {
    const t = String(text) + ' ';
    return t.length >= width ? t : t + '─'.repeat(width - t.length);
  }

  // ---------------------------------------------------------------------
  // Descripción del ticket como lista de "ops"
  // ---------------------------------------------------------------------
  // op = { text, align: 'left'|'center', bold: bool, tall: bool, wide: bool }
  // 'wide' duplica el ancho de cada carácter, así que el texto sólo dispone de
  // la mitad de columnas: úsalo únicamente en titulares cortos y centrados.
  const op = (text, extra) =>
    Object.assign({ text: text, align: 'left', bold: false, tall: false, wide: false }, extra || {});

  const money = n => Number(n || 0).toFixed(2);

  // Las observaciones, sólo si dicen algo. La caja guarda "Sin observaciones"
  // cuando el campo se deja vacío, y no hay por qué gastar cuatro líneas de
  // papel en imprimir que no hay nada que decir.
  function notaDe(model) {
    const texto = String(model.observaciones || '').trim();
    if (!texto) return '';
    return /^sin observaciones\.?$/i.test(texto) ? '' : texto;
  }

  const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  /**
   * Cabecera común.
   *
   * El orden va de lo que menos cambia a lo que más: marca, barra, evento y
   * por último el número de comanda, que es el dato que se busca. El número va
   * a doble tamaño y solo en su bloque porque es lo que el mesero canta en voz
   * alta y lo que el cliente rastrea entre varios tickets en el bolsillo.
   *
   * Los bloques se separan con líneas en blanco, no con más filas de "=". El
   * papel térmico barato emborrona los caracteres repetidos, y un ticket con
   * cuatro reglas gruesas se lee peor que uno con aire.
   */
  function buildHeaderOps(model, settings, subtitulo) {
    const w = settings.width;
    const ops = [];

    ops.push(op(rule(w)));
    ops.push(op(model.marca || 'MASTERDRINKS', { align: 'center', bold: true, tall: true, wide: true, isLogo: true }));
    if (model.barra) ops.push(op(model.barra, { align: 'center', bold: true }));
    // El evento sólo si lo hay: en el montaje de prueba está vacío y una línea
    // en blanco en la cabecera parece un fallo de impresión.
    if (model.evento) {
      wrap(model.evento, w).forEach(l => ops.push(op(l, { align: 'center' })));
    }
    ops.push(op(rule(w)));
    ops.push(op(''));
    ops.push(op('COMANDA ' + (model.ref || model.id),
      { align: 'center', bold: true, tall: true, wide: true }));
    ops.push(op(subtitulo, { align: 'center' }));

    // Un ticket reimpreso que sale idéntico al original vale para cobrar la
    // misma venta otra vez. Va en grande y encima de los precios: quien lo
    // recibe tiene que verlo sin buscarlo, aunque lea el papel de lejos.
    if (model.reimpresion) {
      ops.push(op(''));
      ops.push(op('*** REIMPRESION ***',
        { align: 'center', bold: true, tall: true }));
      ops.push(op('copia ' + (model.numeroCopia || 2) + ' - no es un cobro nuevo',
        { align: 'center' }));
    }

    ops.push(op(''));

    return ops;
  }

  function buildFooterOps(model, settings, cierre) {
    const w = settings.width;
    const ops = [];

    ops.push(op(''));
    ops.push(op(rule(w)));
    cierre.forEach(linea => ops.push(op(linea.text, { align: 'center', bold: !!linea.bold })));
    ops.push(op(rule(w)));

    return ops;
  }

  /** Ticket de cobro (copia del cajero). */
  /**
   * Cuántas líneas y cuántas unidades lleva el pedido.
   *
   * Cuenta también lo que va dentro de los paquetes: el pie del ticket dice
   * cuántas cosas hay que servir, y las bebidas de un combo se sirven igual
   * que las sueltas. Dejarlas fuera haría que un ticket de dos combos dijera
   * "0 productos".
   */
  function contarPedido(model) {
    let lineas = (model.items || []).length;
    let unidades = (model.items || []).reduce((n, i) => n + Number(i.cantidad || 0), 0);
    (model.promociones || []).forEach(pr => {
      (pr.contenido || []).forEach(c => {
        lineas += 1;
        unidades += Number(c.cantidad || 0);
      });
    });
    return { lineas, unidades };
  }

  function buildCajeroOps(model, settings) {
    const w = settings.width;
    const ops = buildHeaderOps(model, settings, 'COPIA CAJERO');

    // Fecha y hora en la misma línea, cada una en su punta: son dos datos
    // cortos y gastar dos renglones en ellos alarga el ticket sin motivo.
    if (model.fechaDia && model.hora) {
      ops.push(op(padPair(model.fechaDia, model.hora, w)));
    } else {
      kv('Fecha', model.fecha, w).forEach(l => ops.push(op(l)));
    }
    kv('Cajero', model.cajero, w).forEach(l => ops.push(op(l)));
    kv('Mesero', model.mesero, w).forEach(l => ops.push(op(l)));

    ops.push(op(''));
    ops.push(op(sectionTitle('DETALLE', w), { bold: true }));

    // Los paquetes primero y como una sola cosa: su nombre, su precio cerrado
    // y debajo lo que lleva dentro, sin importes. El precio del paquete se
    // reparte entre sus productos para que cuadre el cierre, pero eso es
    // contabilidad interna: en el papel, un combo de 60 vale 60.
    (model.promociones || []).forEach(pr => {
      wrap(pr.nombre, w).forEach(l => ops.push(op(l, { bold: true })));
      ops.push(op(padPair(
        '   ' + pr.cantidad + ' x ' + money(pr.precio_unitario),
        money(pr.subtotal), w)));

      (pr.contenido || []).forEach(c => {
        const cabeza = '   └ ' + c.cantidad + ' ';
        wrap(c.nombre, w - cabeza.length).forEach((l, i) => ops.push(op(
          i === 0 ? cabeza + l : ' '.repeat(cabeza.length) + l)));
      });
    });

    // Dos líneas por producto: el nombre entero arriba y debajo, sangrado,
    // "cantidad x precio ....... importe". Así el nombre nunca compite por el
    // sitio con las cifras y se ve el precio unitario.
    model.items.forEach(item => {
      wrap(item.nombre, w).forEach(l => ops.push(op(l)));
      const unitario = item.precio_unitario != null
        ? money(item.precio_unitario)
        : money(Number(item.subtotal || 0) / Math.max(1, Number(item.cantidad || 1)));
      ops.push(op(padPair('   ' + item.cantidad + ' x ' + unitario, money(item.subtotal), w)));

      // El acompañante, sangrado bajo su botella y SIN importe. Sin precio a la
      // derecha no hay forma de leerlo como un cargo: se entiende que va
      // dentro. Con un 0.00 al lado, el cliente pregunta qué es ese cero.
      // Los acompañantes cuelgan como ramas de la línea de arriba: la esquina
      // dice que van DENTRO de esa botella, no que son otros productos.
      //
      // La sangría se pone a mano porque wrapIndent sólo sangra las líneas de
      // continuación, y aquí lo que tiene que verse metido es justo la primera.
      (item.acompanantes || []).forEach(a => {
        const cabeza = '   └ ' + a.cantidad + ' ';
        // 9 = "incluido" (8) + el espacio que lo separa. Con 10 se partía
        // "Coca-Cola 500 ml" por un solo carácter.
        const trozos = wrap(a.nombre, w - cabeza.length - 9);
        trozos.forEach((l, i) => {
          if (i === trozos.length - 1) {
            // "incluido" a la derecha, en la misma línea: gasta un renglón
            // menos y se lee de un golpe con el nombre.
            ops.push(op(padPair((i === 0 ? cabeza : ' '.repeat(cabeza.length)) + l, 'incluido', w)));
          } else {
            ops.push(op((i === 0 ? cabeza : ' '.repeat(cabeza.length)) + l));
          }
        });
      });
    });

    ops.push(op(divider(w)));

    const cuenta = contarPedido(model);
    ops.push(op(padPair(
      cuenta.lineas + (cuenta.lineas === 1 ? ' producto' : ' productos'),
      cuenta.unidades + (cuenta.unidades === 1 ? ' unidad' : ' unidades'), w)));

    // El total, centrado y a doble tamaño en su propio bloque. Es la cifra que
    // el cliente comprueba antes de pagar y la que se discute si algo no
    // cuadra: tiene que verse antes que ninguna otra cosa del ticket.
    ops.push(op(''));
    ops.push(op(rule(w)));
    ops.push(op('TOTAL A PAGAR', { align: 'center' }));
    ops.push(op(money(model.total) + ' Bs.',
      { align: 'center', bold: true, tall: true, wide: true }));
    ops.push(op(rule(w)));
    ops.push(op(''));

    ops.push(op(sectionTitle('PAGOS', w), { bold: true }));
    model.pagos.forEach(pago => {
      twoCol(pago.etiqueta, money(pago.monto), w, 2).forEach(l => ops.push(op(l)));
    });

    // El vuelto sólo aparece cuando lo hay: en una comanda pagada justa o con
    // QR, una línea de "CAMBIO 0.00" sólo añade ruido al ticket.
    // 'recibido' es el efectivo que entregó el cliente, que puede ser mayor que
    // lo cobrado; si no viene, se asume que pagó justo.
    const cobrado = round2(model.pagos.reduce((s, p) => s + Number(p.monto || 0), 0));
    const pagado = Number(model.recibido) > cobrado ? round2(model.recibido) : cobrado;
    const cambio = round2(pagado - Number(model.total || 0));
    if (model.pagos.length > 1 || cambio > 0) {
      ops.push(op(divider(w)));
      ops.push(op(padPair('  Recibido', money(pagado), w)));
    }
    if (cambio > 0) {
      ops.push(op(padPair('  CAMBIO', money(cambio) + ' Bs.', w), { bold: true, tall: true }));
    }

    // Las observaciones también en la copia del cajero: si el cliente reclama
    // que pidió algo sin hielo, el papel que tiene él en la mano es este.
    const nota = notaDe(model);
    if (nota) {
      ops.push(op(''));
      ops.push(op(sectionTitle('NOTA', w), { bold: true }));
      wrap(nota, w - 2).forEach(l => ops.push(op('  ' + l)));
    }

    return ops.concat(buildFooterOps(model, settings, [
      { text: 'GRACIAS POR SU COMPRA', bold: true },
      { text: 'Disfrute del evento' }
    ]));
  }

  /** Ticket de preparación (copia del mesero, sin precios). */
  function buildMeseroOps(model, settings) {
    const w = settings.width;
    const ops = buildHeaderOps(model, settings, 'BARRA');

    // Aquí no interesa la fecha entera ni quién cobró: sólo a qué hora entró la
    // comanda, para saber cuál lleva más rato esperando.
    ops.push(op(padPair('Mesero  ' + model.mesero, model.hora || '', w)));

    ops.push(op(''));
    ops.push(op(sectionTitle('PREPARAR', w), { bold: true }));
    ops.push(op(''));

    // Los paquetes, con su nombre encima y sus bebidas debajo, cada una con su
    // casilla. El bartender no sirve "un combo": sirve un whisky y dos
    // cervezas, y necesita poder tacharlas de una en una. El nombre va arriba
    // para que sepa por qué van juntas y no las reparta en dos bandejas.
    (model.promociones || []).forEach((pr, i) => {
      if (i > 0) ops.push(op(''));
      wrapIndent(pr.cantidad + ' x ' + pr.nombre, w, 4)
        .forEach(l => ops.push(op(l, { bold: true, tall: true })));
      (pr.contenido || []).forEach(c => {
        const cabeza = '    [ ] ' + c.cantidad + ' ';
        wrap(c.nombre, w - cabeza.length)
          .forEach((l, j) => ops.push(op(
            j === 0 ? cabeza + l : ' '.repeat(cabeza.length) + l, { bold: true })));
      });
    });

    // Cada producto, grande y con su casilla, separado del siguiente por una
    // línea en blanco. El hueco no es decorativo: es lo que permite tachar con
    // bolígrafo sin comerse el renglón de abajo, y lo que evita leer dos
    // productos como uno solo cuando la barra está a media luz.
    model.items.forEach((item, i) => {
      if ((model.promociones || []).length > 0 && i === 0) ops.push(op(''));
      if (i > 0) ops.push(op(''));
      wrapIndent('[ ] ' + item.cantidad + ' x ' + item.nombre, w, 4)
        .forEach(l => ops.push(op(l, { bold: true, tall: true })));

      // En la barra los acompañantes hay que servirlos igual, así que cada uno
      // lleva su casilla: si no, se prepara la botella y el refresco se olvida.
      (item.acompanantes || []).forEach(a => {
        const cabeza = '    [ ] ' + a.cantidad + ' ';
        wrap(a.nombre, w - cabeza.length)
          .forEach((l, i) => ops.push(op(
            i === 0 ? cabeza + l : ' '.repeat(cabeza.length) + l, { bold: true })));
      });
    });

    ops.push(op(''));
    ops.push(op(divider(w)));
    const cuenta = contarPedido(model);
    ops.push(op(padPair(
      cuenta.lineas + (cuenta.lineas === 1 ? ' producto' : ' productos'),
      cuenta.unidades + (cuenta.unidades === 1 ? ' unidad' : ' unidades'), w)));

    // Las observaciones sólo salen si las hay, y entonces en grande: son la
    // causa más común de que un pedido vuelva a la barra.
    const nota = notaDe(model);
    if (nota) {
      ops.push(op(''));
      ops.push(op(sectionTitle('OJO', w), { bold: true }));
      wrap(nota, w).forEach(l => ops.push(op(l, { bold: true, tall: true })));
    }

    return ops.concat(buildFooterOps(model, settings, [
      { text: 'No es comprobante de pago' }
    ]));
  }

  // ---------------------------------------------------------------------
  // Salida 1: ESC/POS
  // ---------------------------------------------------------------------
  const ESC = 0x1B, GS = 0x1D, LF = 0x0A;

  function opsToEscPos(ops, settings) {
    const bytes = [];
    const push = (...b) => { for (const x of b) bytes.push(x); };

    push(ESC, 0x40);                                   // ESC @  — reiniciar impresora
    if (settings.encoding === 'cp850') push(ESC, 0x74, 0x02); // ESC t 2 — página de códigos CP850

    let align = 'left', bold = false, size = 0x00;

    ops.forEach(o => {
      if (o.isLogo && logoRasterEscPos) {
        push(ESC, 0x61, 1); // Centrado
        push(...logoRasterEscPos.header);
        push(...logoRasterEscPos.data);
        push(LF);
        return;
      }
      if (o.align !== align) {
        push(ESC, 0x61, o.align === 'center' ? 1 : 0); // ESC a n
        align = o.align;
      }
      if (o.bold !== bold) {
        push(ESC, 0x45, o.bold ? 1 : 0);               // ESC E n
        bold = o.bold;
      }
      // GS ! n — n = ((ancho-1) << 4) | (alto-1). El doble ancho gasta dos
      // columnas por carácter, por eso sólo lo llevan los titulares cortos.
      const wanted = (o.wide ? 0x10 : 0x00) | (o.tall ? 0x01 : 0x00);
      if (wanted !== size) {
        push(GS, 0x21, wanted);
        size = wanted;
      }
      push(...encodeText(o.text, settings.encoding));
      push(LF);
    });

    // Volver a valores neutros para no dejar la impresora en negrita.
    push(ESC, 0x61, 0, ESC, 0x45, 0, GS, 0x21, 0x00);
    push(ESC, 0x64, Math.max(0, settings.feed | 0));   // ESC d n — avanzar papel
    if (settings.cut) push(GS, 0x56, 0x42, 0x00);      // GS V B 0 — corte parcial

    return Uint8Array.from(bytes);
  }

  // ---------------------------------------------------------------------
  // Salida 2: texto plano (vista previa)
  // ---------------------------------------------------------------------
  function opsToText(ops, settings) {
    const w = settings.width;
    return ops.map(o => {
      const text = foldForDisplay(o.text, settings.encoding);
      // Un carácter a doble ancho ocupa dos columnas del papel: se cuenta así
      // para centrarlo donde la impresora lo va a poner de verdad.
      const columnas = o.wide ? text.length * 2 : text.length;
      // Una línea vacía se queda vacía. Centrarla rellenaba media línea de
      // espacios, que en el navegador se seleccionan y en el respaldo de texto
      // dejan basura invisible al final de cada bloque.
      if (!text) return '';
      return o.align === 'center' && columnas < w
        ? ' '.repeat(Math.floor((w - columnas) / 2)) + text
        : text;
    }).join('\n');
  }

  // ---------------------------------------------------------------------
  // Salida 3: HTML (respaldo por el diálogo del navegador)
  // ---------------------------------------------------------------------
  function opsToHtml(ops, settings) {
    const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    return ops.map(o => {
      if (o.isLogo) {
        return `<div class="thermal-logo-box" style="text-align:center; padding: 4px 0;"><img src="logo_euphoria.png" alt="Euphoria" style="max-width: 140px; max-height: 40px; object-fit: contain; margin: 0 auto; display: block; filter: grayscale(1) contrast(1.3);"></div>`;
      }
      // Alto y ancho se estiran por separado, nunca con font-size.
      //
      // La impresora dobla SÓLO la dimensión que se le pide: 'tall' es doble
      // alto con el mismo ancho de carácter, y 'wide' al revés. Con font-size
      // crecían las dos a la vez, así que una línea de doble alto ocupaba
      // también un 50 % más de ancho: los dos tickets salían de anchos
      // distintos y la cabecera a doble ancho se desbordaba del papel.
      const escalaX = o.wide ? 2 : 1;
      const escalaY = o.tall ? 2 : 1;

      const style = [
        o.align === 'center' ? 'text-align:center' : 'text-align:left',
        o.bold ? 'font-weight:bold' : '',
        // El renglón necesita sitio para el texto estirado; si no, las líneas
        // de doble alto se pisan entre ellas.
        o.tall ? 'line-height:2.1' : ''
      ].filter(Boolean).join(';');

      const text = escapeHtml(foldForDisplay(o.text, settings.encoding)) || '&nbsp;';
      const cuerpo = (escalaX > 1 || escalaY > 1)
        ? `<span style="display:inline-block;transform:scale(${escalaX},${escalaY});` +
          `transform-origin:center">${text}</span>`
        : text;
      return `<div style="${style}">${cuerpo}</div>`;
    }).join('');
  }

  // ---------------------------------------------------------------------
  // Envío a RawBT
  // ---------------------------------------------------------------------
  function bytesToBase64(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function openExternal(url) {
    // Para esquemas rawbt:, un iframe oculto permite enviar la comanda al
    // servicio de RawBT en segundo plano sin sacar al navegador del modo pantalla completa.
    if (url.startsWith('rawbt:')) {
      try {
        let iframe = document.getElementById('rawbt-hidden-frame');
        if (!iframe) {
          iframe = document.createElement('iframe');
          iframe.id = 'rawbt-hidden-frame';
          iframe.style.display = 'none';
          document.body.appendChild(iframe);
        }
        iframe.src = url;
        return;
      } catch (e) {
        // Fallback a enlace si el iframe es bloqueado
      }
    }

    // Un <a> temporal en vez de location.href: al abrir una app externa el
    // navegador no intenta descargar ni recargar la página actual.
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 500);
  }

  function sendBytes(bytes, settings) {
    const b64 = bytesToBase64(bytes);
    const url = settings.mode === 'intent'
      ? 'intent:base64,' + b64 + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;'
      : 'rawbt:base64,' + b64;
    openExternal(url);
  }

  // ---------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------

  /** Devuelve los dos tickets como listas de ops, listos para renderizar. */
  /**
   * Comanda de traspaso, para el bartender que entrega la mercancía.
   *
   * No es un ticket de venta: no lleva precios ni total, porque aquí no se
   * cobra nada. Lo que tiene que quedar clarísimo es A DÓNDE va y QUÉ se
   * entrega, con casillas para ir tachando mientras se carga la caja, y un
   * hueco de firma: la mercancía cambia de manos y alguien la recibe.
   */
  function buildTraspasoOps(model, settings) {
    settings = settings || getSettings();
    const w = settings.width;
    const ops = [];

    const saliendo = model.tipo !== 'ENTRADA';

    ops.push(op(rule(w)));
    ops.push(op(saliendo ? 'TRASPASO' : 'INGRESO',
      { align: 'center', bold: true, tall: true, wide: true }));
    if (model.barra) ops.push(op(model.barra, { align: 'center', bold: true }));
    ops.push(op(rule(w)));
    ops.push(op(''));

    // El número, grande: es lo que se canta por radio y lo que se apunta en la
    // otra barra al recibir.
    ops.push(op('N.' + model.id, { align: 'center', bold: true, tall: true, wide: true }));
    ops.push(op(''));

    // A dónde va, en grande. Es el dato que evita que la caja acabe en la barra
    // equivocada, que es el error caro de esto.
    ops.push(op(saliendo ? 'DESTINO' : (model.motivo === 'COMPRA' ? 'PROVEEDOR' : 'ORIGEN'),
      { align: 'center' }));
    wrap(model.contraparte || '-', w).forEach(l =>
      ops.push(op(l, { align: 'center', bold: true, tall: true })));
    ops.push(op(''));

    ops.push(op(padPair(model.fecha || '', model.hora || '', w)));
    if (model.responsable) kv('Entrega', model.responsable, w).forEach(l => ops.push(op(l)));

    ops.push(op(''));
    ops.push(op(sectionTitle(saliendo ? 'ENTREGAR' : 'RECIBIDO', w), { bold: true }));
    ops.push(op(''));

    (model.items || []).forEach((item, i) => {
      if (i > 0) ops.push(op(''));
      wrapIndent('[ ] ' + item.cantidad + ' x ' + item.nombre, w, 4)
        .forEach(l => ops.push(op(l, { bold: true, tall: true })));
    });

    ops.push(op(''));
    ops.push(op(divider(w)));
    const unidades = (model.items || []).reduce((n, i) => n + Number(i.cantidad || 0), 0);
    ops.push(op(padPair(
      (model.items || []).length + ((model.items || []).length === 1 ? ' producto' : ' productos'),
      unidades + (unidades === 1 ? ' unidad' : ' unidades'), w)));

    if (model.observaciones) {
      ops.push(op(''));
      ops.push(op(sectionTitle('NOTA', w), { bold: true }));
      wrap(model.observaciones, w).forEach(l => ops.push(op(l)));
    }

    // Hueco de firma: la mercancía cambia de manos, y sin una firma no hay a
    // quién preguntarle si al día siguiente falta media caja.
    ops.push(op(''));
    ops.push(op(''));
    ops.push(op(divider(w)));
    ops.push(op(saliendo ? 'Recibe:' : 'Entrega:'));
    ops.push(op(''));
    ops.push(op(''));
    ops.push(op(divider(w)));
    ops.push(op('No es comprobante de pago', { align: 'center' }));
    ops.push(op(rule(w)));

    return ops;
  }

  function buildTickets(model, settings) {
    settings = settings || getSettings();
    return {
      cajero: buildCajeroOps(model, settings),
      mesero: buildMeseroOps(model, settings)
    };
  }

  /** Texto plano de un ticket, tal como saldrá impreso. */
  function renderText(ops, settings) {
    return opsToText(ops, settings || getSettings());
  }

  /**
   * Manda los dos tickets a RawBT.
   * Con singleJob ambos viajan en un solo trabajo (más fiable: una sola vez
   * que Android tiene que cambiar de app). Si no, se envían separados.
   */
  function printToRawBT(model, settings) {
    settings = settings || getSettings();
    const tickets = buildTickets(model, settings);
    const cajero = opsToEscPos(tickets.cajero, settings);
    const mesero = opsToEscPos(tickets.mesero, settings);

    if (settings.singleJob) {
      const both = new Uint8Array(cajero.length + mesero.length);
      both.set(cajero, 0);
      both.set(mesero, cajero.length);
      sendBytes(both, settings);
    } else {
      sendBytes(cajero, settings);
      // RawBT necesita un respiro entre dos intents seguidos o descarta el segundo.
      setTimeout(() => sendBytes(mesero, settings), 1500);
    }
  }

  /** Manda a la impresora una lista de ops ya armada (traspasos, informes). */
  function printOps(ops, settings) {
    settings = settings || getSettings();
    sendBytes(opsToEscPos(ops, settings), settings);
  }

  /**
   * Respaldo cuando RawBT no está disponible: abre el diálogo de impresión del
   * navegador con el mismo maquetado, en ancho de papel térmico.
   */
  function printViaBrowser(model, settings) {
    settings = settings || getSettings();
    const tickets = buildTickets(model, settings);
    const mm = settings.width >= 48 ? '72mm' : '48mm';

    const win = window.open('', '_blank');
    if (!win) {
      alert('El navegador bloqueó la ventana de impresión. Permite las ventanas emergentes.');
      return;
    }

    win.document.write(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Comanda #' + model.id + '</title><style>' +
      '@page { size: auto; margin: 0; }' +
      'body { margin: 0; padding: 4mm; background: #fff; color: #000;' +
      ' font-family: "Courier New", monospace; font-size: 12px; line-height: 1.25; width: ' + mm + '; }' +
      '.ticket { page-break-after: always; }' +
      '.ticket:last-child { page-break-after: auto; }' +
      '</style></head><body>' +
      '<div class="ticket">' + opsToHtml(tickets.cajero, settings) + '</div>' +
      '<div class="ticket">' + opsToHtml(tickets.mesero, settings) + '</div>' +
      '<script>window.onload=function(){window.print();setTimeout(function(){window.close();},300);};<\/script>' +
      '</body></html>'
    );
    win.document.close();
  }

  return {
    getSettings: getSettings,
    saveSettings: saveSettings,
    buildTickets: buildTickets,
    buildTraspasoOps: buildTraspasoOps,
    printOps: printOps,
    renderText: renderText,
    printToRawBT: printToRawBT,
    printViaBrowser: printViaBrowser,
    // Expuesto para el reporte de inventario, que usa el mismo maquetado.
    helpers: {
      wrap: wrap,
      wrapIndent: wrapIndent,
      twoCol: twoCol,
      divider: divider,
      rule: rule,
      kv: kv,
      sectionTitle: sectionTitle,
      op: op,
      opsToEscPos: opsToEscPos,
      opsToHtml: opsToHtml,
      sendBytes: sendBytes
    }
  };
})();
