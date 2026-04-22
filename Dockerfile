# Stage 1 — install + build
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2 — production deps only
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 3 — minimal runtime image
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as an unprivileged user.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=builder /app/dist        ./dist
COPY package.json ./

USER appuser

EXPOSE 3200

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD wget -qO- http://localhost:3200/healthz || exit 1

ENTRYPOINT ["node", "dist/index.js"]
