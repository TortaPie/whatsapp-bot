const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Express para exibir QR
const app = express();
const PORT = process.env.PORT || 3000;
let qrImageBase64 = null;

app.get('/', (req, res) => {
  if (qrImageBase64) {
    res.send(`
      <!DOCTYPE html>
      <html><body style="display:flex;align-items:center;justify-content:center;height:100vh;">
        <img src="data:image/png;base64,${qrImageBase64}" />
      </body></html>
    `);
  } else {
    res.send('<h2>QR code indisponível</h2>');
  }
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`QR server running at http://0.0.0.0:${PORT}`)
);

// Puppeteer args para reduzir memória
const puppeteerOptions = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process'
  ]
};

// Flags de estado
let isReady = false;
const pendingSends = [];

// Inicializa client WhatsApp
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.SESSION_PATH || './.wwebjs_auth'
  }),
  puppeteer: puppeteerOptions
});

// Safe send que respeita isReady e enfileira mensagens
async function safeSend(to, content, opts = {}) {
  if (!isReady) {
    console.warn('Client não está pronto, enfileirando mensagem.');
    pendingSends.push({ to, content, opts });
    return;
  }
  try {
    await client.sendMessage(to, content, opts);
  } catch (e) {
    console.error('Send error:', e);
  }
}

// Helpers de reconexão
async function restartClient() {
  isReady = false;
  try { await client.destroy(); } catch(_) {}
  client.initialize();
}

// Eventos de conexão
client.on('qr', async qr => {
  console.log('QR recebido, atualizando display.');
  try {
    const dataUrl = await QRCode.toDataURL(qr);
    qrImageBase64 = dataUrl.split(',')[1];
  } catch (e) {
    console.error('QR generation error:', e);
  }
});

client.on('authenticated', () =>
  console.log('Autenticado com sucesso.')
);

client.on('auth_failure', async () => {
  console.warn('Auth failure, reiniciando client...');
  await restartClient();
});

client.on('ready', () => {
  console.log('Client está pronto.');
  isReady = true;
  qrImageBase64 = null;
  // despacha toda fila de mensagens pendentes
  pendingSends.splice(0).forEach(m =>
    safeSend(m.to, m.content, m.opts)
  );
});

client.on('disconnected', async reason => {
  console.warn('Client desconectado:', reason);
  await restartClient();
});

// Captura erros não tratados
process.on('unhandledRejection', err =>
  console.error('Unhandled Rejection:', err)
);
process.on('uncaughtException', err =>
  console.error('Uncaught Exception:', err)
);

// Lógica do bot
const greeted = new Set();

client.on('message', async msg => {
  if (msg.fromMe) return;
  const chatId = msg.from;
  const cmd = (msg.body || '').trim().toLowerCase();

  if (!greeted.has(chatId)) {
    greeted.add(chatId);
    await safeSend(
      chatId,
      'Olá! Sou PieBot\n!ping - testar conexão\n!s - figurinha estática\n!sa - figurinha animada'
    );
  }

  if (cmd === '!ping') return safeSend(chatId, 'Pong!');
  if (cmd !== '!s' && cmd !== '!sa') return;

  const animated = cmd === '!sa';
  let target = msg;
  if (!['image','video','document'].includes(msg.type) && msg.hasQuotedMsg) {
    target = (await msg.getQuotedMessage().catch(() => null)) || msg;
  }
  if (!['image','video','document'].includes(target.type)) {
    return safeSend(
      chatId,
      animated ? 'Envie um GIF/MP4 com !sa' : 'Envie uma imagem com !s'
    );
  }

  // Download e processamento de mídia
  let media;
  try {
    media = await target.downloadMedia();
    if (!media.data) throw new Error('No media data');
  } catch {
    return safeSend(chatId, 'Falha ao baixar mídia');
  }

  const buf = Buffer.from(media.data, 'base64');
  const tmpDir = os.tmpdir();
  const ext = (media.mimetype || '').split('/')[1] || 'bin';
  const inFile = path.join(tmpDir, `in_${Date.now()}.${ext}`);
  const outFile = path.join(tmpDir, `out_${Date.now()}.webp`);

  try {
    await fs.writeFile(inFile, buf);

    if (!animated) {
      // Figurinha estática
      let webpBuf = await sharp(inFile)
        .resize(512, 512, { fit: 'cover' })
        .webp({ quality: 80 })
        .toBuffer();
      if (webpBuf.length > 1024 * 1024) {
        webpBuf = await sharp(inFile)
          .resize(256, 256, { fit: 'cover' })
          .webp({ quality: 50 })
          .toBuffer();
      }
      await safeSend(
        chatId,
        new MessageMedia('image/webp', webpBuf.toString('base64')),
        { sendMediaAsSticker: true }
      );
    } else {
      // Figurinha animada
      await new Promise((res, rej) =>
        ffmpeg(inFile)
          .inputOptions(['-t','10'])
          .outputOptions([
            '-vcodec libwebp',
            '-loop 0',
            '-vf fps=10,scale=512:512:flags=lanczos',
            '-qscale 50'
          ])
          .on('end', res)
          .on('error', rej)
          .save(outFile)
      );
      const stats = await fs.stat(outFile);
      if (stats.size > 1024 * 1024) {
        await new Promise((res, rej) =>
          ffmpeg(inFile)
            .inputOptions(['-t','10'])
            .outputOptions([
              '-vcodec libwebp',
              '-loop 0',
              '-vf fps=10,scale=256:256:flags=lanczos',
              '-qscale 50'
            ])
            .on('end', res)
            .on('error', rej)
            .save(outFile)
        );
      }
      const outBuf = await fs.readFile(outFile);
      await safeSend(
        chatId,
        new MessageMedia('image/webp', outBuf.toString('base64')),
        { sendMediaAsSticker: true }
      );
    }
  } catch (e) {
    console.error('Erro ao criar figurinha:', e);
    await safeSend(
      chatId,
      animated ? 'Erro ao criar figurinha animada' : 'Erro ao criar figurinha estática'
    );
  } finally {
    await Promise.all([
      fs.unlink(inFile).catch(() => {}),
      fs.unlink(outFile).catch(() => {})
    ]);
  }
});

client.initialize();
