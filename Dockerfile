FROM node:22-alpine

# mysql-client para los volcados de seguridad desde el propio contenedor
RUN apk add --no-cache mysql-client tzdata
ENV TZ=Europe/Madrid

WORKDIR /app

# Las dependencias primero: así el cache de capas no se invalida al tocar código.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p uploads && chown -R node:node /app
USER node

ENV NODE_ENV=production HOST=0.0.0.0 PUERTO=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/resumen').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/servidor.js"]
