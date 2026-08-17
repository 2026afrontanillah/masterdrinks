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

  const DEFAULTS = {
    width: 32,          // 32 columnas = papel 58 mm · 48 columnas = papel 80 mm
    encoding: 'cp850',  // 'cp850' (con acentos) | 'ascii' (sin acentos)
    mode: 'rawbt',      // 'rawbt' (rawbt:base64,…) | 'intent' (intent://…)
    singleJob: true,    // los dos tickets en un solo trabajo de impresión
    cut: true,          // enviar corte de papel al final de cada ticket
    feed: 3,            // líneas en blanco antes del corte
    autoPrint: false    // imprimir solo, sin pulsar el botón, al cerrar la venta
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
    '±': 241, '¾': 243, '¶': 244, '§': 245, '÷': 246, '°': 248, '¨': 249, '·': 250
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
    '–': '-', '—': '-', '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...'
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

  const divider = width => '-'.repeat(width);
  // Separador fuerte: marca el principio y el final de un bloque, mientras que
  // el de guiones separa filas dentro del mismo bloque. Con dos grosores el
  // ticket se lee de un vistazo aunque esté impreso en papel barato.
  const rule = width => '='.repeat(width);

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
    return t.length >= width ? t : t + '-'.repeat(width - t.length);
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
  const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  /**
   * Cabecera común: marca, barra y número de comanda a doble tamaño.
   * El número es lo que se canta en la barra y lo que se busca al reimprimir,
   * así que va lo más grande que permite el papel.
   */
  function buildHeaderOps(model, settings, subtitulo) {
    const w = settings.width;
    const ops = [];

    ops.push(op(rule(w)));
    ops.push(op('MASTERDRINKS', { align: 'center', bold: true, tall: true, wide: true }));
    ops.push(op(model.barra, { align: 'center' }));
    ops.push(op(rule(w)));
    // La referencia lleva el prefijo de la barra (N-47): con tres servidores
    // independientes, el número solo no distingue una comanda de otra.
    ops.push(op('COMANDA ' + (model.ref || '#' + model.id),
      { align: 'center', bold: true, tall: true, wide: true }));
    ops.push(op(subtitulo, { align: 'center', bold: true }));
    ops.push(op(divider(w)));

    return ops;
  }

  function buildFooterOps(model, settings, cierre) {
    const w = settings.width;
    const ops = [];

    ops.push(op(divider(w)));
    cierre.forEach(linea => ops.push(op(linea.text, { align: 'center', bold: !!linea.bold })));
    ops.push(op(rule(w)));

    return ops;
  }

  /** Ticket de cobro (copia del cajero). */
  function buildCajeroOps(model, settings) {
    const w = settings.width;
    const ops = buildHeaderOps(model, settings, 'COPIA CAJERO');

    kv('Fecha', model.fecha, w).forEach(l => ops.push(op(l)));
    kv('Cajero', model.cajero, w).forEach(l => ops.push(op(l)));
    kv('Mesero', model.mesero, w).forEach(l => ops.push(op(l)));

    ops.push(op(sectionTitle('DETALLE', w), { bold: true }));

    // Dos líneas por producto: el nombre entero arriba y debajo, sangrado,
    // "cantidad x precio ....... importe". Así el nombre nunca compite por el
    // sitio con las cifras y se ve el precio unitario, que antes no salía.
    model.items.forEach(item => {
      wrap(item.nombre, w).forEach(l => ops.push(op(l)));
      const unitario = item.precio_unitario != null
        ? money(item.precio_unitario)
        : money(Number(item.subtotal || 0) / Math.max(1, Number(item.cantidad || 1)));
      ops.push(op(padPair('  ' + item.cantidad + ' x ' + unitario, money(item.subtotal), w)));
    });

    ops.push(op(divider(w)));

    const unidades = model.items.reduce((n, i) => n + Number(i.cantidad || 0), 0);
    ops.push(op(padPair(model.items.length + ' productos', unidades + ' unidades', w)));
    ops.push(op(rule(w)));

    twoCol('TOTAL', money(model.total) + ' Bs.', w)
      .forEach(l => ops.push(op(l, { bold: true, tall: true })));
    ops.push(op(rule(w)));

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
      ops.push(op(padPair('  CAMBIO', money(cambio) + ' Bs.', w), { bold: true }));
    }

    return ops.concat(buildFooterOps(model, settings, [
      { text: '¡GRACIAS POR SU COMPRA!', bold: true },
      { text: 'Disfrute del evento musical' },
      { text: '' },
      { text: 'MasterDrinks POS' }
    ]));
  }

  /** Ticket de preparación (copia del mesero, sin precios). */
  function buildMeseroOps(model, settings) {
    const w = settings.width;
    const ops = buildHeaderOps(model, settings, 'PREPARACION');

    kv('Mesero', model.mesero, w).forEach(l => ops.push(op(l)));
    // En la barra sólo importa a qué hora entró la comanda, no la fecha entera.
    kv('Hora', model.hora || model.fecha, w).forEach(l => ops.push(op(l)));

    ops.push(op(sectionTitle('PREPARAR', w), { bold: true }));

    // Grande y en negrita: es lo que lee la barra a contraluz y con prisa.
    // La casilla [ ] permite ir tachando lo ya servido.
    model.items.forEach(item => {
      wrapIndent('[ ] ' + item.cantidad + ' x ' + item.nombre, w, 4)
        .forEach(l => ops.push(op(l, { bold: true, tall: true })));
    });

    ops.push(op(divider(w)));
    const unidades = model.items.reduce((n, i) => n + Number(i.cantidad || 0), 0);
    ops.push(op(padPair(model.items.length + ' productos', unidades + ' unidades', w)));

    // Recuadro de observaciones, equivalente al borde que se ve en pantalla.
    const inner = w - 2;
    ops.push(op(sectionTitle('OBSERVACIONES', w), { bold: true }));
    ops.push(op('+' + '-'.repeat(inner) + '+'));
    wrap(model.observaciones || 'Sin observaciones', inner - 2)
      .forEach(l => ops.push(op('|' + (' ' + l).padEnd(inner) + '|')));
    ops.push(op('+' + '-'.repeat(inner) + '+'));

    return ops.concat(buildFooterOps(model, settings, [
      { text: 'TICKET DE PREPARACION', bold: true },
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
      const style = [
        o.align === 'center' ? 'text-align:center' : 'text-align:left',
        o.bold ? 'font-weight:bold' : '',
        o.tall ? 'font-size:1.5em;line-height:1.15' : ''
      ].filter(Boolean).join(';');
      const text = escapeHtml(foldForDisplay(o.text, settings.encoding)) || '&nbsp;';
      // El doble ancho se reproduce estirando el texto, no agrandándolo: así la
      // vista previa ocupa las mismas columnas de papel que la impresión real.
      const cuerpo = o.wide
        ? `<span style="display:inline-block;transform:scaleX(2);transform-origin:center">${text}</span>`
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
    // Un <a> temporal en vez de location.href: al abrir una app externa el
    // navegador no intenta descargar ni descargar la página actual.
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
