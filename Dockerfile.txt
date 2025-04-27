FROM node:18-bullseye
RUN apt-get update && apt-get install -y ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENV SESSION_PATH=/data
CMD ["node","index.js"]
