require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const OpenAI = require('openai');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

// ── إعدادات ────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// ── عملاء Groq ────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── عملاء Gemini (مفتاحان) ────────────────────
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

// ── ذاكرة المحادثة (سياق) ─────────────────────
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

// ── تخزين آخر برومت للصورة (لإعادة التوليد) ──
const lastImagePrompt = new Map();

// ── توليد الصورة (محسّن) ──────────────────────
async function generateImageUrl(prompt) {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=1024&height=1024&nologo=true`;
}

// ── استخراج النص من رابط (لتلخيص المقالات) ────
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
    `• **/start** – رسالة الترحيب مع أزرار تفاعلية\n` +
    `• **/help** – هذا الدليل\n` +
    `• **/stats** – إحصائيات الاستخدام (للمالك فقط)\n\n` +
    `🔄 **السياق:** تذكر آخر 3 تبادلات لمدة 10 دقائق.\n` +
    `⚠️ **احتياطي:** عند فشل نموذج، ينتقل تلقائياً إلى الآخر.\n` +
    `🖼️ **الصور:** مدعومة عبر Pollinations.ai (مجاني، جودة عالية).\n` +
    `📄 **تلخيص الروابط:** أرسل رابطاً لتلخيص المقال فوراً.`;
  ctx.reply(help, { parse_mode: 'Markdown' });
});

// ── أمر /stats (للمالك فقط) ────────────────────
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

// ── معالج الرسائل النصية (الشامل) ──────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;

  // --- الكشف عن الروابط وتلخيصها ---
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
    // تجاهل باقي الرسائل غير الأوامر
    return;
  }

  // --- /image ---
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

  // --- /gemini و /groq (النصوص) ---
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

  // دالة تنفيذ طلب نصي (بدون streaming)
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
      // حفظ السياق
      addMessageToSession(userId, 'user', question);
      addMessageToSession(userId, 'assistant', reply);
      const duration = Date.now() - start;
      recordStat(modelType, true, duration);
      // إرسال الرد كاملاً
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
    // محاولة Gemini عبر المفتاح الأول
    let success = false;
    if (gemini1) {
      success = await executeRequest('gemini', gemini1, 'gemini-2.5-flash');
    }
    if (!success && gemini2) {
      console.log('محاولة استخدام GEMINI_API_KEY2...');
      success = await executeRequest('gemini', gemini2, 'gemini-2.5-flash');
    }

    if (!success) {
      // فشل كلا المفتاحين – الانتقال إلى Groq
      const message = gemini1 || gemini2
        ? '⚠️ تعذر الاتصال بـ Gemini. جاري تحويل طلبك إلى Groq...'
        : '⚠️ نموذج Gemini غير مفعل. جاري استخدام Groq بدلاً منه...';
      ctx.reply(message);
      const groqSuccess = await executeRequest('groq', groq, 'llama-3.3-70b-versatile');
      if (!groqSuccess) ctx.reply('❌ فشل كلا النموذجين. حاول لاحقاً.');
    }
  } else {
    // طلب Groq مباشرة
    const success = await executeRequest('groq', groq, 'llama-3.3-70b-versatile');
    if (!success) {
      // إذا فشل Groq، نجرب Gemini (بالمفتاحين)
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
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => res.send('Bot is alive'));

app.get('/test-gemini', async (_, res) => {
  const client = gemini1 || gemini2;
  if (!client) return res.send('لا يوجد أي مفتاح Gemini');
  try {
    const response = await client.chat.completions.create({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'قل مرحباً بالعربية' }],
    });
    res.send(`✅ نجح Gemini: ${response.choices[0].message.content}`);
  } catch (e) {
    res.send(`❌ فشل Gemini: ${e.message}`);
  }
});

app.listen(PORT, () => console.log(`Express يعمل على ${PORT}`));

// ── تشغيل البوت ────────────────────────────────
bot.launch();
console.log('🤖 البوت يعمل بـ Long Polling...');

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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
