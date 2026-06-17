require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');

// إعداد عميل Groq
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const bot = new Telegraf(process.env.BOT_TOKEN);

// أوامر /start
bot.start((ctx) =>
  ctx.reply('مرحباً! أنا بوت ذكي مدعوم بـ Groq. أرسل لي أي سؤال.')
);

// استقبال أي رسالة نصية
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  await ctx.sendChatAction('typing');

  try {
    const chatCompletion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'أنت مساعد ذكي ومختصر.' },
        { role: 'user', content: userMessage },
      ],
      stream: false,
    });

    const reply =
      chatCompletion.choices[0]?.message?.content || 'لم أستطع استخراج رد.';
    ctx.reply(reply);
  } catch (error) {
    console.error('خطأ في Groq:', error.message);
    ctx.reply('عذراً، حدث خطأ داخلي. حاول مرة أخرى لاحقاً.');
  }
});

// تشغيل البوت بطريقة Long Polling (تعمل على Render أيضاً)
bot.launch();
console.log('البوت يعمل بـ Long Polling...');

// إبقاء العملية حية
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
