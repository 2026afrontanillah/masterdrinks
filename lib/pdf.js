/* ==========================================================================
 * MasterDrinks — Generador de PDF sin dependencias
 * ==========================================================================
 *
 * Escribe PDF 1.4 a mano. Se hizo así a propósito: el servidor corre en una
 * tablet con Termux y sin internet durante el evento, así que no puede
 * depender de que una librería esté instalada ni de descargar fuentes. Aquí
 * sólo se usan las catorce fuentes que TODO lector de PDF trae de serie
 * (Helvetica y Courier), de modo que el archivo pesa unos pocos KB y se abre
 * igual en el móvil, en WhatsApp o en cualquier ordenador.
 *
 * Sobre las medidas de texto: Courier es de ancho fijo (600/1000 de em por
 * carácter), así que centrar, alinear a la derecha y recortar es exacto sin
 * tablas de métricas. Por eso todo lo que hay que medir —cifras, tablas,
 * títulos centrados— va en Courier, y Helvetica se reserva para los textos
 * alineados a la izquierda, donde el ancho no hace falta.
 * ========================================================================== */

'use strict';

// --------------------------------------------------------------------------
// Codificación de texto
// --------------------------------------------------------------------------
// Los PDF con fuentes base usan WinAnsiEncoding, que es CP1252. Coincide con
// latin1 salvo en el tramo 0x80-0x9F (comillas tipográficas, guiones largos,
// euro), que se traduce aparte. Lo que no exista se convierte en '?' antes de
// llegar al archivo: mejor un signo raro que un PDF que no abre.
const CP1252_EXTRA = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f
};

function aWinAnsi(texto) {
  const bytes = [];
  for (const ch of String(texto)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a || cp === 0x0d) { bytes.push(0x20); continue; }
    if (cp < 0x80) { bytes.push(cp); continue; }
    if (CP1252_EXTRA[ch] !== undefined) { bytes.push(CP1252_EXTRA[ch]); continue; }
    if (cp <= 0xff) { bytes.push(cp); continue; }
    bytes.push(0x3f); // '?'
  }
  return bytes;
}

// Dentro de una cadena PDF hay que escapar el paréntesis y la barra invertida.
function cadenaPdf(texto) {
  const salida = [0x28]; // (
  for (const b of aWinAnsi(texto)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) salida.push(0x5c);
    salida.push(b);
  }
  salida.push(0x29); // )
  return Buffer.from(salida).toString('latin1');
}

// --------------------------------------------------------------------------
// Fuentes disponibles y medidas
// --------------------------------------------------------------------------
const FUENTES = {
  normal: { recurso: 'F1', base: 'Helvetica', monoespaciada: false },
  negrita: { recurso: 'F2', base: 'Helvetica-Bold', monoespaciada: false },
  mono: { recurso: 'F3', base: 'Courier', monoespaciada: true },
  monoNegrita: { recurso: 'F4', base: 'Courier-Bold', monoespaciada: true }
};

// Ancho exacto en Courier (0.6 em por carácter, es monoespaciada). En Helvetica
// es una estimación que sólo se usa para recortar textos largos, nunca para
// alinear cifras. El 0.6 va deliberadamente por encima del ancho medio real
// (~0.52) porque en mayúsculas Helvetica es bastante más ancha: si la
// estimación se queda corta, el texto se sale de su columna, y pasarse sólo
// recorta un poco antes de lo necesario.
const anchoTexto = (texto, tamano, fuente) =>
  String(texto).length * tamano * (FUENTES[fuente].monoespaciada ? 0.6 : 0.6);

// Recorta con puntos suspensivos para que una celda nunca se salga de su columna.
function recortar(texto, anchoMax, tamano, fuente) {
  let t = String(texto);
  if (anchoTexto(t, tamano, fuente) <= anchoMax) return t;
  while (t.length > 1 && anchoTexto(t + '...', tamano, fuente) > anchoMax) {
    t = t.slice(0, -1);
  }
  return t + '...';
}

const num2 = n => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);

// --------------------------------------------------------------------------
// Paleta
// --------------------------------------------------------------------------
const COLOR = {
  tinta: [0.10, 0.11, 0.16],
  suave: [0.45, 0.48, 0.55],
  linea: [0.85, 0.86, 0.89],
  marca: [0.55, 0.30, 0.85],
  acento: [0.92, 0.28, 0.60],
  ok: [0.06, 0.60, 0.45],
  alerta: [0.86, 0.20, 0.20],
  aviso: [0.85, 0.55, 0.05],
  cebra: [0.97, 0.97, 0.98],
  blanco: [1, 1, 1]
};

// --------------------------------------------------------------------------
// Documento
// --------------------------------------------------------------------------
class Documento {
  /**
   * @param {object} opciones
   *   titulo    Título del documento (metadatos del PDF)
   *   pie       Texto que acompaña al número de página
   */
  constructor(opciones = {}) {
    this.ancho = 595;          // A4 en puntos
    this.alto = 842;
    this.margen = 40;
    this.titulo = opciones.titulo || 'Reporte';
    this.pie = opciones.pie || '';
    this.paginas = [];
    this.nuevaPagina();
  }

  get anchoUtil() { return this.ancho - this.margen * 2; }

  nuevaPagina() {
    this.pagina = { ops: [] };
    this.paginas.push(this.pagina);
    this.y = this.alto - this.margen;
    return this.pagina;
  }

  // Salta de página si lo que viene no cabe. Todo lo que dibuja llama aquí
  // antes, así que ninguna sección se corta por la mitad sin querer.
  asegurar(altura) {
    if (this.y - altura < this.margen + 28) this.nuevaPagina();
  }

  op(linea) { this.pagina.ops.push(linea); }

  color(c, relleno = true) {
    this.op(c.map(v => v.toFixed(3)).join(' ') + (relleno ? ' rg' : ' RG'));
  }

  rect(x, y, ancho, alto, c) {
    this.color(c);
    this.op(`${x.toFixed(2)} ${y.toFixed(2)} ${ancho.toFixed(2)} ${alto.toFixed(2)} re f`);
  }

  linea(x1, y1, x2, y2, c, grosor = 0.6) {
    this.color(c, false);
    this.op(`${grosor} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  /**
   * Escribe una línea de texto.
   *   x       borde izquierdo (o derecho / centro según align)
   *   align   'left' | 'right' | 'center'
   */
  texto(txt, x, y, opciones = {}) {
    const tamano = opciones.tamano || 10;
    const fuente = opciones.fuente || 'normal';
    const c = opciones.color || COLOR.tinta;
    const align = opciones.align || 'left';

    let px = x;
    if (align !== 'left') {
      const w = anchoTexto(txt, tamano, fuente);
      px = align === 'right' ? x - w : x - w / 2;
    }

    this.color(c);
    this.op(`BT /${FUENTES[fuente].recurso} ${tamano} Tf ` +
            `1 0 0 1 ${px.toFixed(2)} ${y.toFixed(2)} Tm ${cadenaPdf(txt)} Tj ET`);
  }

  // ---- Bloques de alto nivel ------------------------------------------

  /** Banda superior con la marca y el subtítulo. Sólo en la primera página. */
  cabecera(marca, subtitulo, detalle) {
    const alto = 76;
    const y = this.alto - alto;
    this.rect(0, y, this.ancho, alto, COLOR.marca);
    this.rect(0, y, this.ancho, 4, COLOR.acento);

    this.texto(marca, this.margen, y + 44, { tamano: 22, fuente: 'monoNegrita', color: COLOR.blanco });
    this.texto(subtitulo, this.margen, y + 26, { tamano: 11, fuente: 'normal', color: COLOR.blanco });
    if (detalle) {
      this.texto(detalle, this.ancho - this.margen, y + 26,
        { tamano: 8.5, fuente: 'mono', color: COLOR.blanco, align: 'right' });
    }
    this.y = y - 26;
  }

  /** Título de sección subrayado. Se llama 'seccion' y no 'titulo' porque
   *  this.titulo es el título del documento y taparía al método. */
  seccion(txt) {
    this.asegurar(34);
    this.texto(txt, this.margen, this.y, { tamano: 12, fuente: 'negrita', color: COLOR.marca });
    this.y -= 6;
    this.linea(this.margen, this.y, this.ancho - this.margen, this.y, COLOR.marca, 1);
    this.y -= 16;
  }

  /**
   * Párrafo con salto de línea automático. Sin esto, cualquier texto más largo
   * que el ancho del papel se salía por el borde derecho y se perdía: el PDF
   * no recorta ni parte nada por su cuenta.
   */
  parrafo(txt, opciones = {}) {
    const tamano = opciones.tamano || 9.5;
    const fuente = opciones.fuente || 'normal';
    const estilo = Object.assign({ tamano, fuente, color: COLOR.suave }, opciones);

    for (const linea of this.partir(String(txt), this.anchoUtil, tamano, fuente)) {
      this.asegurar(16);
      this.texto(linea, this.margen, this.y, estilo);
      this.y -= tamano + 4.5;
    }
    this.y -= 6;
  }

  /** Parte un texto en líneas que caben en el ancho dado, respetando palabras. */
  partir(txt, anchoMax, tamano, fuente) {
    const palabras = txt.split(/\s+/).filter(Boolean);
    const lineas = [];
    let actual = '';

    for (const palabra of palabras) {
      const tentativa = actual ? actual + ' ' + palabra : palabra;
      if (anchoTexto(tentativa, tamano, fuente) <= anchoMax) {
        actual = tentativa;
      } else if (actual) {
        lineas.push(actual);
        actual = palabra;
      } else {
        // Palabra sola más ancha que el papel: se corta a lo bruto antes de
        // dejar que se salga del borde.
        lineas.push(recortar(palabra, anchoMax, tamano, fuente));
        actual = '';
      }
    }
    if (actual) lineas.push(actual);
    return lineas.length ? lineas : [''];
  }

  /**
   * Fila de tarjetas con las cifras principales.
   * @param {Array} tarjetas  [{ etiqueta, valor, color }]
   */
  indicadores(tarjetas) {
    const alto = 54;
    this.asegurar(alto + 12);
    const hueco = 10;
    const ancho = (this.anchoUtil - hueco * (tarjetas.length - 1)) / tarjetas.length;

    tarjetas.forEach((t, i) => {
      const x = this.margen + i * (ancho + hueco);
      const y = this.y - alto;
      this.rect(x, y, ancho, alto, COLOR.cebra);
      this.rect(x, y, 3, alto, t.color || COLOR.marca);
      this.texto(recortar(t.etiqueta, ancho - 16, 7.5, 'normal'), x + 10, y + alto - 16,
        { tamano: 7.5, color: COLOR.suave });
      this.texto(recortar(String(t.valor), ancho - 16, 14, 'monoNegrita'), x + 10, y + 14,
        { tamano: 14, fuente: 'monoNegrita', color: t.color || COLOR.tinta });
    });

    this.y -= alto + 14;
  }

  /**
   * Tabla con cabecera, cebra y salto de página automático.
   * @param {object} tabla
   *   columnas  [{ titulo, ancho (proporción), align, fuente }]
   *   filas     [[celda, ...]] · una celda puede ser { texto, color }
   *   totales   fila final destacada (opcional)
   */
  tabla({ columnas, filas, totales }) {
    const altoFila = 16;
    const altoCabecera = 18;
    const suma = columnas.reduce((s, c) => s + c.ancho, 0);
    const anchos = columnas.map(c => (c.ancho / suma) * this.anchoUtil);

    const dibujarCabecera = () => {
      this.asegurar(altoCabecera + altoFila);
      const y = this.y - altoCabecera;
      this.rect(this.margen, y, this.anchoUtil, altoCabecera, COLOR.tinta);
      let x = this.margen;
      columnas.forEach((col, i) => {
        const align = col.align || 'left';
        const px = align === 'right' ? x + anchos[i] - 6 : align === 'center' ? x + anchos[i] / 2 : x + 6;
        this.texto(recortar(col.titulo, anchos[i] - 12, 8, 'negrita'), px, y + 5.5,
          { tamano: 8, fuente: 'negrita', color: COLOR.blanco, align });
        x += anchos[i];
      });
      this.y = y;
    };

    dibujarCabecera();

    filas.forEach((fila, indice) => {
      // Las columnas marcadas como 'multilinea' parten su texto en varias
      // líneas en vez de recortarlo. Se usa donde cortar pierde información
      // que hay que poder leer entera, como el motivo de una anulación.
      const contenido = fila.map((celda, i) => {
        const col = columnas[i] || {};
        const align = col.align || 'left';
        const fuente = col.fuente || (align === 'right' ? 'mono' : 'normal');
        const valor = String((celda && typeof celda === 'object' ? celda.texto : celda) ?? '');
        return {
          lineas: col.multilinea
            ? this.partir(valor, anchos[i] - 12, 8.5, fuente)
            : [recortar(valor, anchos[i] - 12, 8.5, fuente)],
          color: (celda && typeof celda === 'object' && celda.color) || COLOR.tinta,
          align,
          fuente
        };
      });

      const numLineas = Math.max(1, ...contenido.map(c => c.lineas.length));
      const altoReal = numLineas === 1 ? altoFila : 6 + numLineas * 11;

      // Si la fila no cabe, se abre página y se repite la cabecera: una tabla
      // partida sin cabecera obliga a adivinar qué columna es cada número.
      if (this.y - altoReal < this.margen + 28) {
        this.nuevaPagina();
        dibujarCabecera();
      }

      const y = this.y - altoReal;
      if (indice % 2 === 1) this.rect(this.margen, y, this.anchoUtil, altoReal, COLOR.cebra);

      let x = this.margen;
      contenido.forEach((celda, i) => {
        const px = celda.align === 'right' ? x + anchos[i] - 6
          : celda.align === 'center' ? x + anchos[i] / 2 : x + 6;
        celda.lineas.forEach((linea, l) => {
          this.texto(linea, px, y + altoReal - 11.5 - l * 11,
            { tamano: 8.5, fuente: celda.fuente, color: celda.color, align: celda.align });
        });
        x += anchos[i];
      });

      this.y = y;
    });

    if (totales) {
      if (this.y - altoFila - 2 < this.margen + 28) { this.nuevaPagina(); dibujarCabecera(); }
      const y = this.y - altoFila - 2;
      this.linea(this.margen, this.y, this.ancho - this.margen, this.y, COLOR.tinta, 0.8);
      let x = this.margen;
      totales.forEach((celda, i) => {
        const col = columnas[i] || {};
        const align = col.align || 'left';
        const px = align === 'right' ? x + anchos[i] - 6 : align === 'center' ? x + anchos[i] / 2 : x + 6;
        this.texto(String(celda == null ? '' : celda), px, y + 4.5,
          { tamano: 9, fuente: align === 'right' ? 'monoNegrita' : 'negrita', color: COLOR.tinta, align });
        x += anchos[i];
      });
      this.y = y;
    }

    this.y -= 18;
  }

  espacio(alto = 10) { this.y -= alto; }

  // ---- Serialización ---------------------------------------------------

  /** Pies de página. Se dibujan al final porque hasta entonces no se sabe cuántas hay. */
  pintarPies() {
    const total = this.paginas.length;
    this.paginas.forEach((pagina, i) => {
      const guardada = this.pagina;
      this.pagina = pagina;
      const y = this.margen - 12;
      this.linea(this.margen, y + 14, this.ancho - this.margen, y + 14, COLOR.linea, 0.5);
      if (this.pie) {
        this.texto(this.pie, this.margen, y + 2, { tamano: 7.5, fuente: 'mono', color: COLOR.suave });
      }
      this.texto(`Página ${i + 1} de ${total}`, this.ancho - this.margen, y + 2,
        { tamano: 7.5, fuente: 'mono', color: COLOR.suave, align: 'right' });
      this.pagina = guardada;
    });
  }

  /** Devuelve el PDF completo como Buffer. */
  salida() {
    this.pintarPies();

    const objetos = [];      // cuerpo de cada objeto, en orden
    const añadir = cuerpo => { objetos.push(cuerpo); return objetos.length; };

    // 1: catálogo · 2: árbol de páginas · 3-6: fuentes
    añadir('<< /Type /Catalog /Pages 2 0 R >>');
    añadir(null);            // se rellena al final, cuando se conocen los hijos
    const idFuente = {};
    for (const clave of Object.keys(FUENTES)) {
      const f = FUENTES[clave];
      idFuente[f.recurso] = añadir(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`
      );
    }

    const recursos = '<< /Font << ' +
      Object.keys(idFuente).map(r => `/${r} ${idFuente[r]} 0 R`).join(' ') + ' >> >>';

    const idsPagina = [];
    for (const pagina of this.paginas) {
      const flujo = pagina.ops.join('\n');
      const idFlujo = añadir(
        `<< /Length ${Buffer.byteLength(flujo, 'latin1')} >>\nstream\n${flujo}\nendstream`
      );
      idsPagina.push(añadir(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.ancho} ${this.alto}] ` +
        `/Resources ${recursos} /Contents ${idFlujo} 0 R >>`
      ));
    }

    objetos[1] = `<< /Type /Pages /Kids [${idsPagina.map(id => id + ' 0 R').join(' ')}] ` +
                 `/Count ${idsPagina.length} >>`;

    const idInfo = añadir(
      `<< /Title ${cadenaPdf(this.titulo)} /Producer ${cadenaPdf('MasterDrinks POS')} ` +
      `/CreationDate ${cadenaPdf(fechaPdf(new Date()))} >>`
    );

    // Ensamblado con la tabla xref: cada entrada apunta al byte exacto donde
    // empieza su objeto, así que se calculan sobre la marcha.
    let pdf = '%PDF-1.4\n';
    const posiciones = [];
    objetos.forEach((cuerpo, i) => {
      posiciones[i] = Buffer.byteLength(pdf, 'latin1');
      pdf += `${i + 1} 0 obj\n${cuerpo}\nendobj\n`;
    });

    const inicioXref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
    posiciones.forEach(pos => {
      pdf += String(pos).padStart(10, '0') + ' 00000 n \n';
    });
    pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R /Info ${idInfo} 0 R >>\n` +
           `startxref\n${inicioXref}\n%%EOF\n`;

    return Buffer.from(pdf, 'latin1');
  }
}

// Formato de fecha que exige el PDF: D:AAAAMMDDHHmmSS
function fechaPdf(d) {
  const p = n => String(n).padStart(2, '0');
  return 'D:' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

module.exports = { Documento, COLOR, num2, recortar };
