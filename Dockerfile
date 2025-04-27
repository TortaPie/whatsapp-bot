FROM node:18-slim

WORKDIR /app

# instala Chromium e libs necessárias
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libgbm1 \
    libasound2 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# copia manifestos e instala deps
COPY package.json package-lock.json ./
RUN npm ci --production

# copia código e assets
COPY . .

# configura porta e path do Chromium
ENV PORT=3000
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
EXPOSE 3000

# start
CMD ["npm", "start"]
