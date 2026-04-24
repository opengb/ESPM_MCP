# ESPM MCP server — HTTP transport.
#
# Build:
#   docker build -t espm-mcp .
#
# Run (mount your accounts.csv read-only):
#   docker run --rm -p 3000:3000 \
#     -v "$(pwd)/accounts.csv:/app/accounts.csv:ro" \
#     espm-mcp

FROM node:20-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000

EXPOSE 3000

USER node

CMD ["node", "src/main.js", "http"]
