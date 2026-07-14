FROM node:18-alpine

WORKDIR /app

# Install build deps for native Node modules (Baileys/libsignal) and WeasyPrint
RUN apk add --no-cache python3 make g++ py3-pip py3-cffi pango-dev cairo-dev gdk-pixbuf-dev fontconfig-dev libffi-dev python3-dev
RUN pip3 install --no-cache-dir --break-system-packages weasyprint

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
