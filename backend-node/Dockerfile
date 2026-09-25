FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY db ./db
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
