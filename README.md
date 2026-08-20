# Presupuesto

Sustituye el libro de Excel `Presupuesto_2026`. Importa los movimientos del
banco y de PayPal, los clasifica solo con reglas de texto y los cuadra contra
la previsión anual.

## Cómo está montado

```
bin/
  importar.js      CLI de importación
  servidor.js      API + servidor estático
db/
  schema.sql       tablas y vistas
  seed.sql         categorías y reglas iniciales
  presupuesto.sql  previsión 2026 volcada del Excel
src/
  db.js            pool de MySQL
  importador.js    inserción idempotente + motor de reglas
  parsers/
    parseBanco.js  extracto .xls del banco (BIFF, con columna de saldo)
    parsePaypal.js CSV de actividad de PayPal
public/
  index.html       bandeja: clasificar movimientos
  anual.html       presupuesto vs real
uploads/           extractos descargados (fuera del repositorio)
```

### Decisiones que conviene conocer antes de tocar nada

**Signos.** Los movimientos se guardan tal cual los da el banco: ingreso en
positivo, gasto en negativo. El presupuesto sigue el mismo convenio, y por eso
`v_ppto_vs_real` puede restar directamente. Si algún día un importe entra en
positivo siendo gasto, la desviación saldrá del doble.

**Idempotencia.** Cada movimiento lleva un `hash` (SHA-256 de
fecha|concepto|importe|origen) más un `hash_seq` que desempata los que son
legítimamente idénticos el mismo día (dos cafés de 1,50 €). Subir el mismo
extracto veinte veces no duplica nada, así que se puede descargar siempre con
solape.

En PayPal no hace falta: su `Id. de transacción` ya es único y estable.

**`clasif_origen`.** Distingue lo que decidiste a mano (`manual`) de lo que
puso una regla (`regla`). Reclasificar **nunca** toca lo manual. Es la
garantía de que reorganizar reglas no borra tu criterio.

**Traspasos.** Las transferencias entre cuentas propias y los cargos de
financiación de PayPal se marcan como `ignorado` y quedan fuera de ingresos y
gastos. Sin eso, mover dinero de una cuenta a otra aparecería como ingreso.

**PayPal es una cuenta aparte, no una conciliación.** El extracto del banco
solo dice "Recibo Paypal Europe"; la compra real la aporta el CSV de PayPal.
Los cargos del banco se excluyen por regla y el detalle entra del CSV. Si se
importaran los dos, el gasto saldría por duplicado.

## Puesta en marcha desde cero

```bash
npm install
cp .env.example .env      # y rellenar

mysql -u root -p -e "CREATE DATABASE presupuesto CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u presupuesto -p presupuesto < db/schema.sql
mysql -u presupuesto -p presupuesto < db/seed.sql
mysql -u presupuesto -p presupuesto < db/presupuesto.sql
```

El orden importa: `seed.sql` referencia categorías por nombre y
`presupuesto.sql` referencia las categorías del seed.

Comprobación: 125 categorías, 104 reglas, 0 reglas sin categoría.

```bash
npm run db:estado
```

## Uso semanal

1. Descargar de la banca electrónica el extracto **de la cuenta** (no el de
   tarjeta: se solapan y se duplicaría el gasto). Rango con solape, dos
   semanas para una descarga semanal.
2. Descargar de PayPal: Actividad → Descargar → informe de actividad, CSV.
3. Dejarlos en `uploads/` e importar:

```bash
npm run importar uploads/extracto.xls
npm run importar uploads/paypal.csv
```

El del banco tiene que decir `saldosCuadran: true`. Ese campo comprueba que
el saldo de apertura más la suma de importes da el saldo final, y que el
saldo previo de cada apunte existe como saldo de otro. Si falla, falta o
sobra alguna fila.

4. Abrir la bandeja y vaciar los pendientes. Al clasificar algo repetitivo,
   crear la regla: la próxima importación lo hará sola.

```bash
npm start        # http://localhost:3000
npm run dev      # se reinicia al guardar
```

## Comandos

| | |
|---|---|
| `npm start` | servidor |
| `npm run dev` | servidor con recarga |
| `npm run importar <fichero>` | importar |
| `npm run importar:seco <fichero>` | simular sin escribir |
| `npm run reclasificar` | reaplicar reglas a lo pendiente |
| `npm run resumen` | estado por consola |
| `npm run db:estado` | conteos y comprobación de incoherencias |
| `npm run db:backup` | volcado con fecha |

## Despliegue en el VPS

Con Docker Compose y `caddy-docker-proxy`, publicado en un subdominio pero
**accesible solo desde WireGuard**.

```bash
git clone git@github.com:barrerot/presupuesto.git
cd presupuesto
cp .env.example .env      # rellenar DOMINIO y REDES_VPN
docker compose up -d --build
docker compose logs -f app
```

Los `.sql` de `db/` se ejecutan solos la primera vez que arranca el
contenedor de MySQL, con el volumen vacío.

### Traer los datos de la máquina de desarrollo

Para no perder la clasificación ya hecha, en lugar de partir de cero:

```bash
# en local
mysqldump -u presupuesto -p --single-transaction --routines presupuesto > volcado.sql
scp volcado.sql hestiabuluu.es:~/

# en el VPS
docker compose exec -T db mysql -u presupuesto -p presupuesto < ~/volcado.sql
```

El volcado incluye `DROP TABLE IF EXISTS`, así que sobrescribe lo que creó la
inicialización sin conflictos.

### Seguridad

La app **no tiene autenticación**. Es deliberado: el control de acceso lo
hace la VPN. Por eso:

- El puerto 3000 **no se publica** en el host. Solo se llega por la red
  interna de Docker, es decir, a través de Caddy.
- Caddy responde 403 a todo lo que no venga de las redes de `REDES_VPN`.
- Si algún día se quita el filtro por IP, hay que poner `basic_auth` **antes**.

Averiguar la red que usa wg-easy:

```bash
docker exec wg-easy ip -4 addr show wg0 | grep inet
```

### Copias

```bash
chmod +x copias.sh
crontab -e
# 15 4 * * *  cd /ruta/a/presupuesto && ./copias.sh >> copias/copias.log 2>&1
```

Guarda 30 días y avisa si el volcado sale sospechosamente pequeño. Conviene
sacar las copias fuera del VPS: lo que duele perder no son los movimientos
—se reimportan en un minuto— sino las 2.000 decisiones de clasificación.

## Pendiente

- Subir los ficheros desde el navegador, en vez de por consola.
- Pantalla para ver, editar y borrar reglas.
- Resumen anual por categoría y reparto 50/30/20.
- Exportar a Google Sheets como respaldo.
