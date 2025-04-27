const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

let currentQr = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
  }
});

client.on('qr', qr => {
  currentQr = qr;
  qrcode.generate(qr, { small: true });
  console.log('📲 QR code gerado e disponível em /qr.png');
});

client.on('ready', () => {
  console.log('✅ Bot pronto e conectado!');
});

client.on('message', async msg => {
  console.log('🔔 Nova mensagem:', msg.from, msg.body);
  const cmd = (msg.body || '').trim().toLowerCase();
  if (cmd !== '!sticker' && cmd !== '!figurinha') return;

  let source = msg;
  if (!msg.hasMedia && msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage();
    if (quoted.hasMedia) source = quoted;
  }

  if (msg.isViewOnce) return msg.reply('⚠️ Vídeos "Visualizar uma vez" não podem ser processados. Reenvie como Documento (.mp4) ou imagem normal.');

  if (!source.hasMedia) return msg.reply('❌ Para gerar uma figurinha, envie uma mídia com legenda !sticker, ou responda a uma mídia com !sticker.');

  let media;
  try {
    media = await source.downloadMedia();
  } catch {
    return msg.reply('❌ Não foi possível baixar a mídia.');
  }
  if (!media?.data) return msg.reply('❌ Mídia indisponível ou vazia.');

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
      return msg.reply(
        new MessageMedia('image/webp', webp.toString('base64')),
        undefined,
        { sendMediaAsSticker: true }
      );
    } catch (e) {
      console.error('❌ Erro figurinha estática:', e);
      return msg.reply('❌ Falha ao gerar figurinha estática.');
    }
  }

  // Figurinha animada
  const isQuickTime = mime === 'video/quicktime' || filename.endsWith('.mov');
  const isMp4 = mime === 'video/mp4' || filename.endsWith('.mp4');
  if (isQuickTime || isMp4) {
    const tmpIn = path.join(__dirname, 'tmp_in.mp4');
    const tmpTrans = path.join(__dirname, 'tmp_trans.mp4');
    const tmpOut = path.join(__dirname, 'tmp_out.webp');
    fs.writeFileSync(tmpIn, buffer);
    let duration = 0;
    try {
      const info = await new Promise((res, rej) => ffmpeg.ffprobe(tmpIn, (err, data) => err ? rej(err) : res(data)));
      duration = info.format.duration;
      console.log('⏱ Duração do vídeo:', duration);
    } catch (e) {
      console.warn('⚠️ ffprobe falhou, assumindo ≤10s');
    }
    if ((isQuickTime && duration > 5) || duration > 10) {
      fs.unlinkSync(tmpIn);
      console.log('❌ Vídeo muito longo:', duration);
      return msg.reply('⚠️ Vídeos devem ter até 10s (.mov até 5s).');
    }

    try {
      console.log('🔄 Transcodificando para H.264 Baseline');
      await new Promise((res, rej) => {
        ffmpeg(tmpIn)
          .outputOptions([
            '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline', '-level', '3.0',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'
          ])
          .on('error', rej)
          .on('end', res)
          .save(tmpTrans);
      });
      console.log('🔄 Convertendo para WebP animado');
      await new Promise((res, rej) => {
        ffmpeg(tmpTrans)
          .inputOptions(['-t', '10'])
          .videoCodec('libwebp')
          .outputOptions([
            '-vf', 'fps=10,scale=512:512:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-lossless', '0', '-compression_level', '6', '-q:v', '50', '-loop', '0'
          ])
          .on('error', rej)
          .on('end', res)
          .save(tmpOut);
      });
      console.log('📤 Enviando figurinha animada');
      const webp = fs.readFileSync(tmpOut);
      return msg.reply(
        new MessageMedia('image/webp', webp.toString('base64')),
        undefined,
        { sendMediaAsSticker: true }
      );
    } catch (e) {
      console.error('❌ Erro figurinha animada:', e);
      return msg.reply('❌ Não foi possível gerar sticker animado.');
    } finally {
      [tmpIn, tmpTrans, tmpOut].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
      console.log('🧹 Temporários removidos');
    }
  }

  console.log('❌ Tipo de mídia não suportado:', mime);
  return msg.reply('❌ Tipo de mídia não suportado.');
});

client.initialize();
