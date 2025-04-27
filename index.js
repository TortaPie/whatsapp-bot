const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const http = require('http');
const app = express();
let currentQr = null;

const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// helper para respostas seguras
async function safeReply(msg, ...args) {
  try {
    return await msg.reply(...args);
  } catch (err) {
    console.error('🚨 falha ao enviar reply:', err);
  }
}

// 1) Rota principal para exibir QR como PNG
app.get('/', (req, res) => {
  if (!currentQr) return res.send('QR code ainda não gerado. Aguarde.');
  res.send(`
    <h1>WhatsApp Web QR Code</h1>
    <img src="/qr.png" alt="QR Code" />
    <p>Escaneie com seu WhatsApp Mobile</p>
  `);
});

// 2) Rota que serve o QR como imagem PNG
app.get('/qr.png', (req, res) => {
  if (!currentQr) return res.status(404).send('QR não disponível');
  res.type('png');
  QRCode.toFileStream(res, currentQr, { type: 'png' });
});

// Inicia servidor HTTP antes de inicializar o client
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Servidor HTTP rodando na porta ${port}`));

// keep-alive para não hibernar o serviço
setInterval(() => {
  http.get(`http://localhost:${port}/`).on('error', () => {});
}, 4 * 60 * 1000);

// Inicialização do Client com persistência via LocalAuth
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
      '--single-process',
      '--no-zygote',
      '--no-zygote-sandbox'
    ]
  }
});

// eventos de sessão
client.on('qr', qr => {
  currentQr = qr;
  qrcode.generate(qr, { small: true });
  console.log('📲 QR code gerado e disponível em /qr.png');
});

client.on('ready', () => console.log('✅ Bot pronto e conectado!'));

client.on('auth_failure', msg => {
  console.error('⚠️ Falha na autenticação:', msg);
  client.logout().then(() => client.initialize());
});

client.on('disconnected', reason => {
  console.error('⚠️ Puppeteer desconectou:', reason);
  setTimeout(() => client.initialize(), 5000);
});

// Lógica de mensagens e geração de figurinhas com debug
client.on('message', async msg => {
  console.log('🔔 nova mensagem:', msg.from, msg.body);
  const cmd = (msg.body || '').trim().toLowerCase();
  if (cmd !== '!sticker' && cmd !== '!figurinha') return;

  let source = msg;
  if (!msg.hasMedia && msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage();
    if (quoted.hasMedia) source = quoted;
  }

  if (msg.isViewOnce) {
    return safeReply(msg,
      '⚠️ Vídeos "Visualizar uma vez" não podem ser processados. Reenvie como Documento (.mp4) ou imagem normal.'
    );
  }

  if (!source.hasMedia) {
    return safeReply(msg,
      '❌ Para gerar uma figurinha, envie uma mídia com legenda !sticker, ou responda a uma mídia com !sticker.'
    );
  }

  let media;
  try {
    media = await source.downloadMedia();
  } catch {
    return safeReply(msg, '❌ Não foi possível baixar a mídia.');
  }
  if (!media?.data) {
    return safeReply(msg, '❌ Mídia indisponível ou vazia.');
  }

  console.log('⬇️ Baixando mídia...');
  const mime = media.mimetype.toLowerCase();
  const filename = (source.filename || '').toLowerCase();
  const buffer = Buffer.from(media.data, 'base64');
  console.log('✅ Mídia baixada:', mime, filename);

  // Figurinha estática
  if (mime.startsWith('image/')) {
    console.log('🔄 Gerando figurinha estática...');
    try {
      const webp = await sharp(buffer)
        .resize(512, 512, { fit: 'cover' })
        .webp({ quality: 90 })
        .toBuffer();
      console.log('📤 Enviando figurinha estática');
      return safeReply(
        msg,
        new MessageMedia('image/webp', webp.toString('base64')),
        undefined,
        { sendMediaAsSticker: true }
      );
    } catch (e) {
      console.error('❌ Erro figurinha estática:', e);
      return safeReply(msg, '❌ Falha ao gerar figurinha estática.');
    }
  }

  // Figurinha animada
  const isQuickTime = mime === 'video/quicktime' || filename.endsWith('.mov');
  const isMp4 = mime === 'video/mp4' || filename.endsWith('.mp4');
  if (isQuickTime || isMp4) {
    const tmpIn = path.join(__dirname, 'tmp_in.mp4');
    fs.writeFileSync(tmpIn, buffer);
    // filtrar vídeos direto da câmera
    if (isMp4 && !filename) {
      fs.unlinkSync(tmpIn);
      return safeReply(msg,
        '❌ Para stickers animados, envie o vídeo como Documento (.mp4).'
      );
    }
    let duration = 0;
    try {
      const info = await new Promise((res, rej) =>
        ffmpeg.ffprobe(tmpIn, (err, data) => err ? rej(err) : res(data))
      );
      duration = info.format.duration;
      console.log('⏱ Duração do vídeo:', duration);
    } catch (e) {
      console.warn('⚠️ ffprobe falhou, assumindo ≤10s');
    }
    if ((isQuickTime && duration > 5) || duration > 10) {
      fs.unlinkSync(tmpIn);
      console.log('❌ Vídeo muito longo:', duration);
      return safeReply(msg, '⚠️ Vídeos devem ter até 10s (.mov até 5s).');
    }

    const tmpTrans = path.join(__dirname, 'tmp_trans.mp4');
    const tmpOut = path.join(__dirname, 'tmp_out.webp');
    try {
      console.log('🔄 Transcodificando para H.264 Baseline');
      await new Promise((res, rej) =>
        ffmpeg(tmpIn)
          .outputOptions([
            '-c:v','libx264','-preset','ultrafast','-profile:v','baseline','-level','3.0',
            '-pix_fmt','yuv420p','-movflags','+faststart','-an'
          ])
          .on('error', rej)
          .on('end', res)
          .save(tmpTrans)
      );
      console.log('🔄 Convertendo para WebP animado');
      await new Promise((res, rej) =>
        ffmpeg(tmpTrans)
          .inputOptions(['-t','10'])
          .videoCodec('libwebp')
          .outputOptions([
            '-vf','fps=10,scale=512:512:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-lossless','0','-compression_level','6','-q:v','50','-loop','0'
          ])
          .on('error', rej)
          .on('end', res)
          .save(tmpOut)
      );
      console.log('📤 Enviando figurinha animada');
      const webpBuf = fs.readFileSync(tmpOut);
      return safeReply(
        msg,
        new MessageMedia('image/webp', webpBuf.toString('base64')),
        undefined,
        { sendMediaAsSticker: true }
      );
    } catch (e) {
      console.error('❌ Erro figurinha animada:', e);
      return safeReply(msg, '❌ Não foi possível gerar sticker animado.');
    } finally {
      [tmpIn, tmpTrans, tmpOut].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
      console.log('🧹 Temporários removidos');
    }
  }

  console.log('❌ Tipo de mídia não suportado:', mime);
  return safeReply(msg, '❌ Tipo de mídia não suportado.');
});

client.initialize();
