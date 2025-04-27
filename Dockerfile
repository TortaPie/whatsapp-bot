FROM node:18-bullseye

# libs necessárias ao Chromium + ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates fonts-liberation libappindicator3-1 libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
    libxdamage1 libxrandr2 libxkbcommon0 xdg-utils --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

ENV SESSION_PATH=/data
CMD ["node","index.js"]
