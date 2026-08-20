#!/usr/bin/env node
'use strict';

/**
 * CLI de importación.
 *
 *   node bin/importar.js uploads/extracto.xls
 *   node bin/importar.js uploads/paypal.csv
 *   node bin/importar.js --seco uploads/extracto.xls     simula, no escribe
 *   node bin/importar.js uploads/*.xls uploads/*.csv     varios de golpe
 *   node bin/importar.js --reclasificar                  reaplica reglas a lo pendiente
 *   node bin/importar.js --resumen                       estado actual
 */

const { importar, reclasificar } = require('../src/importador');
const { pool } = require('../src/db');

const eur = (n) => Number(n).toFixed(2).padStart(11) + ' €';

async function resumen() {
  const [[t]] = await pool.query(`
    SELECT COUNT(*) total,
           SUM(estado = 'pendiente') pendientes,
           SUM(estado = 'ok')        clasificados,
           SUM(estado = 'ignorado')  ignorados,
           MIN(fecha) desde, MAX(fecha) hasta
      FROM movimientos`);

  console.log('\n=== ESTADO ===');
  if (!t.total) { console.log('  (sin movimientos todavía)'); return; }

  const pct = ((t.clasificados / (t.total - t.ignorados)) * 100).toFixed(1);
  console.log(`  movimientos : ${t.total}  (${t.desde} -> ${t.hasta})`);
  console.log(`  clasificados: ${t.clasificados}  (${pct} % de lo clasificable)`);
  console.log(`  pendientes  : ${t.pendientes}`);
  console.log(`  ignorados   : ${t.ignorados}   (traspasos, financiación PayPal)`);

  const [top] = await pool.query(
    'SELECT concepto, importe, fecha FROM v_pendientes LIMIT 10'
  );
  if (top.length) {
    console.log('\n--- pendientes más gordos ---');
    top.forEach((m) => console.log(
      '  ', m.fecha.toISOString().slice(0, 10), eur(m.importe), ' ', m.concepto.slice(0, 58)
    ));
  }

  const [inc] = await pool.query('SELECT COUNT(*) n FROM v_incoherencias');
  if (inc[0].n) console.log(`\n  !! ${inc[0].n} incoherencias, mira la vista v_incoherencias`);
}

(async () => {
  const args = process.argv.slice(2);
  const seco = args.includes('--seco');
  const ficheros = args.filter((a) => !a.startsWith('--'));

  try {
    if (args.includes('--resumen')) { await resumen(); return; }

    if (args.includes('--reclasificar')) {
      const r = await reclasificar({ incluirYaClasificados: args.includes('--todo') });
      console.log(`revisados ${r.revisados}, reclasificados ${r.reclasificados}`);
      await resumen();
      return;
    }

    if (!ficheros.length) {
      console.error('uso: node bin/importar.js [--seco] <fichero...>');
      console.error('     node bin/importar.js --reclasificar [--todo]');
      console.error('     node bin/importar.js --resumen');
      process.exitCode = 1;
      return;
    }

    for (const f of ficheros) {
      console.log(`\n### ${f}${seco ? '   [SIMULACIÓN]' : ''}`);
      try {
        const r = await importar(f, { seco });
        if (r.nota) console.log('  ', r.nota);
        console.log(`   rango      : ${r.desde} -> ${r.hasta}`);
        console.log(`   leídos     : ${r.filas}`);
        console.log(`   nuevos     : ${r.nuevas}`);
        console.log(`   repetidos  : ${r.repetidas}`);
        if (r.clasificadasPorRegla !== undefined) {
          console.log(`   con regla  : ${r.clasificadasPorRegla}`);
          console.log(`   pendientes : ${r.pendientesDeClasificar}`);
        }
        if (r.saldosCuadran === false) console.log('   !! LOS SALDOS NO CUADRAN, revisa los avisos');
        if (r.avisos && r.avisos.length) {
          console.log(`   avisos     : ${r.avisos.length}`);
          r.avisos.slice(0, 5).forEach((a) => console.log('     -', JSON.stringify(a)));
        }
      } catch (e) {
        console.error('   ERROR:', e.message);
        process.exitCode = 1;
      }
    }

    if (!seco) await resumen();
  } finally {
    await pool.end();
  }
})();
