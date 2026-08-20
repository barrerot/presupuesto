'use strict';

/**
 * API + servidor estático de la app de presupuesto.
 *   node bin/servidor.js       -> http://localhost:3000
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool } = require('../src/db');
const { importar, reclasificar } = require('../src/importador');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Los ficheros subidos se guardan con timestamp para no chocar entre sí,
// pero conservando el nombre original: el importador solo mira la extensión.
const dirSubidas = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(dirSubidas, { recursive: true });
const subida = multer({
  storage: multer.diskStorage({
    destination: dirSubidas,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xls|xlsx|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo se aceptan .xls, .xlsx o .csv'), ok);
  },
});

/** Envuelve un handler async para que los errores lleguen al middleware. */
const ruta = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// --------------------------------------------------------------------------
// Lectura
// --------------------------------------------------------------------------

app.get('/api/resumen', ruta(async (req, res) => {
  const [[t]] = await pool.query(`
    SELECT COUNT(*) total,
           SUM(estado = 'pendiente') pendientes,
           SUM(estado = 'ok')        clasificados,
           SUM(estado = 'ignorado')  ignorados,
           ROUND(SUM(CASE WHEN estado = 'pendiente' THEN importe ELSE 0 END), 2) importePendiente,
           MIN(fecha) desde, MAX(fecha) hasta
      FROM movimientos`);
  res.json(t);
}));

/** Bandeja de entrada. Ordenable y filtrable por columna. */
const ORDENABLES = {
  fecha: 'm.fecha',
  concepto: 'm.concepto_norm',
  importe: 'ABS(m.importe)',
  origen: 'm.origen',
  categoria: 'c.categoria',
};

app.get('/api/pendientes', ruta(async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 100, 500);
  const desplaz = Math.max(Number(req.query.pagina) || 0, 0) * limite;

  const where = [];
  const args = [];

  // Por defecto la bandeja; 'todos' permite revisar y corregir lo ya hecho.
  const estado = req.query.estado || 'pendiente';
  if (estado !== 'todos') { where.push('m.estado = ?'); args.push(estado); }

  const q = (req.query.q || '').trim();
  if (q) {
    where.push('(m.concepto_norm LIKE ? OR c.subcategoria LIKE ? OR c.categoria LIKE ?)');
    args.push(`%${q.toLowerCase()}%`, `%${q}%`, `%${q}%`);
  }

  if (req.query.origen) { where.push('m.origen = ?'); args.push(req.query.origen); }
  if (req.query.categoriaId) { where.push('m.categoria_id = ?'); args.push(req.query.categoriaId); }
  if (req.query.fechaDesde) { where.push('m.fecha >= ?'); args.push(req.query.fechaDesde); }
  if (req.query.fechaHasta) { where.push('m.fecha <= ?'); args.push(req.query.fechaHasta); }

  // El filtro de importe va sobre el valor absoluto: pensamos en "cuánto",
  // no en el signo.
  if (req.query.min !== undefined && req.query.min !== '') {
    where.push('ABS(m.importe) >= ?'); args.push(Number(req.query.min));
  }
  if (req.query.max !== undefined && req.query.max !== '') {
    where.push('ABS(m.importe) <= ?'); args.push(Number(req.query.max));
  }
  if (req.query.signo === 'gasto') where.push('m.importe < 0');
  if (req.query.signo === 'ingreso') where.push('m.importe > 0');

  const col = ORDENABLES[req.query.orden] || 'ABS(m.importe)';
  const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const filtro = where.length ? where.join(' AND ') : '1';
  const desde = 'FROM movimientos m LEFT JOIN categorias c ON c.id = m.categoria_id';

  const [filas] = await pool.query(
    `SELECT m.id, m.fecha, m.concepto, m.importe, m.origen, m.estado,
            m.clasif_origen, m.categoria_id,
            c.categoria, c.subcategoria, c.tipo
       ${desde}
      WHERE ${filtro}
      ORDER BY ${col} ${dir}, m.id DESC
      LIMIT ? OFFSET ?`,
    [...args, limite, desplaz]
  );

  const [[agg]] = await pool.query(
    `SELECT COUNT(*) total, ROUND(SUM(m.importe), 2) suma ${desde} WHERE ${filtro}`, args
  );

  // Los ids de TODO lo que casa, para poder actuar sobre el filtro completo
  // y no solo sobre la página visible.
  let ids = [];
  if (req.query.ids === '1' && agg.total <= 2000) {
    const [r] = await pool.query(`SELECT m.id ${desde} WHERE ${filtro}`, args);
    ids = r.map((x) => x.id);
  }

  res.json({ total: agg.total, suma: agg.suma || 0, filas, ids });
}));

/** Devolver a la bandeja algo que se clasificó mal. */
app.post('/api/despejar', ruta(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'Selecciona al menos un movimiento.' });
  }
  const [r] = await pool.query(
    `UPDATE movimientos
        SET categoria_id = NULL, clasif_origen = NULL, regla_id = NULL, estado = 'pendiente'
      WHERE id IN (?)`, [ids]
  );
  res.json({ actualizados: r.affectedRows });
}));

/**
 * Subir y ese mismo fichero, importar. Reutiliza el importador de consola:
 * un solo camino para los datos, tanto si entran por CLI como por navegador.
 */
app.post('/api/subir', subida.single('fichero'), ruta(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún fichero.' });
  try {
    const r = await importar(req.file.path);
    res.json({
      fichero: req.file.originalname, ...r,
      // Ruta relativa: no interesa exponer la ruta absoluta del contenedor.
      guardadoComo: path.basename(req.file.path),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.get('/api/categorias', ruta(async (req, res) => {
  // ?todas=1 incluye las desactivadas y cuenta en qué se usan, para el panel.
  if (req.query.todas) {
    const [filas] = await pool.query(`
      SELECT c.id, c.categoria, c.subcategoria, c.tipo, c.reparto, c.activa,
             (SELECT COUNT(*) FROM movimientos m WHERE m.categoria_id = c.id) usos,
             (SELECT COUNT(*) FROM reglas r     WHERE r.categoria_id = c.id) reglas
        FROM categorias c ORDER BY c.categoria, c.subcategoria`);
    return res.json(filas);
  }
  const [filas] = await pool.query(
    `SELECT id, categoria, subcategoria, tipo FROM categorias
      WHERE activa = 1 ORDER BY categoria, subcategoria`
  );
  res.json(filas);
}));

/** El reparto 50/30/20 se deduce del tipo: un dato menos que rellenar. */
function repartoDe(tipo, reparto) {
  if (tipo === 'gasto') return reparto === 'fijo' ? 'fijo' : 'variable';
  if (tipo === 'ahorro' || tipo === 'inversion') return 'ahorro_inversion';
  return null;
}

const TIPOS = ['ingreso', 'gasto', 'ahorro', 'inversion', 'traspaso'];

app.post('/api/categorias', ruta(async (req, res) => {
  const categoria = String(req.body.categoria || '').trim();
  const subcategoria = String(req.body.subcategoria || '').trim();
  const tipo = String(req.body.tipo || 'gasto');

  if (!categoria || !subcategoria) {
    return res.status(400).json({ error: 'Hacen falta categoría y subcategoría.' });
  }
  if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo no válido.' });

  const [dup] = await pool.query(
    'SELECT id, activa FROM categorias WHERE categoria = ? AND subcategoria = ?',
    [categoria, subcategoria]
  );
  if (dup.length) {
    // Ya existía pero estaba desactivada: reactivarla es lo que se espera.
    if (!dup[0].activa) {
      await pool.query('UPDATE categorias SET activa = 1 WHERE id = ?', [dup[0].id]);
      return res.json({ id: dup[0].id, reactivada: true });
    }
    return res.status(409).json({ error: 'Esa categoría ya existe.' });
  }

  const [r] = await pool.query(
    `INSERT INTO categorias (categoria, subcategoria, tipo, reparto, orden)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(orden), 0) + 10 FROM categorias c))`,
    [categoria, subcategoria, tipo, repartoDe(tipo, req.body.reparto)]
  );
  res.json({ id: r.insertId });
}));

app.patch('/api/categorias/:id', ruta(async (req, res) => {
  const id = Number(req.params.id);
  const [[actual]] = await pool.query('SELECT * FROM categorias WHERE id = ?', [id]);
  if (!actual) return res.status(404).json({ error: 'No existe esa categoría.' });

  const categoria = String(req.body.categoria ?? actual.categoria).trim();
  const subcategoria = String(req.body.subcategoria ?? actual.subcategoria).trim();
  const tipo = req.body.tipo ?? actual.tipo;
  const activa = req.body.activa === undefined ? actual.activa : (req.body.activa ? 1 : 0);

  if (!categoria || !subcategoria) {
    return res.status(400).json({ error: 'Hacen falta categoría y subcategoría.' });
  }
  if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo no válido.' });

  try {
    await pool.query(
      `UPDATE categorias SET categoria = ?, subcategoria = ?, tipo = ?, reparto = ?, activa = ?
        WHERE id = ?`,
      [categoria, subcategoria, tipo, repartoDe(tipo, req.body.reparto ?? actual.reparto),
       activa, id]
    );
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ya hay otra categoría con ese nombre.' });
    }
    throw e;
  }
  res.json({ ok: true });
}));

/**
 * Borrar solo si no se usa. Si hay movimientos colgando, el ON DELETE SET NULL
 * los dejaría sin categoría en silencio; mejor obligar a desactivar.
 */
app.delete('/api/categorias/:id', ruta(async (req, res) => {
  const id = Number(req.params.id);
  const [[{ usos }]] = await pool.query(
    'SELECT COUNT(*) usos FROM movimientos WHERE categoria_id = ?', [id]
  );
  const [[{ n: reglas }]] = await pool.query(
    'SELECT COUNT(*) n FROM reglas WHERE categoria_id = ?', [id]
  );
  if (usos || reglas) {
    return res.status(409).json({
      error: `En uso: ${usos} movimientos y ${reglas} reglas. Desactívala en vez de borrarla.`,
    });
  }
  await pool.query('DELETE FROM categorias WHERE id = ?', [id]);
  res.json({ ok: true });
}));

/**
 * Cuántos movimientos cogería un patrón. Alimenta el "aplicar a otros N".
 * Solo mira lo pendiente: no propone tocar lo ya decidido.
 */
app.get('/api/coincidencias', ruta(async (req, res) => {
  const patron = (req.query.patron || '').trim().toLowerCase();
  if (patron.length < 3) return res.json({ n: 0, ejemplos: [] });

  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) n FROM movimientos
      WHERE estado = 'pendiente' AND concepto_norm LIKE ?`, [`%${patron}%`]
  );
  const [ejemplos] = await pool.query(
    `SELECT concepto, importe FROM movimientos
      WHERE estado = 'pendiente' AND concepto_norm LIKE ? LIMIT 3`, [`%${patron}%`]
  );
  res.json({ n, ejemplos });
}));

// --------------------------------------------------------------------------
// Escritura
// --------------------------------------------------------------------------

/**
 * Clasificar a mano. Marca clasif_origen = 'manual', que es la señal de
 * "esto lo decidí yo": ninguna regla ni reclasificación lo tocará después.
 */
app.post('/api/clasificar', ruta(async (req, res) => {
  const { ids, categoriaId, estado = 'ok' } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'Selecciona al menos un movimiento.' });
  }
  if (estado !== 'ignorado' && !categoriaId) {
    return res.status(400).json({ error: 'Elige una categoría.' });
  }

  const [r] = await pool.query(
    `UPDATE movimientos
        SET categoria_id = ?, clasif_origen = 'manual', regla_id = NULL, estado = ?
      WHERE id IN (?)`,
    [categoriaId || null, estado, ids]
  );
  res.json({ actualizados: r.affectedRows });
}));

/** Crear regla y, opcionalmente, aplicarla al resto de pendientes. */
/** Listado de reglas para gestionarlas: uso, categoría, todo visible. */
app.get('/api/reglas', ruta(async (req, res) => {
  const [filas] = await pool.query(`
    SELECT r.id, r.patron, r.tipo_patron, r.origen, r.prioridad, r.excluir,
           r.activa, r.aciertos, r.ultima_vez, r.categoria_id,
           c.categoria, c.subcategoria
      FROM reglas r JOIN categorias c ON c.id = r.categoria_id
     ORDER BY r.prioridad ASC, r.aciertos DESC`);
  res.json(filas);
}));

app.patch('/api/reglas/:id', ruta(async (req, res) => {
  const id = Number(req.params.id);
  const [[actual]] = await pool.query('SELECT * FROM reglas WHERE id = ?', [id]);
  if (!actual) return res.status(404).json({ error: 'No existe esa regla.' });

  const patron = String(req.body.patron ?? actual.patron).trim().toLowerCase();
  const categoriaId = req.body.categoriaId ?? actual.categoria_id;
  const prioridad = req.body.prioridad ?? actual.prioridad;
  const excluir = req.body.excluir === undefined ? actual.excluir : (req.body.excluir ? 1 : 0);
  const activa = req.body.activa === undefined ? actual.activa : (req.body.activa ? 1 : 0);

  if (patron.length < 2) return res.status(400).json({ error: 'El patrón es demasiado corto.' });

  try {
    await pool.query(
      `UPDATE reglas SET patron=?, categoria_id=?, prioridad=?, excluir=?, activa=? WHERE id=?`,
      [patron, categoriaId, prioridad, excluir, activa, id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe una regla con ese patrón.' });
    throw e;
  }
  res.json({ ok: true });
}));

app.delete('/api/reglas/:id', ruta(async (req, res) => {
  await pool.query('DELETE FROM reglas WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/reglas', ruta(async (req, res) => {
  const { patron, categoriaId, prioridad = 100, aplicarAhora = true } = req.body;
  const p = String(patron || '').trim().toLowerCase();

  if (p.length < 3) {
    return res.status(400).json({ error: 'El patrón necesita al menos 3 caracteres.' });
  }
  if (!categoriaId) return res.status(400).json({ error: 'Elige una categoría.' });

  const cx = await pool.getConnection();
  try {
    await cx.beginTransaction();
    await cx.query(
      `INSERT INTO reglas (patron, tipo_patron, categoria_id, origen, prioridad)
       VALUES (?, 'contiene', ?, 'todos', ?)
       ON DUPLICATE KEY UPDATE categoria_id = VALUES(categoria_id),
                               prioridad    = VALUES(prioridad),
                               activa       = 1`,
      [p, categoriaId, prioridad]
    );
    const [[regla]] = await cx.query(
      "SELECT id FROM reglas WHERE patron = ? AND origen = 'todos'", [p]
    );

    let aplicados = 0;
    if (aplicarAhora) {
      const [r] = await cx.query(
        `UPDATE movimientos
            SET categoria_id = ?, clasif_origen = 'regla', regla_id = ?, estado = 'ok'
          WHERE estado = 'pendiente' AND concepto_norm LIKE ?`,
        [categoriaId, regla.id, `%${p}%`]
      );
      aplicados = r.affectedRows;
    }
    await cx.commit();
    res.json({ reglaId: regla.id, aplicados });
  } catch (e) {
    await cx.rollback();
    throw e;
  } finally {
    cx.release();
  }
}));

/**
 * Presupuesto vs real de un año. Devuelve una fila por subcategoría con los
 * 12 meses, para poder pintar la rejilla sin más consultas.
 *
 * Se cruzan por FULL JOIN a mano (UNION) porque hay categorías con
 * presupuesto y sin gasto, y otras con gasto que nunca se presupuestaron.
 * Un LEFT JOIN desde presupuesto se dejaría fuera las segundas, que son
 * justo las que interesa ver.
 */
/**
 * Datos agregados para el dashboard: todo en una sola consulta por bloque,
 * para no ir y venir 15 veces desde el navegador cada vez que se cambia
 * de año.
 */
app.get('/api/dashboard', ruta(async (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();

  // 1. Ingresos y gastos por mes (real).
  const [porMes] = await pool.query(`
    SELECT MONTH(m.fecha) mes,
           ROUND(SUM(CASE WHEN c.tipo='ingreso' THEN m.importe ELSE 0 END), 2) ingresos,
           ROUND(SUM(CASE WHEN c.tipo='gasto'   THEN m.importe ELSE 0 END), 2) gastos,
           ROUND(SUM(CASE WHEN c.tipo IN ('ahorro','inversion') THEN m.importe ELSE 0 END), 2) ahorro
      FROM movimientos m JOIN categorias c ON c.id = m.categoria_id
     WHERE YEAR(m.fecha) = ? AND m.estado <> 'ignorado'
     GROUP BY MONTH(m.fecha) ORDER BY mes`, [anio]);

  // 2. Gasto por categoría (para el reparto y el ranking).
  const [porCategoria] = await pool.query(`
    SELECT c.categoria, c.subcategoria, c.tipo, c.reparto,
           ROUND(SUM(m.importe), 2) importe, COUNT(*) n
      FROM movimientos m JOIN categorias c ON c.id = m.categoria_id
     WHERE YEAR(m.fecha) = ? AND m.estado <> 'ignorado' AND c.tipo = 'gasto'
     GROUP BY c.id, c.categoria, c.subcategoria, c.tipo, c.reparto
     ORDER BY importe ASC`, [anio]);

  // 3. Reparto 50/30/20: fijo, variable, ahorro+inversión.
  const [reparto] = await pool.query(`
    SELECT c.reparto, c.tipo, ROUND(SUM(m.importe), 2) importe
      FROM movimientos m JOIN categorias c ON c.id = m.categoria_id
     WHERE YEAR(m.fecha) = ? AND m.estado <> 'ignorado'
       AND c.tipo IN ('gasto','ahorro','inversion')
     GROUP BY c.reparto, c.tipo`, [anio]);

  // 4. Comparación con el año anterior, para ver tendencia.
  const [comparativa] = await pool.query(`
    SELECT YEAR(m.fecha) anio,
           ROUND(SUM(CASE WHEN c.tipo='ingreso' THEN m.importe ELSE 0 END), 2) ingresos,
           ROUND(SUM(CASE WHEN c.tipo='gasto'   THEN m.importe ELSE 0 END), 2) gastos
      FROM movimientos m JOIN categorias c ON c.id = m.categoria_id
     WHERE YEAR(m.fecha) IN (?, ?) AND m.estado <> 'ignorado'
     GROUP BY YEAR(m.fecha)`, [anio, anio - 1]);

  // 5. Estado de la clasificación, para el aviso de fiabilidad.
  const [[pend]] = await pool.query(`
    SELECT COUNT(*) n, ROUND(SUM(ABS(importe)), 2) importe
      FROM movimientos WHERE YEAR(fecha) = ? AND estado = 'pendiente'`, [anio]);

  const anios = (await pool.query(
    'SELECT DISTINCT YEAR(fecha) a FROM movimientos ORDER BY a DESC'))[0].map((r) => r.a);

  res.json({ anio, anios, porMes, porCategoria, reparto, comparativa, pendiente: pend });
}));

app.get('/api/anual', ruta(async (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();

  // OJO: nada de llamar `real` a una columna. REAL es palabra reservada en
  // MySQL (es un tipo de dato) y rompe la consulta como alias.
  const [filas] = await pool.query(`
    SELECT c.id, c.categoria, c.subcategoria, c.tipo, c.reparto, x.mes,
           ROUND(SUM(x.ppto), 2)       AS ppto,
           ROUND(SUM(x.realizado), 2)  AS realizado
      FROM (
        SELECT categoria_id, mes, importe AS ppto, 0 AS realizado
          FROM presupuesto WHERE anio = ?
        UNION ALL
        SELECT m.categoria_id, MONTH(m.fecha), 0, m.importe
          FROM movimientos m
          JOIN categorias cc ON cc.id = m.categoria_id
         WHERE YEAR(m.fecha) = ? AND m.estado <> 'ignorado' AND cc.tipo <> 'traspaso'
      ) x
      JOIN categorias c ON c.id = x.categoria_id
     GROUP BY c.id, c.categoria, c.subcategoria, c.tipo, c.reparto, x.mes
     HAVING ppto <> 0 OR realizado <> 0
     ORDER BY c.categoria, c.subcategoria, x.mes`, [anio, anio]);

  // Agrupar por subcategoría con los 12 meses en un array.
  const mapa = new Map();
  for (const f of filas) {
    if (!mapa.has(f.id)) {
      mapa.set(f.id, {
        id: f.id, categoria: f.categoria, subcategoria: f.subcategoria,
        tipo: f.tipo, reparto: f.reparto,
        ppto: Array(12).fill(0), real: Array(12).fill(0),
      });
    }
    const fila = mapa.get(f.id);
    fila.ppto[f.mes - 1] = Number(f.ppto);
    fila.real[f.mes - 1] = Number(f.realizado);
  }

  const anios = (await pool.query(
    `SELECT DISTINCT YEAR(fecha) a FROM movimientos
      UNION SELECT DISTINCT anio FROM presupuesto ORDER BY a DESC`
  ))[0].map((r) => r.a);

  res.json({ anio, anios, filas: [...mapa.values()] });
}));

/** Guardar una celda del presupuesto. importe = 0 borra la línea. */
app.put('/api/presupuesto', ruta(async (req, res) => {
  const { anio, mes, categoriaId } = req.body;
  const importe = Number(req.body.importe);

  if (!anio || !mes || !categoriaId || !Number.isFinite(importe)) {
    return res.status(400).json({ error: 'Faltan datos o el importe no es un número.' });
  }

  const [[c]] = await pool.query('SELECT tipo FROM categorias WHERE id = ?', [categoriaId]);
  if (!c) return res.status(404).json({ error: 'No existe esa categoría.' });

  // Se teclea siempre en positivo; el signo lo pone el tipo de la categoría.
  const valor = c.tipo === 'ingreso' ? Math.abs(importe) : -Math.abs(importe);

  if (importe === 0) {
    await pool.query(
      'DELETE FROM presupuesto WHERE anio = ? AND mes = ? AND categoria_id = ?',
      [anio, mes, categoriaId]);
    return res.json({ importe: 0 });
  }

  await pool.query(
    `INSERT INTO presupuesto (anio, mes, categoria_id, importe) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE importe = VALUES(importe)`,
    [anio, mes, categoriaId, valor]);
  res.json({ importe: valor });
}));

/** Copiar el importe de un mes al resto del año. */
app.post('/api/presupuesto/repetir', ruta(async (req, res) => {
  const { anio, mes, categoriaId, desdeMes } = req.body;
  const [[origen]] = await pool.query(
    'SELECT importe FROM presupuesto WHERE anio = ? AND mes = ? AND categoria_id = ?',
    [anio, desdeMes || mes, categoriaId]);
  if (!origen) return res.status(404).json({ error: 'Ese mes no tiene importe que copiar.' });

  const valores = [];
  for (let m = 1; m <= 12; m++) valores.push([anio, m, categoriaId, origen.importe]);
  await pool.query(
    `INSERT INTO presupuesto (anio, mes, categoria_id, importe) VALUES ?
     ON DUPLICATE KEY UPDATE importe = VALUES(importe)`, [valores]);
  res.json({ importe: origen.importe, meses: 12 });
}));

app.post('/api/reclasificar', ruta(async (req, res) => {
  res.json(await reclasificar({ incluirYaClasificados: false }));
}));

// --------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const puerto = Number(process.env.PUERTO || 3000);
// En Docker hace falta 0.0.0.0 para que Caddy llegue por la red interna.
// Fuera de Docker, 127.0.0.1 evita dejar el puerto abierto por la IP pública.
const host = process.env.HOST || '127.0.0.1';
app.listen(puerto, host, () => console.log(`Presupuesto en http://${host}:${puerto}`));
