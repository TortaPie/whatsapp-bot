node_modules/
.wwebjs_auth/
.wwebjs_cache/
npm-debug.log*

# ---------- Base ----------
FROM node:18-bullseye

# ---------- Dependências para Chromium + FFmpeg ----------
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates fonts-liberation libappindicator3-1 libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
    libxdamage1 libxrandr2 libxkbcommon0 xdg-utils --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# ---------- App ----------
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# volume onde ficará a sessão
ENV SESSION_PATH=/data

CMD ["node","index.js"]
