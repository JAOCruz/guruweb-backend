FROM node:18-slim

WORKDIR /app

# Install Rust, Python, build tools, and weasyprint system deps
RUN apt-get update && apt-get install -y \
    curl \
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

# Install Rust (needed for libsignal-node prebuild fallback)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install weasyprint for PDF invoice generation
RUN pip3 install --no-cache-dir weasyprint

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
