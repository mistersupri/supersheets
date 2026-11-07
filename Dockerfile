# Single image: builds the web app and the API, then serves both from the API.
FROM node:22-slim
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN cd apps/server && npx prisma generate && cd ../web && npx vite build && cd ../server && npx tsup
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/apps/web/dist
WORKDIR /app/apps/server
EXPOSE 3000
# Apply pending migrations, then start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
