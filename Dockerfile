FROM node:22
WORKDIR /app

RUN npm install telegraf axios

COPY . .

CMD ["node", "index.js"]
