FROM node:20-bookworm-slim AS base
WORKDIR /app

# Install dependencies (root + mission-control workspace)
COPY package.json package-lock.json ./
COPY mission-control/package.json ./mission-control/package.json
RUN npm ci

# Copy application source
COPY . .

# Build Mission Control static export so backend/server.js serves both API and UI on one port
ENV NEXT_PUBLIC_RELAY_API=""
RUN npm run build -w mission-control || true

EXPOSE 3001
ENV RELAY_PORT=3001
ENV RELAY_BIND_HOST=0.0.0.0
ENV RELAY_PUBLIC_READONLY=1
ENV RELAY_SKIP_GLOBAL_HOOKS=1

CMD ["node", "backend/server.js", "--port", "3001"]
