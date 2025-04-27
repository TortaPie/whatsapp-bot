# imagem base leve
FROM node:18-alpine

# diretório de trabalho
WORKDIR /app

# 1) copie package.json e package-lock.json
COPY package.json package-lock.json ./

# 2) instale só deps de produção
RUN npm ci --production

# 3) copie o restante do código
COPY . .

# variável de porta
ENV PORT=3000
EXPOSE 3000

# 4) startup
CMD ["npm", "start"]
