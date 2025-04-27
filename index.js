const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode   = require('qrcode-terminal');
const QRCode   = require('qrcode');
const express  = require('express');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const ffmpeg   = require('fluent-ffmpeg');
const sharp    = require('sharp');

// SERVIDOR EXPRESS PARA QR CODE
const app = express();
let currentQr = null;

app.get('/', (req, res) => {
  if (!currentQr) return res.send('QR code ainda não gerado. Aguarde.');
  res.type('png');
  QRCode.toFileStream(res, currentQr);
});

app.get('/qr-page', (req, res) => {
  if (!currentQr) return res.send('QR code ainda não gerado. Aguarde.');
  res.send(`
    <h1>QR Code para PieBot</h1>
    <img src="/" alt="QR Code" />
    <p>Escaneie com seu WhatsApp Mobile para conectar o bot.</p>
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🌐 Servidor HTTP iniciado na porta ${port}`);
  setInterval(() => {
    http.get(`http://localhost:${port}/qr-page`).on('error', ()=>{});
  }, 4*60*1000);
});

// INICIALIZA BOT
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--single-process','--no-zygote','--no-zygote-sandbox'
    ]
  }
});

client.on('qr', qr => {
  currentQr = qr;
  qrcode.generate(qr, { small: true });
  console.log('📲 QR gerado');
});

client.on('ready', () => console.log('✅ PieBot conectado!'));

client.on('message', async msg => {
  console.log('🆕 Mensagem de', msg.from, '| tipo:', msg.type, '| corpo:', msg.body);
  const cmd = (msg.body||'').trim().toLowerCase();

  // Apresentação via !start
  if (cmd === '!start') {
    return msg.reply(
      '✨ *Olá, sou Pie Bot, um robozinho muito gostoso!* Espero poder lhe ajudar!\n\n' +
      '🔹 *Figurinhas animadas* funcionam somente com arquivos enviados como *Documento* (GIF ou MP4).\n' +
      '🔹 *Vídeos .mp4* têm duração máxima de *9 segundos*.\n' +
      '🔹 Envie seu arquivo junto ao comando *!sticker* para eu processar e enviar sua figurinha animada!'
    );
  }

  if (cmd !== '!sticker' && cmd !== '!figurinha') return;

  // stickers nativos
  if (msg.type === 'sticker') {
    console.log('⚡ Sticker nativo detectado');
    return msg.reply('❌ Não converto stickers prontos. Envie imagem, GIF ou vídeo como documento.');
  }

  // captura mídia
  let source = msg;
  if (!msg.hasMedia && msg.hasQuotedMsg) {
    const q = await msg.getQuotedMessage(); if (q.hasMedia) source = q;
  }
  if (!source.hasMedia) {
    console.log('⚠️ Sem mídia');
    return msg.reply('❌ Envie uma mídia (imagem, GIF ou vídeo) junto ao !sticker ou em reply.');
  }

  console.log('⬇️ Baixando mídia...');
  let media;
  try { media = await source.downloadMedia(); }
  catch (e) { console.error('❌ downloadMedia falhou:', e); return msg.reply('❌ Não foi possível baixar a mídia.'); }
  if (!media || !media.data) {
    console.log('⚠️ Mídia vazia após download');
    if (source.type === 'image') return msg.reply('⚠️ GIF inline não suportado; envie como Documento (.gif).');
    if (source.type === 'video') return msg.reply('⚠️ Vídeo direto da câmera não suportado; envie como Documento (.mp4).');
    return msg.reply('⚠️ Mídia indisponível. Envie como documento.');
  }

  const mime = media.mimetype;
  const filename = (source.filename||'').toLowerCase();
  const buf = Buffer.from(media.data, 'base64');
  console.log('📄 MIME:', mime, '| nome:', filename);

  // estática
  if (mime.startsWith('image/') && !mime.includes('gif')) {
    console.log('🖼️ Branch imagem estática');
    try {
      const webp = await sharp(buf).resize(512,512,{fit:'cover'}).webp({quality:90}).toBuffer();
      return msg.reply(new MessageMedia('image/webp', webp.toString('base64')),undefined,{sendMediaAsSticker:true});
    } catch(e) { console.error('❌ erro estática',e); return msg.reply('❌ Falha ao gerar figurinha estática.'); }
  }

  // GIF
  if (mime.includes('gif') || filename.endsWith('.gif')) {
    console.log('🎞️ Branch GIF');
    const tmpIn = path.join(__dirname,'in.gif'), tmpOut = path.join(__dirname,'out.webp');
    fs.writeFileSync(tmpIn,buf);
    try {
      await new Promise((r,j)=> ffmpeg(tmpIn)
        .outputOptions([
          '-vcodec','libwebp','-lossless','0','-q:v','50','-compression_level','6','-loop','0',
          '-preset','default','-an','-vsync','0','-vf','fps=10,scale=512:512:flags=lanczos'
        ])
        .on('end',r).on('error',j)
        .save(tmpOut)
      );
      const webp = fs.readFileSync(tmpOut);
      return msg.reply(new MessageMedia('image/webp',webp.toString('base64')),undefined,{sendMediaAsSticker:true});
    } catch(e){ console.error('❌ erro GIF',e); return msg.reply('❌ Falha ao gerar figurinha do GIF.'); } finally{ fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); }
  }

  // vídeo
  if (mime.startsWith('video/')) {
    console.log('🎥 Branch vídeo');
    const tmpIn = path.join(__dirname, filename.endsWith('.mov')?'in.mov':'in.mp4');
    const tmpTrans = path.join(__dirname,'trans.mp4');
    const tmpOut = path.join(__dirname,'out.webp');
    fs.writeFileSync(tmpIn,buf);

    let duration=0;
    try { const info = await new Promise((r,j)=> ffmpeg.ffprobe(tmpIn,(e,d)=>e?j(e):r(d))); duration = info.format.duration; } catch{ duration=10; }
    if (duration > 10) { fs.unlinkSync(tmpIn); return msg.reply('⚠️ Vídeos devem ter no máximo 10 segundos (.mp4 ou .mov).'); }

    try {
      await new Promise((r,j)=> ffmpeg(tmpIn)
        .outputOptions(['-c:v','libx264','-preset','ultrafast','-profile:v','baseline','-level','3.0','-pix_fmt','yuv420p','-movflags','+faststart','-an'])
        .on('end',r).on('error',j)
        .save(tmpTrans)
      );
      await new Promise((r,j)=> ffmpeg(tmpTrans)
        .inputOptions(['-t','10']).videoCodec('libwebp')
        .outputOptions(['-vf','fps=10,scale=512:512:flags=lanczos','-lossless','0','-compression_level','6','-q:v','50','-loop','0'])
        .on('end',r).on('error',j)
        .save(tmpOut)
      );
      const webpBuf = fs.readFileSync(tmpOut);
      return msg.reply(new MessageMedia('image/webp',webpBuf.toString('base64')),undefined,{sendMediaAsSticker:true});
    } catch(e){ console.error('❌ erro vídeo',e); return msg.reply('❌ Falha ao gerar figurinha animada do vídeo.'); } finally{ [tmpIn,tmpTrans,tmpOut].forEach(f=>fs.existsSync(f)&&fs.unlinkSync(f)); }
  }

  return msg.reply('❌ Tipo não suportado.');
});

client.initialize();
