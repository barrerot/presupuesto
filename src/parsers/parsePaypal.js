'use strict';

/**
 * Parser del CSV de actividad de PayPal (Actividad -> Descargar -> Personalizar).
 *
 * Devuelve la MISMA forma que parseBanco.js, para que el importador no tenga
 * que saber de dónde viene cada movimiento.
 *
 * ---------------------------------------------------------------------------
 * LA TRAMPA DEL FICHERO
 *
 * Cada compra genera DOS filas:
 *
 *   "Hetzner Online GmbH"  Pago exprés            Completado  -54,00
 *   ""                     Depósito bancario...   Pendiente   +54,00
 *
 * La primera es la compra. La segunda es PayPal tirando del dinero del banco
 * para cubrirla, y es justo la que aparece en el extracto como
 * "Recibo Paypal Europe". Si se importan las dos, se anulan entre sí.
 *
 * Aquí se descartan los depósitos: el cargo bancario ya lo aporta el extracto
 * del banco (marcado como excluido), y la compra la aporta este fichero.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const crypto = require('crypto');
const Papa = require('papaparse');

const ORIGEN = 'paypal';

/** Tipos que NO son un gasto ni un ingreso real. */
const TIPOS_IGNORADOS = [
  'depósito bancario',   // financiación de la compra; ya está en el banco
  'autorización',        // bloqueo de saldo, aún no es cargo
  'desprovisto de autorización', // liberación de un bloqueo
];

/** Tipos que son movimiento de dinero propio, no gasto. */
const TIPOS_TRASPASO = [
  'retirada iniciada por el usuario',  // de PayPal a la cuenta bancaria
];

function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Igual que norm pero conservando acentos, para comparar tipos en español. */
function bajo(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** "1.234,56" -> 1234.56 */
function parseImporte(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** "05/01/2026" + "05:17:41" -> Date UTC */
function parseFecha(f, hora) {
  const m = String(f).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const h = String(hora || '').match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  const d = new Date(Date.UTC(
    +m[3], +m[2] - 1, +m[1],
    h ? +h[1] : 12, h ? +h[2] : 0, h ? +h[3] : 0
  ));
  return isNaN(d) ? null : d;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * @param {string|Buffer} entrada  Ruta al CSV o Buffer con su contenido.
 * @returns {{meta, movimientos, avisos}}
 */
function parsePaypal(entrada) {
  let texto = Buffer.isBuffer(entrada)
    ? entrada.toString('utf8')
    : fs.readFileSync(entrada, 'utf8');
  texto = texto.replace(/^\uFEFF/, ''); // PayPal manda BOM

  const res = Papa.parse(texto, { header: true, skipEmptyLines: true });
  if (!res.data.length) throw new Error('El CSV de PayPal está vacío');

  const cols = Object.keys(res.data[0]);
  ['Fecha', 'Nombre', 'Tipo', 'Estado', 'Importe', 'Id. de transacción'].forEach((c) => {
    if (!cols.includes(c)) {
      throw new Error(
        `Falta la columna "${c}". Columnas encontradas: ${cols.join(', ')}. ` +
        '¿Has descargado el informe de actividad, o es otro tipo de informe?'
      );
    }
  });

  const movimientos = [];
  const avisos = [];
  const descartados = { deposito: 0, autorizacion: 0, noCompletado: 0 };
  let sumaTodo = 0;

  res.data.forEach((r, i) => {
    const fila = i + 2; // +1 cabecera, +1 base 1
    const tipo = bajo(r['Tipo']);
    const estado = bajo(r['Estado']);
    const importe = parseImporte(r['Importe']);
    const fecha = parseFecha(r['Fecha'], r['Hora']);
    const txid = String(r['Id. de transacción'] || '').trim();

    if (importe !== null) sumaTodo += importe;

    if (!fecha || importe === null) {
      avisos.push({ fila, motivo: 'fila descartada, fecha o importe ilegibles' });
      return;
    }

    if (TIPOS_IGNORADOS.some((t) => tipo.includes(t))) {
      if (tipo.includes('depósito')) descartados.deposito++;
      else descartados.autorizacion++;
      return;
    }

    // Solo lo consolidado. Lo pendiente entrará en la siguiente descarga,
    // ya completado, sin duplicarse: el Id. de transacción es el mismo.
    if (estado !== 'completado') { descartados.noCompletado++; return; }

    if (!txid) {
      avisos.push({ fila, motivo: 'sin Id. de transacción, no se puede deduplicar' });
      return;
    }

    // Divisa distinta de EUR: el importe no está en euros y no se convierte aquí.
    const divisa = String(r['Divisa'] || 'EUR').trim().toUpperCase();
    if (divisa !== 'EUR') {
      avisos.push({
        fila, motivo: 'divisa no EUR, revisar a mano',
        divisa, importe, nombre: r['Nombre'],
      });
    }

    const nombre = String(r['Nombre'] || '').trim();
    const descripcion = String(r['Descripción'] || '').trim();
    const concepto = nombre || descripcion || String(r['Tipo'] || '').trim();

    movimientos.push({
      fila,
      fecha,
      fechaValor: null,
      concepto,
      conceptoNorm: norm(concepto),
      importe,
      saldo: parseImporte(r['Saldo']),
      origen: ORIGEN,
      divisa,
      comision: parseImporte(r['Tarifas']) || 0,
      tipoPaypal: String(r['Tipo'] || '').trim(),
      // Traspaso: dinero que sale de PayPal a la cuenta. No es gasto.
      esTraspaso: TIPOS_TRASPASO.some((t) => tipo.includes(t)),
      refExterna: txid,
      // El Id. de transacción de PayPal ya es único y estable entre descargas,
      // así que no hace falta hash compuesto ni secuencia de desempate.
      hash: crypto.createHash('sha256').update(ORIGEN + '|' + txid, 'utf8').digest('hex'),
      hashSeq: 0,
    });
  });

  // Aviso si el fichero trae varios Id. de transacción repetidos: no debería.
  const vistos = new Set();
  movimientos.forEach((m) => {
    if (vistos.has(m.refExterna)) {
      avisos.push({ fila: m.fila, motivo: 'Id. de transacción duplicado', ref: m.refExterna });
    }
    vistos.add(m.refExterna);
  });

  const fechas = movimientos.map((m) => m.fecha).sort((a, b) => a - b);
  const gasto = movimientos.filter((m) => !m.esTraspaso)
    .reduce((s, m) => s + m.importe, 0);

  return {
    meta: {
      origen: ORIGEN,
      desde: fechas.length ? iso(fechas[0]) : null,
      hasta: fechas.length ? iso(fechas[fechas.length - 1]) : null,
      filasLeidas: res.data.length,
      filas: movimientos.length,
      descartados,
      sumaImportesFichero: Math.round(sumaTodo * 100) / 100,
      gastoNeto: Math.round(gasto * 100) / 100,
    },
    movimientos,
    avisos,
  };
}

module.exports = { parsePaypal, parseImporte, parseFecha, norm };

if (require.main === module) {
  const ruta = process.argv[2];
  if (!ruta) { console.error('uso: node parsePaypal.js <Download.CSV>'); process.exit(1); }
  const r = parsePaypal(ruta);
  console.log(JSON.stringify(r.meta, null, 2));
  console.log('avisos:', r.avisos.length);
  r.avisos.forEach((a) => console.log('  !', JSON.stringify(a)));
  console.log('\nprimeros 8:');
  r.movimientos.slice(0, 8).forEach((m) =>
    console.log(' ', iso(m.fecha), String(m.importe).padStart(9),
                m.esTraspaso ? 'TRASP' : '     ', m.refExterna, m.concepto.slice(0, 45)));
}
