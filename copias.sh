#!/bin/sh
# Volcado diario de la base. Guarda 30 días y borra lo anterior.
#
#   chmod +x copias.sh
#   crontab -e
#   15 4 * * *  cd /ruta/a/presupuesto && ./copias.sh >> copias/copias.log 2>&1
#
# El trabajo que no quieres repetir no son los movimientos (esos se
# reimportan en un minuto) sino la clasificación: 2.000 decisiones.

set -eu
cd "$(dirname "$0")"

FECHA=$(date '+%F %T')
FICHERO="copias/presupuesto-$(date +%F-%H%M).sql.gz"
mkdir -p copias

CLAVE=$(grep '^DB_PASS=' .env | cut -d= -f2-)
BASE=$(grep '^DB_NAME=' .env | cut -d= -f2-)
USUARIO=$(grep '^DB_USER=' .env | cut -d= -f2-)

# --no-tablespaces es imprescindible: sin él, mysqldump de MySQL 8 intenta
# leer INFORMATION_SCHEMA.FILES, necesita el privilegio PROCESS que este
# usuario no tiene, y aborta dejando un volcado con estructura y sin datos.
#
# MYSQL_PWD en vez de -p para que la clave no aparezca en la lista de procesos.
docker compose exec -T -e MYSQL_PWD="$CLAVE" db \
  mysqldump -u "$USUARIO" --single-transaction --no-tablespaces "$BASE" \
  > copias/parcial.sql

# Comprobar ANTES de comprimir. Un volcado sin INSERT es un volcado inútil,
# por muchos kilobytes que ocupe: la estructura sola no sirve de nada.
INSERTS=$(grep -c '^INSERT INTO' copias/parcial.sql || true)
if [ "$INSERTS" -lt 3 ]; then
  echo "$FECHA  ERROR: el volcado solo tiene $INSERTS sentencias INSERT. No se guarda."
  rm -f copias/parcial.sql
  exit 1
fi

MOVS=$(grep -c '^INSERT INTO `movimientos`' copias/parcial.sql || true)
if [ "$MOVS" -lt 1 ]; then
  echo "$FECHA  ERROR: no hay datos de movimientos en el volcado. No se guarda."
  rm -f copias/parcial.sql
  exit 1
fi

gzip -c copias/parcial.sql > "$FICHERO"
rm -f copias/parcial.sql

TAM=$(stat -c%s "$FICHERO")
find copias -name 'presupuesto-*.sql.gz' -mtime +30 -delete
echo "$FECHA  copia correcta: $FICHERO ($TAM bytes, $INSERTS INSERT)"