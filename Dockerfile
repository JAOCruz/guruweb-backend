FROM node:18-alpine

WORKDIR /app

# Install build deps for native Node modules (Baileys/libsignal)
RUN apk add --no-cache python3 make g++

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
