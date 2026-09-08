/* ==========================================================================
 * MasterDrinks — Maquetación del reporte detallado de comandas en PDF
 * ==========================================================================
 *
 * Genera un PDF optimizado para impresión con el listado detallado de todas
 * las comandas del evento/barra, incluyendo productos, meseros, pagos y
 * totales.
 *
 * Reglas de negocio:
 * 1. Las comandas anuladas aparecen destacadas con fondo gris medio para
 *    facilitar su identificación visual en auditoría.
 * 2. El total recaudado en el sumario final NO incluye las comandas anuladas.
 * 3. Se incluye una aclaración explícita indicando que las anuladas están
 *    excluidas del total recaudado en Bs.
 * ========================================================================== */

'use strict';

const { Documento, COLOR, num2 } = require('./pdf');

/**
 * Genera el nombre del archivo para descarga.
 */
function nombreArchivoComandas(datos) {
  const hoy = new Date();
  const p = n => String(n).padStart(2, '0');
  const fechaStr = `${hoy.getFullYear()}_${p(hoy.getMonth() + 1)}_${p(hoy.getDate())}`;
  const barra = (datos.evento && datos.evento.barra ? datos.evento.barra : '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `Comandas_${barra ? barra + '_' : ''}${fechaStr}.pdf`;
}

function formatearHoraCorta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Construye el documento PDF con todas las comandas.
 * @param {object} datos
 *   evento      { nombre_evento, fecha_evento, lugar, responsable, barra }
 *   instancia   { nombre, ... }
 *   generado    string fecha/hora de generación
 *   filtro      string con término de búsqueda o null
 *   comandas    array de comandas con detalles y pagos
 */
function construirPdfComandas(datos) {
  const doc = new Documento({
    titulo: 'Reporte Detallado de Comandas · MasterDrinks',
    pie: (datos.evento ? (datos.evento.nombre_evento || 'MasterDrinks') + ' · ' : '') + 'Generado ' + datos.generado
  });

  const { comandas = [], evento = {}, filtro } = datos;

  // Clasificación de comandas
  const validas = comandas.filter(c => c.estado_pago !== 'ANULADO');
  const anuladas = comandas.filter(c => c.estado_pago === 'ANULADO');

  const totalRecaudado = validas.reduce((s, c) => s + (Number(c.total) || 0), 0);
  const totalAnulado = anuladas.reduce((s, c) => s + (Number(c.total) || 0), 0);
  const totalComandas = comandas.length;

  let totalUnidades = 0;
  validas.forEach(c => {
    (c.detalles || []).forEach(d => {
      totalUnidades += Number(d.cantidad) || 0;
    });
  });

  const barra = evento.barra || (datos.instancia && datos.instancia.nombre) || '';

  // ---- 1. Cabecera del Reporte ----------------------------------------
  doc.cabecera(
    'MASTERDRINKS',
    barra ? `Reporte de Comandas · Barra ${barra}` : 'Reporte Detallado de Comandas',
    filtro ? `Filtro: "${filtro}"` : `${totalComandas} comandas`
  );

  // Datos institucionales del evento
  const infoEvento = [evento.nombre_evento, evento.lugar, evento.fecha_evento].filter(Boolean).join(' · ');
  if (infoEvento) {
    doc.parrafo(infoEvento, { color: COLOR.tinta });
  }
  if (evento.responsable) {
    doc.parrafo('Responsable de la barra: ' + evento.responsable, { color: COLOR.suave });
  }
  doc.espacio(2);

  // ---- 2. Indicadores Superiores (KPIs) -------------------------------
  doc.indicadores([
    { etiqueta: 'RECAUDADO (BS.)', valor: num2(totalRecaudado), color: COLOR.ok },
    { etiqueta: 'COMANDAS', valor: String(totalComandas) },
    { etiqueta: 'COBRADAS', valor: String(validas.length), color: COLOR.ok },
    { etiqueta: 'ANULADAS', valor: String(anuladas.length), color: anuladas.length > 0 ? COLOR.alerta : COLOR.suave },
    { etiqueta: 'ANULADO (BS.)', valor: num2(totalAnulado), color: anuladas.length > 0 ? COLOR.alerta : COLOR.suave }
  ]);

  if (anuladas.length > 0) {
    doc.parrafo(
      `* Nota: Las ${anuladas.length} comandas anuladas (${num2(totalAnulado)} Bs.) se destacan con fondo gris y NO están sumadas en el total recaudado.`,
      { color: COLOR.alerta, tamano: 8 }
    );
    doc.espacio(4);
  }

  // ---- 3. Tabla Detallada de Comandas ---------------------------------
  doc.seccion('DETALLE DE COMANDAS');

  if (comandas.length === 0) {
    doc.parrafo('No se encontraron comandas registradas para este reporte.', { color: COLOR.suave });
  } else {
    // Definición de columnas con anchos ajustados exactamente a 515 pt útiles
    const columnas = [
      { titulo: '# / Hora', ancho: 49, align: 'left', multilinea: true },
      { titulo: 'Personal', ancho: 65, align: 'left', multilinea: true },
      { titulo: 'Detalle de Productos', ancho: 218, align: 'left', multilinea: true },
      { titulo: 'Pago', ancho: 68, align: 'left', multilinea: true },
      { titulo: 'Estado', ancho: 55, align: 'center' },
      { titulo: 'Total Bs.', ancho: 60, align: 'right' }
    ];

    const filas = comandas.map(c => {
      const esAnulada = c.estado_pago === 'ANULADO';

      // 1. Columna # / Hora
      const horaStr = formatearHoraCorta(c.fecha_hora);
      const colId = `#${c.id_comanda}\n${horaStr}`;

      // 2. Columna Mesero / Cajero
      const meseroTxt = c.nombre_mesero || 'Mesero';
      const cajeroTxt = c.nombre_cajero || 'Cajero';
      const colPersonal = `M: ${meseroTxt}\nC: ${cajeroTxt}`;

      // 3. Columna Productos y Detalles
      const lineasProds = [];
      if (c.detalles && c.detalles.length > 0) {
        c.detalles.forEach(d => {
          const cant = d.cantidad;
          const nom = d.nombre_producto;
          const sub = num2(d.subtotal || (cant * d.precio_unitario));
          lineasProds.push(`${cant}x ${nom} (Bs. ${sub})`);
        });
      } else {
        lineasProds.push('Sin productos');
      }

      if (c.observaciones) {
        lineasProds.push(`Obs: ${c.observaciones}`);
      }
      if (esAnulada && c.motivo_anulacion) {
        lineasProds.push(`Motivo anulación: ${c.motivo_anulacion}`);
      }
      const colProductos = lineasProds.join('\n');

      // 4. Columna Pagos
      let colPago = '-';
      if (c.pagos && c.pagos.length > 0) {
        const lineasPagos = [];
        c.pagos.forEach(p => {
          const met = p.nombre_metodo || 'Pago';
          lineasPagos.push(`${met}: ${num2(p.monto)}`);
          if (p.referencia) {
            lineasPagos.push(`Ref: ${p.referencia}`);
          }
        });
        colPago = lineasPagos.join('\n');
      }

      // 5. Columna Estado
      const colEstado = esAnulada
        ? { texto: 'ANULADA', color: COLOR.alerta, fuente: 'negrita' }
        : { texto: 'VENDIDA', color: COLOR.ok, fuente: 'negrita' };

      // 6. Columna Total
      const colTotal = esAnulada
        ? { texto: num2(c.total) + '*', color: COLOR.textoAnulado, fuente: 'monoNegrita' }
        : { texto: num2(c.total), color: COLOR.tinta, fuente: 'monoNegrita' };

      // Si la comanda es anulada, se aplica fondo gris medio a toda la fila
      return {
        celdas: [colId, colPersonal, colProductos, colPago, colEstado, colTotal],
        fondo: esAnulada ? COLOR.grisAnulado : null,
        colorTexto: esAnulada ? COLOR.textoAnulado : null,
        separador: true
      };
    });

    const totalesTabla = [
      'TOTALES',
      `${validas.length} vál. / ${anuladas.length} an.`,
      `${totalUnidades} unidades vendidas`,
      '',
      '',
      `${num2(totalRecaudado)} Bs.`
    ];

    doc.tabla({
      columnas,
      filas,
      totales: totalesTabla,
      separadorFilas: true
    });
  }

  // ---- 4. Sumario Final y Aclaración de Totales -------------------------
  doc.espacio(6);
  doc.seccion('RESUMEN Y CUADRE GENERAL');

  // Tarjeta / Tabla de desglose de cierre
  doc.tabla({
    columnas: [
      { titulo: 'Concepto', ancho: 45, align: 'left' },
      { titulo: 'Cantidad', ancho: 20, align: 'center' },
      { titulo: 'Importe Total', ancho: 35, align: 'right' }
    ],
    filas: [
      [
        'Comandas válidas cobradas (Ingreso real)',
        String(validas.length),
        { texto: `${num2(totalRecaudado)} Bs.`, color: COLOR.ok, fuente: 'monoNegrita' }
      ],
      {
        celdas: [
          'Comandas anuladas (Excluidas del total)',
          String(anuladas.length),
          { texto: `${num2(totalAnulado)} Bs. *`, color: COLOR.alerta, fuente: 'monoNegrita' }
        ],
        fondo: COLOR.grisAnulado,
        colorTexto: COLOR.textoAnulado
      }
    ],
    totales: [
      'TOTAL RECAUDADO EFECTIVO',
      `${validas.length} válidas`,
      `${num2(totalRecaudado)} Bs.`
    ]
  });

  doc.espacio(4);

  // Cuadro de Aclaración requerida
  doc.parrafo(
    `ACLARACIÓN: El total recaudado de ${num2(totalRecaudado)} Bs. NO considera ni suma las comandas anuladas. ` +
    `Las ${anuladas.length} comandas anuladas (${num2(totalAnulado)} Bs.) figuran en este reporte con fondo gris ` +
    'únicamente con fines de control interno, auditoría y verificación de bajas de inventario.',
    { color: COLOR.tinta, tamano: 9, fuente: 'negrita' }
  );

  return doc.salida();
}

module.exports = {
  construirPdfComandas,
  nombreArchivoComandas
};
