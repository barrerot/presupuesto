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
. ./.env

mkdir -p copias
FICHERO="copias/presupuesto-$(date +%F-%H%M).sql.gz"

docker compose exec -T db \
  mysqldump -u "$DB_USER" -p"$DB_PASS" --single-transaction --routines "$DB_NAME" \
  | gzip > "$FICHERO"

# Un volcado de 2 KB es un volcado fallido: mejor enterarse hoy que el día
# que haga falta restaurarlo.
TAM=$(stat -c%s "$FICHERO")
if [ "$TAM" -lt 20000 ]; then
  echo "$(date +%F\ %T)  AVISO: la copia solo ocupa $TAM bytes, revísala"
  exit 1
fi

find copias -name 'presupuesto-*.sql.gz' -mtime +30 -delete
echo "$(date +%F\ %T)  copia correcta: $FICHERO ($TAM bytes)"
