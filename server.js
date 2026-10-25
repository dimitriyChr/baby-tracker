const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

const TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://dimitriychr.github.io/baby-tracker/';

const bot = new TelegramBot(TOKEN, { polling: true });

// Хранилище базы данных и привязок чатов
const databases = {};
const chatToFamily = {};
const subscribedChats = new Set();

function getNowTime() {
  return new Date().toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getTodayStr() {
  return new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
}

// Умное слияние двух списков записей (чтобы Mini App не стирал записи из бота)
function mergeArraysById(serverArr = [], clientArr = []) {
  const map = new Map();
  serverArr.forEach(item => {
    const key = item.id || item.timestamp || `${item.date}_${item.time}`;
    map.set(key, item);
  });
  clientArr.forEach(item => {
    const key = item.id || item.timestamp || `${item.date}_${item.time}`;
    map.set(key, item);
  });
  return Array.from(map.values()).sort((a, b) => (b.timestamp || b.id || 0) - (a.timestamp || a.id || 0));
}

function getFamilyDb(chatId) {
  subscribedChats.add(chatId);
  let familyId = chatToFamily[chatId];

  if (!familyId) {
    const existingFamilies = Object.keys(databases);
    familyId = existingFamilies.length > 0 ? existingFamilies[0] : 'default_family';
    chatToFamily[chatId] = familyId;
  }

  if (!databases[familyId]) {
    databases[familyId] = {};
  }

  const db = databases[familyId];
  if (!Array.isArray(db.feedings)) db.feedings = [];
  if (!Array.isArray(db.diapers)) db.diapers = [];
  if (!Array.isArray(db.sleeps)) db.sleeps = [];
  if (typeof db.notificationsEnabled === 'undefined') db.notificationsEnabled = true;

  return { db, familyId };
}

// Нижняя клавиатура
const quickKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '🍼 Открыть трекер', web_app: { url: WEB_APP_URL } }],
      [{ text: '🍼 Поел' }, { text: '😴 Сон (Старт/Стоп)' }],
      [{ text: '💧 Пописал' }, { text: '💩 Покакал' }, { text: '📊 Сводка' }],
      [{ text: '🔔 Уведомления Вкл/Выкл' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

// Команда /start
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Родитель';
  const passedFamilyId = match[1] ? match[1].trim() : null;

  subscribedChats.add(chatId);

  if (passedFamilyId) {
    chatToFamily[chatId] = passedFamilyId;
    if (!databases[passedFamilyId]) databases[passedFamilyId] = {};
  }

  bot.sendMessage(
    chatId,
    `Привет, ${userName}! 🍼\n\nБыстрые кнопки и контроль кормления активны. Ровно через 3 часа после еды я напомню покормить малыша и добавить капли от коликов в смесь!`,
    { parse_mode: 'Markdown', ...quickKeyboard }
  );
});

// Обработка нажатий на кнопки
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  const { db } = getFamilyDb(chatId);
  const time = getNowTime();
  const nowMs = Date.now();
  const todayStr = getTodayStr();

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
    db.feedingAlertSent = false; // Сбрасываем флаг напоминания для следующего раза

    bot.sendMessage(
      chatId,
      `✅ *Кормление записано!*\n🕒 Время: *${time}*\n🍼 Объем: *~${lastAmount} мл*\n\n🔔 _Через 3 часа напомню про следующее кормление и капли от коликов!_`,
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
        `🌙 *Малыш уснул в ${time}*\nТаймер сна запущен. Когда проснется — нажми кнопку еще раз!`,
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
      `🛌 *Сон:* ${sleepStatus}\n` +
      `🔔 *Уведомления:* ${db.notificationsEnabled ? 'Включены ✅' : 'Выключены 🔕'}\n\n` +
      `Всего записей: кормлений — ${db.feedings.length}, подгузников — ${db.diapers.length}`;

    bot.sendMessage(chatId, summaryText, { parse_mode: 'Markdown', ...quickKeyboard });
  }

  // 5. КНОПКА: ВКЛ/ВЫКЛ УВЕДОМЛЕНИЙ
  else if (text === '🔔 Уведомления Вкл/Выкл') {
    db.notificationsEnabled = !db.notificationsEnabled;
    const statusText = db.notificationsEnabled
      ? '🔔 *Уведомления включены!* Ровно через 3 часа после еды напомню о следующем кормлении и каплях от коликов.'
      : '🔕 *Уведомления выключены.* Не буду беспокоить пушами, пока не включишь обратно.';

    bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown', ...quickKeyboard });
  }
});

// === ФОНОВЫЙ ТАЙМЕР КОНТРОЛЯ КОРМЛЕНИЯ (проверка каждую минуту) ===
setInterval(() => {
  const nowMs = Date.now();

  subscribedChats.forEach((chatId) => {
    const { db } = getFamilyDb(chatId);
    if (!db.notificationsEnabled) return;

    // Напоминание о кормлении + каплях от коликов (ровно через 3 часа = 180 минут, если малыш не спит)
    const lastFeedMs = db.lastFeedingTime || (db.feedings[0] && db.feedings[0].timestamp);
    if (lastFeedMs && !db.feedingAlertSent && !db.activeSleepStart) {
      const minutesPassed = Math.floor((nowMs - lastFeedMs) / 60000);
      if (minutesPassed >= 180 && minutesPassed < 360) {
        db.feedingAlertSent = true;
        const hours = Math.floor(minutesPassed / 60);
        const mins = minutesPassed % 60;
        const timePassedStr = mins > 0 ? `${hours} ч ${mins} мин` : `${hours} ч`;

        bot.sendMessage(
          chatId,
          `🍼 *Пора готовить смесь!* С последнего кормления прошло *${timePassedStr}*.\n\n💧 **Не забудь добавить капли от коликов в смесь!**\n\n_(Когда покормишь, нажми кнопку «🍼 Поел» внизу)_`,
          { parse_mode: 'Markdown', ...quickKeyboard }
        );
      }
    }
  });
}, 60 * 1000);

// === API ДЛЯ MINI APP С УМНОЙ СИНХРОНИЗАЦИЕЙ ===

app.get('/api/get/:familyId', (req, res) => {
  const { familyId } = req.params;
  res.json(databases[familyId] || null);
});

app.post('/api/save/:familyId', (req, res) => {
  const { familyId } = req.params;
  const currentDb = databases[familyId] || {};
  const incoming = req.body || {};

  // Если кормление добавили через Mini App, обновляем таймер для пушей
  const mergedFeedings = mergeArraysById(currentDb.feedings, incoming.feedings);
  const newestFeedMs = mergedFeedings[0] ? (mergedFeedings[0].timestamp || mergedFeedings[0].id) : currentDb.lastFeedingTime;
  const isNewFeedAdded = newestFeedMs && newestFeedMs !== currentDb.lastFeedingTime;

  databases[familyId] = {
    ...currentDb,
    ...incoming,
    feedings: mergedFeedings,
    diapers: mergeArraysById(currentDb.diapers, incoming.diapers),
    sleeps: mergeArraysById(currentDb.sleeps, incoming.sleeps),
    lastFeedingTime: newestFeedMs || currentDb.lastFeedingTime,
    feedingAlertSent: isNewFeedAdded ? false : currentDb.feedingAlertSent,
    activeSleepStart: currentDb.activeSleepStart || incoming.activeSleepStart || null,
    activeSleepTimeStr: currentDb.activeSleepTimeStr || incoming.activeSleepTimeStr || null
  };

  res.json({ success: true, mergedData: databases[familyId] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Бот и сервер успешно запущены на порту ${PORT}`);
});
