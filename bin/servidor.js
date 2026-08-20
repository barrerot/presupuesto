"use strict";

/**
 * API + servidor estático de la app de presupuesto.
 *   node bin/servidor.js       -> http://localhost:3000
 */

const express = require("express");
const path = require("path");
const { pool } = require("../src/db");
const { reclasificar } = require("../src/importador");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/** Envuelve un handler async para que los errores lleguen al middleware. */
const ruta = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// --------------------------------------------------------------------------
// Lectura
// --------------------------------------------------------------------------

app.get(
  "/api/resumen",
  ruta(async (req, res) => {
    const [[t]] = await pool.query(`
    SELECT COUNT(*) total,
           SUM(estado = 'pendiente') pendientes,
           SUM(estado = 'ok')        clasificados,
           SUM(estado = 'ignorado')  ignorados,
           ROUND(SUM(CASE WHEN estado = 'pendiente' THEN importe ELSE 0 END), 2) importePendiente,
           MIN(fecha) desde, MAX(fecha) hasta
      FROM movimientos`);
    res.json(t);
  }),
);

/** Bandeja de entrada. Ordenable y filtrable por columna. */
const ORDENABLES = {
  fecha: "m.fecha",
  concepto: "m.concepto_norm",
  importe: "ABS(m.importe)",
  origen: "m.origen",
  categoria: "c.categoria",
};

app.get(
  "/api/pendientes",
  ruta(async (req, res) => {
    const limite = Math.min(Number(req.query.limite) || 100, 500);
    const desplaz = Math.max(Number(req.query.pagina) || 0, 0) * limite;

    const where = [];
    const args = [];

    // Por defecto la bandeja; 'todos' permite revisar y corregir lo ya hecho.
    const estado = req.query.estado || "pendiente";
    if (estado !== "todos") {
      where.push("m.estado = ?");
      args.push(estado);
    }

    const q = (req.query.q || "").trim();
    if (q) {
      where.push(
        "(m.concepto_norm LIKE ? OR c.subcategoria LIKE ? OR c.categoria LIKE ?)",
      );
      args.push(`%${q.toLowerCase()}%`, `%${q}%`, `%${q}%`);
    }

    if (req.query.origen) {
      where.push("m.origen = ?");
      args.push(req.query.origen);
    }
    if (req.query.categoriaId) {
      where.push("m.categoria_id = ?");
      args.push(req.query.categoriaId);
    }
    if (req.query.fechaDesde) {
      where.push("m.fecha >= ?");
      args.push(req.query.fechaDesde);
    }
    if (req.query.fechaHasta) {
      where.push("m.fecha <= ?");
      args.push(req.query.fechaHasta);
    }

    // El filtro de importe va sobre el valor absoluto: pensamos en "cuánto",
    // no en el signo.
    if (req.query.min !== undefined && req.query.min !== "") {
      where.push("ABS(m.importe) >= ?");
      args.push(Number(req.query.min));
    }
    if (req.query.max !== undefined && req.query.max !== "") {
      where.push("ABS(m.importe) <= ?");
      args.push(Number(req.query.max));
    }
    if (req.query.signo === "gasto") where.push("m.importe < 0");
    if (req.query.signo === "ingreso") where.push("m.importe > 0");

    const col = ORDENABLES[req.query.orden] || "ABS(m.importe)";
    const dir = String(req.query.dir).toLowerCase() === "asc" ? "ASC" : "DESC";
    const filtro = where.length ? where.join(" AND ") : "1";
    const desde =
      "FROM movimientos m LEFT JOIN categorias c ON c.id = m.categoria_id";

    const [filas] = await pool.query(
      `SELECT m.id, m.fecha, m.concepto, m.importe, m.origen, m.estado,
            m.clasif_origen, m.categoria_id,
            c.categoria, c.subcategoria, c.tipo
       ${desde}
      WHERE ${filtro}
      ORDER BY ${col} ${dir}, m.id DESC
      LIMIT ? OFFSET ?`,
      [...args, limite, desplaz],
    );

    const [[agg]] = await pool.query(
      `SELECT COUNT(*) total, ROUND(SUM(m.importe), 2) suma ${desde} WHERE ${filtro}`,
      args,
    );

    // Los ids de TODO lo que casa, para poder actuar sobre el filtro completo
    // y no solo sobre la página visible.
    let ids = [];
    if (req.query.ids === "1" && agg.total <= 2000) {
      const [r] = await pool.query(
        `SELECT m.id ${desde} WHERE ${filtro}`,
        args,
      );
      ids = r.map((x) => x.id);
    }

    res.json({ total: agg.total, suma: agg.suma || 0, filas, ids });
  }),
);

/** Devolver a la bandeja algo que se clasificó mal. */
app.post(
  "/api/despejar",
  ruta(async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res
        .status(400)
        .json({ error: "Selecciona al menos un movimiento." });
    }
    const [r] = await pool.query(
      `UPDATE movimientos
        SET categoria_id = NULL, clasif_origen = NULL, regla_id = NULL, estado = 'pendiente'
      WHERE id IN (?)`,
      [ids],
    );
    res.json({ actualizados: r.affectedRows });
  }),
);

app.get(
  "/api/categorias",
  ruta(async (req, res) => {
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
      WHERE activa = 1 ORDER BY categoria, subcategoria`,
    );
    res.json(filas);
  }),
);

/** El reparto 50/30/20 se deduce del tipo: un dato menos que rellenar. */
function repartoDe(tipo, reparto) {
  if (tipo === "gasto") return reparto === "fijo" ? "fijo" : "variable";
  if (tipo === "ahorro" || tipo === "inversion") return "ahorro_inversion";
  return null;
}

const TIPOS = ["ingreso", "gasto", "ahorro", "inversion", "traspaso"];

app.post(
  "/api/categorias",
  ruta(async (req, res) => {
    const categoria = String(req.body.categoria || "").trim();
    const subcategoria = String(req.body.subcategoria || "").trim();
    const tipo = String(req.body.tipo || "gasto");

    if (!categoria || !subcategoria) {
      return res
        .status(400)
        .json({ error: "Hacen falta categoría y subcategoría." });
    }
    if (!TIPOS.includes(tipo))
      return res.status(400).json({ error: "Tipo no válido." });

    const [dup] = await pool.query(
      "SELECT id, activa FROM categorias WHERE categoria = ? AND subcategoria = ?",
      [categoria, subcategoria],
    );
    if (dup.length) {
      // Ya existía pero estaba desactivada: reactivarla es lo que se espera.
      if (!dup[0].activa) {
        await pool.query("UPDATE categorias SET activa = 1 WHERE id = ?", [
          dup[0].id,
        ]);
        return res.json({ id: dup[0].id, reactivada: true });
      }
      return res.status(409).json({ error: "Esa categoría ya existe." });
    }

    const [r] = await pool.query(
      `INSERT INTO categorias (categoria, subcategoria, tipo, reparto, orden)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(orden), 0) + 10 FROM categorias c))`,
      [categoria, subcategoria, tipo, repartoDe(tipo, req.body.reparto)],
    );
    res.json({ id: r.insertId });
  }),
);

app.patch(
  "/api/categorias/:id",
  ruta(async (req, res) => {
    const id = Number(req.params.id);
    const [[actual]] = await pool.query(
      "SELECT * FROM categorias WHERE id = ?",
      [id],
    );
    if (!actual)
      return res.status(404).json({ error: "No existe esa categoría." });

    const categoria = String(req.body.categoria ?? actual.categoria).trim();
    const subcategoria = String(
      req.body.subcategoria ?? actual.subcategoria,
    ).trim();
    const tipo = req.body.tipo ?? actual.tipo;
    const activa =
      req.body.activa === undefined ? actual.activa : req.body.activa ? 1 : 0;

    if (!categoria || !subcategoria) {
      return res
        .status(400)
        .json({ error: "Hacen falta categoría y subcategoría." });
    }
    if (!TIPOS.includes(tipo))
      return res.status(400).json({ error: "Tipo no válido." });

    try {
      await pool.query(
        `UPDATE categorias SET categoria = ?, subcategoria = ?, tipo = ?, reparto = ?, activa = ?
        WHERE id = ?`,
        [
          categoria,
          subcategoria,
          tipo,
          repartoDe(tipo, req.body.reparto ?? actual.reparto),
          activa,
          id,
        ],
      );
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") {
        return res
          .status(409)
          .json({ error: "Ya hay otra categoría con ese nombre." });
      }
      throw e;
    }
    res.json({ ok: true });
  }),
);

/**
 * Borrar solo si no se usa. Si hay movimientos colgando, el ON DELETE SET NULL
 * los dejaría sin categoría en silencio; mejor obligar a desactivar.
 */
app.delete(
  "/api/categorias/:id",
  ruta(async (req, res) => {
    const id = Number(req.params.id);
    const [[{ usos }]] = await pool.query(
      "SELECT COUNT(*) usos FROM movimientos WHERE categoria_id = ?",
      [id],
    );
    const [[{ n: reglas }]] = await pool.query(
      "SELECT COUNT(*) n FROM reglas WHERE categoria_id = ?",
      [id],
    );
    if (usos || reglas) {
      return res.status(409).json({
        error: `En uso: ${usos} movimientos y ${reglas} reglas. Desactívala en vez de borrarla.`,
      });
    }
    await pool.query("DELETE FROM categorias WHERE id = ?", [id]);
    res.json({ ok: true });
  }),
);

/**
 * Cuántos movimientos cogería un patrón. Alimenta el "aplicar a otros N".
 * Solo mira lo pendiente: no propone tocar lo ya decidido.
 */
app.get(
  "/api/coincidencias",
  ruta(async (req, res) => {
    const patron = (req.query.patron || "").trim().toLowerCase();
    if (patron.length < 3) return res.json({ n: 0, ejemplos: [] });

    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) n FROM movimientos
      WHERE estado = 'pendiente' AND concepto_norm LIKE ?`,
      [`%${patron}%`],
    );
    const [ejemplos] = await pool.query(
      `SELECT concepto, importe FROM movimientos
      WHERE estado = 'pendiente' AND concepto_norm LIKE ? LIMIT 3`,
      [`%${patron}%`],
    );
    res.json({ n, ejemplos });
  }),
);

// --------------------------------------------------------------------------
// Escritura
// --------------------------------------------------------------------------

/**
 * Clasificar a mano. Marca clasif_origen = 'manual', que es la señal de
 * "esto lo decidí yo": ninguna regla ni reclasificación lo tocará después.
 */
app.post(
  "/api/clasificar",
  ruta(async (req, res) => {
    const { ids, categoriaId, estado = "ok" } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res
        .status(400)
        .json({ error: "Selecciona al menos un movimiento." });
    }
    if (estado !== "ignorado" && !categoriaId) {
      return res.status(400).json({ error: "Elige una categoría." });
    }

    const [r] = await pool.query(
      `UPDATE movimientos
        SET categoria_id = ?, clasif_origen = 'manual', regla_id = NULL, estado = ?
      WHERE id IN (?)`,
      [categoriaId || null, estado, ids],
    );
    res.json({ actualizados: r.affectedRows });
  }),
);

/** Crear regla y, opcionalmente, aplicarla al resto de pendientes. */
app.post(
  "/api/reglas",
  ruta(async (req, res) => {
    const {
      patron,
      categoriaId,
      prioridad = 100,
      aplicarAhora = true,
    } = req.body;
    const p = String(patron || "")
      .trim()
      .toLowerCase();

    if (p.length < 3) {
      return res
        .status(400)
        .json({ error: "El patrón necesita al menos 3 caracteres." });
    }
    if (!categoriaId)
      return res.status(400).json({ error: "Elige una categoría." });

    const cx = await pool.getConnection();
    try {
      await cx.beginTransaction();
      await cx.query(
        `INSERT INTO reglas (patron, tipo_patron, categoria_id, origen, prioridad)
       VALUES (?, 'contiene', ?, 'todos', ?)
       ON DUPLICATE KEY UPDATE categoria_id = VALUES(categoria_id),
                               prioridad    = VALUES(prioridad),
                               activa       = 1`,
        [p, categoriaId, prioridad],
      );
      const [[regla]] = await cx.query(
        "SELECT id FROM reglas WHERE patron = ? AND origen = 'todos'",
        [p],
      );

      let aplicados = 0;
      if (aplicarAhora) {
        const [r] = await cx.query(
          `UPDATE movimientos
            SET categoria_id = ?, clasif_origen = 'regla', regla_id = ?, estado = 'ok'
          WHERE estado = 'pendiente' AND concepto_norm LIKE ?`,
          [categoriaId, regla.id, `%${p}%`],
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
  }),
);

/**
 * Presupuesto vs real de un año. Devuelve una fila por subcategoría con los
 * 12 meses, para poder pintar la rejilla sin más consultas.
 *
 * Se cruzan por FULL JOIN a mano (UNION) porque hay categorías con
 * presupuesto y sin gasto, y otras con gasto que nunca se presupuestaron.
 * Un LEFT JOIN desde presupuesto se dejaría fuera las segundas, que son
 * justo las que interesa ver.
 */
app.get(
  "/api/anual",
  ruta(async (req, res) => {
    const anio = Number(req.query.anio) || new Date().getFullYear();

    // OJO: nada de llamar `real` a una columna. REAL es palabra reservada en
    // MySQL (es un tipo de dato) y rompe la consulta como alias.
    const [filas] = await pool.query(
      `
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
     ORDER BY c.categoria, c.subcategoria, x.mes`,
      [anio, anio],
    );

    // Agrupar por subcategoría con los 12 meses en un array.
    const mapa = new Map();
    for (const f of filas) {
      if (!mapa.has(f.id)) {
        mapa.set(f.id, {
          id: f.id,
          categoria: f.categoria,
          subcategoria: f.subcategoria,
          tipo: f.tipo,
          reparto: f.reparto,
          ppto: Array(12).fill(0),
          real: Array(12).fill(0),
        });
      }
      const fila = mapa.get(f.id);
      fila.ppto[f.mes - 1] = Number(f.ppto);
      fila.real[f.mes - 1] = Number(f.realizado);
    }

    const anios = (
      await pool.query(
        `SELECT DISTINCT YEAR(fecha) a FROM movimientos
      UNION SELECT DISTINCT anio FROM presupuesto ORDER BY a DESC`,
      )
    )[0].map((r) => r.a);

    res.json({ anio, anios, filas: [...mapa.values()] });
  }),
);

/** Guardar una celda del presupuesto. importe = 0 borra la línea. */
app.put(
  "/api/presupuesto",
  ruta(async (req, res) => {
    const { anio, mes, categoriaId } = req.body;
    const importe = Number(req.body.importe);

    if (!anio || !mes || !categoriaId || !Number.isFinite(importe)) {
      return res
        .status(400)
        .json({ error: "Faltan datos o el importe no es un número." });
    }

    const [[c]] = await pool.query("SELECT tipo FROM categorias WHERE id = ?", [
      categoriaId,
    ]);
    if (!c) return res.status(404).json({ error: "No existe esa categoría." });

    // Se teclea siempre en positivo; el signo lo pone el tipo de la categoría.
    const valor = c.tipo === "ingreso" ? Math.abs(importe) : -Math.abs(importe);

    if (importe === 0) {
      await pool.query(
        "DELETE FROM presupuesto WHERE anio = ? AND mes = ? AND categoria_id = ?",
        [anio, mes, categoriaId],
      );
      return res.json({ importe: 0 });
    }

    await pool.query(
      `INSERT INTO presupuesto (anio, mes, categoria_id, importe) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE importe = VALUES(importe)`,
      [anio, mes, categoriaId, valor],
    );
    res.json({ importe: valor });
  }),
);

/** Copiar el importe de un mes al resto del año. */
app.post(
  "/api/presupuesto/repetir",
  ruta(async (req, res) => {
    const { anio, mes, categoriaId, desdeMes } = req.body;
    const [[origen]] = await pool.query(
      "SELECT importe FROM presupuesto WHERE anio = ? AND mes = ? AND categoria_id = ?",
      [anio, desdeMes || mes, categoriaId],
    );
    if (!origen)
      return res
        .status(404)
        .json({ error: "Ese mes no tiene importe que copiar." });

    const valores = [];
    for (let m = 1; m <= 12; m++)
      valores.push([anio, m, categoriaId, origen.importe]);
    await pool.query(
      `INSERT INTO presupuesto (anio, mes, categoria_id, importe) VALUES ?
     ON DUPLICATE KEY UPDATE importe = VALUES(importe)`,
      [valores],
    );
    res.json({ importe: origen.importe, meses: 12 });
  }),
);

app.post(
  "/api/reclasificar",
  ruta(async (req, res) => {
    res.json(await reclasificar({ incluirYaClasificados: false }));
  }),
);

// --------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const puerto = Number(process.env.PUERTO || 3000);
app.listen(puerto, () =>
  console.log(`Presupuesto en http://localhost:${puerto}`),
);
