/* ------------------------------------
   DEPENDÊNCIAS
------------------------------------ */
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode   = require('qrcode-terminal');
const ffmpeg   = require('fluent-ffmpeg');
const sharp    = require('sharp');
const fs       = require('fs');
const path     = require('path');

/* ------------------------------------
   CLIENTE WHATSAPP
------------------------------------ */
const SESSION_DIR = process.env.SESSION_PATH || '.';

const client = new Client({
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR })
});

/* ------------------------------------
   EVENTOS DE CONEXÃO
------------------------------------ */
client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('📲  Escaneie o QR acima para logar');
});

client.on('ready', () => {
  console.log('✅  Bot conectado e pronto!');
});

/* ------------------------------------
   FUNÇÃO AUXILIAR – DOWNLOAD SEGURO
------------------------------------ */
async function safeDownload(msg) {
  try {
    return await msg.downloadMedia();
  } catch (e) {
    console.error('❌  Falha no download:', e);
    return null;
  }
}

/* ------------------------------------
   TRATAMENTO DE MENSAGENS
------------------------------------ */
client.on('message', async (msg) => {

  const trigger = (msg.body || '').trim().toLowerCase();
  if (trigger !== '!sticker' && trigger !== '!figurinha') return;

  // 1) Descobrir onde está a mídia (na própria ou em reply)
  let src = msg;
  if (!msg.hasMedia && msg.hasQuotedMsg) {
    const q = await msg.getQuotedMessage();
    if (q.hasMedia) src = q;
  }

  // 2) Checagem rápida
  if (!src.hasMedia) {
    return msg.reply('❌ Envie uma imagem ou vídeo com a legenda *!sticker*,\n'
                   + 'ou responda a uma mídia com *!sticker*.');
  }
  if (src.isViewOnce) {
    return msg.reply('⚠️ Vídeos “Visualizar uma vez” não são suportados.\n'
                   + 'Reenvie como documento (.mp4) ou vídeo normal.');
  }

  // 3) Baixar mídia
  console.log('⬇️  Baixando mídia...');
  const media = await safeDownload(src);
  if (!media || !media.data) {
    return msg.reply('❌ Mídia indisponível. Tente reenviar como documento.');
  }
  const buffer   = Buffer.from(media.data, 'base64');
  const mime     = media.mimetype.toLowerCase();
  const filename = (src.filename || '').toLowerCase();
  console.log('✅  Mídia:', mime, filename || '');

  /* ---------- FIGURINHA ESTÁTICA ---------- */
  if (mime.startsWith('image/')) {
    try {
      const webpBuf = await sharp(buffer)
        .resize(512, 512, { fit: 'cover' })
        .webp({ quality: 90 })
        .toBuffer();

      await msg.reply(
        new MessageMedia('image/webp', webpBuf.toString('base64')),
        undefined,
        { sendMediaAsSticker: true }
      );
      console.log('🎉  Sticker estático enviado!');
    } catch (e) {
      console.error('❌  Erro sticker estático:', e);
      msg.reply('❌ Falha ao gerar figurinha estática.');
    }
    return;
  }

  /* ---------- FIGURINHA ANIMADA ---------- */
  const isMov = mime === 'video/quicktime' || filename.endsWith('.mov');
  const isMp4 = mime === 'video/mp4' || filename.endsWith('.mp4') || mime === 'video/gif';

  if (!isMov && !isMp4) {
    return msg.reply('❌ Formato não suportado. Use imagem ou vídeo .mp4/.mov.');
  }

  // salvar vídeo temporário
  const tmpIn    = path.join(__dirname, 'tmp_in');
  const tmpTrans = path.join(__dirname, 'tmp_trans.mp4');
  const tmpOut   = path.join(__dirname, 'tmp_out.webp');
  fs.writeFileSync(tmpIn, buffer);

  // Detectar duração
  let duration = 0;
  try {
    const info = await new Promise((res, rej) =>
      ffmpeg.ffprobe(tmpIn, (err, data) => err ? rej(err) : res(data))
    );
    duration = info.format.duration || 0;
  } catch (e) {
    console.warn('⚠️  ffprobe falhou, assumindo duração curta');
  }

  // Regras de duração
  if (isMov && duration > 5) {
    fs.unlinkSync(tmpIn);
    return msg.reply('⚠️ Vídeos .mov gravados pela câmera só funcionam até 5 s.\n'
                   + 'Envie como Documento (.mp4) se quiser até 10 s.');
  }
  if (duration > 10) {
    fs.unlinkSync(tmpIn);
    return msg.reply('⚠️ O WhatsApp limita stickes animados a 10 s.\n'
                   + 'Envie um trecho menor.');
  }

  try {
    // 1) Transcode (caso precise) para H.264 baseline
    await new Promise((ok, err) => {
      ffmpeg(tmpIn)
        .outputOptions([
          '-c:v','libx264',
          '-preset','ultrafast',
          '-profile:v','baseline',
          '-level','3.0',
          '-pix_fmt','yuv420p',
          '-movflags','+faststart',
          '-an'
        ])
        .on('end', ok)
        .on('error', err)
        .save(tmpTrans);
    });

    // 2) Converter para WebP animado em 512×512
    await new Promise((ok, err) => {
      ffmpeg(tmpTrans)
        .inputOptions(['-t','10'])
        .videoCodec('libwebp')
        .outputOptions([
          '-vf','fps=10,scale=512:512:flags=lanczos,' +
                'format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
          '-lossless','0',
          '-compression_level','6',
          '-q:v','50',
          '-loop','0',
          '-an'
        ])
        .on('end', ok)
        .on('error', err)
        .save(tmpOut);
    });

    const webpBuf = fs.readFileSync(tmpOut);
    await msg.reply(
      new MessageMedia('image/webp', webpBuf.toString('base64')),
      undefined,
      { sendMediaAsSticker: true }
    );
    console.log('🎉  Sticker animado enviado!');

  } catch (e) {
    console.error('❌  Falha no processamento do vídeo:', e);
    msg.reply('❌ Não foi possível gerar o sticker animado.\n'
            + 'Tente outro vídeo .mp4 de até 10 s ou envie como documento.');
  } finally {
    [tmpIn, tmpTrans, tmpOut].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
  }
});

/* ------------------------------------ */
client.initialize();
