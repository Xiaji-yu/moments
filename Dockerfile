FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci
COPY server ./server
COPY web ./web
RUN npm run build -w server && npm run build -w web

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci --omit=dev -w server
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
ENV WEB_DIST=/app/web/dist
VOLUME /data
EXPOSE 8787
CMD ["node", "server/dist/index.js"]
