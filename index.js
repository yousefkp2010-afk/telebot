require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const OpenAI = require('openai');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const ffmpeg = require('fluent-ffmpeg');

// ── إعدادات البيئة ────────────────────────────────────
console.log('🚀 بدء تشغيل البوت (Polling mode)...');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN غير موجود في المتغيرات البيئية!');
  process.exit(1);
}
console.log('✅ BOT_TOKEN موجود.');

// ── عملاء الذكاء الاصطناعي ────────────────────────────
console.log('📦 جاري تهيئة عملاء الذكاء الاصطناعي...');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
console.log('✅ Groq جاهز.');

let gemini1 = null;
let gemini2 = null;
if (process.env.GEMINI_API_KEY) {
  gemini1 = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  });
  console.log('✅ Gemini (المفتاح 1) جاهز.');
}
if (process.env.GEMINI_API_KEY2) {
  gemini2 = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY2,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  });
  console.log('✅ Gemini (المفتاح 2) جاهز.');
}
if (!gemini1 && !gemini2) {
  console.warn('⚠️ لا يوجد مفتاح Gemini. ستتوقف ميزة /story.');
}

// ── التحقق من وجود ffmpeg ─────────────────────────────
console.log('🔍 جاري التحقق من وجود ffmpeg...');
(async () => {
  try {
    await exec('ffmpeg -version');
    console.log('✅ ffmpeg مثبت ومتاح في النظام.');
  } catch (e) {
    console.error('❌ ffmpeg غير موجود! سيتم تعطيل ميزة الفيديو.');
  }
})();

// ── ذاكرة المحادثة ────────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000;
const MAX_HISTORY = 6;

function getSession(userId) {
  const now = Date.now();
  let session = sessions.get(userId);
  if (!session || now - session.lastActive > SESSION_TTL) {
    session = { messages: [], lastActive: now };
    sessions.set(userId, session);
  } else {
    session.lastActive = now;
  }
  return session;
}

function addMessageToSession(userId, role, content) {
  const session = getSession(userId);
  session.messages.push({ role, content });
  if (session.messages.length > MAX_HISTORY) {
    session.messages.shift();
  }
}

// ── الإحصائيات ──────────────────────────────────────────
const stats = {
  groq: { success: 0, fail: 0, totalTime: 0 },
  gemini: { success: 0, fail: 0, totalTime: 0 },
  images: 0,
  summaries: 0,
  stories: 0,
  lastReset: Date.now(),
};

function recordStat(model, success, duration) {
  const s = stats[model];
  if (success) {
    s.success++;
    s.totalTime += duration;
  } else {
    s.fail++;
  }
}

// ── تخزين آخر طلبات ──────────────────────────────────
const lastImagePrompt = new Map();
const lastStoryPrompt = new Map();

// ── دالة توليد رابط الصورة ──────────────────────────
async function generateImageUrl(prompt) {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=1024&height=1024&nologo=true`;
}

// ── استخراج النص من رابط ──────────────────────────────
async function extractTextFromUrl(url) {
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    const $ = cheerio.load(data);
    $('script, style, nav, footer, header, aside').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    return text.substring(0, 3000);
  } catch (e) {
    console.error('فشل استخراج الرابط:', e.message);
    return null;
  }
}

// ── دوال توليد القصة (نفس السابق) ──────────────────
async function generateStoryDescriptions(storyIdea, geminiClient, retryCount = 0) {
  console.log(`📝 توليد أوصاف القصة (محاولة ${retryCount + 1})...`);
  const prompt = `
You are an expert at generating detailed image descriptions for a story.
Based on the following story idea, generate exactly 8 highly detailed descriptions in English.
Each description must be very detailed (at least 30 words) covering: characters (facial features, clothes, expressions), environment (background, colors, lighting), camera angle, artistic style (e.g., cinematic, realistic, cartoon, oil painting), and any visual elements that enhance the scene.
Output only a valid JSON array of 8 strings. Do not add any extra text outside the JSON.

Story idea: "${storyIdea}"

Output format: ["description 1", "description 2", ..., "description 8"]
`;

  try {
    const completion = await geminiClient.chat.completions.create({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that outputs only JSON arrays.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      stream: false,
    });
    const content = completion.choices[0]?.message?.content || '';
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('لم يتم العثور على JSON في الرد.');
    const descriptions = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(descriptions) || descriptions.length < 8) {
      throw new Error(`الرد يحتوي على ${descriptions.length} أوصاف فقط (مطلوب 8).`);
    }
    console.log(`✅ تم توليد ${descriptions.length} أوصاف بنجاح.`);
    return descriptions.slice(0, 8);
  } catch (error) {
    console.error(`❌ فشل توليد الأوصاف (محاولة ${retryCount + 1}):`, error.message);
    if (retryCount < 2) {
      console.log('🔄 إعادة المحاولة بعد 3 ثوانٍ...');
      await new Promise(r => setTimeout(r, 3000));
      return generateStoryDescriptions(storyIdea, geminiClient, retryCount + 1);
    }
    throw error;
  }
}

async function generateSingleImageWithRetry(prompt, index, maxRetries = 3) {
  const url = await generateImageUrl(prompt);
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🖼️ محاولة ${attempt} للصورة ${index+1}...`);
      
      // تأخير عشوائي بين 7-12 ثانية لتجنب 429
      const delay = 7000 + Math.random() * 5000;
      console.log(`⏳ انتظار ${Math.round(delay/1000)} ثوانٍ قبل الطلب...`);
      await new Promise(r => setTimeout(r, delay));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (response.status === 429) {
        console.warn(`⚠️ 429 (معدل الطلبات) للصورة ${index+1}. انتظار أطول...`);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      const fileName = `temp_img_${Date.now()}_${index}.jpg`;
      await fs.writeFile(fileName, Buffer.from(buffer));
      console.log(`✅ تم حفظ الصورة ${index+1} في ${fileName}`);
      return fileName;
    } catch (err) {
      lastError = err;
      console.error(`❌ فشل توليد الصورة ${index+1} (محاولة ${attempt}):`, err.message);
      if (attempt < maxRetries) {
        const wait = 10000 * attempt;
        console.log(`⏳ انتظار ${wait/1000} ثوانٍ قبل المحاولة التالية...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw new Error(`فشل توليد الصورة ${index+1} بعد ${maxRetries} محاولات: ${lastError?.message || 'غير معروف'}`);
}

async function generateAndSendImages(descriptions, ctx) {
  const imagePaths = [];
  const total = descriptions.length;
  
  await ctx.reply(`🖼️ سيتم توليد ${total} صور وإرسالها فوراً (قد يستغرق كل صورة 10-15 ثانية)...`);

  for (let i = 0; i < descriptions.length; i++) {
    try {
      await ctx.reply(`⏳ جاري توليد الصورة ${i+1}/${total}...`);
      const fileName = await generateSingleImageWithRetry(descriptions[i], i, 3);
      if (fileName) {
        imagePaths.push(fileName);
        await ctx.replyWithPhoto(
          { source: fileName },
          { caption: `📸 الصورة ${i+1}/${total}` }
        );
        console.log(`✅ تم إرسال الصورة ${i+1} للمستخدم.`);
        stats.images++;
      }
    } catch (err) {
      console.error(`❌ فشل توليد وإرسال الصورة ${i+1}:`, err.message);
      await ctx.reply(`⚠️ فشلت الصورة ${i+1}: ${err.message}`);
    }
  }
  
  console.log(`✅ تم توليد وإرسال ${imagePaths.length} من ${total} صور.`);
  return imagePaths;
}

async function createVideoFromImages(imagePaths, outputVideoPath, durationPerImage = 3.5, fadeDuration = 0.5) {
  console.log(`🎬 بدء إنشاء فيديو من ${imagePaths.length} صور...`);
  
  if (imagePaths.length === 0) {
    throw new Error('لا توجد صور لإنشاء الفيديو.');
  }

  try {
    await exec('ffmpeg -version');
  } catch (e) {
    throw new Error('ffmpeg غير مثبت على النظام. لا يمكن إنشاء الفيديو.');
  }

  return new Promise((resolve, reject) => {
    const numImages = imagePaths.length;
    const duration = durationPerImage;
    const fade = fadeDuration;

    let command = ffmpeg();
    imagePaths.forEach(img => command.input(img));

    let filterParts = [];
    for (let i = 0; i < numImages; i++) {
      const inLabel = `[${i}:v]`;
      const outLabel = `[v${i}]`;
      const scaleFilter = `scale=1024:1024:force_original_aspect_ratio=decrease,pad=1024:1024:(ow-iw)/2:(oh-ih)/2`;
      const trimFilter = `trim=0:${duration},setpts=PTS-STARTPTS`;
      let fadeFilter = '';
      if (i === 0) {
        fadeFilter = `fade=in:0:d=${fade}`;
      } else if (i === numImages - 1) {
        fadeFilter = `fade=out:${duration - fade}:d=${fade}`;
      } else {
        fadeFilter = `fade=in:0:d=${fade},fade=out:${duration - fade}:d=${fade}`;
      }
      const filter = `${scaleFilter},${trimFilter},${fadeFilter}`;
      filterParts.push(`${inLabel} ${filter} ${outLabel}`);
    }

    let currentOutput = 'v0';
    for (let i = 1; i < numImages; i++) {
      const prev = currentOutput;
      const next = `v${i}`;
      const out = `v${i-1}_${i}`;
      const offset = duration - fade;
      const xfadeFilter = `[${prev}][${next}] xfade=transition=fade:duration=${fade}:offset=${offset} [${out}]`;
      filterParts.push(xfadeFilter);
      currentOutput = out;
    }

    const filterComplex = filterParts.join('; ');
    command = command.complexFilter(filterComplex, 'output');

    command
      .output(outputVideoPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-r 30'
      ])
      .on('start', (cmd) => console.log(`🎬 بدء ffmpeg: ${cmd}`))
      .on('progress', (progress) => {
        if (progress.percent) console.log(`⏳ تقدم الفيديو: ${Math.round(progress.percent)}%`);
      })
      .on('end', () => {
        console.log(`✅ تم إنشاء الفيديو: ${outputVideoPath}`);
        resolve(outputVideoPath);
      })
      .on('error', (err) => {
        console.error('❌ خطأ في ffmpeg:', err);
        reject(err);
      })
      .run();
  });
}

async function handleStoryCommand(ctx, storyIdea) {
  const userId = ctx.from.id;
  const startTime = Date.now();
  console.log(`📖 بدء معالجة قصة للمستخدم ${userId}: "${storyIdea}"`);

  lastStoryPrompt.set(userId, storyIdea);
  
  await ctx.reply('📖 جاري معالجة فكرة القصة وتوليد 8 أوصاف مفصلة... (قد يستغرق هذا دقيقة)');

  let geminiClient = gemini1 || gemini2;
  if (!geminiClient) {
    return ctx.reply('❌ لا يوجد مفتاح Gemini لتوليد الأوصاف. يرجى إعداد GEMINI_API_KEY في البيئة.');
  }

  try {
    console.log('📝 المرحلة 1: توليد الأوصاف...');
    const descriptions = await generateStoryDescriptions(storyIdea, geminiClient);
    console.log(`✅ تم توليد ${descriptions.length} وصفاً.`);

    await ctx.reply('✅ تم توليد 8 أوصاف. سيتم الآن توليد الصور وإرسالها واحدة تلو الأخرى...');

    console.log('🖼️ المرحلة 2: توليد الصور وإرسالها...');
    const imagePaths = await generateAndSendImages(descriptions, ctx);
    
    if (imagePaths.length === 0) {
      console.error('❌ لم يتم توليد أي صورة.');
      return ctx.reply('❌ فشل توليد جميع الصور. حاول مرة أخرى.');
    }

    console.log(`✅ تم إرسال ${imagePaths.length} صور للمستخدم.`);

    if (imagePaths.length < 2) {
      await ctx.reply('⚠️ عدد الصور أقل من 2، لا يمكن إنشاء فيديو.');
      for (const img of imagePaths) {
        await fs.unlink(img).catch(() => {});
      }
      return;
    }

    await ctx.reply(`🎬 جاري محاولة إنشاء فيديو من ${imagePaths.length} صور... (قد يستغرق 15-30 ثانية)`);

    let videoCreated = false;
    let videoFileName = null;

    try {
      videoFileName = `story_video_${Date.now()}.mp4`;
      await createVideoFromImages(imagePaths, videoFileName, 3.5, 0.5);
      videoCreated = true;
      console.log(`✅ تم إنشاء الفيديو: ${videoFileName}`);
    } catch (videoError) {
      console.error(`❌ فشل إنشاء الفيديو:`, videoError.message);
      await ctx.reply(`⚠️ تعذر إنشاء الفيديو: ${videoError.message}`);
    }

    if (videoCreated && videoFileName) {
      try {
        await ctx.replyWithVideo(
          { source: videoFileName },
          {
            caption: `🎥 فيديو القصة المصور (كل صورة 3.5 ثانية)\n\n📖 الفكرة: ${storyIdea}`,
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 إعادة توليد الفيديو', callback_data: 'regen_story' }]
              ]
            }
          }
        );
        console.log(`✅ تم إرسال الفيديو.`);
        stats.stories++;
        await fs.unlink(videoFileName).catch(() => {});
      } catch (sendError) {
        console.error(`❌ فشل إرسال الفيديو:`, sendError.message);
        await ctx.reply('⚠️ تعذر إرسال الفيديو، لكن تم إرسال الصور بالفعل.');
      }
    }

    console.log(`🧹 تنظيف ${imagePaths.length} صورة مؤقتة...`);
    for (const img of imagePaths) {
      await fs.unlink(img).catch((err) => {
        console.warn(`⚠️ تعذر حذف ${img}:`, err.message);
      });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ اكتملت معالجة القصة في ${elapsed} ثانية.`);
    await ctx.reply(`✨ تم! (استغرق المعالجة ${elapsed} ثانية)`);

  } catch (error) {
    console.error(`❌ خطأ عام في /story:`, error);
    await ctx.reply(`❌ حدث خطأ أثناء توليد الفيديو: ${error.message}`);
  }
}

// ── إنشاء البوت ──────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ── معالج الأزرار التفاعلية ──────────────────────────
bot.action(/^cmd_(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  await ctx.answerCbQuery();
  if (action === 'gemini') {
    ctx.reply('🧠 اكتب سؤالك بعد **/gemini**\nمثال: `/gemini ما هو الذكاء الاصطناعي؟`', { parse_mode: 'Markdown' });
  } else if (action === 'groq') {
    ctx.reply('⚡ اكتب سؤالك بعد **/groq**\nمثال: `/groq اشرح النظرية النسبية`', { parse_mode: 'Markdown' });
  } else if (action === 'image') {
    ctx.reply('🖼️ اكتب وصف الصورة بعد **/image**\nمثال: `/image منظر طبيعي لجبال`', { parse_mode: 'Markdown' });
  } else if (action === 'story') {
    ctx.reply('📖 اكتب فكرة القصة بعد **/story**\nمثال: `/story طفل يكتشف غابة مسحورة`', { parse_mode: 'Markdown' });
  } else if (action === 'help') {
    ctx.reply('📘 استخدم **/help** لعرض جميع الأوامر.', { parse_mode: 'Markdown' });
  }
});

bot.action('regen_image', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const prompt = lastImagePrompt.get(userId);
  if (!prompt) return ctx.reply('⚠️ لا يوجد وصف سابق لإعادة التوليد.');
  await ctx.sendChatAction('upload_photo');
  const statusMsg = await ctx.reply('🎨 جارٍ إعادة توليد الصورة...');
  try {
    const imageUrl = await generateImageUrl(prompt);
    await ctx.replyWithPhoto(
      { url: imageUrl },
      {
        caption: `🖼️ ${prompt}\n\nتم الانشاء بواسطة بوت @ysfaibot`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 إعادة التوليد', callback_data: 'regen_image' }],
            [{ text: '⬇️ تحميل الصورة', url: imageUrl }]
          ]
        }
      }
    );
    stats.images++;
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
  } catch (error) {
    console.error('خطأ في إعادة التوليد:', error.message);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ فشلت إعادة التوليد. حاول لاحقاً.').catch(() => {});
  }
});

bot.action('regen_story', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const prompt = lastStoryPrompt.get(userId);
  if (!prompt) return ctx.reply('⚠️ لا توجد قصة سابقة لإعادة التوليد.');
  await handleStoryCommand(ctx, prompt);
});

// ── الأمر /start ────────────────────────────────────────
bot.start((ctx) => {
  const welcome = `🌟 **مرحباً بك في البوت الذكي!**\n\nاختر إحدى الخدمات:`;
  ctx.reply(welcome, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🧠 اسأل Gemini', callback_data: 'cmd_gemini' },
          { text: '⚡ اسأل Groq', callback_data: 'cmd_groq' }
        ],
        [
          { text: '🖼️ توليد صورة', callback_data: 'cmd_image' },
          { text: '📖 توليد فيديو من قصة', callback_data: 'cmd_story' }
        ],
        [
          { text: 'ℹ️ مساعدة', callback_data: 'cmd_help' }
        ]
      ]
    }
  });
});

// ── الأمر /help ────────────────────────────────────────
bot.help((ctx) => {
  const help = `📘 **دليل الاستخدام**\n\n` +
    `• **/gemini [نص]** – اسأل نموذج Google Gemini (عميق)\n` +
    `• **/groq [نص]** – اسأل نموذج Groq (سريع)\n` +
    `• **/image [وصف]** – توليد صورة بالذكاء الاصطناعي\n` +
    `• **/story [فكرة]** – توليد فيديو من 8 صور متسلسلة بناءً على فكرة قصة\n` +
    `• **/start** – رسالة الترحيب مع أزرار تفاعلية\n` +
    `• **/help** – هذا الدليل\n` +
    `• **/stats** – إحصائيات الاستخدام (للمالك فقط)\n\n` +
    `🔄 **السياق:** تذكر آخر 3 تبادلات لمدة 10 دقائق.\n` +
    `⚠️ **احتياطي:** عند فشل نموذج، ينتقل تلقائياً إلى الآخر.\n` +
    `🖼️ **الصور:** مدعومة عبر Pollinations.ai (مجاني، جودة عالية).\n` +
    `📄 **تلخيص الروابط:** أرسل رابطاً لتلخيص المقال فوراً.`;
  ctx.reply(help, { parse_mode: 'Markdown' });
});

// ── الأمر /stats ────────────────────────────────────────
bot.command('stats', (ctx) => {
  const userId = String(ctx.from.id);
  if (ADMIN_CHAT_ID && userId !== ADMIN_CHAT_ID) {
    return ctx.reply('⛔ هذا الأمر مخصص للمالك فقط.');
  }
  const now = Date.now();
  const uptimeMs = now - stats.lastReset;
  const uptimeMins = Math.floor(uptimeMs / 60000);
  const groqAvg = stats.groq.success > 0 ? (stats.groq.totalTime / stats.groq.success).toFixed(0) : 0;
  const geminiAvg = stats.gemini.success > 0 ? (stats.gemini.totalTime / stats.gemini.success).toFixed(0) : 0;
  const report = `📊 **إحصائيات البوت** (آخر ${uptimeMins} دقيقة)\n\n` +
    `⚡ **Groq:** ${stats.groq.success} نجاح | ${stats.groq.fail} فشل | متوسط ${groqAvg}ms\n` +
    `🧠 **Gemini:** ${stats.gemini.success} نجاح | ${stats.gemini.fail} فشل | متوسط ${geminiAvg}ms\n` +
    `🖼️ **الصور المولدة:** ${stats.images}\n` +
    `📄 **التلخيصات:** ${stats.summaries}\n` +
    `🎬 **فيديوهات القصص:** ${stats.stories}\n` +
    `🔄 **المستخدمين النشطين:** ${sessions.size}`;
  ctx.reply(report, { parse_mode: 'Markdown' });
});

// ── استخراج النص بعد الأمر ────────────────────────────
function extractQuestion(text, command) {
  if (text.startsWith(command + ' ')) {
    return text.slice(command.length + 1).trim();
  }
  if (text.startsWith(command)) {
    return text.slice(command.length).trim();
  }
  return '';
}

// ── معالج الرسائل النصية ─────────────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;

  // تلخيص الروابط
  if (!text.startsWith('/')) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex);
    if (urls && urls.length > 0) {
      const url = urls[0];
      await ctx.sendChatAction('typing');
      const statusMsg = await ctx.reply('📄 جارٍ استخراج النص من الرابط...');
      const articleText = await extractTextFromUrl(url);
      if (!articleText) {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ تعذر استخراج النص من الرابط. تأكد من أنه رابط مقال متاح للجميع.');
        return;
      }
      try {
        const completion = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'أنت ملخص محترف. لخص النص التالي في فقرة أو فقرات قصيرة مع أبرز النقاط، باللغة العربية. استخدم Markdown وإيموجيز خفيفة.' },
            { role: 'user', content: `لخص هذا النص:\n\n${articleText}` }
          ],
          stream: false,
        });
        const summary = completion.choices[0]?.message?.content || 'لم أستطع تلخيص النص.';
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          `📝 **تلخيص المقال**\n${summary}`,
          { parse_mode: 'Markdown' }
        );
        stats.summaries++;
      } catch (e) {
        console.error('خطأ تلخيص:', e.message);
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ فشل التلخيص. حاول لاحقاً.');
      }
      return;
    }
    return;
  }

  // /image
  if (text.startsWith('/image')) {
    const prompt = extractQuestion(text, '/image');
    if (!prompt) {
      return ctx.reply('🖼️ اكتب وصف الصورة بعد /image\nمثال: /image قطة بيضاء تجلس على كرسي');
    }
    lastImagePrompt.set(userId, prompt);
    await ctx.sendChatAction('upload_photo');
    const statusMsg = await ctx.reply('🎨 جارٍ توليد الصورة...');
    try {
      const imageUrl = await generateImageUrl(prompt);
      await ctx.replyWithPhoto(
        { url: imageUrl },
        {
          caption: `🖼️ ${prompt}\n\nتم الانشاء بواسطة بوت @ysfaibot`,
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 إعادة التوليد', callback_data: 'regen_image' }],
              [{ text: '⬇️ تحميل الصورة', url: imageUrl }]
            ]
          }
        }
      );
      stats.images++;
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    } catch (error) {
      console.error('خطأ في توليد الصورة:', error.message);
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ فشل توليد الصورة. حاول لاحقاً.').catch(() => {});
    }
    return;
  }

  // /story
  if (text.startsWith('/story')) {
    const storyIdea = extractQuestion(text, '/story');
    if (!storyIdea) {
      return ctx.reply('📖 اكتب فكرة القصة بعد /story\nمثال: /story طفل يكتشف غابة مسحورة');
    }
    await handleStoryCommand(ctx, storyIdea);
    return;
  }

  // /gemini و /groq
  if (!text.startsWith('/gemini') && !text.startsWith('/groq')) return;

  const isGemini = text.startsWith('/gemini');
  const command = isGemini ? '/gemini' : '/groq';
  const question = extractQuestion(text, command);

  if (!question) {
    return ctx.reply(`❓ اكتب سؤالك بعد ${command}\nمثال: ${command} ما هو الذكاء الاصطناعي؟`);
  }

  const session = getSession(userId);
  const systemMessage = { role: 'system', content: 'أنت مساعد خبير، أجب بإجابات واضحة ومنسقة باستخدام Markdown مع إيموجيز خفيفة.' };
  const messages = [systemMessage, ...session.messages, { role: 'user', content: question }];

  const executeRequest = async (modelType, client, modelName) => {
    const start = Date.now();
    try {
      await ctx.sendChatAction('typing');
      const completion = await client.chat.completions.create({
        model: modelName,
        messages,
        stream: false,
      });
      const reply = completion.choices[0]?.message?.content || 'لم أحصل على رد.';
      addMessageToSession(userId, 'user', question);
      addMessageToSession(userId, 'assistant', reply);
      const duration = Date.now() - start;
      recordStat(modelType, true, duration);
      await ctx.reply(reply, { parse_mode: 'Markdown' });
      return true;
    } catch (error) {
      const duration = Date.now() - start;
      recordStat(modelType, false, duration);
      console.error(`خطأ ${modelType}:`, error.message);
      return false;
    }
  };

  if (isGemini) {
    let success = false;
    if (gemini1) {
      success = await executeRequest('gemini', gemini1, 'gemini-2.5-flash');
    }
    if (!success && gemini2) {
      success = await executeRequest('gemini', gemini2, 'gemini-2.5-flash');
    }
    if (!success) {
      const message = gemini1 || gemini2
        ? '⚠️ تعذر الاتصال بـ Gemini. جاري تحويل طلبك إلى Groq...'
        : '⚠️ نموذج Gemini غير مفعل. جاري استخدام Groq بدلاً منه...';
      ctx.reply(message);
      const groqSuccess = await executeRequest('groq', groq, 'llama-3.3-70b-versatile');
      if (!groqSuccess) ctx.reply('❌ فشل كلا النموذجين. حاول لاحقاً.');
    }
  } else {
    const success = await executeRequest('groq', groq, 'llama-3.3-70b-versatile');
    if (!success) {
      if (gemini1 || gemini2) {
        ctx.reply('⚠️ تعذر الاتصال بـ Groq. جاري تحويل طلبك إلى Gemini...');
        let geminiSuccess = false;
        if (gemini1) {
          geminiSuccess = await executeRequest('gemini', gemini1, 'gemini-2.5-flash');
        }
        if (!geminiSuccess && gemini2) {
          geminiSuccess = await executeRequest('gemini', gemini2, 'gemini-2.5-flash');
        }
        if (!geminiSuccess) ctx.reply('❌ فشل كلا النموذجين. حاول لاحقاً.');
      } else {
        ctx.reply('❌ فشل نموذج Groq ولا يوجد نموذج بديل.');
      }
    }
  }
});

// ── خادم Express (فقط للـ Health Check و Guard) ──────
const app = express();
app.use(express.json());

app.get('/', (_, res) => res.send('Bot is alive (Polling mode)'));

// ── تشغيل البوت باستخدام Polling ─────────────────────
(async () => {
  try {
    // إلغاء أي Webhook نشط لتجنب التعارض
    await bot.telegram.deleteWebhook();
    console.log('✅ تم إلغاء Webhook (إن وجد).');
  } catch (e) {
    console.warn('⚠️ فشل إلغاء Webhook:', e.message);
  }

  // بدء Polling
  bot.launch()
    .then(() => {
      console.log('✅ البوت يعمل الآن باستخدام Polling (getUpdates).');
      console.log('🤖 جاهز لاستقبال الأوامر.');
    })
    .catch((err) => {
      console.error('❌ فشل تشغيل البوت:', err);
      process.exit(1);
    });
})();

// ── خادم Express ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Express يعمل على المنفذ ${PORT} (للـ Health Check فقط)`);
});

// ── الحارس المتبادل ────────────────────────────────────
const GUARD_URL = process.env.GUARD_URL;
if (GUARD_URL) {
  const ping = () => {
    fetch(GUARD_URL)
      .then(res => console.log(`🏓 Ping guard: ${res.status}`))
      .catch(err => console.error('❌ Guard unreachable:', err.message));
  };
  setInterval(ping, 30000);
  ping();
}

// ── معالجة الإغلاق ──────────────────────────────────
process.once('SIGINT', () => {
  console.log('🛑 إيقاف البوت...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('🛑 إيقاف البوت...');
  bot.stop('SIGTERM');
  process.exit(0);
});
