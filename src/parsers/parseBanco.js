'use strict';

/**
 * Parser del extracto .xls del banco (BIFF/OLE, una hoja "Movimientos").
 *
 * Formato observado:
 *   - Cabecera suelta en las primeras filas (entidad, fecha de export, saldo).
 *   - Fila de cabecera de tabla: FECHA OPERACIÓN | FECHA VALOR | CONCEPTO |
 *     IMPORTE EUR | SALDO
 *   - Fechas como TEXTO dd/mm/aaaa. Importe y saldo como NÚMERO.
 *   - Gastos en negativo, ingresos en positivo. Filas de más reciente a más antigua.
 *
 * No transforma signos: se guardan tal cual los da el banco.
 */

const XLSX = require('xlsx');
const crypto = require('crypto');

const ORIGEN = 'banco';

// Cabeceras aceptadas -> campo interno. Se comparan normalizadas.
const COLUMNAS = {
  'fecha operacion': 'fecha',
  'fecha': 'fecha',
  'fecha valor': 'fechaValor',
  'concepto': 'concepto',
  'descripcion': 'concepto',
  'importe eur': 'importe',
  'importe': 'importe',
  'saldo': 'saldo',
  'saldo eur': 'saldo',
};

/** Minúsculas, sin acentos, sin espacios de sobra. */
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "13/08/2026" -> Date (mediodía UTC, para que no baile con la zona horaria). */
function parseFecha(v) {
  if (v instanceof Date) return v;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12, 0, 0));
  return isNaN(d) ? null : d;
}

/**
 * Importe a número. El banco ya lo da numérico, pero algunos exports lo
 * mandan como texto con coma decimal y punto de millares.
 */
function parseImporte(v) {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  let s = String(v == null ? '' : v).replace(/[€\s]/g, '').replace(/EUR/gi, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Clave de idempotencia. No incluye el saldo a propósito: si el banco
 * reordena dos apuntes del mismo día entre dos exports, el saldo de cada
 * uno cambia y el mismo movimiento generaría un hash distinto.
 */
function hashMovimiento(m) {
  const base = [iso(m.fecha), m.concepto, m.importe.toFixed(2), ORIGEN].join('|');
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

/**
 * Integridad por saldos, SIN depender del orden de las filas.
 *
 * El banco no ordena cronológicamente los apuntes del mismo día, así que
 * comparar cada fila con la siguiente da falsos positivos. Estas dos
 * comprobaciones son independientes del orden:
 *
 *   1. Global: saldo_apertura + suma(importes) === saldo_final.
 *   2. Cadena: el saldo previo de cada apunte (saldo - importe) tiene que
 *      existir como saldo de otro apunte. La única excepción es el más
 *      antiguo, cuyo predecesor queda fuera del fichero.
 *
 * Si falta una fila o se cuela un duplicado, ambas fallan.
 */
function comprobarSaldos(movs) {
  const conSaldo = movs.filter((m) => m.saldo !== null);
  if (conSaldo.length < 2) return { aplicable: false, ok: null, fallos: [] };

  const cent = (x) => Math.round(x * 100);
  const fallos = [];

  // 1. Cuadre global
  const masNuevo = conSaldo[0];
  const masViejo = conSaldo[conSaldo.length - 1];
  const apertura = cent(masViejo.saldo) - cent(masViejo.importe);
  const suma = conSaldo.reduce((s, m) => s + cent(m.importe), 0);
  const esperado = apertura + suma;

  if (esperado !== cent(masNuevo.saldo)) {
    fallos.push({
      tipo: 'descuadre_global',
      saldoApertura: apertura / 100,
      sumaImportes: suma / 100,
      saldoFinalEsperado: esperado / 100,
      saldoFinalLeido: masNuevo.saldo,
      diferencia: (cent(masNuevo.saldo) - esperado) / 100,
    });
  }

  // 2. Cadena de saldos
  const existentes = new Set(conSaldo.map((m) => cent(m.saldo)));
  const huerfanos = conSaldo.filter(
    (m) => !existentes.has(cent(m.saldo) - cent(m.importe))
  );

  // Uno es normal: el apunte más antiguo del fichero.
  if (huerfanos.length > 1) {
    huerfanos.forEach((m) => {
      fallos.push({
        tipo: 'cadena_rota',
        fila: m.fila,
        fecha: iso(m.fecha),
        concepto: m.concepto.slice(0, 60),
        importe: m.importe,
        saldo: m.saldo,
        saldoPrevioNoEncontrado: (cent(m.saldo) - cent(m.importe)) / 100,
      });
    });
  }

  return { aplicable: true, ok: fallos.length === 0, fallos };
}

/**
 * @param {string|Buffer} entrada  Ruta al .xls o Buffer con su contenido.
 * @returns {{meta, movimientos, avisos}}
 */
function parseBanco(entrada) {
  const wb = Buffer.isBuffer(entrada)
    ? XLSX.read(entrada, { type: 'buffer', cellDates: false, raw: true })
    : XLSX.readFile(entrada, { cellDates: false, raw: true });

  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: '' });

  // 1. Localizar la fila de cabecera buscando la que tenga CONCEPTO e IMPORTE.
  let iCab = -1;
  let mapa = null;
  for (let i = 0; i < Math.min(filas.length, 40); i++) {
    const candidato = {};
    filas[i].forEach((celda, c) => {
      const campo = COLUMNAS[norm(celda)];
      if (campo && candidato[campo] === undefined) candidato[campo] = c;
    });
    if (candidato.concepto !== undefined && candidato.importe !== undefined
        && candidato.fecha !== undefined) {
      iCab = i;
      mapa = candidato;
      break;
    }
  }
  if (iCab === -1) {
    throw new Error(
      'No se encontró la fila de cabecera (FECHA OPERACIÓN / CONCEPTO / IMPORTE). ' +
      '¿Ha cambiado el formato del export?'
    );
  }

  // 2. Metadatos sueltos de la cabecera (entidad, saldo declarado).
  const meta = { entidad: null, saldoDeclarado: null, exportadoEn: null };
  for (let i = 0; i < iCab; i++) {
    for (let c = 0; c < filas[i].length; c++) {
      const etiqueta = norm(filas[i][c]);
      const debajo = filas[i + 1] ? filas[i + 1][c] : null;
      if (etiqueta === 'saldo' && debajo) meta.saldoDeclarado = parseImporte(debajo);
      if (etiqueta === 'fecha' && debajo) meta.exportadoEn = String(debajo).trim();
    }
    const primera = filas[i].find((v) => String(v).trim());
    if (!meta.entidad && primera && norm(primera) !== 'movimientos') {
      meta.entidad = String(primera).trim();
    }
  }

  // 3. Filas de datos.
  const movimientos = [];
  const avisos = [];

  for (let i = iCab + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || !f.some((v) => String(v).trim())) continue; // línea vacía

    const fecha = parseFecha(f[mapa.fecha]);
    const importe = parseImporte(f[mapa.importe]);
    const concepto = String(f[mapa.concepto] == null ? '' : f[mapa.concepto])
      .replace(/\s+/g, ' ')
      .trim();

    if (!fecha || importe === null || !concepto) {
      avisos.push({ fila: i + 1, motivo: 'fila descartada, faltan campos', datos: f });
      continue;
    }

    movimientos.push({
      fila: i + 1,
      fecha,
      fechaValor: mapa.fechaValor !== undefined ? parseFecha(f[mapa.fechaValor]) : null,
      concepto,
      conceptoNorm: norm(concepto),
      importe,
      saldo: mapa.saldo !== undefined ? parseImporte(f[mapa.saldo]) : null,
      origen: ORIGEN,
    });
  }

  // 4. Hash + secuencia. El seq desempata movimientos idénticos el mismo día
  //    (dos cafés de 1,50 €). Se ordena por saldo descendente para que la
  //    numeración sea estable entre exports.
  const grupos = new Map();
  movimientos.forEach((m) => {
    m.hash = hashMovimiento(m);
    if (!grupos.has(m.hash)) grupos.set(m.hash, []);
    grupos.get(m.hash).push(m);
  });
  for (const lista of grupos.values()) {
    if (lista.length === 1) { lista[0].hashSeq = 0; continue; }
    lista.sort((a, b) => (b.saldo ?? 0) - (a.saldo ?? 0));
    lista.forEach((m, k) => { m.hashSeq = k; });
  }

  // 5. Integridad por saldos (independiente del orden dentro del día).
  const chequeo = comprobarSaldos(movimientos);
  chequeo.fallos.forEach((x) => avisos.push({ ...x, motivo: 'integridad de saldos' }));

  const fechas = movimientos.map((m) => m.fecha).sort((a, b) => a - b);

  return {
    meta: {
      ...meta,
      desde: fechas.length ? iso(fechas[0]) : null,
      hasta: fechas.length ? iso(fechas[fechas.length - 1]) : null,
      filas: movimientos.length,
      // true / false / null cuando el export no trae columna de saldo
      saldosCuadran: chequeo.ok,
    },
    movimientos,
    avisos,
  };
}

module.exports = { parseBanco, norm, parseFecha, parseImporte, comprobarSaldos };

if (require.main === module) {
  const ruta = process.argv[2];
  if (!ruta) { console.error('uso: node parseBanco.js <extracto.xls>'); process.exit(1); }
  const r = parseBanco(ruta);
  console.log(JSON.stringify(r.meta, null, 2));
  console.log('avisos:', r.avisos.length);
  r.avisos.forEach((a) => console.log('  !', JSON.stringify(a)));
  console.log('\nprimeros 5:');
  r.movimientos.slice(0, 5).forEach((m) =>
    console.log(' ', iso(m.fecha), String(m.importe).padStart(9),
                String(m.saldo).padStart(9), m.hash.slice(0, 10), 'seq' + m.hashSeq,
                m.concepto.slice(0, 55)));
}
