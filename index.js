const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');

// --- SERVIDOR EXPRESS PARA QR CODE ---
const app = express();
let currentQr = null;

// Página HTML com QR Code
app.get('/', (req, res) => {
  if (!currentQr) return res.send('🔄 QR code ainda não gerado. Aguarde...');
  res.send(`
    <h1>📲 QR Code para PieBot</h1>
    <img src="/qr.png" alt="QR Code" />
    <p>Escaneie com seu WhatsApp Mobile para conectar o bot.</p>
  `);
});

// Serve o QR Code como imagem PNG
app.get('/qr.png', (req, res) => {
  if (!currentQr) return res.status(404).send('❌ QR não disponível');
  res.type('png');
  QRCode.toFileStream(res, currentQr);
});

// Tratamento de erros no servidor e no processo
process.on('uncaughtException', err => console.error('❌ Uncaught Exception:', err));
process.on('unhandledRejection', reason => console.error('❌ Unhandled Rejection:', reason));

// Inicia servidor HTTP com tratamento de erros
const port = process.env.PORT || 3000;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`🌐 Servidor HTTP iniciado na porta ${port}`);
  // Keep-alive interno
  const keepAlive = setInterval(() => {
    http.get(`http://localhost:${port}/`).on('error', () => {});
  }, 4 * 60 * 1000);
  keepAlive.unref();
});
server.on('error', err => console.error('❌ Erro no servidor Express:', err));

// --- INICIALIZAÇÃO DO BOT WHATSAPP ---
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--no-zygote-sandbox'
    ]
  }
});

// Geração de QR Code
client.on('qr', qr => {
  currentQr = qr;
  qrcode.generate(qr, { small: true });
  console.log('📲 QR code gerado e disponível em /');
});
client.on('ready', () => console.log('✅ PieBot conectado!'));

client.on('message', async msg => {
  console.log(`📩 Mensagem de ${msg.from} | tipo: ${msg.type} | corpo: ${msg.body}`);
  const cmd = (msg.body || '').trim().toLowerCase();

  // Comando de apresentação
  if (cmd === '!start') {
    return msg.reply(
      '🌟 *Olá, sou PieBot, um robozinho muito gostoso!* 🌟\n' +
      '\n' +
      '✨ *Figurinhas animadas* funcionam apenas com arquivos enviados como *Documento* (GIF ou MP4).\n' +
      '⏱️ *Vídeos .mp4* têm duração máxima de *9 segundos*.\n' +
      '📨 Envie seu arquivo junto com o comando *!sticker* para eu processar e enviar sua figurinha animada!'
    );
  }

  if (cmd !== '!sticker' && cmd !== '!figurinha') return;

  // Detecta sticker nativo
  if (msg.type === 'sticker') {
    return msg.reply('❌ Não converto stickers prontos. Envie imagem, GIF ou vídeo como documento.');
  }

  // Captura mídia (mensagem ou reply)
  let source = msg;
  if (!msg.hasMedia && msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage();
    if (quoted.hasMedia) source = quoted;
  }
  if (!source.hasMedia) {
    return msg.reply('❌ Envie uma mídia (imagem, GIF ou vídeo) junto ao !sticker ou em resposta a uma mídia.');
  }

  // Processo de mídia
  console.log('⬇️ Baixando mídia...');
  let media;
  try {
    media = await source.downloadMedia();
  } catch (e) {
    console.error('❌ Falha ao baixar mídia:', e);
    return msg.reply('❌ Não foi possível baixar a mídia.');
  }
  if (!media || !media.data) {
    if (source.type === 'image') return msg.reply('⚠️ GIF inline não suportado. Envie como Documento (.gif).');
    if (source.type === 'video') return msg.reply('⚠️ Vídeo da câmera não suportado. Envie como Documento (.mp4).');
    return msg.reply('⚠️ Mídia inválida. Por favor, envie como Documento.');
  }

  const mime = media.mimetype;
  const filename = (source.filename || '').toLowerCase();
  const buffer = Buffer.from(media.data, 'base64');

  // Sticker estático (imagem)
  if (mime.startsWith('image/') && !mime.includes('gif')) {
    try {
      const webp = await sharp(buffer).resize(512, 512, { fit: 'cover' }).webp({ quality: 90 }).toBuffer();
      return msg.reply(new MessageMedia('image/webp', webp.toString('base64')), undefined, { sendMediaAsSticker: true });
    } catch (e) {
      console.error('❌ Erro estática:', e);
      return msg.reply('❌ Falha ao gerar figurinha estática.');
    }
  }

  // Sticker animado (GIF)
  if (mime.includes('gif') || filename.endsWith('.gif')) {
    const tmpIn = path.join(__dirname, 'in.gif');
    const tmpOut = path.join(__dirname, 'out.webp');
    fs.writeFileSync(tmpIn, buffer);
    try {
      await new Promise((res, rej) => {
        ffmpeg(tmpIn)
          .outputOptions([
            '-vcodec', 'libwebp', '-lossless', '0', '-q:v', '50', '-compression_level', '6',
            '-loop', '0', '-preset', 'default', '-an', '-vsync', '0',
            '-vf', 'fps=10,scale=512:512:flags=lanczos'
          ])
          .on('end', res)
          .on('error', rej)
          .save(tmpOut);
      });
      const webpBuf = fs.readFileSync(tmpOut);
      return msg.reply(new MessageMedia('image/webp', webpBuf.toString('base64')), undefined, { sendMediaAsSticker: true });
    } catch (e) {
      console.error('❌ Erro GIF:', e);
      return msg.reply('❌ Falha ao gerar figurinha do GIF.');
    } finally {
      fs.unlinkSync(tmpIn);
      fs.unlinkSync(tmpOut);
    }
  }

  // Sticker animado (vídeo)
  if (mime.startsWith('video/')) {
    const tmpIn = path.join(__dirname, filename.endsWith('.mov') ? 'in.mov' : 'in.mp4');
    const tmpTrans = path.join(__dirname, 'trans.mp4');
    const tmpOut = path.join(__dirname, 'out.webp');
    fs.writeFileSync(tmpIn, buffer);
    let duration = 0;
    try {
      const info = await new Promise((res, rej) => ffmpeg.ffprobe(tmpIn, (err, data) => err ? rej(err) : res(data)));
      duration = info.format.duration;
    } catch {
      duration = 10;
    }
    if (duration > 10) {
      fs.unlinkSync(tmpIn);
      return msg.reply('⚠️ Vídeos devem ter no máximo 10 segundos (.mp4 ou .mov).');
    }
    try {
      await new Promise((res, rej) => {
        ffmpeg(tmpIn)
          .outputOptions([
            '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline', '-level', '3.0',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'
          ])
          .on('end', res)
          .on('error', rej)
          .save(tmpTrans);
      });
      await new Promise((res, rej) => {
        ffmpeg(tmpTrans)
          .inputOptions(['-t', '10'])
          .videoCodec('libwebp')
          .outputOptions([
            '-vf', 'fps=10,scale=512:512:flags=lanczos',
            '-lossless', '0', '-compression_level', '6', '-q:v', '50', '-loop', '0'
          ])
          .on('end', res)
          .on('error', rej)
          .save(tmpOut);
      });
      const webpBuf = fs.readFileSync(tmpOut);
      return msg.reply(new MessageMedia('image/webp', webpBuf.toString('base64')), undefined, { sendMediaAsSticker: true });
    } catch (e) {
      console.error('❌ Erro vídeo:', e);
      return msg.reply('❌ Falha ao gerar figurinha animada do vídeo.');
    } finally {
      [tmpIn, tmpTrans, tmpOut].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
    }
  }

  return msg.reply('❌ Tipo não suportado.');
});

client.initialize();
