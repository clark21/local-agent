FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
CMD ["node", "dist/main.js"]
