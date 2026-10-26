# bakrim filter UI — admin page + rules API + AllManga web resolver
# (zero npm dependencies)
FROM node:20-alpine
WORKDIR /app
COPY server.js index.html allmanga.js ./
ENV NODE_ENV=production
ENV HOME=/tmp
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
