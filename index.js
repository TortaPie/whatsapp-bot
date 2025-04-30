const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

// Configura servidor web para exibir QR code
const app = express();
const PORT = process.env.PORT || 3000;
let qrImageBase64 = null;

app.get('/', (req, res) => {
  if (!qrImageBase64) {
    return res.send('<h2>QR code ainda não gerado. Por favor, aguarde...</h2>');
  }
  res.send(`
    <html>
      <head><title>PieBot QR Code</title></head>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
        <h1>Escaneie este QR com seu WhatsApp</h1>
        <img src="data:image/png;base64,${qrImageBase64}" alt="QR Code" />
        <p>Depois disso, volte ao seu WhatsApp para usar o bot.</p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`Servidor HTTP rodando em http://localhost:${PORT}`));

// Inicializa cliente WhatsApp Web
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  }
});

// Gera QR code e atualiza página
client.on('qr', async qr => {
  try {
    const url = await QRCode.toDataURL(qr);
    qrImageBase64 = url.split(',')[1];
    console.log('QR code gerado e disponível em /');
  } catch (err) {
    console.error('Erro ao gerar QR code:', err);
  }
});

client.on('ready', () => console.log('Cliente WhatsApp Web pronto!'));

// Armazena chats já saudados
const greetedChats = new Set();

// Limites e parâmetros
const MAX_STATIC_SIZE = 1024 * 1024; // 1MB
const MAX_DURATION = 10; // 10 segundos para animados

client.on('message', async msg => {
  if (msg.fromMe) return;

  // Saudação inicial
  if (!greetedChats.has(msg.from)) {
    greetedChats.add(msg.from);
    await msg.reply(
      'Olá! Sou o PieBot 🤖\n' +
      'Use *!s* para stickers estáticos (imagem)\n' +
      'Use *!sa* para stickers animados (GIF/vídeo como DOCUMENTO)\n' +
      'Digite *!help* para mais detalhes.'
    );
  }

  const text = msg.body?.trim().toLowerCase();

  // Ajuda
  if (text === '!help') {
    return msg.reply(
      '*!s* → Sticker estático: envie/responda imagem com !s\n' +
      '*!sa* → Sticker animado: envie GIF/vídeo como DOCUMENTO com !sa'
    );
  }

  // Sticker estático
  if (text === '!s') {
    let src = msg;
    if (!msg.hasMedia && msg.hasQuotedMsg) src = await msg.getQuotedMessage();
    if (!src.hasMedia) {
      return msg.reply('Envie/responda uma imagem com !s para criar um sticker estático.');
    }
    try {
      const media = await src.downloadMedia();
      const buf = Buffer.from(media.data, 'base64');
      let webp = await sharp(buf)
        .resize(512,512, { fit: 'cover' })
        .webp({ quality: 80 })
        .toBuffer();
      if (webp.length > MAX_STATIC_SIZE) {
        webp = await sharp(buf)
          .resize(256,256, { fit: 'cover' })
          .webp({ quality: 50 })
          .toBuffer();
      }
      const sticker = new MessageMedia('image/webp', webp.toString('base64'));
      await msg.reply(sticker, undefined, { sendMediaAsSticker: true });
    } catch (err) {
      console.error('Erro sticker estático:', err);
      msg.reply('Erro ao criar sticker estático.');
    }
    return;
  }

  // Sticker animado
  if (text === '!sa') {
    let src = msg;
    if (!msg.hasMedia && msg.hasQuotedMsg) src = await msg.getQuotedMessage();
    if (!src.hasMedia) {
      return msg.reply('Envie/responda um GIF ou vídeo como DOCUMENTO com !sa para sticker animado.');
    }
    try {
      const media = await src.downloadMedia();
      const buf = Buffer.from(media.data, 'base64');
      const inPath = path.join(__dirname, 'temp_in');
      const outPath = path.join(__dirname, 'temp_out.webp');
      await fs.writeFile(inPath, buf);
      await new Promise((resolve, reject) => {
        ffmpeg(inPath)
          .inputOptions([`-t ${MAX_DURATION}`])
          .outputOptions([
            '-vcodec libwebp',
            '-loop 0',
            '-preset default',
            '-an',
            '-vsync 0',
            '-vf fps=10,scale=512:512:flags=lanczos',
            '-qscale 50',
            '-compression_level 6'
          ])
          .on('end', resolve)
          .on('error', reject)
          .save(outPath);
      });
      const webpBuf = await fs.readFile(outPath);
      const sticker = new MessageMedia('image/webp', webpBuf.toString('base64'));
      await msg.reply(sticker, undefined, { sendMediaAsSticker: true });
      await fs.unlink(inPath);
      await fs.unlink(outPath);
    } catch (err) {
      console.error('Erro sticker animado:', err);
      msg.reply('Erro ao criar sticker animado.');
    }
    return;
  }
});

client.initialize();
