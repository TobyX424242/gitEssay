# gitEssay frontend — build the Vite bundle, then serve it with nginx.
#
#   docker build -t gitessay-frontend ./frontend
#
# Multi-stage: a Node build produces static assets; nginx serves them and
# reverse-proxies /api → the backend service (with SSE-friendly buffering off
# so the streaming agent works through the proxy).
FROM node:22-bookworm-slim AS build
WORKDIR /app

# .npmrc carries legacy-peer-deps=true (atlaskit vs React 19); copy it first.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# --- serve stage ---
FROM nginx:1.27-alpine AS serve

# nginx config (SPA fallback + /api reverse proxy with SSE buffering disabled).
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Built static bundle.
COPY --from=build /app/build /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
