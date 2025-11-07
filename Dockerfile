# Dockerfile
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create non-root user
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /app/books /app/assets \
  && chown -R app:app /app
USER app

ENV NODE_ENV=production

ENTRYPOINT ["node","main.js"]
