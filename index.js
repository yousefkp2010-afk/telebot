require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const express = require('express');

// ── عميل Groq ──
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── بوت تيليغرام ──
const bot = new Telegraf(process.env.BOT_TOKEN);

// الرد فقط على الرسائل التي تبدأ بـ "/ai"
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  if (!text.startsWith('/ai')) return;

  const question = text.slice(3).trim();
  if (!question) {
    return ctx.reply(
      '📝 *طريقة الاستخدام*\n\nاكتب سؤالك بعد /ai\nمثال: `/ai ما هو الذكاء الاصطناعي؟`',
      { parse_mode: 'Markdown' }
    );
  }

  await ctx.sendChatAction('typing');

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `أنت مساعد ودود ومفيد. أجب بطريقة منظمة وجميلة. استخدم التنسيق التالي:
- ضع العناوين الرئيسية بين نجمتين ** مثل: **عنوان**
- أضف إيموجيز مناسبة في بداية العناوين أو الفقرات
- اجعل الفقرات واضحة ومتباعدة
- عند كتابة أكواد برمجية، ضعها في كتلة منفصلة باستخدام \`\`\`
- استخدم تنسيق Markdown العادي (وليس MarkdownV2)
- لا تستخدم أحرفاً خاصة مثل _ أو [ ] إلا للغرض التنسيقي`
        },
        { role: 'user', content: question },
      ],
      stream: false,
    });

    const reply = completion.choices[0]?.message?.content || '❌ لم أستطع الإجابة.';

    // إرسال الرد بتنسيق Markdown
    await ctx.reply(reply, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('خطأ Groq:', error.message);
    // في حال فشل التنسيق، نرسل بدون تنسيق
    ctx.reply('⚠️ عذراً، حدث خطأ داخلي. حاول مرة أخرى لاحقاً.');
  }
});

// ── خادم Express لاستقبال pings (يمنع النوم) ──
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive'));
app.listen(PORT, () => {
  console.log(`Express يستمع على المنفذ ${PORT}`);
});

// ── تشغيل البوت (Long Polling) ──
bot.launch();
console.log('البوت يعمل بـ Long Polling...');

// ── إرسال ping إلى الحارس كل 30 ثانية (إن وُجد) ──
const GUARD_URL = process.env.GUARD_URL;
if (GUARD_URL) {
  const ping = () => {
    fetch(GUARD_URL)
      .then((res) => console.log(`Pinged guard: ${res.status}`))
      .catch((err) => console.error('Guard ping failed:', err.message));
  };
  setInterval(ping, 30000);
  ping();
}

// ── إيقاف آمن عند إغلاق الخدمة ──
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
