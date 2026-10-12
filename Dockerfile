FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build
# Check a real native query on the build target, without accessing runtime data.
RUN node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); if(db.prepare('SELECT 1 AS ok').get().ok!==1) throw new Error('SQLite unavailable'); db.close();"
FROM node:22-bookworm-slim
ENV NODE_ENV=production DEPLOYMENT=node DB_DRIVER=sqlite SQLITE_PATH=/data/open-alert.sqlite PORT=3000
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json /app/LICENSE /app/README.md ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm","start"]
