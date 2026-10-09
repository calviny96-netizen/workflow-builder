FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/autoaudit/package.json ./packages/autoaudit/package.json
COPY packages/engine/package.json ./packages/engine/package.json
COPY packages/nodes/package.json ./packages/nodes/package.json
RUN npm ci
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm run build

FROM node:24-bookworm-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends python3 libseccomp2 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
EXPOSE 8787
CMD ["node", "apps/server/src/main.ts"]

FROM nginx:alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
