const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const ffmpeg = require('fluent-ffmpeg');
const sharp  = require('sharp');
const fs     = require('fs');
const path   = require('path');

const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('📲 Escaneie o QR no WhatsApp Mobile');
});

client.on('ready', () => {
  console.log('✅ Bot pronto e conectado!');
});

client.on('message', async msg => {
  const cmd = (msg.body||'').trim().toLowerCase();
  if (cmd !== '!sticker' && cmd !== '!figurinha') return;

  // 1) Captura mídia na própria mensagem ou em reply
  let source = msg;
  if (!msg.hasMedia && msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage();
    if (quoted.hasMedia) {
      source = quoted;
      console.log('📌 Comando em reply — usando mídia da mensagem citada');
    }
  }

  // 2) Recusa “view once”
  if (msg.isViewOnce) {
    return msg.reply(
      '⚠️ Vídeos “Visualizar uma vez” não podem ser processados.\n' +
      'Reenvie como Documento (.mp4) ou envie uma imagem normal.'
    );
  }

  // 3) Sem mídia → instruções
  if (!source.hasMedia) {
    console.log('⚠️ Sem mídia anexada');
    return msg.reply(
      '❌ Para gerar uma figurinha, envie uma imagem ou vídeo junto da legenda `!sticker`,\n' +
      'ou responda à mídia com `!sticker`.'
    );
  }

  // 4) Baixa mídia
  console.log('⬇️ Baixando mídia...');
  let media;
  try {
    media = await source.downloadMedia();
  } catch (e) {
    console.error('❌ downloadMedia falhou:', e);
    return msg.reply('❌ Não foi possível baixar a mídia. Reenvie como documento (.mp4) ou imagem.');
  }
  if (!media || !media.data) {
    console.log('❌ Mídia inválida ou vazia');
    return msg.reply('❌ Mídia indisponível. Vídeos .mov (gravação direto da camera) serão suportados menores ou igual a 5s, caso precise de mais tempo, envie o video como documento .mp4 com duração máxima de 9s. Vídeos .mp4 so podem ser processados até 9s. GIFs são suportados normalmente.');
  }

  const mime     = media.mimetype.toLowerCase();
  const filename = (source.filename||'').toLowerCase();
  const buffer   = Buffer.from(media.data, 'base64');
  console.log('✅ Mídia baixada:', mime, filename);

  // ——— Figurinha estática ———
  if (mime.startsWith('image/')) {
    console.log('🔄 Gerando figurinha estática 512×512 (cover)...');
    try {
      const webpBuf = await sharp(buffer)
        .resize(512, 512, { fit: 'cover' })
        .webp({ quality: 90 })
        .toBuffer();

      console.log('📤 Enviando figurinha estática...');
      await msg.reply(
        new MessageMedia('image/webp', webpBuf.toString('base64')),
        undefined,
        { sendMediaAsSticker: true }
      );
      console.log('🎉 Figurinha estática enviada!');
    } catch (e) {
      console.error('❌ Erro figurinha estática:', e);
      await msg.reply('❌ Falha ao gerar figurinha estática.');
    }
    return;
  }

  // ——— Figurinha animada ———
  const isQuickTime = mime === 'video/quicktime' || filename.endsWith('.mov');
  const isMp4       = mime === 'video/mp4' || filename.endsWith('.mp4');

  if (isQuickTime || isMp4) {
    // Salva temp input
    const tmpIn    = path.join(__dirname, 'tmp_in.mp4');
    const tmpTrans = path.join(__dirname, 'tmp_trans.mp4');
    const tmpOut   = path.join(__dirname, 'tmp_out.webp');
    fs.writeFileSync(tmpIn, buffer);

    // 5) Usa ffprobe pra duração
    let duration = 0;
    try {
      const info = await new Promise((res, rej) =>
        ffmpeg.ffprobe(tmpIn, (err, data) => err ? rej(err) : res(data))
      );
      duration = info.format.duration;
      console.log('⏱ Duração do vídeo:', duration.toFixed(2), 's');
    } catch (e) {
      console.warn('⚠️ ffprobe falhou, assumindo duração sup ≤10s');
    }

    // 6) Se QuickTime (>5s) não disponível no web
    if (isQuickTime && duration > 5) {
      fs.unlinkSync(tmpIn);
      console.log('❌ QuickTime >5s — instruir envio como doc MP4');
      return msg.reply(
        '⚠️ Vídeos .mov capturados pela câmera acima de 5 s não podem ser baixados.\n' +
        'Por favor, reenvie como **Documento (.mp4)** menores que 10s de duração.'
      );
    }

    // 7) Se MP4 >10s, pede vídeo menor
    if (duration > 10) {
      fs.unlinkSync(tmpIn);
      console.log('❌ Vídeo >10s — instruir duração máxima');
      return msg.reply(
        '⚠️ Vídeos só podem ser menores que 10s para stickers animados.\n' +
        'Por favor, envie um trecho menor que **10 segundos**.'
      );
    }

    try {
      // 8) Pré-transcode para H.264 Baseline (aceita vídeos da câmera)
      console.log('🔄 Transcodificando para H.264 Baseline...');
      await new Promise((res, rej) => {
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
          .on('error', rej)
          .on('end', res)
          .save(tmpTrans);
      });

      // 9) Converter para WebP animado (trunca em 10s se precisar)
      console.log('🔄 Convertendo para WebP animado...');
      await new Promise((res, rej) => {
        ffmpeg(tmpTrans)
          .inputOptions(['-t','10'])
          .videoCodec('libwebp')
          .outputOptions([
            '-vf',
              'fps=10,scale=512:512:flags=lanczos,format=rgba,' +
              'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-lossless','0',
            '-compression_level','6',
            '-q:v','50',
            '-loop','0'
          ])
          .on('error', rej)
          .on('end', res)
          .save(tmpOut);
      });

      // 10) Envia sticker animado
      console.log('📤 Enviando figurinha animada...');
      const webpBuf = fs.readFileSync(tmpOut);
      await msg.reply(
        new MessageMedia('image/webp', webpBuf.toString('base64')),
        undefined,
        { sendMediaAsSticker: true }
      );
      console.log('🎉 Figurinha animada enviada!');

    } catch (e) {
      console.error('❌ Erro processando vídeo:', e);
      await msg.reply(
        '❌ Não foi possível gerar o sticker animado.\n' +
        'Certifique-se de enviar um .mp4 válido menor que 10segundos como Documento.'
      );
    } finally {
      [tmpIn, tmpTrans, tmpOut].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
      console.log('🧹 Temporários removidos');
    }
    return;
  }

  // ——— Tipo não suportado ———
  console.log('❌ Tipo de mídia não suportado:', mime);
  await msg.reply('❌ Tipo não suportado. Envie uma imagem ou vídeo (.mp4).');
});

client.initialize();
