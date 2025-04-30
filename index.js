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
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox'] }
});

// Safe send wrapper
async function safeSend(chatId, content, options = {}) {
  try {
    await client.sendMessage(chatId, content, options);
  } catch (err) {
    console.error('Send error:', err.message || err);
  }
}

// Safe download wrapper
async function safeDownload(msg) {
  try {
    return await msg.downloadMedia();
  } catch (err) {
    console.error('Download error:', err.message || err);
    throw err;
  }
}

// Handle auth failures
client.on('auth_failure', () => {
  console.error('Auth failure, restarting session');
  client.logout().catch(err => console.error('Logout error:', err))
    .finally(() => client.initialize());
});

// Reconnect on disconnect
client.on('disconnected', reason => {
  console.warn('Client disconnected:', reason, 'reconnecting...');
  client.initialize();
});

// Generate QR Code
client.on('qr', async qr => {
  try {
    const url = await QRCode.toDataURL(qr);
    qrImageBase64 = url.split(',')[1];
    console.log('QR generated, scan via http://localhost:' + PORT);
  } catch (err) {
    console.error('QR error:', err);
  }
});

client.on('ready', () => console.log('Client ready'));

// --- Bot Logic ---
const greeted = new Set();
const MAX_STATIC_SIZE = 1024 * 1024;
const MAX_DURATION = 10;

client.on('message', async msg => {
  if (msg.fromMe) return;
  const body = (msg.body || '').trim();
  const cmd = body.toLowerCase();
  const chatId = msg.from;

  // !ping
  if (cmd === '!ping') {
    await safeSend(chatId, 'Pong!');
    return;
  }

  // Welcome once
  if (!greeted.has(chatId)) {
    greeted.add(chatId);
    await safeSend(chatId,
      'Olá! Sou PieBot 🤖\n' +
      '*!ping* para testar conexão\n' +
      '*!s*    para sticker estático\n' +
      '*!sa*   para sticker animado'
    );
  }

  // !help
  if (cmd === '!help') {
    await safeSend(chatId,
      '*!s* → envie imagem com !s para sticker estático\n' +
      '*!sa* → envie GIF/MP4 como doc com !sa para sticker animado'
    );
    return;
  }

  // !s
  if (cmd === '!s') {
    if (!msg.hasMedia) {
      await safeSend(chatId, 'Envie imagem com legenda !s para criar sticker estático.');
      return;
    }
    try {
      const media = await safeDownload(msg);
      const buf = Buffer.from(media.data, 'base64');
      let webp;
      for (let q of [80,60,40,20]) {
        webp = await sharp(buf).resize(512,512,{fit:'cover'}).webp({quality:q}).toBuffer();
        if (webp.length <= MAX_STATIC_SIZE) break;
      }
      if (webp.length > MAX_STATIC_SIZE) {
        webp = await sharp(buf).resize(256,256,{fit:'cover'}).webp({quality:50}).toBuffer();
      }
      const sticker = new MessageMedia('image/webp', webp.toString('base64'));
      await safeSend(chatId, sticker, { sendMediaAsSticker:true });
    } catch (err) {
      console.error('Static sticker error:', err);
      await safeSend(chatId, 'Erro ao criar sticker estático.');
    }
    return;
  }

  // !sa
  if (cmd === '!sa') {
    if (!msg.hasMedia) {
      await safeSend(chatId, 'Envie GIF/MP4 como documento com !sa para sticker animado.');
      return;
    }
    try {
      const media = await safeDownload(msg);
      const buf = Buffer.from(media.data, 'base64');
      let ext = media.mimetype.split('/')[1].split('+')[0] || 'mp4';
      if (ext === 'jpeg') ext = 'jpg';
      const inFile = path.join(__dirname, `temp_in.${ext}`);
      const outFile = path.join(__dirname, 'temp_out.webp');
      await fs.writeFile(inFile, buf);
      // First conversion
      await new Promise((res, rej) => {
        ffmpeg(inFile)
          .inputOptions([`-t ${MAX_DURATION}`])
          .outputOptions([
            '-vcodec libwebp','-loop 0','-preset default','-an','-vsync 0',
            '-vf fps=10,scale=512:512:flags=lanczos','-qscale 50','-compression_level 6'
          ])
          .save(outFile)
          .on('end', res)
          .on('error', rej);
      });
      const stats = await fs.stat(outFile);
      if (stats.size > MAX_STATIC_SIZE) {
        await new Promise((res, rej) => {
          ffmpeg(inFile)
            .inputOptions([`-t ${MAX_DURATION}`])
            .outputOptions([
              '-vcodec libwebp','-loop 0','-preset default','-an','-vsync 0',
              '-vf fps=10,scale=256:256:flags=lanczos','-qscale 50','-compression_level 6'
            ])
            .save(outFile)
            .on('end', res)
            .on('error', rej);
        });
      }
      const webpBuf = await fs.readFile(outFile);
      const sticker = new MessageMedia('image/webp', webpBuf.toString('base64'));
      await safeSend(chatId, sticker, { sendMediaAsSticker:true });
      await fs.unlink(inFile).catch(() => {});
      await fs.unlink(outFile).catch(() => {});
    } catch (err) {
      console.error('Animated sticker error:', err);
      await safeSend(chatId, 'Erro ao criar sticker animado.');
    }
    return;
  }
});

client.initialize();
