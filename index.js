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
  console.error('❌ BOT_TOKEN غير موجود!');
  process.exit(1);
}
console.log('✅ BOT_TOKEN موجود.');

// ── عملاء الذكاء الاصطناعي ────────────────────────────
console.log('📦 جاري تهيئة العملاء...');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
console.log('✅ Groq جاهز.');

let gemini1 = null, gemini2 = null;
if (process.env.GEMINI_API_KEY) {
  gemini1 = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  });
  console.log('✅ Gemini (مفتاح 1) جاهز.');
}
if (process.env.GEMINI_API_KEY2) {
  gemini2 = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY2,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  });
  console.log('✅ Gemini (مفتاح 2) جاهز.');
}

// ── التحقق من ffmpeg ──────────────────────────────────
(async () => {
  try {
    await exec('ffmpeg -version');
    console.log('✅ ffmpeg مثبت.');
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
  if (session.messages.length > MAX_HISTORY) session.messages.shift();
}

// ── الإحصائيات ────────────────────────────────────────
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
  if (success) { s.success++; s.totalTime += duration; }
  else s.fail++;
}

// ── تخزين آخر طلبات ──────────────────────────────────
const lastImagePrompt = new Map();
const lastStoryPrompt = new Map();

// ── دالة توليد رابط الصورة (مع محاولات إعادة) ──────
async function generateImageUrl(prompt) {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=1024&height=1024&nologo=true`;
}

// ── استخراج النص من رابط ─────────────────────────────
async function extractTextFromUrl(url) {
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    const $ = cheerio.load(data);
    $('script, style, nav, footer, header, aside').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    return text.substring(0, 3000);
  } catch (e) {
    console.error(`❌ فشل استخراج الرابط: ${e.message}`);
    return null;
  }
}

// ── توليد أوصاف القصة (مع إعادة محاولة) ─────────────
async function generateStoryDescriptions(storyIdea, geminiClient, retryCount = 0) {
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
    if (!jsonMatch) throw new Error('لم يتم العثور على JSON.');
    const descriptions = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(descriptions) || descriptions.length < 8) {
      throw new Error(`عدد الأوصاف غير كافٍ (${descriptions.length})`);
    }
    return descriptions.slice(0, 8);
  } catch (error) {
    if (retryCount < 2) {
      await new Promise(r => setTimeout(r, 3000));
      return generateStoryDescriptions(storyIdea, geminiClient, retryCount + 1);
    }
    throw error;
  }
}

// ── تحميل صورة واحدة مع إعادة محاولة ──────────────────
async function downloadImageWithRetry(url, filePath, retries = 3, delay = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`📥 محاولة تحميل الصورة (${attempt}/${retries}) من ${url.substring(0, 60)}...`);
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 45000, // 45 ثانية مهلة
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      await fs.writeFile(filePath, response.data);
      console.log(`✅ تم حفظ الصورة في ${filePath}`);
      return true;
    } catch (error) {
      console.error(`❌ فشل تحميل الصورة (محاولة ${attempt}): ${error.message}`);
      if (attempt < retries) {
        const wait = delay * attempt; // تأخير متزايد
        console.log(`⏳ انتظار ${wait/1000} ثانية قبل المحاولة التالية...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  return false;
}

// ── توليد الصور من الأوصاف (مع إعادة محاولة وتأخير) ──
async function generateImagesFromDescriptions(descriptions, ctx) {
  const imagePaths = [];
  const total = descriptions.length;
  // نرسل رسالة بداية
  await ctx.reply(`🖼️ سيتم توليد ${total} صور (قد يستغرق كل منها 10-30 ثانية).`);

  for (let i = 0; i < total; i++) {
    // إرسال رسالة تحضير
    await ctx.reply(`🔄 جاري التحضير للصورة ${i+1}/${total}...`);

    const prompt = descriptions[i];
    const url = await generateImageUrl(prompt);
    const fileName = `temp_img_${Date.now()}_${i}.jpg`;
    let success = false;

    // محاولة التحميل مع إعادة المحاولة
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // نرسل رسالة "جارٍ الإنشاء"
        await ctx.reply(`🖼️ جارٍ إنشاء الصورة ${i+1}/${total} (محاولة ${attempt})...`);
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 60000, // 60 ثانية مهلة
        });
        if (response.status === 200) {
          await fs.writeFile(fileName, response.data);
          imagePaths.push(fileName);
          success = true;
          await ctx.reply(`✅ تم تحميل الصورة ${i+1}/${total}`);
          break;
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        console.error(`❌ فشل تحميل الصورة ${i+1} (محاولة ${attempt}): ${error.message}`);
        if (attempt < 3) {
          const wait = 5000 * attempt; // 5, 10, 15 ثانية
          await ctx.reply(`⏳ سيتم إعادة المحاولة بعد ${wait/1000} ثوانٍ...`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          await ctx.reply(`❌ فشل تحميل الصورة ${i+1} بعد 3 محاولات. سيتم تخطيها.`);
        }
      }
    }

    // تأخير إضافي بين الصور الناجحة (حتى لو فشلت ننتظر)
    if (i < total - 1) {
      const delay = 10000; // 10 ثوانٍ بين كل طلب ناجح
      await ctx.reply(`⏳ انتظار ${delay/1000} ثوانٍ قبل الصورة التالية...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return imagePaths;
}

// ── إنشاء فيديو من الصور (مع تحسينات) ────────────────
async function createVideoFromImages(imagePaths, outputVideoPath, durationPerImage = 3.5, fadeDuration = 0.5) {
  if (imagePaths.length === 0) throw new Error('لا توجد صور لإنشاء الفيديو.');
  try { await exec('ffmpeg -version'); } catch (e) { throw new Error('ffmpeg غير مثبت.'); }

  return new Promise((resolve, reject) => {
    const numImages = imagePaths.length;
    const duration = durationPerImage;
    const fade = fadeDuration;
    let command = ffmpeg();
    imagePaths.forEach(img => command.input(img));

    let filterParts = [];
    let inputs = [];
    for (let i = 0; i < numImages; i++) {
      const inLabel = `[${i}:v]`;
      const outLabel = `[v${i}]`;
      const scaleFilter = `scale=1024:1024:force_original_aspect_ratio=decrease,pad=1024:1024:(ow-iw)/2:(oh-ih)/2`;
      const trimFilter = `trim=0:${duration},setpts=PTS-STARTPTS`;
      let fadeFilter = '';
      if (i === 0) fadeFilter = `fade=in:0:d=${fade}`;
      else if (i === numImages - 1) fadeFilter = `fade=out:${duration - fade}:d=${fade}`;
      else fadeFilter = `fade=in:0:d=${fade},fade=out:${duration - fade}:d=${fade}`;
      const filter = `${scaleFilter},${trimFilter},${fadeFilter}`;
      filterParts.push(`${inLabel} ${filter} ${outLabel}`);
      inputs.push(outLabel);
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
      .outputOptions(['-pix_fmt yuv420p', '-movflags +faststart', '-r 30'])
      .on('start', (cmd) => console.log(`🎬 ffmpeg بدأ: ${cmd}`))
      .on('progress', (p) => { if (p.percent) console.log(`⏳ تقدم الفيديو: ${Math.round(p.percent)}%`); })
      .on('end', () => { console.log(`✅ فيديو تم إنشاؤه: ${outputVideoPath}`); resolve(outputVideoPath); })
      .on('error', (err) => { console.error('❌ خطأ ffmpeg:', err.message); reject(err); })
      .run();
  });
}

// ── معالج أمر /story الرئيسي ──────────────────────────
async function handleStoryCommand(ctx, storyIdea) {
  const userId = ctx.from.id;
  const startTime = Date.now();
  console.log(`📖 طلب قصة من ${userId}: "${storyIdea}"`);
  lastStoryPrompt.set(userId, storyIdea);

  await ctx.reply('📖 جاري معالجة فكرة القصة وتوليد 8 أوصاف مفصلة... (قد يستغرق هذا دقيقة)');

  let geminiClient = gemini1 || gemini2;
  if (!geminiClient) {
    return ctx.reply('❌ لا يوجد مفتاح Gemini. يرجى إعداد GEMINI_API_KEY.');
  }

  try {
    // 1. توليد الأوصاف
    const descriptions = await generateStoryDescriptions(storyIdea, geminiClient);
    await ctx.reply('✅ تم توليد 8 أوصاف. جاري إنشاء الصور...');

    // 2. توليد الصور
    const imagePaths = await generateImagesFromDescriptions(descriptions, ctx);
    if (imagePaths.length === 0) {
      return ctx.reply('❌ فشل تحميل جميع الصور. حاول مرة أخرى لاحقاً.');
    }

    // 3. محاولة إنشاء الفيديو
    let videoCreated = false;
    let videoFileName = null;
    try {
      videoFileName = `story_video_${Date.now()}.mp4`;
      await ctx.reply(`🎬 جاري تجميع ${imagePaths.length} صورة في فيديو...`);
      await createVideoFromImages(imagePaths, videoFileName);
      videoCreated = true;
    } catch (videoError) {
      console.error('❌ فشل الفيديو:', videoError.message);
      await ctx.reply(`⚠️ تعذر إنشاء الفيديو (${videoError.message}). سيتم إرسال الصور منفردة.`);
    }

    // 4. إرسال النتيجة
    if (videoCreated && videoFileName) {
      try {
        await ctx.replyWithVideo(
          { source: videoFileName },
          {
            caption: `🎥 فيديو القصة\n📖 الفكرة: ${storyIdea}`,
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 إعادة توليد الفيديو', callback_data: 'regen_story' }]
              ]
            }
          }
        );
        stats.stories++;
        await fs.unlink(videoFileName).catch(() => {});
      } catch (sendError) {
        console.error('❌ فشل إرسال الفيديو:', sendError.message);
        videoCreated = false;
      }
    }

    // إذا فشل الفيديو، نرسل الصور منفردة
    if (!videoCreated) {
      for (let i = 0; i < imagePaths.length; i++) {
        try {
          await ctx.replyWithPhoto(
            { source: imagePaths[i] },
            { caption: `📸 الصورة ${i+1}/${imagePaths.length}` }
          );
        } catch (photoError) {
          console.error(`❌ فشل إرسال الصورة ${i+1}:`, photoError.message);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // تنظيف الصور المؤقتة
    for (const img of imagePaths) {
      await fs.unlink(img).catch(() => {});
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await ctx.reply(`✨ تم! (استغرق ${elapsed} ثانية)`);

  } catch (error) {
    console.error('❌ خطأ في /story:', error);
    await ctx.reply(`❌ حدث خطأ: ${error.message}`);
  }
}

// ── إنشاء البوت ────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ── أزرار تفاعلية ──────────────────────────────────────
bot.action(/^cmd_(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  await ctx.answerCbQuery();
  const replies = {
    gemini: '🧠 اكتب سؤالك بعد **/gemini**',
    groq: '⚡ اكتب سؤالك بعد **/groq**',
    image: '🖼️ اكتب وصف الصورة بعد **/image**',
    story: '📖 اكتب فكرة القصة بعد **/story**',
    help: '📘 استخدم **/help** لعرض جميع الأوامر.'
  };
  ctx.reply(replies[action] || '❓ أمر غير معروف.', { parse_mode: 'Markdown' });
});

bot.action('regen_image', async (ctx) => {
  await ctx.answerCbQuery();
  const prompt = lastImagePrompt.get(ctx.from.id);
  if (!prompt) return ctx.reply('⚠️ لا يوجد وصف سابق.');
  await ctx.sendChatAction('upload_photo');
  const statusMsg = await ctx.reply('🎨 جارٍ إعادة توليد الصورة...');
  try {
    const imageUrl = await generateImageUrl(prompt);
    await ctx.replyWithPhoto(
      { url: imageUrl },
      {
        caption: `🖼️ ${prompt}`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 إعادة التوليد', callback_data: 'regen_image' }],
            [{ text: '⬇️ تحميل', url: imageUrl }]
          ]
        }
      }
    );
    stats.images++;
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ فشل إعادة التوليد.');
  }
});

bot.action('regen_story', async (ctx) => {
  await ctx.answerCbQuery();
  const prompt = lastStoryPrompt.get(ctx.from.id);
  if (!prompt) return ctx.reply('⚠️ لا توجد قصة سابقة.');
  await handleStoryCommand(ctx, prompt);
});

// ── الأوامر ────────────────────────────────────────────
bot.start((ctx) => {
  ctx.reply('🌟 **مرحباً بك في البوت الذكي!**\nاختر خدمة:', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🧠 Gemini', callback_data: 'cmd_gemini' }, { text: '⚡ Groq', callback_data: 'cmd_groq' }],
        [{ text: '🖼️ صورة', callback_data: 'cmd_image' }, { text: '📖 قصة', callback_data: 'cmd_story' }],
        [{ text: 'ℹ️ مساعدة', callback_data: 'cmd_help' }]
      ]
    }
  });
});

bot.help((ctx) => {
  ctx.reply(
    `📘 **دليل الاستخدام**\n\n` +
    `• /gemini [نص] – اسأل Gemini\n` +
    `• /groq [نص] – اسأل Groq\n` +
    `• /image [وصف] – توليد صورة\n` +
    `• /story [فكرة] – توليد فيديو من قصة\n` +
    `• /start – الترحيب\n` +
    `• /help – هذا الدليل\n` +
    `• /stats – إحصائيات (للمالك)`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('stats', (ctx) => {
  if (ADMIN_CHAT_ID && String(ctx.from.id) !== ADMIN_CHAT_ID) {
    return ctx.reply('⛔ هذا الأمر للمالك فقط.');
  }
  const now = Date.now();
  const uptimeMins = Math.floor((now - stats.lastReset) / 60000);
  const groqAvg = stats.groq.success > 0 ? (stats.groq.totalTime / stats.groq.success).toFixed(0) : 0;
  const geminiAvg = stats.gemini.success > 0 ? (stats.gemini.totalTime / stats.gemini.success).toFixed(0) : 0;
  ctx.reply(
    `📊 **إحصائيات** (آخر ${uptimeMins} دقيقة)\n` +
    `⚡ Groq: ${stats.groq.success} نجاح | ${stats.groq.fail} فشل | متوسط ${groqAvg}ms\n` +
    `🧠 Gemini: ${stats.gemini.success} نجاح | ${stats.gemini.fail} فشل | متوسط ${geminiAvg}ms\n` +
    `🖼️ صور: ${stats.images}\n📄 تلخيص: ${stats.summaries}\n🎬 فيديوهات: ${stats.stories}\n👥 جلسات: ${sessions.size}`,
    { parse_mode: 'Markdown' }
  );
});

// ── معالج الرسائل ──────────────────────────────────────
function extractQuestion(text, command) {
  if (text.startsWith(command + ' ')) return text.slice(command.length + 1).trim();
  if (text.startsWith(command)) return text.slice(command.length).trim();
  return '';
}

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;

  // تلخيص الروابط
  if (!text.startsWith('/')) {
    const urls = text.match(/(https?:\/\/[^\s]+)/g);
    if (urls && urls.length) {
      const url = urls[0];
      await ctx.sendChatAction('typing');
      const statusMsg = await ctx.reply('📄 جارٍ استخراج النص...');
      const articleText = await extractTextFromUrl(url);
      if (!articleText) {
        return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ تعذر استخراج النص.');
      }
      try {
        const completion = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'لخص النص التالي بالعربية، مع أبرز النقاط، استخدم Markdown.' },
            { role: 'user', content: `لخص:\n${articleText}` }
          ],
          stream: false,
        });
        const summary = completion.choices[0]?.message?.content || '';
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          `📝 **التلخيص**\n${summary}`,
          { parse_mode: 'Markdown' }
        );
        stats.summaries++;
      } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ فشل التلخيص.');
      }
      return;
    }
    return;
  }

  // أمر /image
  if (text.startsWith('/image')) {
    const prompt = extractQuestion(text, '/image');
    if (!prompt) return ctx.reply('🖼️ اكتب وصفاً بعد /image');
    lastImagePrompt.set(userId, prompt);
    await ctx.sendChatAction('upload_photo');
    const statusMsg = await ctx.reply('🎨 جارٍ توليد الصورة...');
    try {
      const imageUrl = await generateImageUrl(prompt);
      await ctx.replyWithPhoto(
        { url: imageUrl },
        {
          caption: `🖼️ ${prompt}`,
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 إعادة التوليد', callback_data: 'regen_image' }],
              [{ text: '⬇️ تحميل', url: imageUrl }]
            ]
          }
        }
      );
      stats.images++;
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ فشل توليد الصورة.');
    }
    return;
  }

  // أمر /story
  if (text.startsWith('/story')) {
    const storyIdea = extractQuestion(text, '/story');
    if (!storyIdea) return ctx.reply('📖 اكتب فكرة القصة بعد /story');
    await handleStoryCommand(ctx, storyIdea);
    return;
  }

  // أوامر /gemini و /groq
  if (!text.startsWith('/gemini') && !text.startsWith('/groq')) return;
  const isGemini = text.startsWith('/gemini');
  const command = isGemini ? '/gemini' : '/groq';
  const question = extractQuestion(text, command);
  if (!question) return ctx.reply(`❓ اكتب سؤالك بعد ${command}`);

  const session = getSession(userId);
  const systemMessage = { role: 'system', content: 'أنت مساعد خبير، أجب بإجابات واضحة ومنسقة باستخدام Markdown.' };
  const messages = [systemMessage, ...session.messages, { role: 'user', content: question }];

  const executeRequest = async (modelType, client, modelName) => {
    const start = Date.now();
    try {
      await ctx.sendChatAction('typing');
      const completion = await client.chat.completions.create({ model: modelName, messages, stream: false });
      const reply = completion.choices[0]?.message?.content || 'لا رد.';
      addMessageToSession(userId, 'user', question);
      addMessageToSession(userId, 'assistant', reply);
      recordStat(modelType, true, Date.now() - start);
      await ctx.reply(reply, { parse_mode: 'Markdown' });
      return true;
    } catch (e) {
      recordStat(modelType, false, Date.now() - start);
      console.error(`❌ خطأ ${modelType}:`, e.message);
      return false;
    }
  };

  if (isGemini) {
    let success = false;
    if (gemini1) success = await executeRequest('gemini', gemini1, 'gemini-2.5-flash');
    if (!success && gemini2) success = await executeRequest('gemini', gemini2, 'gemini-2.5-flash');
    if (!success) {
      await ctx.reply('⚠️ جاري التحويل إلى Groq...');
      const groqSuccess = await executeRequest('groq', groq, 'llama-3.3-70b-versatile');
      if (!groqSuccess) ctx.reply('❌ فشل كلا النموذجين.');
    }
  } else {
    let success = await executeRequest('groq', groq, 'llama-3.3-70b-versatile');
    if (!success && (gemini1 || gemini2)) {
      await ctx.reply('⚠️ جاري التحويل إلى Gemini...');
      let geminiSuccess = false;
      if (gemini1) geminiSuccess = await executeRequest('gemini', gemini1, 'gemini-2.5-flash');
      if (!geminiSuccess && gemini2) geminiSuccess = await executeRequest('gemini', gemini2, 'gemini-2.5-flash');
      if (!geminiSuccess) ctx.reply('❌ فشل كلا النموذجين.');
    }
  }
});

// ── خادم Express ──────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (_, res) => res.send('Bot is alive'));
app.post('/webhook', (req, res) => bot.handleUpdate(req.body, res));
app.get('/setwebhook', async (req, res) => {
  try {
    const webhookUrl = `${APP_URL}/webhook`;
    const result = await bot.telegram.setWebhook(webhookUrl);
    res.send(`✅ Webhook set to ${webhookUrl}\n${JSON.stringify(result)}`);
  } catch (e) {
    res.status(500).send(`❌ ${e.message}`);
  }
});
app.get('/test-telegram', async (_, res) => {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    res.send(`✅ ${JSON.stringify(response.data)}`);
  } catch (e) {
    res.status(500).send(`❌ ${e.message}`);
  }
});

// ── تشغيل الخادم ──────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Express يعمل على المنفذ ${PORT}`);
  try {
    const webhookUrl = `${APP_URL}/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Webhook تم تعيينه إلى ${webhookUrl}`);
  } catch (e) {
    console.error('❌ فشل تعيين Webhook:', e.message);
  }
});

// ── الحارس المتبادل ──────────────────────────────────
if (process.env.GUARD_URL) {
  setInterval(() => {
    axios.get(process.env.GUARD_URL).catch(() => {});
  }, 30000);
}

// ── إيقاف نظيف ──────────────────────────────────────
process.once('SIGINT', async () => {
  await bot.telegram.deleteWebhook().catch(() => {});
  process.exit(0);
});
process.once('SIGTERM', async () => {
  await bot.telegram.deleteWebhook().catch(() => {});
  process.exit(0);
});

console.log('✅ البوت جاهز.');
