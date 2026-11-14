# Build from the repo root (the server reuses classifiers from src/utils):
#   docker build -f server/Dockerfile -t takziv-server .
# The same image runs the scheduled sync as a Cloud Run Job by overriding the
# command: node build/server/src/syncJob.js

FROM node:22-bookworm-slim AS build
WORKDIR /app/server
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
# The shared modules listed in server/tsconfig.json; only those are compiled.
COPY src/types /app/src/types
COPY src/utils /app/src/utils
# With "module": "NodeNext", tsc picks ESM vs CommonJS per file from the
# nearest package.json "type". The root package.json (which says "module")
# isn't in the image, so without this the shared src/ files compile to
# CommonJS, and the ESM server then fails at startup with "does not provide
# an export named …".
RUN echo '{"type":"module"}' > /app/package.json
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# System Chromium + the shared libraries/fonts it needs (Hebrew bank pages).
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-liberation ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PORT=8080
WORKDIR /app/server
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/build ./build
COPY server/package.json ./
USER node
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "build/server/src/index.js"]
