const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

// --- Servidor Web para QR Code ---
const app = express();
const PORT = process.env.PORT || 3000;
let qrImageBase64 = null;
app.get('/', (req, res) => {
  if (!qrImageBase64) return res.send('<h2>QR code não gerado ainda. Aguarde...</h2>');
  res.send(`
    <html><head><title>PieBot QR</title></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
      <h1>Escaneie com seu WhatsApp</h1>
      <img src="data:image/png;base64,${qrImageBase64}" />
    </body></html>
  `);
});
app.listen(PORT, () => console.log(`HTTP server em http://localhost:${PORT}`));

// --- Configuração do cliente WhatsApp Web ---
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
});

// Reconectar em caso de desconexão
client.on('disconnected', reason => {
  console.log('Desconectado:', reason, '. Tentando reconectar...');
  client.initialize();
});
client.on('auth_failure', msg => console.error('Falha de autenticação', msg));

// Geração do QR code
client.on('qr', async qr => {
  try {
    const url = await QRCode.toDataURL(qr);
    qrImageBase64 = url.split(',')[1];
    console.log('QR code gerado. Acesse / no navegador.');
  } catch (err) {
    console.error('Erro ao gerar QR code:', err);
  }
});

client.on('ready', () => console.log('Cliente WhatsApp Web pronto!'));

// --- Lógica de Mensagens ---
const greetedChats = new Set();
const MAX_STATIC = 1024 * 1024;  // 1MB
const MAX_DUR = 10;              // segundos animado

client.on('message', async msg => {
  try {
    if (msg.fromMe) return;
    const text = (msg.body || '').trim().toLowerCase();

    // Conexão
    if (text === '!ping') return msg.reply('Pong!');

    // Saudação inicial
    if (!greetedChats.has(msg.from)) {
      greetedChats.add(msg.from);
      await msg.reply(
        'Olá! Sou o PieBot 🤖\n' +
        '*!ping* para teste de conexão\n' +
        '*!s*    → Sticker estático (imagem)\n' +
        '*!sa*   → Sticker animado (GIF/vídeo como DOCUMENTO)'
      );
    }

    // Ajuda
    if (text === '!help') {
      return msg.reply(
        '*!ping* → Testa conexão\n' +
        '*!s* → Sticker estático: envie ou responda uma imagem com !s\n' +
        '*!sa* → Sticker animado: envie ou responda um GIF/vídeo como DOCUMENTO com !sa'
      );
    }

    // Sticker estático
    if (text === '!s') {
      let src = msg;
      if (!msg.hasMedia && msg.hasQuotedMsg) src = await msg.getQuotedMessage();
      if (!src.hasMedia) return msg.reply('Envie ou responda uma imagem com !s.');
      const media = await src.downloadMedia();
      if (!media?.data) return msg.reply('Falha ao baixar mídia.');
      const buf = Buffer.from(media.data, 'base64');
      let webp = await sharp(buf).resize(512,512,{fit:'cover'}).webp({quality:80}).toBuffer();
      if (webp.length > MAX_STATIC) {
        webp = await sharp(buf).resize(256,256,{fit:'cover'}).webp({quality:50}).toBuffer();
      }
      const sticker = new MessageMedia('image/webp', webp.toString('base64'));
      return msg.reply(sticker, undefined, { sendMediaAsSticker: true });
    }

    // Sticker animado
    if (text === '!sa') {
      let src = msg;
      if (!msg.hasMedia && msg.hasQuotedMsg) src = await msg.getQuotedMessage();
      if (!src.hasMedia) return msg.reply('Envie ou responda um GIF/vídeo como DOCUMENTO com !sa.');
      const media = await src.downloadMedia();
      if (!media?.data) return msg.reply('Falha ao baixar mídia.');
      const buf = Buffer.from(media.data, 'base64');
      let ext = media.mimetype.split('/')[1].split('+')[0] || 'mp4';
      if (ext === 'jpeg') ext = 'jpg';
      const inPath = path.join(__dirname, `temp_in.${ext}`);
      const outPath = path.join(__dirname, 'temp_out.webp');
      await fs.writeFile(inPath, buf);
      await new Promise((resolve, reject) => {
        ffmpeg(inPath)
          .inputOptions([`-t ${MAX_DUR}`])
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
      await fs.unlink(inPath).catch(() => {});
      await fs.unlink(outPath).catch(() => {});
      return;
    }
  } catch (err) {
    console.error('Erro no handler:', err);
  }
});

client.initialize();
