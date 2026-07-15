require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const OpenAI = require('openai');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

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
const storyLocks = new Map();

// ── دالة توليد رابط الصورة ──────────────────────────
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

// ── توليد أوصاف القصة ──────────────────────────────
async function generateStoryDescriptions(storyIdea, geminiClient, retryCount = 0) {
  const prompt = `
You are an expert at generating detailed image descriptions for a story.
Based on the following story idea, generate exactly 8 highly detailed descriptions in English.
Each description must be very detailed (at least 30 words) covering: characters, environment, camera angle, artistic style.
Output only a valid JSON array of 8 strings. Do not add any extra text.

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

// ── توليد تعليق نصي للقصة (ملخص أو نهاية) ──────────
async function generateStoryComment(storyIdea, client = null) {
  // نحاول استخدام Gemini إن وجد، وإلا Groq
  const prompt = `
بناءً على فكرة القصة التالية، اكتب تعليقاً ختامياً جميلاً باللغة العربية (لا يزيد عن 200 حرف) يعبر عن مغزى القصة أو نهايتها بأسلوب أدبي بسيط.

فكرة القصة: "${storyIdea}"
`;
  try {
    let completion;
    if (client) {
      // استخدام Gemini
      completion = await client.chat.completions.create({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'أنت كاتب محترف، اكتب تعليقاً ختامياً قصيراً وجميلاً.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        stream: false,
      });
    } else {
      // استخدام Groq
      completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'أنت كاتب محترف، اكتب تعليقاً ختامياً قصيراً وجميلاً.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        stream: false,
      });
    }
    const comment = completion.choices[0]?.message?.content || '💫 نهاية القصة تحمل في طياتها الكثير من المعاني.';
    // تقليم النص إلى 200 حرف
    return comment.length > 200 ? comment.substring(0, 200) + '...' : comment;
  } catch (error) {
    console.error('❌ فشل توليد التعليق النصي:', error.message);
    return '💫 انتهت القصة، وتبقى الذكريات.';
  }
}

// ── تحميل صورة مع إعادة محاولة ──────────────────────
async function downloadImageWithRetry(url, filePath, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
      });
      if (response.status === 200) {
        await fs.writeFile(filePath, response.data);
        return true;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.error(`❌ فشل تحميل الصورة (محاولة ${attempt}): ${error.message}`);
      if (attempt < maxRetries) {
        const delay = 5000 + Math.random() * 10000;
        console.log(`⏳ انتظار ${Math.round(delay/1000)} ثانية...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return false;
}

// ── توليد الصور من الأوصاف ──────────────────────────
async function generateImagesFromDescriptions(descriptions, ctx) {
  const imagePaths = [];
  const total = descriptions.length;
  await ctx.reply(`🖼️ سيتم توليد ${total} صور (قد تستغرق كل منها 10-30 ثانية).`);

  for (let i = 0; i < total; i++) {
    await ctx.reply(`🔄 جاري التحضير للصورة ${i+1}/${total}...`);
    const prompt = descriptions[i];
    const url = await generateImageUrl(prompt);
    const fileName = `temp_img_${Date.now()}_${i}.jpg`;
    
    const success = await downloadImageWithRetry(url, fileName);
    if (success) {
      imagePaths.push(fileName);
      await ctx.reply(`✅ تم تحميل الصورة ${i+1}/${total}`);
    } else {
      await ctx.reply(`❌ فشل تحميل الصورة ${i+1}/${total} بعد 3 محاولات. سيتم تخطيها.`);
    }

    if (i < total - 1) {
      const delay = 10000 + Math.random() * 5000;
      await ctx.reply(`⏳ انتظار ${Math.round(delay/1000)} ثانية قبل الصورة التالية...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return imagePaths;
}

// ── إنشاء فيديو من الصور (باستخدام exec مباشرة) ──
async function createVideoFromImages(imagePaths, outputVideoPath, durationPerImage = 3.5, fadeDuration = 0.5) {
  if (imagePaths.length < 2) throw new Error('يلزم على الأقل صورتان لتكوين فيديو.');

  // التحقق من وجود ffmpeg
  try {
    await exec('ffmpeg -version');
  } catch (e) {
    throw new Error('ffmpeg غير مثبت على النظام.');
  }

  const numImages = imagePaths.length;
  const duration = durationPerImage;
  const fade = fadeDuration;

  // بناء أجزاء الفلتر لكل صورة
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

  // إضافة انتقالات xfade بين الصور المتتالية
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

  // الفلتر النهائي (جميع الأجزاء مفصولة بفواصل منقوطة)
  const filterComplex = filterParts.join('; ');

  // بناء أمر ffmpeg
  const inputArgs = imagePaths.map(p => `-i "${p}"`).join(' ');
  const cmd = `ffmpeg ${inputArgs} -filter_complex "${filterComplex}" -map "[${currentOutput}]" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -r 30 "${outputVideoPath}"`;

  console.log('🎬 تنفيذ أمر ffmpeg:', cmd);

  try {
    const { stdout, stderr } = await exec(cmd);
    if (stderr) console.log('⚠️ stderr من ffmpeg:', stderr);
    console.log('✅ تم إنشاء الفيديو بنجاح:', outputVideoPath);
    return outputVideoPath;
  } catch (error) {
    console.error('❌ فشل تنفيذ ffmpeg:', error.message);
    throw new Error(`ffmpeg فشل: ${error.message}`);
  }
}

// ── معالج أمر /story مع قفل وتعليق نصي ──────────────
async function handleStoryCommand(ctx, storyIdea) {
  const userId = ctx.from.id;
  if (storyLocks.get(userId)) {
    return ctx.reply('⏳ لديك طلب قيد المعالجة، انتظر حتى يكتمل.');
  }
  storyLocks.set(userId, true);

  try {
    const startTime = Date.now();
    console.log(`📖 طلب قصة من ${userId}: "${storyIdea}"`);
    lastStoryPrompt.set(userId, storyIdea);

    await ctx.reply('📖 جاري معالجة فكرة القصة وتوليد 8 أوصاف مفصلة... (قد يستغرق هذا دقيقة)');

    let geminiClient = gemini1 || gemini2;
    if (!geminiClient) {
      await ctx.reply('❌ لا يوجد مفتاح Gemini. يرجى إعداد GEMINI_API_KEY.');
      return;
    }

    const descriptions = await generateStoryDescriptions(storyIdea, geminiClient);
    await ctx.reply('✅ تم توليد 8 أوصاف. جاري إنشاء الصور...');

    const imagePaths = await generateImagesFromDescriptions(descriptions, ctx);
    if (imagePaths.length === 0) {
      await ctx.reply('❌ فشل تحميل جميع الصور. حاول مرة أخرى لاحقاً.');
      return;
    }

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

    // ── إرسال التعليق النصي للقصة ──────────────────
    let comment = '💫 انتهت القصة، وتبقى الذكريات.';
    try {
      // نفضل استخدام Gemini إن وجد
      const client = gemini1 || gemini2 || null;
      comment = await generateStoryComment(storyIdea, client);
    } catch (e) {
      console.error('❌ فشل التعليق النصي، نرسل الافتراضي.');
    }
    await ctx.reply(`📝 **تعليق على القصة:**\n${comment}`, { parse_mode: 'Markdown' });

    // تنظيف الصور المؤقتة
    for (const img of imagePaths) {
      await fs.unlink(img).catch(() => {});
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await ctx.reply(`✨ تم! (استغرق ${elapsed} ثانية)`);

  } catch (error) {
    console.error('❌ خطأ في /story:', error);
    await ctx.reply(`❌ حدث خطأ: ${error.message}`);
  } finally {
    storyLocks.delete(userId);
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
  if (storyLocks.get(ctx.from.id)) {
    return ctx.reply('⏳ لديك طلب قيد المعالجة، انتظر حتى يكتمل.');
  }
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

app.post('/webhook', (req, res) => {
  bot.webhookCallback('/webhook')(req, res).catch(err => {
    console.error('❌ خطأ في webhook:', err);
    res.status(500).send('Internal Server Error');
  });
});

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
  console.log(`🌐 APP_URL: ${APP_URL}`);
  
  try {
    const webhookUrl = `${APP_URL}/webhook`;
    console.log(`🔗 محاولة تعيين Webhook إلى ${webhookUrl}`);
    const result = await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Webhook تم تعيينه بنجاح: ${JSON.stringify(result)}`);
  } catch (e) {
    console.error('❌ فشل تعيين Webhook:', e.message);
    console.log('⚠️ سيتم استخدام polling كحل احتياطي...');
    bot.launch().then(() => {
      console.log('✅ Bot يعمل عبر polling.');
    }).catch(err => console.error('❌ فشل بدء polling:', err));
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
  console.log('🛑 استلام SIGINT، جاري الإيقاف...');
  await bot.telegram.deleteWebhook().catch(() => {});
  process.exit(0);
});
process.once('SIGTERM', async () => {
  console.log('🛑 استلام SIGTERM، جاري الإيقاف...');
  await bot.telegram.deleteWebhook().catch(() => {});
  process.exit(0);
});

console.log('✅ البوت جاهز لاستقبال الطلبات.');
