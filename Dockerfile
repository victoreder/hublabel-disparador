# ---- build: bundle + ofuscação (o código-fonte não vai para a imagem final) ----
FROM node:22-alpine AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs

ARG LICENSE_PUBLIC_KEY
ARG LICENSE_SERVER_URL
RUN LICENSE_PUBLIC_KEY="$LICENSE_PUBLIC_KEY" LICENSE_SERVER_URL="$LICENSE_SERVER_URL" node scripts/build.mjs

# ---- runtime ----
FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /build/dist/src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3080

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3080/health || exit 1

# Meta (padrão): node src/index.js
# Evolution:       node src/workers/evolution.js
# Inbound:         node src/inbound.js
CMD ["node", "src/index.js"]
