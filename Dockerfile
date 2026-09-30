FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . ./
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
