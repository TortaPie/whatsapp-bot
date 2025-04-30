// index.js

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

// --- HTTP Server for QR Code ---
const app = express();
const PORT = process.env.PORT || 3000;
let qrImageBase64 = '';
app.get('/', (req, res) => {
  const content = qrImageBase64
    ? `<img src="data:image/png;base64,${qrImageBase64}" />`
    : '<h2>QR Code não disponível. Aguarde...</h2>';
  res.send(`<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;">${content}</body></html>`);
});
app.listen(PORT, () => console.log(`QR server listening at http://localhost:${PORT}`));

// --- WhatsApp Web Client ---
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true, args: ['--no-sandbox'] }
});

// Reconnection handlers
client.on('auth_failure', () => {
  console.error('Authentication failure, restarting session...');
  client.logout().then(() => client.initialize());
});
client.on('disconnected', () => {
  console.warn('Client disconnected, reconnecting...');
  client.initialize();
});

// Generate QR Code
client.on('qr', async qr => {
  try {
    const dataUrl = await QRCode.toDataURL(qr);
    qrImageBase64 = dataUrl.split(',')[1];
    console.log('QR Code generated. Open browser to scan.');
  } catch (err) {
    console.error('Error generating QR Code', err);
  }
});

client.on('ready', () => console.log('WhatsApp client is ready.'));

// --- Bot Logic ---
const greeted = new Set();
const MAX_STATIC_SIZE = 1024 * 1024; // 1MB
const MAX_DURATION = 10; // seconds

client.on('message', async msg => {
  if (msg.fromMe) return;
  const body = (msg.body || '').trim();
  const cmd = body.toLowerCase();

  // Ping
  if (cmd === '!ping') {
    await client.sendMessage(msg.from, 'Pong!');
    return;
  }

  // Welcome message
  if (!greeted.has(msg.from)) {
    greeted.add(msg.from);
    await client.sendMessage(msg.from,
      'Olá! Eu sou o PieBot 🤖\n' +
      '*!ping* → Testa conexão\n' +
      '*!s*    → Sticker estático (imagem)\n' +
      '*!sa*   → Sticker animado (GIF/vídeo como DOCUMENTO)'
    );
  }

  // Help
  if (cmd === '!help') {
    await client.sendMessage(msg.from,
      '*!ping* → Testa conexão\n' +
      '*!s* → Sticker estático: envie/responda imagem com !s\n' +
      '*!sa* → Sticker animado: envie GIF/vídeo como DOCUMENTO com !sa'
    );
    return;
  }

  // Static sticker
  if (cmd === '!s') {
    let source = msg;
    if (!msg.hasMedia) {
      if (msg.hasQuotedMsg) {
        try {
          source = await msg.getQuotedMessage();
        } catch {
          await client.sendMessage(msg.from, 'Não consegui acessar a mensagem citada. Tente enviar diretamente com !s.');
          return;
        }
      } else {
        await client.sendMessage(msg.from, 'Envie ou responda uma imagem com !s.');
        return;
      }
    }
    if (!source.hasMedia) {
      await client.sendMessage(msg.from, 'Nenhuma mídia encontrada.');
      return;
    }
    try {
      const media = await source.downloadMedia();
      if (!media?.data) throw new Error('No media data');
      const buf = Buffer.from(media.data, 'base64');
      let webp = await sharp(buf).resize(512,512,{fit:'cover'}).webp({quality:80}).toBuffer();
      if (webp.length > MAX_STATIC_SIZE) {
        webp = await sharp(buf).resize(256,256,{fit:'cover'}).webp({quality:50}).toBuffer();
      }
      const sticker = new MessageMedia('image/webp', webp.toString('base64'));
      await client.sendMessage(msg.from, sticker, { sendMediaAsSticker: true });
    } catch (err) {
      console.error('Static sticker error:', err);
      await client.sendMessage(msg.from, 'Erro ao criar sticker estático.');
    }
    return;
  }

  // Animated sticker
  if (cmd === '!sa') {
    let source = msg;
    if (!msg.hasMedia) {
      if (msg.hasQuotedMsg) {
        try {
          source = await msg.getQuotedMessage();
        } catch {
          await client.sendMessage(msg.from, 'Não consegui acessar a mensagem citada. Tente enviar como documento com !sa.');
          return;
        }
      } else {
        await client.sendMessage(msg.from, 'Envie ou responda um GIF/vídeo como DOCUMENTO com !sa.');
        return;
      }
    }
    if (!source.hasMedia) {
      await client.sendMessage(msg.from, 'Nenhuma mídia encontrada.');
      return;
    }
    try {
      const media = await source.downloadMedia();
      if (!media?.data) throw new Error('No media data');
      const buf = Buffer.from(media.data, 'base64');
      let ext = media.mimetype.split('/')[1].split('+')[0] || 'mp4';
      if (ext === 'jpeg') ext = 'jpg';
      const inFile = path.join(__dirname, `input.${ext}`);
      const outFile = path.join(__dirname, 'output.webp');
      await fs.writeFile(inFile, buf);
      await new Promise((res, rej) => {
        ffmpeg(inFile)
          .inputOptions([`-t ${MAX_DURATION}`])
          .outputOptions([
            '-vcodec libwebp','-loop 0','-preset default','-an','-vsync 0',
            '-vf fps=10,scale=512:512:flags=lanczos','-qscale 50','-compression_level 6'
          ])
          .on('end', res)
          .on('error', rej)
          .save(outFile);
      });
      const webpBuf = await fs.readFile(outFile);
      const sticker = new MessageMedia('image/webp', webpBuf.toString('base64'));
      await client.sendMessage(msg.from, sticker, { sendMediaAsSticker: true });
      await fs.unlink(inFile).catch(() => {});
      await fs.unlink(outFile).catch(() => {});
    } catch (err) {
      console.error('Animated sticker error:', err);
      await client.sendMessage(msg.from, 'Erro ao criar sticker animado.');
    }
    return;
  }
});

client.initialize();
