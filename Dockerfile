# Container image for the arxivsub-mcp stdio server.
# Used by Glama (and any container-based MCP host) to start the server and
# answer introspection (tools/list works without a key). Build from source so
# the image always matches the repo.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
