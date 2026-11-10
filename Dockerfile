# ---- build the web app
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/fetch-server.js && npm run build

# ---- runtime: Node + adb
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends adb ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY web/src/shared ./web/src/shared
COPY --from=build /app/web/public ./web/public
COPY --from=build /app/dist ./dist
EXPOSE 8000
# adb keys live here: mount a volume so phones stay authorized across restarts
VOLUME ["/root/.android"]
CMD ["node", "server/index.js"]
