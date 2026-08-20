'use strict';

/**
 * Importador. Coge lo que escupen los parsers y lo mete en MySQL.
 *
 * Garantías:
 *  - Idempotente: INSERT IGNORE sobre la clave única (hash, hash_seq).
 *    Subir el mismo fichero dos veces no duplica nada.
 *  - No pisa lo manual: reclasificar solo toca clasif_origen IN ('regla','importador').
 *  - Todo o nada: una transacción por fichero.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const { pool } = require('./db');
const { parseBanco } = require('./parsers/parseBanco');
const { parsePaypal } = require('./parsers/parsePaypal');

/** Detecta el parser por extensión. */
function elegirParser(ruta) {
  const ext = path.extname(ruta).toLowerCase();
  if (ext === '.xls' || ext === '.xlsx') return { fn: parseBanco, origen: 'banco' };
  if (ext === '.csv') return { fn: parsePaypal, origen: 'paypal' };
  throw new Error(`No sé qué hacer con "${ext}". Se esperaba .xls (banco) o .csv (PayPal).`);
}

function hashFichero(ruta) {
  return crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
}

/** Carga las reglas activas, ya ordenadas por prioridad. */
async function cargarReglas(cx, origen) {
  const [filas] = await cx.query(
    `SELECT id, patron, tipo_patron, categoria_id, excluir
       FROM reglas
      WHERE activa = 1 AND origen IN ('todos', ?)
      ORDER BY prioridad ASC, LENGTH(patron) DESC`,
    [origen]
  );
  return filas.map((r) => ({
    ...r,
    re: r.tipo_patron === 'regex' ? new RegExp(r.patron, 'i') : null,
    patronLower: r.patron.toLowerCase(),
  }));
}

/** Primera regla que casa, o null. */
function aplicarReglas(conceptoNorm, reglas) {
  for (const r of reglas) {
    const casa = r.re ? r.re.test(conceptoNorm) : conceptoNorm.includes(r.patronLower);
    if (casa) return r;
  }
  return null;
}

/**
 * @param {string} ruta      Fichero a importar.
 * @param {object} opciones  { seco: true } para simular sin escribir.
 */
async function importar(ruta, opciones = {}) {
  const { seco = false } = opciones;
  const { fn, origen } = elegirParser(ruta);

  const resultado = fn(ruta);
  const { movimientos, meta, avisos } = resultado;

  if (!movimientos.length) {
    return { ...meta, nuevas: 0, repetidas: 0, avisos, nota: 'el fichero no traía movimientos' };
  }

  const cx = await pool.getConnection();
  try {
    await cx.beginTransaction();

    // 1. ¿Este fichero exacto ya se subió?
    const hf = hashFichero(ruta);
    const [previo] = await cx.query(
      'SELECT id, creada_en, filas_nuevas FROM importaciones WHERE hash_fichero = ?', [hf]
    );
    if (previo.length && !seco) {
      await cx.rollback();
      return {
        ...meta, nuevas: 0, repetidas: movimientos.length, avisos,
        nota: `fichero ya importado el ${previo[0].creada_en.toISOString().slice(0, 16)} ` +
              `(${previo[0].filas_nuevas} movimientos nuevos entonces)`,
      };
    }

    // 2. Registrar la importación.
    let importacionId = null;
    if (!seco) {
      const [ins] = await cx.query(
        `INSERT INTO importaciones
           (origen, fichero, hash_fichero, filas_leidas, desde, hasta)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [origen, path.basename(ruta), hf, meta.filas, meta.desde, meta.hasta]
      );
      importacionId = ins.insertId;
    }

    // 3. Reglas y categorías especiales.
    const reglas = await cargarReglas(cx, origen);
    const [[traspaso]] = await cx.query(
      `SELECT id FROM categorias
        WHERE categoria = 'TRASPASOS' AND subcategoria = 'Entre cuentas propias'`
    );

    // 4. Insertar. INSERT IGNORE + clave única = idempotencia.
    let nuevas = 0, repetidas = 0, clasificadas = 0, pendientes = 0;

    for (const m of movimientos) {
      let categoriaId = null;
      let clasifOrigen = null;
      let reglaId = null;
      let estado = 'pendiente';

      // Los traspasos que marca el parser de PayPal van directos.
      if (m.esTraspaso && traspaso) {
        categoriaId = traspaso.id;
        clasifOrigen = 'importador';
        estado = 'ok';
      } else {
        const regla = aplicarReglas(m.conceptoNorm, reglas);
        if (regla) {
          categoriaId = regla.categoria_id;
          clasifOrigen = 'regla';
          reglaId = regla.id;
          estado = regla.excluir ? 'ignorado' : 'ok';
        }
      }

      if (estado === 'pendiente') pendientes++; else clasificadas++;

      if (seco) { nuevas++; continue; }

      const [r] = await cx.query(
        `INSERT IGNORE INTO movimientos
           (fecha, fecha_valor, concepto, concepto_norm, importe, saldo,
            origen, cuenta, categoria_id, clasif_origen, regla_id, estado,
            hash, hash_seq, ref_externa, importacion_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          m.fecha, m.fechaValor, m.concepto, m.conceptoNorm, m.importe, m.saldo,
          m.origen, m.cuenta || null, categoriaId, clasifOrigen, reglaId, estado,
          m.hash, m.hashSeq, m.refExterna || null, importacionId,
        ]
      );
      if (r.affectedRows === 1) nuevas++; else repetidas++;
    }

    if (!seco) {
      await cx.query(
        'UPDATE importaciones SET filas_nuevas = ?, filas_repetidas = ? WHERE id = ?',
        [nuevas, repetidas, importacionId]
      );
      // Contador de uso de cada regla, para ver cuáles sobran.
      await cx.query(
        `UPDATE reglas r
            SET r.aciertos = (SELECT COUNT(*) FROM movimientos m WHERE m.regla_id = r.id),
                r.ultima_vez = NOW()
          WHERE r.id IN (SELECT DISTINCT regla_id FROM movimientos WHERE regla_id IS NOT NULL)`
      );
      await cx.commit();
    } else {
      await cx.rollback();
    }

    return {
      ...meta, origen, nuevas, repetidas,
      clasificadasPorRegla: clasificadas,
      pendientesDeClasificar: pendientes,
      avisos,
      seco,
    };
  } catch (e) {
    await cx.rollback();
    throw e;
  } finally {
    cx.release();
  }
}

/**
 * Reaplica las reglas a lo que quedó pendiente. Útil tras añadir reglas nuevas.
 * NUNCA toca lo clasificado a mano.
 */
async function reclasificar({ incluirYaClasificados = false } = {}) {
  const cx = await pool.getConnection();
  try {
    await cx.beginTransaction();

    const cond = incluirYaClasificados
      ? "clasif_origen IN ('regla','importador') OR categoria_id IS NULL"
      : 'categoria_id IS NULL';

    const [movs] = await cx.query(
      `SELECT id, concepto_norm, origen FROM movimientos
        WHERE (${cond}) AND estado <> 'ignorado'`
    );

    const cache = new Map();
    let tocados = 0;

    for (const m of movs) {
      if (!cache.has(m.origen)) cache.set(m.origen, await cargarReglas(cx, m.origen));
      const regla = aplicarReglas(m.concepto_norm, cache.get(m.origen));
      if (!regla) continue;

      await cx.query(
        `UPDATE movimientos
            SET categoria_id = ?, clasif_origen = 'regla', regla_id = ?, estado = ?
          WHERE id = ?`,
        [regla.categoria_id, regla.id, regla.excluir ? 'ignorado' : 'ok', m.id]
      );
      tocados++;
    }

    await cx.commit();
    return { revisados: movs.length, reclasificados: tocados };
  } catch (e) {
    await cx.rollback();
    throw e;
  } finally {
    cx.release();
  }
}

module.exports = { importar, reclasificar, aplicarReglas, cargarReglas };
