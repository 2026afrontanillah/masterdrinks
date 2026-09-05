/* ==========================================================================
 * MasterDrinks — Maquetación del reporte de cierre en PDF
 * ==========================================================================
 *
 * Recibe los datos ya calculados por construirReporte() y los coloca sobre el
 * papel. El orden de las secciones es el del cuadre de caja: primero cuánto
 * hay que tener, luego de dónde salió, y al final lo que hay que justificar
 * (anulaciones) y lo que queda por vender (stock).
 * ========================================================================== */

'use strict';

const { Documento, COLOR, num2 } = require('./pdf');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function textoRango(rango) {
  if (rango.todo) return 'Todo el evento';
  const bonita = iso => {
    if (!iso) return null;
    const [a, m, d] = iso.split('-');
    return `${Number(d)} de ${MESES[Number(m) - 1]} de ${a}`;
  };
  if (rango.desde && rango.hasta) {
    return rango.desde === rango.hasta ? bonita(rango.desde) : `Del ${bonita(rango.desde)} al ${bonita(rango.hasta)}`;
  }
  if (rango.desde) return `Desde el ${bonita(rango.desde)}`;
  return `Hasta el ${bonita(rango.hasta)}`;
}

/**
 * Nombre de archivo pensado para mandarlo por WhatsApp sin renombrarlo.
 * Lleva dentro la barra y la fecha: si al mismo chat llegan los cierres de
 * varios eventos y se llaman igual, el segundo pisa al primero.
 */
function nombreArchivoReporte(datos) {
  const hoy = new Date();
  const p = n => String(n).padStart(2, '0');
  const sello = datos.rango.todo
    ? `${p(hoy.getDate())}_${p(hoy.getMonth() + 1)}_${hoy.getFullYear()}`
    : [datos.rango.desde, datos.rango.hasta].filter(Boolean).join('_al_').replace(/-/g, '_');
  // Sin acentos ni espacios: acaba siendo un nombre de archivo en Android.
  const barra = (datos.instancia && datos.instancia.nombre ? datos.instancia.nombre : '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `Cierre_${barra ? barra + '_' : ''}${sello}.pdf`;
}

const pct = (parte, total) => (total > 0 ? (parte / total) * 100 : 0);

function construirPdfCierre(datos) {
  const { resumen } = datos;
  const doc = new Documento({
    titulo: 'Cierre de caja · MasterDrinks',
    pie: (datos.evento ? datos.evento.nombre_evento + ' · ' : '') + 'Generado ' + datos.generado
  });

  // ---- Cabecera --------------------------------------------------------
  const barra = (datos.evento && datos.evento.barra) ||
    (datos.instancia && datos.instancia.nombre) || null;
  doc.cabecera('MASTERDRINKS',
    barra ? 'Cierre de caja · ' + barra : 'Reporte de cierre de caja',
    textoRango(datos.rango));
  if (barra) {
    doc.parrafo(`Este cierre cubre la barra ${barra}` +
      '. Recoge todo lo vendido, cobrado y descontado de stock en este servidor.',
      { color: COLOR.tinta });
  }
  if (datos.evento) {
    const e = datos.evento;
    doc.parrafo([e.nombre_evento, e.lugar, e.fecha_evento].filter(Boolean).join(' · '));
    // El responsable firma el cierre: es quien responde de lo que hay en la caja.
    if (e.responsable) {
      doc.parrafo('Responsable de la barra: ' + e.responsable, { color: COLOR.tinta });
    }
  }
  doc.espacio(4);

  // ---- Cifras principales ---------------------------------------------
  doc.indicadores([
    { etiqueta: 'RECAUDADO', valor: num2(resumen.recaudado), color: COLOR.ok },
    { etiqueta: 'COMANDAS', valor: String(resumen.validas) },
    { etiqueta: 'TICKET MEDIO', valor: num2(resumen.ticket_medio) },
    { etiqueta: 'UNIDADES', valor: String(resumen.unidades) },
    { etiqueta: 'ANULADAS', valor: String(resumen.anuladas),
      color: resumen.anuladas > 0 ? COLOR.alerta : COLOR.suave }
  ]);

  if (resumen.anuladas > 0) {
    doc.parrafo(`Las ${resumen.anuladas} comandas anuladas (${num2(resumen.importe_anulado)} Bs.) ` +
                'no se cuentan en lo recaudado. Van detalladas al final.',
      { color: COLOR.alerta });
    doc.espacio(4);
  }

  // ---- Formas de pago: lo que debe haber en cada sitio -----------------
  doc.seccion('COBROS POR FORMA DE PAGO');
  if (datos.porMetodo.length === 0) {
    doc.parrafo('Sin cobros registrados en este rango.');
  } else {
    doc.tabla({
      columnas: [
        { titulo: 'Forma de pago', ancho: 34 },
        { titulo: 'Operaciones', ancho: 18, align: 'right' },
        { titulo: 'Importe (Bs.)', ancho: 26, align: 'right' },
        { titulo: '% del total', ancho: 22, align: 'right' }
      ],
      filas: datos.porMetodo.map(m => [
        m.metodo,
        String(m.operaciones),
        num2(m.importe),
        pct(m.importe, resumen.recaudado).toFixed(1) + ' %'
      ]),
      totales: ['TOTAL', String(datos.porMetodo.reduce((s, m) => s + Number(m.operaciones), 0)),
                num2(datos.porMetodo.reduce((s, m) => s + Number(m.importe), 0)), '100.0 %']
    });
    doc.parrafo('El efectivo es lo que tiene que estar en el cajón; el resto ya está en la cuenta.');
    doc.espacio(6);
  }

  // ---- Por barra -------------------------------------------------------
  // Con una sola barra esta tabla repetiría la cifra de arriba y ocuparía media
  // página para no decir nada, así que sólo sale cuando hay algo que comparar.
  if (datos.porBarra.length > 1) {
    doc.seccion('VENTAS POR BARRA');
    doc.tabla({
      columnas: [
        { titulo: 'Barra', ancho: 40 },
        { titulo: 'Comandas', ancho: 18, align: 'right' },
        { titulo: 'Importe (Bs.)', ancho: 24, align: 'right' },
        { titulo: '% del total', ancho: 18, align: 'right' }
      ],
      filas: datos.porBarra.map(b => [
        b.barra, String(b.comandas), num2(b.importe), pct(b.importe, resumen.recaudado).toFixed(1) + ' %'
      ])
    });
  }

  // ---- Por cajero ------------------------------------------------------
  if (datos.porCajero.length > 0) {
    doc.seccion('VENTAS POR CAJERO');
    doc.tabla({
      columnas: [
        { titulo: 'Cajero', ancho: 32 },
        { titulo: 'Barra', ancho: 26 },
        { titulo: 'Comandas', ancho: 16, align: 'right' },
        { titulo: 'Importe (Bs.)', ancho: 26, align: 'right' }
      ],
      filas: datos.porCajero.map(c => [c.cajero, c.barra, String(c.comandas), num2(c.importe)])
    });
  }

  // ---- Por mesero ------------------------------------------------------
  if (datos.porMesero.length > 0) {
    doc.seccion('VENTAS POR MESERO');
    doc.tabla({
      columnas: [
        { titulo: 'Mesero', ancho: 46 },
        { titulo: 'Comandas', ancho: 20, align: 'right' },
        { titulo: 'Importe (Bs.)', ancho: 34, align: 'right' }
      ],
      filas: datos.porMesero.map(m => [m.mesero, String(m.comandas), num2(m.importe)])
    });
  }

  // ---- Productos vendidos ---------------------------------------------
  doc.seccion('PRODUCTOS VENDIDOS');
  if (datos.productos.length === 0) {
    doc.parrafo('Sin productos vendidos en este rango.');
  } else {
    doc.tabla({
      columnas: [
        { titulo: 'Producto', ancho: 40 },
        { titulo: 'Categoría', ancho: 22 },
        { titulo: 'Unidades', ancho: 15, align: 'right' },
        { titulo: 'Importe (Bs.)', ancho: 23, align: 'right' }
      ],
      filas: datos.productos.map(p => [
        p.producto, p.categoria || '—', String(p.unidades), num2(p.importe)
      ]),
      totales: ['TOTAL', '',
        String(datos.productos.reduce((s, p) => s + Number(p.unidades), 0)),
        num2(datos.productos.reduce((s, p) => s + Number(p.importe), 0))]
    });
  }

  // ---- Cobros a cuadrar con el banco -----------------------------------
  // El sistema no puede confirmar estos pagos por su cuenta: no habla con el
  // banco. Esta lista es la que se va tachando contra el extracto.
  const digitales = datos.cobrosDigitales || [];
  if (digitales.length > 0) {
    doc.seccion('COBROS A CUADRAR CON EL BANCO');
    doc.parrafo('Pagos por QR, tarjeta o transferencia, con la referencia que anotó el cajero. ' +
                'Compáralos uno a uno con el extracto: el sistema no los verifica con el banco.');
    doc.tabla({
      columnas: [
        { titulo: 'Comanda', ancho: 13, align: 'right' },
        { titulo: 'Método', ancho: 20 },
        { titulo: 'Importe (Bs.)', ancho: 17, align: 'right' },
        { titulo: 'Referencia', ancho: 30 },
        { titulo: 'Hora', ancho: 20 }
      ],
      filas: digitales.map(c => [
        String(c.id_comanda),
        c.metodo,
        num2(c.monto),
        c.referencia || '—',
        String(c.fecha_hora || '').slice(11, 16)
      ]),
      totales: ['', 'TOTAL', num2(digitales.reduce((s, c) => s + Number(c.monto), 0)), '', '']
    });
  }

  // ---- Reimpresiones ---------------------------------------------------
  //
  // Va junto a los cobros a cuadrar y antes de las anulaciones porque se lee
  // por el mismo motivo: buscar de dónde sale un descuadre. Un ticket
  // reimpreso es un ticket que se puede volver a cobrar, así que aquí importa
  // tanto la comanda como quién pidió la copia.
  const reimpresiones = datos.reimpresiones || [];
  if (reimpresiones.length > 0) {
    doc.seccion('REIMPRESIONES');
    doc.parrafo('Copias sacadas después del ticket original. Cada línea deja al cajero y al ' +
                'mesero que estaban en turno: una misma comanda repetida varias veces merece ' +
                'una explicación.');
    doc.tabla({
      columnas: [
        { titulo: 'Comanda', ancho: 12, align: 'right' },
        { titulo: 'Copia', ancho: 8, align: 'right' },
        { titulo: 'Ticket', ancho: 12 },
        { titulo: 'Cajero', ancho: 22 },
        { titulo: 'Mesero', ancho: 22 },
        { titulo: 'Hora', ancho: 12 }
      ],
      filas: reimpresiones.map(r => [
        String(r.id_comanda),
        String(r.numero_copia),
        r.copia_de,
        r.cajero,
        r.mesero,
        String(r.fecha || '').slice(11, 16)
      ])
    });
  }

  // ---- Anulaciones -----------------------------------------------------
  if (datos.anuladas.length > 0) {
    doc.seccion('COMANDAS ANULADAS');
    doc.tabla({
      // El motivo se lleva la mitad del ancho: es lo que hay que poder leer
      // entero al justificar un descuadre. El mesero se cae de la tabla porque
      // la responsabilidad de una anulación es de quien la autoriza.
      columnas: [
        { titulo: 'Nº', ancho: 9, align: 'right' },
        { titulo: 'Importe', ancho: 15, align: 'right' },
        { titulo: 'Autorizada por', ancho: 24, multilinea: true },
        { titulo: 'Motivo', ancho: 52, multilinea: true }
      ],
      filas: datos.anuladas.map(a => [
        String(a.id_comanda),
        { texto: num2(a.total), color: COLOR.alerta },
        a.admin || '—',
        a.motivo_anulacion || 'Sin motivo'
      ])
    });
    doc.parrafo(
      `Total anulado: ${num2(datos.anuladas.reduce((s, a) => s + Number(a.total), 0))} Bs. ` +
      `en ${datos.anuladas.length} comanda(s). Este importe ya está descontado de lo recaudado.`);
  }

  // ---- Stock -----------------------------------------------------------
  doc.seccion('EXISTENCIAS AL CIERRE');
  const agotados = datos.stock.filter(s => s.stock_actual <= 0).length;
  const bajos = datos.stock.filter(s => s.stock_actual > 0 && s.stock_actual < 10).length;
  doc.parrafo(`${datos.stock.length} productos activos · ${agotados} agotados · ${bajos} por debajo de 10 unidades.`);
  doc.tabla({
    columnas: [
      { titulo: 'Producto', ancho: 42 },
      { titulo: 'Categoría', ancho: 24 },
      { titulo: 'Precio (Bs.)', ancho: 17, align: 'right' },
      { titulo: 'Stock', ancho: 17, align: 'right' }
    ],
    filas: datos.stock.map(s => [
      s.producto,
      s.categoria || '—',
      num2(s.precio_venta),
      {
        texto: s.stock_actual <= 0 ? 'AGOTADO' : String(s.stock_actual),
        color: s.stock_actual <= 0 ? COLOR.alerta : s.stock_actual < 10 ? COLOR.aviso : COLOR.tinta
      }
    ])
  });

  doc.espacio(8);
  doc.parrafo('Documento generado automáticamente por MasterDrinks POS. ' +
              'Las cifras se calculan directamente sobre la base de datos del evento.');

  return doc.salida();
}

module.exports = { construirPdfCierre, nombreArchivoReporte };
