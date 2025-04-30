const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

// Inicializa cliente WhatsApp Web com QR Code no terminal
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
});

// Armazena chats saudados
const greetedChats = new Set();

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('QR code gerado! Escaneie no seu WhatsApp.');
});

client.on('ready', () => console.log('Cliente WhatsApp Web pronto!'));

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
      '• !s  → Sticker estático: envie/responda uma imagem com legenda *!s*\n' +
      '• !sa → Sticker animado: envie/responda um GIF ou vídeo **como DOCUMENTO** com legenda *!sa*\n' +
      'Digite *!help* para mais informações.'
    );
  }

  const text = msg.body?.trim().toLowerCase();

  // Ajuda
  if (text === '!help') {
    return msg.reply(
      'Comandos:\n' +
      '!s  → Sticker estático: envie uma imagem com legenda *!s*\n' +
      '!sa → Sticker animado: envie um GIF/vídeo **como DOCUMENTO** com legenda *!sa*'
    );
  }

  // Sticker estático
  if (text === '!s') {
    let source = msg;
    if (!msg.hasMedia && msg.hasQuotedMsg) source = await msg.getQuotedMessage();
    if (!source.hasMedia) return msg.reply('Envie/responda uma imagem com *!s* para criar um sticker estático.');
    try {
      const media = await source.downloadMedia();
      const buffer = Buffer.from(media.data, 'base64');
      let webp = await sharp(buffer)
        .resize(512,512,{fit:'cover'})
        .webp({quality:80})
        .toBuffer();
      if (webp.length > MAX_STATIC_SIZE) {
        webp = await sharp(buffer)
          .resize(256,256,{fit:'cover'})
          .webp({quality:50})
          .toBuffer();
      }
      const sticker = new MessageMedia('image/webp', webp.toString('base64'));
      await msg.reply(sticker, undefined, { sendMediaAsSticker: true });
    } catch (e) {
      console.error('Erro sticker estático:', e);
      msg.reply('Não foi possível criar o sticker estático.');
    }
    return;
  }

  // Sticker animado
  if (text === '!sa') {
    let source = msg;
    if (!msg.hasMedia && msg.hasQuotedMsg) source = await msg.getQuotedMessage();
    if (!source.hasMedia) {
      return msg.reply('Envie/responda um GIF ou vídeo **como DOCUMENTO** com *!sa* para criar um sticker animado.');
    }
    try {
      const media = await source.downloadMedia();
      const buffer = Buffer.from(media.data, 'base64');
      const inPath = path.join(__dirname, 'temp_in');
      const outPath = path.join(__dirname, 'temp_out.webp');
      await fs.writeFile(inPath, buffer);
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
            '-lossless 0',
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
    } catch (e) {
      console.error('Erro sticker animado:', e);
      msg.reply('Não foi possível criar o sticker animado.');
    }
    return;
  }
});

client.initialize();
