'use strict';
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const { randomUUID } = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ─── Pacotes Express e qrcode (para web QR) ───────────────
const express = require('express');
const QRCode = require('qrcode');
const app = express();

let latestQR = null; // Armazena último QR recebido

// Rota para exibir QR code (SVG)
app.get('/qr', async (req, res) => {
  if (!latestQR) return res.status(404).send('QR code ainda não gerado.');
  try {
    const svg = await QRCode.toString(latestQR, { type: 'svg' });
    res.type('svg').send(svg);
  } catch (e) {
    res.status(500).send('Erro ao gerar SVG do QR.');
  }
});

// Home simples
app.get('/', (req, res) => {
  res.send(`
    <h1>QR Code do WhatsApp Bot</h1>
    <p>Abra <a href="/qr">/qr</a> para ver o QR code atual.</p>
  `);
});

// Porta dinâmica para Render/heroku/etc
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor web para QR code rodando na porta', PORT);
});

// ─── Puppeteer opções de baixo consumo de memória ─────────
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

// ─── Flags de estado e fila de envios ─────────────────────
let isReady = false;
const pendingSends = [];
let keepAliveInterval = null;

// ─── Inicialização do client WhatsApp ─────────────────────
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.SESSION_PATH || './.wwebjs_auth'
  }),
  puppeteer: puppeteerOptions
});

// Safe send respeitando isReady e enfileirando se necessário
async function safeSend(to, content, opts = {}) {
  if (!isReady) {
    console.warn('Client não está pronto, enfileirando mensagem');
    pendingSends.push({ to, content, opts });
    return;
  }
  try {
    await client.sendMessage(to, content, opts);
  } catch (e) {
    console.error('Send error:', e);
  }
}

// ─── Função de reinicialização robusta ─────────────────────
async function restartClient() {
  isReady = false;
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  try { await client.destroy(); } catch (_) {}
  client.initialize();
}

// ─── Handlers de eventos do client ────────────────────────
client.on('qr', qr => {
  latestQR = qr; // Atualiza QR para servir via web
  // Exibe QR também no terminal, com separação visual
  if (typeof console.clear === 'function') console.clear();
  const separador = '\n' + '='.repeat(40) + '\n';
  console.log(separador +
    'QR Code recebido! Escaneie em /qr para autenticar.' +
    separador
  );
  try {
    qrcodeTerminal.generate(qr, { small: true });
  } catch (e) {
    console.error('QR generation error:', e);
  }
  console.log(separador + 'Aguarde a autenticação...' + separador);
});

client.on('authenticated', () =>
  console.log('Autenticado com sucesso')
);

client.on('auth_failure', async () => {
  console.warn('Auth failure, reiniciando client');
  await restartClient();
});

client.on('ready', () => {
  console.log('Client está pronto');
  isReady = true;

  // Despacha fila de mensagens pendentes
  pendingSends.splice(0).forEach(m =>
    safeSend(m.to, m.content, m.opts)
  );

  // KEEP‑ALIVE: envia presença a cada 5 minutos
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(() => {
    if (isReady) {
      console.log('Keep‑alive: enviando presença disponível');
      client.sendPresenceAvailable();
    }
  }, 5 * 60 * 1000);
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

// ─── Lógica de processamento de mensagens ─────────────────
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

  // Download da mídia
  let media;
  try {
    media = await target.downloadMedia();
    if (!media.data) throw new Error('No media data');
  } catch {
    return safeSend(chatId, 'Falha ao baixar mídia');
  }

  const buf = Buffer.from(media.data, 'base64');
  const tmpDir = os.tmpdir();
  const ext = (media.mimetype || '').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  const inFile = path.join(tmpDir, `in_${randomUUID()}.${ext}`);
  const outFile = path.join(tmpDir, `out_${randomUUID()}.webp`);

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
