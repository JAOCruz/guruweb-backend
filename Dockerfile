FROM node:18-bullseye

WORKDIR /app

# System dependencies for native Node modules (Baileys/libsignal) and weasyprint
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-cffi \
    python3-brotli \
    make \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    libpango-1.0-0 \
    libharfbuzz0b \
    libpangoft2-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install weasyprint for PDF invoice generation
RUN pip3 install --no-cache-dir weasyprint

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
