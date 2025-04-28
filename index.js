const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');

const app = express();
const port = process.env.PORT || 3000;
let currentQr = null;

// Express server para exibir o QR code
app.get('/', (_, res) => {
  if (!currentQr) return res.send('QR code ainda não gerado. Aguarde.');
  res.send(`
    <h1>WhatsApp Web QR Code</h1>
    <img src="/qr.png" alt="QR Code" />
    <p>Escaneie com seu WhatsApp Mobile</p>
  `);
});
app.get('/qr.png', (_, res) => {
  if (!currentQr) return res.status(404).send('QR não disponível');
  res.type('png');
  QRCode.toFileStream(res, currentQr);
});
app.listen(port, '0.0.0.0', () => console.log(`Servidor HTTP na porta ${port}`));

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ]
  }
});

client.on('qr', qr => {
  currentQr = qr;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('QR code gerado');
});
client.on('ready', () => console.log('Bot conectado!'));
client.on('disconnected', reason => {
  console.log(`Conexão perdida: ${reason}. Tentando reconectar...`);
  setTimeout(() => client.initialize(), 5000);
});

// Processadores de mídia
const processors = {
  image: buf =>
    sharp(buf)
      .resize(512, 512, { fit: 'cover' })
      .webp({ quality: 90 })
      .toBuffer(),

  gif: (inPath, outPath) =>
    new Promise((res, rej) =>
      ffmpeg(inPath)
        .outputOptions([
          '-vcodec libwebp',
          '-lossless 0',
          '-q:v 50',
          '-compression_level 6',
          '-loop 0',
          '-preset default',
          '-an',
          '-vsync 0',
          '-vf fps=10,scale=512:512:flags=lanczos'
        ])
        .on('end', res)
        .on('error', rej)
        .save(outPath)
    ),

  video: async (inPath, transPath, outPath) => {
    await new Promise((res, rej) =>
      ffmpeg(inPath)
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast',
          '-profile:v baseline',
          '-level 3.0',
          '-pix_fmt yuv420p',
          '-movflags +faststart',
          '-an'
        ])
        .on('end', res)
        .on('error', rej)
        .save(transPath)
    );
    return new Promise((res, rej) =>
      ffmpeg(transPath)
        .inputOptions(['-t', '10'])
        .videoCodec('libwebp')
        .outputOptions([
          '-vf fps=10,scale=512:512:flags=lanczos',
          '-lossless 0',
          '-compression_level 6',
          '-q:v 50',
          '-loop 0'
        ])
        .on('end', res)
        .on('error', rej)
        .save(outPath)
    );
  }
};

client.on('message', async msg => {
  const text = (msg.body || '').trim().toLowerCase();

  // TESTE DE CONEXÃO
  if (text === '!ping') {
    return msg.reply('Pong!');
  }

  if (text === '!start') {
    return msg.reply(
      '✨ *Olá, sou PieBot, um robozinho muito gostoso!* ✨\n' +
      '• Figurinhas animadas só com DOCUMENTOS (GIF ou MP4)\n' +
      '• MP4: máximo de 9 segundos\n' +
      'Envie !sticker + seu arquivo!'
    );
  }
  if (text !== '!sticker' && text !== '!figurinha') return;

  // Se for sticker pronto
  if (msg.type === 'sticker') {
    return msg.reply('❌️ Enviei um sticker pronto? Use GIF ou vídeo como documento.');
  }

  // obtém mídia, seja direta ou em reply
  let source = msg;
  if (!msg.hasMedia && msg.hasQuotedMsg) {
    const q = await msg.getQuotedMessage();
    if (q.hasMedia) source = q;
  }
  if (!source.hasMedia) {
    return msg.reply('❌️ Envie uma mídia junto com !sticker.');
  }

  let media;
  try {
    media = await source.downloadMedia();
  } catch {
    return msg.reply('❌️ Falha ao baixar mídia.');
  }
  if (!media?.data) {
    return msg.reply('⚠️️ Mídia indisponível. Use documento.');
  }

  const mime = media.mimetype;
  const buf = Buffer.from(media.data, 'base64');
  const filename = (source.filename || '').toLowerCase();
  const isGif = mime.includes('gif') || filename.endsWith('.gif');
  const isVideo = mime.startsWith('video/');
  const ext = isGif
    ? 'gif'
    : isVideo
      ? filename.endsWith('.mov') ? 'mov' : 'mp4'
      : null;

  const inPath = ext ? path.join(__dirname, `in.${ext}`) : null;
  const transPath = path.join(__dirname, 'trans.mp4');
  const outPath = path.join(__dirname, 'out.webp');

  try {
    // imagem estática
    if (mime.startsWith('image/') && !isGif) {
      const result = await processors.image(buf);
      return msg.reply(
        new MessageMedia('image/webp', result.toString('base64')),
        undefined,
        { sendMediaAsSticker: true }
      );
    }

    // grava o buffer no disco
    if (!inPath) throw new Error('unsupported');
    await fs.writeFile(inPath, buf);

    if (isGif) {
      await processors.gif(inPath, outPath);
    } else {
      // vídeo
      const probe = await new Promise((res, rej) =>
        ffmpeg.ffprobe(inPath, (err, data) => (err ? rej(err) : res(data)))
      ).catch(() => ({ format: { duration: 10 } }));

      if (probe.format.duration > 10) throw new Error('duration');
      await processors.video(inPath, transPath, outPath);
    }

    const wp = await fs.readFile(outPath);
    return msg.reply(
      new MessageMedia('image/webp', wp.toString('base64')),
      undefined,
      { sendMediaAsSticker: true }
    );
  } catch (err) {
    if (err.message === 'duration') {
      return msg.reply('⚠️️ Vídeo maior que 10s não suportado.');
    }
    if (err.message === 'unsupported') {
      return msg.reply('❌️ Tipo não suportado.');
    }
    return msg.reply('❌️ Erro ao processar mídia.');
  } finally {
    [inPath, transPath, outPath].forEach(f => f && fs.unlink(f).catch(() => {}));
  }
});

client.initialize();
