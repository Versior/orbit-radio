# 环听 Orbit：零依赖，不需要 npm install
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765

COPY . .
# data/ 是电台分布缓存，挂成卷可以避免每次重启都重新拉全库
RUN mkdir -p data && chown -R node:node data

USER node
EXPOSE 8765
VOLUME ["/app/data"]
CMD ["node", "server.mjs"]
