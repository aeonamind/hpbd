FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY server.js ./
COPY public ./public
USER 1000
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
