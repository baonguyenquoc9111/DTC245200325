FROM node:22-alpine

WORKDIR /app

RUN addgroup -S blog && adduser -S blog -G blog

COPY package*.json ./
RUN npm install --omit=dev

COPY --chown=blog:blog . .
RUN mkdir -p /app/uploads && chown blog:blog /app/uploads

USER blog

EXPOSE 3000

CMD ["node", "index.js"]