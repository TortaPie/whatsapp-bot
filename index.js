const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');

// Express server for QR code
const app = express();
let currentQr = null;
app.get('/', (req, res) => {
  if (!currentQr) return res.send('QR code ainda não gerado. Aguarde.');
  res.send(`
    <h1>WhatsApp Web QR Code</h1>
    <img src="/qr.png" alt="QR Code" />
    <p>Escaneie com seu WhatsApp Mobile</p>
  `);
});
app.get('/qr.png', (req, res) => {
  if (!currentQr) return res.status(404).send('QR não disponível');
  res.type('png');
  QRCode.toFileStream(res, currentQr);
});
const port = process.env.PORT || 3000;
const server = app.listen(port, '0.0.0.0', () => console.log(`Servidor HTTP na porta ${port}`));
server.on('error', err => console.error('Erro no Express:', err));

// Media processors
async function processStatic(buffer) {
  return sharp(buffer)
    .resize(512, 512, { fit: 'cover' })
    .webp({ quality: 90 })
    .toBuffer();
}

function processGif(inPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions([
        '-vcodec libwebp','-lossless 0','-q:v 50','-compression_level 6','-loop 0',
        '-preset default','-an','-vsync 0','-vf fps=10,scale=512:512:flags=lanczos'
      ])
      .on('end', () => resolve())
      .on('error', reject)
      .save(outPath);
  });
}

function processVideo(inPath, transPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions([
        '-c:v libx264','-preset ultrafast','-profile:v baseline','-level 3.0',
        '-pix_fmt yuv420p','-movflags +faststart','-an'
      ])
      .on('end', () => {
        ffmpeg(transPath)
          .inputOptions(['-t', '10'])
          .videoCodec('libwebp')
          .outputOptions([
            '-vf fps=10,scale=512:512:flags=lanczos','-lossless 0',
            '-compression_level 6','-q:v 50','-loop 0'
          ])
          .on('end', resolve)
          .on('error', reject)
          .save(outPath);
      })
      .on('error', reject)
      .save(transPath);
  });
}

// WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process']
  }
});

client.on('qr', qr => {
  currentQr = qr;
  qrcode.generate(qr, { small: true });
  console.log('QR code gerado');
});
client.on('ready', () => console.log('Bot conectado!'));

client.on('message', async msg => {
  const text = (msg.body || '').trim().toLowerCase();
  if (text === '!start') {
    return msg.reply(
      '✨ *Olá, sou PieBot, um robozinho muito gostoso!* ✨\n' +
      '• Figurinhas animadas só com DOCUMENTOS (GIF ou MP4)\n' +
      '• MP4: máximo de 9 segundos\n' +
      'Envie !sticker + seu arquivo!'
    );
  }
  if (text !== '!sticker' && text !== '!figurinha') return;
  if (msg.type === 'sticker') {
    return msg.reply('❌️ Enviei um sticker pronto? Use GIF ou vídeo como documento.');
  }

  let source = msg;
  if (!msg.hasMedia && msg.hasQuotedMsg) {
    const q = await msg.getQuotedMessage(); if (q.hasMedia) source = q;
  }
  if (!source.hasMedia) {
    return msg.reply('❌️ Envie uma mídia junto com !sticker.');
  }

  let media;
  try { media = await source.downloadMedia(); }
  catch { return msg.reply('❌️ Falha ao baixar mídia.'); }
  if (!media || !media.data) {
    return msg.reply('⚠️️ Mídia indisponível. Use documento.');
  }

  const mime = media.mimetype;
  const buf = Buffer.from(media.data, 'base64');
  const filename = (source.filename || '').toLowerCase();

  // Static image
  if (mime.startsWith('image/') && !mime.includes('gif')) {
    try {
      const result = await processStatic(buf);
      return msg.reply(new MessageMedia('image/webp', result.toString('base64')), undefined, { sendMediaAsSticker: true });
    } catch {
      return msg.reply('❌️ Erro na figurinha estática.');
    }
  }

  // GIF
  if (mime.includes('gif') || filename.endsWith('.gif')) {
    const inPath = path.join(__dirname, 'in.gif');
    const outPath = path.join(__dirname, 'out.webp');
    await fs.writeFile(inPath, buf);
    try {
      await processGif(inPath, outPath);
      const wp = await fs.readFile(outPath);
      return msg.reply(new MessageMedia('image/webp', wp.toString('base64')), undefined, { sendMediaAsSticker: true });
    } catch {
      return msg.reply('❌️ Erro ao processar GIF.');
    } finally {
      await fs.unlink(inPath); await fs.unlink(outPath);
    }
  }

  // Video
  if (mime.startsWith('video/')) {
    const ext = filename.endsWith('.mov') ? 'mov' : 'mp4';
    const inPath = path.join(__dirname, `in.${ext}`);
    const transPath = path.join(__dirname, 'trans.mp4');
    const outPath = path.join(__dirname, 'out.webp');
    await fs.writeFile(inPath, buf);

    let info;
    try {
      info = await new Promise((res, rej) => ffmpeg.ffprobe(inPath, (e, d) => e ? rej(e) : res(d)));
    } catch {
      info = { format: { duration: 10 } };
    }
    if (info.format.duration > 10) {
      await fs.unlink(inPath);
      return msg.reply('⚠️️ Vídeo maior que 10s não suportado.');
    }

    try {
      await processVideo(inPath, transPath, outPath);
      const wp = await fs.readFile(outPath);
      return msg.reply(new MessageMedia('image/webp', wp.toString('base64')), undefined, { sendMediaAsSticker: true });
    } catch {
      return msg.reply('❌️ Erro ao processar vídeo.');
    } finally {
      for (const f of [inPath, transPath, outPath]) {
        try { await fs.unlink(f); } catch {}
      }
    }
  }

  return msg.reply('❌️ Tipo não suportado.');
});

client.initialize();
