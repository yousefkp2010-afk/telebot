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
console.log('🚀 بدء تشغيل البوت...');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN غير موجود في المتغيرات البيئية!');
  process.exit(1);
}
console.log('✅ BOT_TOKEN موجود.');

// ── عملاء الذكاء الاصطناعي ────────────────────────────
console.log('📦 جاري تهيئة عملاء الذكاء الاصطناعي...');

// Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
console.log('✅ Groq جاهز.');

// Gemini (مفتاحان للاحتياطي)
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
    console.error('   لاحظ أن بعض وظائف /story ستعمل بدون فيديو (صور منفردة).');
  }
})();

// ── ذاكرة المحادثة (السياق) ────────────────────────────
const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000;
const MAX_HISTORY = 6;

function getSession(userId) {
  const now = Date.now();
  let session = sessions.get(userId);
  if (!session || now - session.lastActive > SESSION_TTL) {
    session = { messages: [], lastActive: now };
    sessions.set(userId, session);
    console.log(`📂 جلسة جديدة للمستخدم ${userId}`);
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
  console.log(`💬 أضيفت رسالة للمستخدم ${userId} (${session.messages.length} رسائل)`);
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
  console.log(`📊 إحصاء ${model}: نجاح=${s.success}, فشل=${s.fail}`);
}

// ── تخزين آخر طلبات لإعادة التوليد ──────────────────
const lastImagePrompt = new Map();
const lastStoryPrompt = new Map();

// ── دالة توليد رابط الصورة عبر Pollinations ──────────
async function generateImageUrl(prompt) {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=1024&height=1024&nologo=true`;
  console.log(`🌐 رابط الصورة: ${url.substring(0, 80)}...`);
  return url;
}

// ── استخراج النص من رابط المقال ──────────────────────
async function extractTextFromUrl(url) {
  console.log(`🔗 استخراج النص من: ${url}`);
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    const $ = cheerio.load(data);
    $('script, style, nav, footer, header, aside').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    console.log(`📄 تم استخراج ${text.length} حرفاً.`);
    return text.substring(0, 3000);
  } catch (e) {
    console.error(`❌ فشل استخراج الرابط: ${e.message}`);
    return null;
  }
}

// ── دوال توليد القصة (مع رسائل تتبع مفصلة) ───────────

/**
 * توليد 8 أوصاف باللغة الإنجليزية بصيغة JSON باستخدام Gemini
 * مع إعادة محاولة تلقائية في حال الفشل
 */
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
    console.log(`📥 استجابة Gemini: ${content.substring(0, 100)}...`);

    // استخراج JSON من النص
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

/**
 * توليد صور من قائمة الأوصاف مع تتبع التقدم وإرسال تحديثات للمستخدم
 */
async function generateImagesFromDescriptions(descriptions, ctx) {
  console.log(`🖼️ بدء توليد ${descriptions.length} صور...`);
  const imagePaths = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < descriptions.length; i++) {
    console.log(`🖼️ توليد الصورة ${i+1}/${descriptions.length}: ${descriptions[i].substring(0, 50)}...`);
    
    // تأخير 5 ثوان بين الطلبات لتجنب حد Pollinations (طلب واحد لكل IP كل 5 ثوان)
    if (i > 0) {
      console.log(`⏳ انتظار 5 ثوانٍ لتجنب حد Pollinations...`);
      await sleep(5000);
    }

    const prompt = descriptions[i];
    const url = await generateImageUrl(prompt);

    try {
      // مهلة 30 ثانية للطلب لتجنب التعليق طويلاً
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        console.warn(`⏰ انتهت مهلة طلب الصورة ${i+1}.`);
        controller.abort();
      }, 30000);

      console.log(`📡 طلب الصورة ${i+1}...`);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      const fileName = `temp_img_${Date.now()}_${i}.jpg`;
      await fs.writeFile(fileName, Buffer.from(buffer));
      imagePaths.push(fileName);
      console.log(`✅ تم حفظ الصورة ${i+1} في ${fileName}`);

      // إرسال تحديث للمستخدم كل صورتين
      if ((i + 1) % 2 === 0 || i === descriptions.length - 1) {
        await ctx.reply(`🖼️ تم توليد ${i+1} من ${descriptions.length} صور`);
      }
    } catch (err) {
      console.error(`❌ فشل توليد الصورة ${i+1}:`, err.message);
      // لا نوقف العملية، نستمر في توليد الباقي
    }
  }

  console.log(`✅ تم توليد ${imagePaths.length} من ${descriptions.length} صور بنجاح.`);
  return imagePaths;
}

/**
 * إنشاء فيديو من الصور باستخدام ffmpeg (مع انتقال fade)
 * مع التحقق المسبق من وجود ffmpeg ومعالجة الأخطاء
 */
async function createVideoFromImages(imagePaths, outputVideoPath, durationPerImage = 3.5, fadeDuration = 0.5) {
  console.log(`🎬 بدء إنشاء فيديو من ${imagePaths.length} صور...`);
  
  if (imagePaths.length === 0) {
    throw new Error('❌ لا توجد صور لإنشاء الفيديو.');
  }

  // التحقق من وجود ffmpeg
  try {
    console.log('🔍 التحقق من وجود ffmpeg...');
    await exec('ffmpeg -version');
    console.log('✅ ffmpeg موجود.');
  } catch (e) {
    console.error('❌ ffmpeg غير موجود!');
    throw new Error('❌ ffmpeg غير مثبت على النظام. لا يمكن إنشاء الفيديو. سيتم إرسال الصور منفردة كحل بديل.');
  }

  return new Promise((resolve, reject) => {
    console.log('🎞️ بناء أوامر ffmpeg...');
    const numImages = imagePaths.length;
    const duration = durationPerImage;
    const fade = fadeDuration;

    let command = ffmpeg();
    imagePaths.forEach(img => {
      console.log(`📂 إضافة صورة: ${img}`);
      command.input(img);
    });

    // بناء filter complex يدوياً
    let filterParts = [];
    let inputs = [];
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
      inputs.push(outLabel);
      console.log(`🔧 الفلتر للصورة ${i}: ${filter}`);
    }

    // xfade بين كل زوج متتالي
    let currentOutput = 'v0';
    for (let i = 1; i < numImages; i++) {
      const prev = currentOutput;
      const next = `v${i}`;
      const out = `v${i-1}_${i}`;
      const offset = duration - fade;
      const xfadeFilter = `[${prev}][${next}] xfade=transition=fade:duration=${fade}:offset=${offset} [${out}]`;
      filterParts.push(xfadeFilter);
      currentOutput = out;
      console.log(`🔀 إضافة انتقال بين الصورة ${i-1} و ${i}: ${xfadeFilter}`);
    }

    const filterComplex = filterParts.join('; ');
    console.log(`📋 فلتر معقد: ${filterComplex.substring(0, 200)}...`);
    command = command.complexFilter(filterComplex, 'output');

    // إعدادات الخرج
    command
      .output(outputVideoPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-r 30'
      ])
      .on('start', (cmd) => {
        console.log(`🎬 بدء تشغيل ffmpeg: ${cmd}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`⏳ تقدم الفيديو: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', () => {
        console.log(`✅ تم إنشاء الفيديو بنجاح: ${outputVideoPath}`);
        resolve(outputVideoPath);
      })
      .on('error', (err) => {
        console.error(`❌ خطأ في ffmpeg:`, err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * الدالة الرئيسية لتوليد قصة كاملة (أوصاف + صور + فيديو)
 * مع إرسال الصور منفردة كحل بديل في حال فشل الفيديو
 */
async function handleStoryCommand(ctx, storyIdea) {
  const userId = ctx.from.id;
  const startTime = Date.now();
  console.log(`📖 بدء معالجة قصة للمستخدم ${userId}: "${storyIdea}"`);

  lastStoryPrompt.set(userId, storyIdea);
  
  // رسالة فورية لتجنب انتهاء مهلة الـ webhook
  await ctx.reply('📖 جاري معالجة فكرة القصة وتوليد 8 أوصاف مفصلة... (قد يستغرق هذا دقيقة)');

  // اختيار عميل Gemini (المفتاح الأول إن وجد، وإلا الثاني)
  let geminiClient = gemini1 || gemini2;
  if (!geminiClient) {
    console.error('❌ لا يوجد مفتاح Gemini.');
    return ctx.reply('❌ لا يوجد مفتاح Gemini لتوليد الأوصاف. يرجى إعداد GEMINI_API_KEY في البيئة.');
  }

  try {
    // 1. توليد الأوصاف
    console.log('📝 المرحلة 1: توليد الأوصاف...');
    const descriptions = await generateStoryDescriptions(storyIdea, geminiClient);
    console.log(`✅ تم توليد ${descriptions.length} وصفاً.`);

    // إرسال الأوصاف للمستخدم (اختياري، لكن مفيد للتتبع)
    // const descText = descriptions.map((d, i) => `${i+1}. ${d}`).join('\n\n');
    // await ctx.reply(`📝 الأوصاف:\n${descText}`);

    await ctx.reply('✅ تم توليد 8 أوصاف. جاري إنشاء الصور... (قد يستغرق 30-60 ثانية)');

    // 2. توليد الصور
    console.log('🖼️ المرحلة 2: توليد الصور...');
    const imagePaths = await generateImagesFromDescriptions(descriptions, ctx);
    console.log(`✅ تم توليد ${imagePaths.length} صور.`);

    if (imagePaths.length === 0) {
      console.error('❌ لم يتم توليد أي صورة.');
      return ctx.reply('❌ فشل توليد جميع الصور. حاول مرة أخرى.');
    }

    // 3. محاولة إنشاء الفيديو
    console.log('🎬 المرحلة 3: إنشاء الفيديو...');
    let videoCreated = false;
    let videoFileName = null;

    try {
      videoFileName = `story_video_${Date.now()}.mp4`;
      await ctx.reply(`🎬 جاري تجميع ${imagePaths.length} صورة في فيديو... (قد يستغرق 15-30 ثانية)`);
      
      await createVideoFromImages(imagePaths, videoFileName, 3.5, 0.5);
      videoCreated = true;
      console.log(`✅ تم إنشاء الفيديو: ${videoFileName}`);
    } catch (videoError) {
      console.error(`❌ فشل إنشاء الفيديو:`, videoError.message);
      await ctx.reply(`⚠️ تعذر إنشاء الفيديو (${videoError.message}). سيتم إرسال الصور منفردة كحل بديل.`);
    }

    // 4. إرسال النتيجة
    if (videoCreated && videoFileName) {
      // إرسال الفيديو
      console.log(`📤 إرسال الفيديو...`);
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
        // حذف الفيديو بعد الإرسال
        await fs.unlink(videoFileName).catch(() => {});
      } catch (sendError) {
        console.error(`❌ فشل إرسال الفيديو:`, sendError.message);
        // في حال فشل إرسال الفيديو، نرسل الصور منفردة
        await ctx.reply('⚠️ تعذر إرسال الفيديو. سأرسل الصور منفردة بدلاً من ذلك.');
        videoCreated = false;
      }
    }

    // إذا فشل الفيديو، نرسل الصور منفردة
    if (!videoCreated) {
      console.log(`📤 إرسال ${imagePaths.length} صور منفردة...`);
      for (let i = 0; i < imagePaths.length; i++) {
        try {
          await ctx.replyWithPhoto(
            { source: imagePaths[i] },
            { caption: `📸 الصورة ${i+1}/${imagePaths.length}` }
          );
          console.log(`✅ تم إرسال الصورة ${i+1}`);
        } catch (photoError) {
          console.error(`❌ فشل إرسال الصورة ${i+1}:`, photoError.message);
        }
        // تأخير بسيط بين إرسال الصور
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // تنظيف الصور المؤقتة
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

// ── إنشاء البوت (Telegraf) ────────────────────────────
console.log('🤖 تهيئة البوت...');
const bot = new Telegraf(BOT_TOKEN);
console.log('✅ البوت مهيأ.');

// ── معالج الأزرار التفاعلية ──────────────────────────
bot.action(/^cmd_(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  console.log(`🔄 زر تم الضغط عليه: ${action} من المستخدم ${ctx.from.id}`);
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
  console.log(`🔄 إعادة توليد صورة للمستخدم ${ctx.from.id}`);
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
    console.error('❌ خطأ في إعادة التوليد:', error.message);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ فشلت إعادة التوليد. حاول لاحقاً.').catch(() => {});
  }
});

bot.action('regen_story', async (ctx) => {
  console.log(`🔄 إعادة توليد قصة للمستخدم ${ctx.from.id}`);
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const prompt = lastStoryPrompt.get(userId);
  if (!prompt) return ctx.reply('⚠️ لا توجد قصة سابقة لإعادة التوليد.');
  await handleStoryCommand(ctx, prompt);
});

// ── الأمر /start ────────────────────────────────────────
bot.start((ctx) => {
  console.log(`📩 /start من المستخدم ${ctx.from.id}`);
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
  console.log(`📩 /help من المستخدم ${ctx.from.id}`);
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
  console.log(`📊 /stats من المستخدم ${userId}`);
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

// ── معالج الرسائل النصية (الشامل) ─────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;
  console.log(`💬 رسالة من ${userId}: "${text.substring(0, 50)}..."`);

  // ── تلخيص الروابط ──────────────────────────────
  if (!text.startsWith('/')) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex);
    if (urls && urls.length > 0) {
      const url = urls[0];
      console.log(`🔗 رابط مكتشف: ${url}`);
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
        console.log(`✅ تم تلخيص المقال بنجاح.`);
      } catch (e) {
        console.error('❌ خطأ تلخيص:', e.message);
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ فشل التلخيص. حاول لاحقاً.');
      }
      return;
    }
    return; // تجاهل الرسائل العادية غير الأوامر
  }

  // ── أمر /image ──────────────────────────────────
  if (text.startsWith('/image')) {
    const prompt = extractQuestion(text, '/image');
    if (!prompt) {
      return ctx.reply('🖼️ اكتب وصف الصورة بعد /image\nمثال: /image قطة بيضاء تجلس على كرسي');
    }
    console.log(`🖼️ طلب صورة من ${userId}: "${prompt}"`);
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
      console.log(`✅ تم إرسال الصورة.`);
    } catch (error) {
      console.error('❌ خطأ في توليد الصورة:', error.message);
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ فشل توليد الصورة. حاول لاحقاً.').catch(() => {});
    }
    return;
  }

  // ── أمر /story ──────────────────────────────────
  if (text.startsWith('/story')) {
    const storyIdea = extractQuestion(text, '/story');
    if (!storyIdea) {
      return ctx.reply('📖 اكتب فكرة القصة بعد /story\nمثال: /story طفل يكتشف غابة مسحورة');
    }
    console.log(`📖 طلب قصة من ${userId}: "${storyIdea}"`);
    await handleStoryCommand(ctx, storyIdea);
    return;
  }

  // ── أوامر /gemini و /groq ──────────────────────
  if (!text.startsWith('/gemini') && !text.startsWith('/groq')) return;

  const isGemini = text.startsWith('/gemini');
  const command = isGemini ? '/gemini' : '/groq';
  const question = extractQuestion(text, command);

  if (!question) {
    return ctx.reply(`❓ اكتب سؤالك بعد ${command}\nمثال: ${command} ما هو الذكاء الاصطناعي؟`);
  }

  console.log(`${isGemini ? '🧠' : '⚡'} طلب من ${userId}: "${question}"`);

  const session = getSession(userId);
  const systemMessage = { role: 'system', content: 'أنت مساعد خبير، أجب بإجابات واضحة ومنسقة باستخدام Markdown مع إيموجيز خفيفة.' };
  const messages = [systemMessage, ...session.messages, { role: 'user', content: question }];

  const executeRequest = async (modelType, client, modelName) => {
    const start = Date.now();
    try {
      await ctx.sendChatAction('typing');
      console.log(`📡 استدعاء ${modelType} (${modelName})...`);
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
      console.log(`✅ رد ${modelType} في ${duration}ms`);
      return true;
    } catch (error) {
      const duration = Date.now() - start;
      recordStat(modelType, false, duration);
      console.error(`❌ خطأ ${modelType}:`, error.message);
      return false;
    }
  };

  if (isGemini) {
    let success = false;
    if (gemini1) {
      success = await executeRequest('gemini', gemini1, 'gemini-2.5-flash');
    }
    if (!success && gemini2) {
      console.log('🔄 محاولة استخدام GEMINI_API_KEY2...');
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

// ── خادم Express ──────────────────────────────────────
console.log('🌐 إعداد خادم Express...');
const app = express();
app.use(express.json()); // لاستقبال JSON من Telegram

// نقطة نهاية Health Check
app.get('/', (_, res) => {
  console.log('🏥 Health check');
  res.send('Bot is alive');
});

// نقطة نهاية Webhook (تستقبل تحديثات Telegram)
app.post('/webhook', (req, res) => {
  console.log(`📨 طلب Webhook ورد (${req.body?.update_id || 'بدون معرف'})`);
  bot.handleUpdate(req.body, res);
});

// نقطة تعيين Webhook يدوياً
app.get('/setwebhook', async (req, res) => {
  try {
    const webhookUrl = `${APP_URL}/webhook`;
    console.log(`🔗 تعيين Webhook إلى ${webhookUrl}`);
    const result = await bot.telegram.setWebhook(webhookUrl);
    res.send(`✅ تم تعيين الـ webhook إلى ${webhookUrl}\nالنتيجة: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`❌ فشل تعيين Webhook:`, error.message);
    res.status(500).send(`❌ فشل تعيين الـ webhook: ${error.message}`);
  }
});

// نقطة اختبار اتصال Telegram
app.get('/test-telegram', async (_, res) => {
  console.log('🔍 اختبار اتصال Telegram...');
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await response.json();
    console.log(`✅ نجح اختبار Telegram: ${JSON.stringify(data)}`);
    res.send(`✅ نجح الاتصال: ${JSON.stringify(data)}`);
  } catch (e) {
    console.error(`❌ فشل اختبار Telegram:`, e.message);
    res.status(500).send(`❌ فشل الاتصال: ${e.message}`);
  }
});

// ── تشغيل الخادم وتعيين Webhook ────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Express يعمل على المنفذ ${PORT}`);
  console.log(`🌐 عنوان التطبيق: ${APP_URL}`);

  // تعيين الـ Webhook تلقائياً عند بدء التشغيل
  try {
    const webhookUrl = `${APP_URL}/webhook`;
    console.log(`🔗 محاولة تعيين Webhook إلى ${webhookUrl}`);
    const result = await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ تم تعيين الـ webhook بنجاح!`);
    console.log(`📩 رد Telegram: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`❌ فشل تعيين الـ webhook تلقائياً:`, error.message);
    console.log(`⚠️ يرجى تعيينه يدوياً عبر /setwebhook`);
  }
});

// ── الحارس المتبادل (Keep-alive) ────────────────────
const GUARD_URL = process.env.GUARD_URL;
if (GUARD_URL) {
  console.log(`🛡️ تفعيل الحارس المتبادل إلى ${GUARD_URL}`);
  const ping = () => {
    fetch(GUARD_URL)
      .then(res => console.log(`🏓 Ping guard: ${res.status}`))
      .catch(err => console.error('❌ Guard unreachable:', err.message));
  };
  setInterval(ping, 30000);
  ping();
} else {
  console.log('ℹ️ لا يوجد GUARD_URL، تم تخطي الحارس المتبادل.');
}

// ── معالجة الإغلاق ──────────────────────────────────
process.once('SIGINT', async () => {
  console.log('🛑 استلام SIGINT، جاري إيقاف البوت...');
  try {
    await bot.telegram.deleteWebhook();
    console.log('✅ تم حذف Webhook.');
  } catch (e) {}
  process.exit(0);
});

process.once('SIGTERM', async () => {
  console.log('🛑 استلام SIGTERM، جاري إيقاف البوت...');
  try {
    await bot.telegram.deleteWebhook();
    console.log('✅ تم حذف Webhook.');
  } catch (e) {}
  process.exit(0);
});

console.log('✅ اكتمل إعداد البوت، في انتظار التحديثات...');
