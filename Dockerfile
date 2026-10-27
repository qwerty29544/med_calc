FROM node:24.21.0-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.8.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/clinical/package.json packages/clinical/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/therapy/package.json packages/therapy/package.json
RUN pnpm install --frozen-lockfile
COPY --chown=node:node . .
ENV NEXT_TELEMETRY_DISABLED=1
ARG API_URL=http://api:3001
ENV API_URL=${API_URL}
RUN pnpm db:generate && pnpm content:compile && pnpm build
ENV NODE_ENV=production
USER node
EXPOSE 3000 3001
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
