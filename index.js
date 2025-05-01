const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// HTTP server for QR display
const app = express();
const PORT = process.env.PORT || 3000;
let qrImageBase64 = '';
app.get('/', (req, res) => {
  const imgTag = qrImageBase64
    ? `<img src="data:image/png;base64,${qrImageBase64}"/>`
    : '<h2>QR code indisponível</h2>';
  res.send(`<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;">${imgTag}</body></html>`);
});
app.listen(PORT, '0.0.0.0', () => console.log(`QR server running at http://0.0.0.0:${PORT}`));

// Initialize WhatsApp client
console.log('Initializing WhatsApp client...');
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox'] }
});

// Safe send wrapper
async function safeSend(to, content, opts = {}) {
  try { await client.sendMessage(to, content, opts); }
  catch (e) { console.error('Send error:', e); }
}

// Event handlers for connection
client.on('loading_screen', (percent, message) => console.log(`Loading ${percent}% - ${message}`));
client.on('qr', async qr => {
  console.log('QR Code received, generate and display.');
  try { qrImageBase64 = (await QRCode.toDataURL(qr)).split(',')[1]; }
  catch (e) { console.error('QR generation error:', e); }
});
client.on('authenticated', () => console.log('Authenticated successfully.'));
client.on('auth_failure', () => console.warn('Auth failure, restarting...'));
client.on('ready', () => {
  console.log('Client is ready.');
  // free QR data to reduce memory
  qrImageBase64 = '';
});
client.on('disconnected', reason => console.warn('Client disconnected:', reason));

// Bot logic
const greeted = new Set();
client.on('message', async msg => {
  if (msg.fromMe) return;
  const chatId = msg.from;
  const cmd = (msg.body||'').trim().toLowerCase();
  if (!greeted.has(chatId)) {
    greeted.add(chatId);
    await safeSend(chatId, 'Olá! Sou PieBot 🤖\n!ping - test connection\n!s - static sticker\n!sa - animated sticker');
  }
  if (cmd === '!ping') return safeSend(chatId, 'Pong!');
  if (cmd === '!s' || cmd === '!sa') {
    const animated = cmd === '!sa';
    // determine target (direct or quoted)
    let target = msg;
    if (!['image','video','document'].includes(msg.type) && msg.hasQuotedMsg) {
      const qm = await msg.getQuotedMessage().catch(() => null);
      if (qm) target = qm;
    }
    if (!['image','video','document'].includes(target.type)) {
      return safeSend(chatId, animated ? 'Send a GIF/MP4 with !sa' : 'Send an image with !s');
    }
    // download media
    let media;
    try { media = await target.downloadMedia(); }
    catch (e) { return safeSend(chatId, 'Media download failed'); }
    if (!media?.data) return safeSend(chatId, 'Media processing failed');

    if (!animated) {
      try {
        const buf = Buffer.from(media.data, 'base64');
        let webp = await sharp(buf).resize(512,512,{fit:'cover'}).webp({quality:80}).toBuffer();
        if (webp.length > 1024*1024) webp = await sharp(buf).resize(256,256,{fit:'cover'}).webp({quality:50}).toBuffer();
        await safeSend(chatId, new MessageMedia('image/webp', webp.toString('base64')), { sendMediaAsSticker:true });
      } catch (e) {
        console.error('Static sticker error:', e);
        await safeSend(chatId, 'Error creating static sticker');
      }
    } else {
      try {
        const buf = Buffer.from(media.data, 'base64');
        const mime = media.mimetype || 'video/mp4';
        const ext = mime.split('/')[1].split(';')[0];
        const inFile = path.join(__dirname, `temp_in.${ext}`);
        const outFile = path.join(__dirname, 'temp_out.webp');
        await fs.writeFile(inFile, buf);
        // first pass
        await new Promise((res,rej) => ffmpeg(inFile).inputOptions(['-t','10']).outputOptions(['-vcodec libwebp','-loop 0','-vf fps=10,scale=512:512:flags=lanczos','-qscale 50']).on('end',res).on('error',rej).save(outFile));
        // if too big
        if ((await fs.stat(outFile)).size > 1024*1024) {
          await new Promise((res,rej) => ffmpeg(inFile).inputOptions(['-t','10']).outputOptions(['-vcodec libwebp','-loop 0','-vf fps=10,scale=256:256:flags=lanczos','-qscale 50']).on('end',res).on('error',rej).save(outFile));
        }
        const outBuf = await fs.readFile(outFile);
        await safeSend(chatId, new MessageMedia('image/webp', outBuf.toString('base64')), { sendMediaAsSticker:true });
        await fs.unlink(inFile); await fs.unlink(outFile);
      } catch (e) {
        console.error('Animated sticker error:', e);
        await safeSend(chatId, 'Error creating animated sticker');
      }
    }
  }
});

client.initialize();
