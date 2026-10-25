const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

// Токен берется безопасно из вкладки Environment на Render!
const TOKEN = process.env.BOT_TOKEN;
// Ссылка на твой сайт с GitHub Pages
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://dimitriychr.github.io/baby-tracker/';

// Инициализируем бота
const bot = new TelegramBot(TOKEN, { polling: true });

// Хранилище базы данных в памяти сервера
const databases = {};
// Привязка chatId пользователя Telegram к familyId
const chatToFamily = {};

// Вспомогательная функция для времени (ЧЧ:ММ по МСК)
function getNowTime() {
  return new Date().toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Ищем базу семьи для конкретного чата
function getFamilyDb(chatId) {
  let familyId = chatToFamily[chatId];

  // Если чат еще не привязан, но в базе уже есть семья — берем первую доступную
  if (!familyId) {
    const existingFamilies = Object.keys(databases);
    if (existingFamilies.length > 0) {
      familyId = existingFamilies[0];
      chatToFamily[chatId] = familyId;
    } else {
      familyId = 'default_family';
      chatToFamily[chatId] = familyId;
    }
  }

  if (!databases[familyId]) {
    databases[familyId] = {};
  }

  const db = databases[familyId];
  // Гарантируем, что массивы существуют
  if (!Array.isArray(db.feedings)) db.feedings = [];
  if (!Array.isArray(db.diapers)) db.diapers = [];
  if (!Array.isArray(db.sleeps)) db.sleeps = [];

  return { db, familyId };
}

// Нижняя клавиатура с быстрыми кнопками
const quickKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '🍼 Открыть трекер', web_app: { url: WEB_APP_URL } }],
      [{ text: '🍼 Поел' }, { text: '😴 Сон (Старт/Стоп)' }],
      [{ text: '💧 Пописал' }, { text: '💩 Покакал' }, { text: '📊 Сводка' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

// Команда /start (и возможность вручную привязать код семьи: /start КОД_СЕМЬИ)
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Родитель';
  const passedFamilyId = match[1] ? match[1].trim() : null;

  if (passedFamilyId) {
    chatToFamily[chatId] = passedFamilyId;
    if (!databases[passedFamilyId]) databases[passedFamilyId] = {};
  }

  // Также отправим инлайн-кнопку и одновременно включим нижнее меню
  bot.sendMessage(
    chatId,
    `Привет, ${userName}! 🍼\n\nЯ обновился! Теперь внизу экрана есть **быстрые кнопки** — нажимай их прямо в чате для мгновенной записи в один клик, или открывай полное приложение:`,
    {
      parse_mode: 'Markdown',
      ...quickKeyboard
    }
  );
});

// Обработка нажатий на быстрые кнопки
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  const { db, familyId } = getFamilyDb(chatId);
  const time = getNowTime();
  const nowMs = Date.now();
  const todayStr = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

  // 1. КНОПКА: ПОЕЛ
  if (text === '🍼 Поел') {
    const lastAmount = db.feedings.length > 0 ? (db.feedings[0].amount || db.feedings[0].ml || 120) : 120;

    const newFeeding = {
      id: nowMs,
      time: time,
      date: todayStr,
      timestamp: nowMs,
      amount: lastAmount,
      ml: lastAmount,
      note: 'Быстрая запись из бота'
    };

    db.feedings.unshift(newFeeding);
    db.lastFeedingTime = nowMs;

    bot.sendMessage(
      chatId,
      `✅ *Кормление записано!*\n🕒 Время: *${time}*\n🍼 Объем: *~${lastAmount} мл*\n_(Семья: ${familyId})_`,
      { parse_mode: 'Markdown', ...quickKeyboard }
    );
  }

  // 2. КНОПКИ: ПОДГУЗНИКИ
  else if (text === '💧 Пописал' || text === '💩 Покакал') {
    const isPoop = text === '💩 Покакал';
    const diaperType = isPoop ? 'Грязный 💩' : 'Мокрый 💧';

    db.diapers.unshift({
      id: nowMs,
      time: time,
      date: todayStr,
      timestamp: nowMs,
      type: isPoop ? 'dirty' : 'wet',
      label: diaperType
    });

    bot.sendMessage(
      chatId,
      `✅ *Подгузник отмечен:* ${diaperType} в *${time}*`,
      { parse_mode: 'Markdown', ...quickKeyboard }
    );
  }

  // 3. КНОПКА: СОН (СТАРТ / СТОП)
  else if (text === '😴 Сон (Старт/Стоп)') {
    if (!db.activeSleepStart) {
      db.activeSleepStart = nowMs;
      db.activeSleepTimeStr = time;

      bot.sendMessage(
        chatId,
        `🌙 *Малыш уснул в ${time}*\nТаймер сна запущен. Когда проснется — нажми эту же кнопку еще раз!`,
        { parse_mode: 'Markdown', ...quickKeyboard }
      );
    } else {
      const durationMinutes = Math.max(1, Math.round((nowMs - db.activeSleepStart) / 60000));
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      const durationStr = hours > 0 ? `${hours} ч ${mins} мин` : `${mins} мин`;

      const startedAt = db.activeSleepTimeStr;

      db.sleeps.unshift({
        id: nowMs,
        startTime: startedAt,
        endTime: time,
        date: todayStr,
        durationMinutes: durationMinutes,
        durationText: durationStr,
        timestamp: nowMs
      });

      db.activeSleepStart = null;
      db.activeSleepTimeStr = null;

      bot.sendMessage(
        chatId,
        `☀️ *Малыш проснулся в ${time}!*\n🛌 Проспал: *${durationStr}* (с ${startedAt} до ${time})`,
        { parse_mode: 'Markdown', ...quickKeyboard }
      );
    }
  }

  // 4. КНОПКА: СВОДКА
  else if (text === '📊 Сводка') {
    const lastFeed = db.feedings[0]
      ? `${db.feedings[0].time} (${db.feedings[0].amount || db.feedings[0].ml || '?'} мл)`
      : 'нет записей';

    const lastDiaper = db.diapers[0]
      ? `${db.diapers[0].time} (${db.diapers[0].label || db.diapers[0].type})`
      : 'нет записей';

    const sleepStatus = db.activeSleepStart
      ? `😴 Сейчас спит (уснул в ${db.activeSleepTimeStr})`
      : (db.sleeps[0] ? `Проснулся в ${db.sleeps[0].endTime} (спал ${db.sleeps[0].durationText})` : 'нет записей');

    const summaryText =
      `📊 *Быстрая сводка по малышу:*\n\n` +
      `🍼 *Последнее кормление:* ${lastFeed}\n` +
      `🧷 *Последний подгузник:* ${lastDiaper}\n` +
      `🛌 *Сон:* ${sleepStatus}\n\n` +
      `Всего в базе: кормлений — ${db.feedings.length}, подгузников — ${db.diapers.length}, снов — ${db.sleeps.length}`;

    bot.sendMessage(chatId, summaryText, { parse_mode: 'Markdown', ...quickKeyboard });
  }
});

// === API ДЛЯ MINI APP ===

app.get('/api/get/:familyId', (req, res) => {
  const { familyId } = req.params;
  res.json(databases[familyId] || null);
});

app.post('/api/save/:familyId', (req, res) => {
  const { familyId } = req.params;
  // Сохраняем данные из приложения, но не затираем активный таймер сна и записи из бота, если их еще не было в приложении
  const currentDb = databases[familyId] || {};
  databases[familyId] = {
    ...currentDb,
    ...req.body
  };
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Бот и сервер успешно запущены на порту ${PORT}`);
});
