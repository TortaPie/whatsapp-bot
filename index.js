const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const app = express();
let currentQr = null;

const ffmpeg = require('fluent-ffmpeg');
const sharp  = require('sharp');
const fs     = require('fs');
const path   = require('path');

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

// Inicialização do Client com persistência via LocalAuth
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ]
  }
});

// Gera o QR e armazena para servir como PNG
client.on('qr', qr => {
  currentQr = qr;
  qrcode.generate(qr, { small: true });
  console.log('📲 QR code gerado e disponível em /qr.png');
});

client.on('ready', () => console.log('✅ Bot pronto e conectado!'));

// Lógica de mensagens e geração de figurinhas permanece inalterada
client.on('message', async msg => {
  const cmd = (msg.body||'').trim().toLowerCase();
  if (cmd !== '!sticker' && cmd !== '!figurinha') return;

  let source = msg;
  if (!msg.hasMedia && msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage();
    if (quoted.hasMedia) source = quoted;
  }

  if (msg.isViewOnce) return msg.reply(
    '⚠️ Vídeos "Visualizar uma vez" não podem ser processados. Reenvie como Documento (.mp4) ou imagem normal.'
  );

  if (!source.hasMedia) return msg.reply(
    '❌ Para gerar uma figurinha, envie uma mídia com legenda !sticker, ou responda a uma mídia com !sticker.'
  );

  let media;
  try { media = await source.downloadMedia(); }
  catch { return msg.reply('❌ Não foi possível baixar a mídia.'); }
  if (!media?.data) return msg.reply('❌ Mídia indisponível ou vazia.');

  const mime = media.mimetype.toLowerCase();
  const filename = (source.filename||'').toLowerCase();
  const buffer = Buffer.from(media.data, 'base64');

  // Figurinha estática
  if (mime.startsWith('image/')) {
    try {
      const webp = await sharp(buffer).resize(512,512,{fit:'cover'}).webp({quality:90}).toBuffer();
      return msg.reply(new MessageMedia('image/webp', webp.toString('base64')), undefined, { sendMediaAsSticker: true });
    } catch { return msg.reply('❌ Falha ao gerar figurinha estática.'); }
  }

  // Figurinha animada
  const isQuickTime = mime==='video/quicktime' || filename.endsWith('.mov');
  const isMp4 = mime==='video/mp4' || filename.endsWith('.mp4');
  if (isQuickTime||isMp4) {
    const tmpIn = path.join(__dirname,'tmp_in.mp4');
    fs.writeFileSync(tmpIn, buffer);
    let duration = 0;
    try {
      const info = await new Promise((r,j) => ffmpeg.ffprobe(tmpIn,(e,d)=>e?j(e):r(d)));
      duration = info.format.duration;
    } catch {}
    if ((isQuickTime && duration>5) || duration>10) {
      fs.unlinkSync(tmpIn);
      return msg.reply('⚠️ Vídeo deve ter até 10s (.mov até 5s).');
    }
    const tmpTrans = path.join(__dirname,'tmp_trans.mp4');
    const tmpOut = path.join(__dirname,'tmp_out.webp');
    try {
      await new Promise((r,j) => ffmpeg(tmpIn)
        .outputOptions(['-c:v','libx264','-preset','ultrafast','-profile:v','baseline','-level','3.0','-pix_fmt','yuv420p','-movflags','+faststart','-an'])
        .on('error',j).on('end',r).save(tmpTrans)
      );
      await new Promise((r,j) => ffmpeg(tmpTrans)
        .inputOptions(['-t','10']).videoCodec('libwebp')
        .outputOptions(['-vf','fps=10,scale=512:512:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000','-lossless','0','-compression_level','6','-q:v','50','-loop','0'])
        .on('error',j).on('end',r).save(tmpOut)
      );
      const webp = fs.readFileSync(tmpOut);
      return msg.reply(new MessageMedia('image/webp', webp.toString('base64')), undefined, { sendMediaAsSticker: true });
    } catch {
      return msg.reply('❌ Não foi possível gerar sticker animado.');
    } finally {
      [tmpIn,tmpTrans,tmpOut].forEach(f=>fs.existsSync(f)&&fs.unlinkSync(f));
    }
  }

  return msg.reply('❌ Tipo de mídia não suportado.');
});

client.initialize();
