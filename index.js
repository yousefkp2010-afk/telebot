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

// ── إعدادات ────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT = process.env.PORT || 3000;
// عنوان التطبيق على Render (بدون https://)
const APP_URL = process.env.APP_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN مطلوب في المتغيرات البيئية');
  process.exit(1);
}

// ── عملاء Groq ────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── عملاء Gemini ──────────────────────────────
let gemini1 = null;
let gemini2 = null;
if (process.env.GEMINI_API_KEY) {
  gemini1 = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  });
}
if (process.env.GEMINI_API_KEY2) {
  gemini2 = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY2,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  });
}

// ── ذاكرة المحادثة ────────────────────────────
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

// ── إحصائيات ──────────────────────────────────
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

// ── تخزين آخر برومت ──────────────────────────
const lastImagePrompt = new Map();
const lastStoryPrompt = new Map();

// ── توليد الصورة ──────────────────────────────
async function generateImageUrl(prompt) {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=1024&height=1024&nologo=true`;
}

// ── استخراج النص من رابط ──────────────────────
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

// ── دوال توليد القصة (نفس السابق) ──────────────
async function generateStoryDescriptions(storyIdea, geminiClient) {
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
      throw new Error('الرد لا يحتوي على 8 أوصاف.');
    }
    return descriptions.slice(0, 8);
  } catch (error) {
    console.error('فشل توليد الأوصاف من Gemini:', error.message);
    throw error;
  }
}

async function generateImagesFromDescriptions(descriptions) {
  const imagePaths = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < descriptions.length; i++) {
    if (i > 0) await sleep(5000);
    const prompt = descriptions[i];
    const url = await generateImageUrl(prompt);
    console.log(`🖼️ جاري توليد الصورة ${i+1}/8...`);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const fileName = `temp_img_${Date.now()}_${i}.jpg`;
      await fs.writeFile(fileName, Buffer.from(buffer));
      imagePaths.push(fileName);
    } catch (err) {
      console.error(`فشل توليد الصورة ${i+1}:`, err.message);
    }
  }
  return imagePaths;
}

async function createVideoFromImages(imagePaths, outputVideoPath, durationPerImage = 3.5, fadeDuration = 0.5) {
  if (imagePaths.length === 0) throw new Error('لا توجد صور لإنشاء الفيديو');
  try {
    await exec('ffmpeg -version');
  } catch (e) {
    throw new Error('ffmpeg غير مثبت على النظام. يرجى تثبيته أولاً.');
  }
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
      .on('start', (cmd) => console.log('🎬 بدء إنشاء الفيديو:', cmd))
      .on('progress', (progress) => {
        if (progress.percent) console.log(`⏳ تقدم: ${Math.round(progress.percent)}%`);
      })
      .on('end', () => {
        console.log('✅ تم إنشاء الفيديو بنجاح');
        resolve(outputVideoPath);
      })
      .on('error', (err) => {
        console.error('❌ خطأ في ffmpeg:', err);
        reject(err);
      })
      .run();
  });
}

async function generateStoryVideo(storyIdea, geminiClient) {
  const descriptions = await generateStoryDescriptions(storyIdea, geminiClient);
  const imagePaths = await generateImagesFromDescriptions(descriptions);
  if (imagePaths.length === 0) {
    throw new Error('لم يتم توليد أي صورة.');
  }
  const videoFileName = `story_video_${Date.now()}.mp4`;
  await createVideoFromImages(imagePaths, videoFileName, 3.5, 0.5);
  for (const img of imagePaths) {
    await fs.unlink(img).catch(() => {});
  }
  return { videoPath: videoFileName, descriptions };
}

async function handleStoryCommand(ctx, storyIdea) {
  const userId = ctx.from.id;
  lastStoryPrompt.set(userId, storyIdea);
  await ctx.reply('📖 جاري معالجة فكرة القصة وتوليد 8 أوصاف مفصلة... (قد يستغرق هذا دقيقة)');
  let geminiClient = gemini1 || gemini2;
  if (!geminiClient) {
    return ctx.reply('❌ لا يوجد مفتاح Gemini لتوليد الأوصاف. يرجى إعداد GEMINI_API_KEY في البيئة.');
  }
  try {
    const descriptions = await generateStoryDescriptions(storyIdea, geminiClient);
    const descText = descriptions.map((d, i) => `${i+1}. ${d}`).join('\n\n');
    await ctx.reply(`✅ تم توليد 8 أوصاف. جاري إنشاء الصور... (قد يستغرق 30-60 ثانية)`);
    const imagePaths = await generateImagesFromDescriptions(descriptions);
    if (imagePaths.length === 0) {
      return ctx.reply('❌ فشل توليد جميع الصور. حاول مرة أخرى.');
    }
    const videoFileName = `story_video_${Date.now()}.mp4`;
    await ctx.reply('🎬 جاري تجميع الصور في فيديو...');
    await createVideoFromImages(imagePaths, videoFileName, 3.5, 0.5);
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
    stats.stories++;
    await fs.unlink(videoFileName).catch(() => {});
    for (const img of imagePaths) {
      await fs.unlink(img).catch(() => {});
    }
  } catch (error) {
    console.error('خطأ في /story:', error);
    await ctx.reply(`❌ حدث خطأ أثناء توليد الفيديو: ${error.message}`);
  }
}

// ── إنشاء البوت (Telegraf) ──────────────────
const bot = new Telegraf(BOT_TOKEN);

// ── معالج الأزرار التفاعلية ──────────────────
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

// ── أمر /start ──────────────────────────────────
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

// ── أمر /help ──────────────────────────────────
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

// ── أمر /stats ──────────────────────────────────
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

// ── استخراج النص بعد الأمر ──────────────────
function extractQuestion(text, command) {
  if (text.startsWith(command + ' ')) {
    return text.slice(command.length + 1).trim();
  }
  if (text.startsWith(command)) {
    return text.slice(command.length).trim();
  }
  return '';
}

// ── معالج الرسائل النصية (نفس السابق) ──────
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
      console.log('محاولة استخدام GEMINI_API_KEY2...');
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

// ── خادم Express ──────────────────────────────
const app = express();
app.use(express.json()); // لاستقبال JSON من Telegram

// نقطة نهاية الـ Health Check
app.get('/', (_, res) => res.send('Bot is alive'));

// نقطة نهاية الـ Webhook (تستقبل تحديثات Telegram)
app.post('/webhook', (req, res) => {
  bot.handleUpdate(req.body, res);
});

// نقطة نهاية لتعيين الـ Webhook يدوياً
app.get('/setwebhook', async (req, res) => {
  try {
    const webhookUrl = `${APP_URL}/webhook`;
    const result = await bot.telegram.setWebhook(webhookUrl);
    res.send(`✅ تم تعيين الـ webhook إلى ${webhookUrl}\nالنتيجة: ${JSON.stringify(result)}`);
  } catch (error) {
    res.status(500).send(`❌ فشل تعيين الـ webhook: ${error.message}`);
  }
});

// نقطة نهاية لاختبار اتصال Telegram
app.get('/test-telegram', async (_, res) => {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await response.json();
    res.send(`✅ نجح الاتصال: ${JSON.stringify(data)}`);
  } catch (e) {
    res.status(500).send(`❌ فشل الاتصال: ${e.message}`);
  }
});

// تشغيل الخادم
app.listen(PORT, async () => {
  console.log(`Express يعمل على ${PORT}`);

  // تعيين الـ Webhook تلقائياً عند بدء التشغيل
  try {
    const webhookUrl = `${APP_URL}/webhook`;
    const result = await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ تم تعيين الـ webhook إلى ${webhookUrl}`);
    console.log(`📩 الرد: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error('❌ فشل تعيين الـ webhook تلقائياً:', error.message);
    console.log('⚠️ يرجى تعيينه يدوياً عبر /setwebhook');
  }
});

// ── الحارس المتبادل ────────────────────────────
const GUARD_URL = process.env.GUARD_URL;
if (GUARD_URL) {
  const ping = () => {
    fetch(GUARD_URL)
      .then(res => console.log(`Pinged guard: ${res.status}`))
      .catch(err => console.error('Guard unreachable:', err.message));
  };
  setInterval(ping, 30000);
  ping();
}

process.once('SIGINT', () => {
  bot.telegram.deleteWebhook().catch(() => {});
  process.exit(0);
});
process.once('SIGTERM', () => {
  bot.telegram.deleteWebhook().catch(() => {});
  process.exit(0);
});
