const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3000;
let qrImageBase64 = '';
app.get('/', (req, res) => {
  const img = qrImageBase64 ? `<img src="data:image/png;base64,${qrImageBase64}"/>` : '<h2>QR indisponível</h2>';
  res.send(`<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;">${img}</body></html>`);
});
app.listen(PORT, '0.0.0.0');

const client = new Client({ authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }), puppeteer: { headless: true, args: ['--no-sandbox'] } });
async function safeSend(to, content, opts = {}) { try { await client.sendMessage(to, content, opts); } catch {} }
client.on('auth_failure', () => client.logout().finally(() => client.initialize()));
client.on('disconnected', () => client.initialize());
client.on('qr', async qr => { try { qrImageBase64 = (await QRCode.toDataURL(qr)).split(',')[1]; } catch {} });
client.on('ready', () => {});

const greeted = new Set();
client.on('message', async msg => {
  if (msg.fromMe) return;
  const chatId = msg.from;
  const cmd = (msg.body||'').trim().toLowerCase();
  if (!greeted.has(chatId)) { greeted.add(chatId); await safeSend(chatId, 'Olá! Sou PieBot 🤖\n!ping - testa conexão\n!s - sticker estático\n!sa - sticker animado'); }
  if (cmd === '!ping') return safeSend(chatId, 'Pong!');

  // handle sticker commands
  if (cmd === '!s' || cmd === '!sa') {
    const isAnimated = cmd === '!sa';
    const validTypes = ['image','video','document'];
    let target = msg;
    if (!validTypes.includes(msg.type) && msg.hasQuotedMsg) {
      const qm = await msg.getQuotedMessage().catch(() => null);
      if (qm && validTypes.includes(qm.type)) target = qm;
    }
    if (!validTypes.includes(target.type)) {
      const hint = isAnimated ? 'Envie GIF/MP4 com !sa' : 'Envie imagem com !s';
      return safeSend(chatId, hint);
    }
    let media;
    try { media = await target.downloadMedia(); } catch { return safeSend(chatId, 'Falha ao baixar mídia'); }
    if (!media || !media.data) return safeSend(chatId, 'Falha ao processar mídia');

    if (!isAnimated) {
      try {
        const buf = Buffer.from(media.data,'base64');
        let webp = await sharp(buf).resize(512,512,{fit:'cover'}).webp({quality:80}).toBuffer();
        if (webp.length > 1024*1024) webp = await sharp(buf).resize(256,256,{fit:'cover'}).webp({quality:50}).toBuffer();
        return safeSend(chatId, new MessageMedia('image/webp', webp.toString('base64')), { sendMediaAsSticker:true });
      } catch { return safeSend(chatId, 'Erro sticker estático'); }
    } else {
      try {
        const buf = Buffer.from(media.data,'base64');
        const ext = (media.mimetype||'video/mp4').split('/')[1].split(';')[0];
        const inPath = path.join(__dirname, `in.${ext}`);
        const outPath = path.join(__dirname,'out.webp');
        await fs.writeFile(inPath, buf);
        await new Promise((res,rej) => ffmpeg(inPath).inputOptions(['-t','10']).outputOptions(['-vcodec libwebp','-loop 0','-vf fps=10,scale=512:512:flags=lanczos','-qscale 50']).on('end',res).on('error',rej).save(outPath));
        if ((await fs.stat(outPath)).size > 1024*1024) {
          await new Promise((res,rej) => ffmpeg(inPath).inputOptions(['-t','10']).outputOptions(['-vcodec libwebp','-loop 0','-vf fps=10,scale=256:256:flags=lanczos','-qscale 50']).on('end',res).on('error',rej).save(outPath));
        }
        const outBuf = await fs.readFile(outPath);
        await safeSend(chatId, new MessageMedia('image/webp', outBuf.toString('base64')), { sendMediaAsSticker:true });
        await fs.unlink(inPath); await fs.unlink(outPath);
      } catch { return safeSend(chatId, 'Erro sticker animado'); }
    }
  }
});
client.initialize();
