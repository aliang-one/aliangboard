# syntax=docker/dockerfile:1

# ---- build：编译前端 dist/（含 devDeps：vite/tailwind/…）----
FROM node:25-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime：单进程 Node 服务 API + 静态 ----
FROM node:25-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/ ./server/
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app/data
ARG VERSION=dev
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production APP_VERSION=${VERSION}
USER node
EXPOSE 8787
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "server/index.mjs"]
