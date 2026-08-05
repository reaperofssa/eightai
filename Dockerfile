FROM node:22-alpine

WORKDIR /app

RUN npm install telegraf axios

COPY . .

CMD ["node", "index.js"]
