FROM node:22-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY crane-section/package*.json crane-section/
RUN cd crane-section && npm install

COPY . .

EXPOSE 3000
CMD cd crane-section && npm run deploy; cd .. && node server.js
