const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

const TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://dimitriychr.github.io/baby-tracker/';
const FIREBASE_URL = process.env.FIREBASE_URL;

// === НАСТРОЙКИ ВОЗРАСТА И НОРМ (1.5 МЕСЯЦА) ===
const BIRTH_DATE = { year: 2026, month: 10, day: 10 }; // 10.10.2026
const DEFAULT_FEED_ML = 120;      // Новый базовый объем для 1.5 мес.
const DAILY_TARGET_ML = 880;      // Ориентир суточной нормы (мл)
const FEED_INTERVAL_MIN = 195;    // Напоминание о еде через 3ч 15м (195 мин)
const WAKE_WINDOW_LIMIT_MIN = 75; // Сигнал о конце ВБ через 1ч 15м (75 мин)

const bot = new TelegramBot(TOKEN, { polling: true });

const databases = {};
const chatToFamily = {};
const subscribedChats = new Set();
let reminders = [];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getMskDateObj() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
}

function getNowTime() {
  const msk = getMskDateObj();
  return pad2(msk.getHours()) + ':' + pad2(msk.getMinutes());
}

function getTodayStr() {
  const msk = getMskDateObj();
  return pad2(msk.getDate()) + '.' + pad2(msk.getMonth() + 1) + '.' + msk.getFullYear();
}

// Расчет точного возраста (месяцы и дни)
function getBabyAgeStr() {
  const now = getMskDateObj();
  let months = (now.getFullYear() - BIRTH_DATE.year) * 12 + (now.getMonth() + 1 - BIRTH_DATE.month);
  let days = now.getDate() - BIRTH_DATE.day;

  if (days < 0) {
    months -= 1;
    const prevMonthDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    days += prevMonthDays;
  }
  return `${months} мес. ${days} дн.`;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

// === ОБЛАЧНЫЙ БЭКАП ===
async function loadFromCloud() {
  if (!FIREBASE_URL) return;
  try {
    const res = await fetch(`${FIREBASE_URL}/backup.json`);
    const data = await res.json();
    if (data) {
      if (data.databases) Object.assign(databases, data.databases);
      if (data.chatToFamily) Object.assign(chatToFamily, data.chatToFamily);
      if (data.subscribedChats) data.subscribedChats.forEach(id => subscribedChats.add(id));
      console.log('☁️ Данные восстановлены из облака!');
    }
  } catch (err) {
    console.error('Ошибка загрузки из облака:', err.message);
  }
}

async function saveToCloud() {
  if (!FIREBASE_URL) return;
  try {
    await fetch(`${FIREBASE_URL}/backup.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        databases,
        chatToFamily,
        subscribedChats: Array.from(subscribedChats)
      })
    });
  } catch (err) {
    console.error('Ошибка сохранения в облако:', err.message);
  }
}

// Умное слияние списков (совместимо с index.html)
function mergeLists(serverArr = [], clientArr = [], deletedIds = []) {
  const delSet = new Set(deletedIds.map(String));
  const map = new Map();

  [...serverArr, ...clientArr].forEach(item => {
    if (item && item.id && !delSet.has(String(item.id))) {
      const key = String(item.id);
      const existing = map.get(key);
      if (!existing || (item.editedAt || 0) >= (existing.editedAt || 0)) {
        map.set(key, item);
      }
    }
  });

  return Array.from(map.values())
    .sort((a, b) => (b.ts || b.id || 0) - (a.ts || a.id || 0))
    .slice(0, 150);
}

// Получение базы семьи
function getFamilyDb(chatId) {
  subscribedChats.add(chatId);
  let familyId = chatToFamily[chatId];

  if (!familyId) {
    const defaultUserFam = 'fam_' + chatId;
    const existingFamilies = Object.keys(databases);

    if (databases[defaultUserFam]) {
      familyId = defaultUserFam;
    } else if (existingFamilies.length > 0) {
      familyId = existingFamilies[0];
    } else {
      familyId = defaultUserFam;
    }
    chatToFamily[chatId] = familyId;
  }

  if (!databases[familyId]) {
    databases[familyId] = { familyId };
  }

  const db = databases[familyId];
  if (!Array.isArray(db.feeds)) db.feeds = [];
  if (!Array.isArray(db.diapers)) db.diapers = [];
  if (!Array.isArray(db.sleeps)) db.sleeps = [];
  if (!Array.isArray(db.careLogs)) db.careLogs = []; // Витамин D3, газики, животик
  if (!Array.isArray(db.deletedIds)) db.deletedIds = [];
  if (typeof db.notificationsEnabled === 'undefined') db.notificationsEnabled = true;

  return { db, familyId };
}

// Общая функция записи кормления
function recordFeeding(db, ml, type, rawUserName) {
  const time = getNowTime();
  const nowMs = Date.now();
  const todayStr = getTodayStr();

  const newFeed = {
    id: nowMs,
    ts: nowMs,
    editedAt: nowMs,
    date: todayStr,
    time: time,
    ml: Number(ml),
    type: type || 'Смесь',
    by: rawUserName,
    tags: []
  };

  db.feeds.unshift(newFeed);
  db.updatedAt = nowMs;
  db.lastFeedingTime = nowMs;
  db.feedingAlertSent = false;
  saveToCloud();

  const todayFeeds = db.feeds.filter(f => f.date === todayStr);
  const totalTodayMl = todayFeeds.reduce((s, f) => s + (Number(f.ml) || 0), 0);

  return { newFeed, totalTodayMl, todayCount: todayFeeds.length };
}

// Нижняя клавиатура (обновленная под 1.5 месяца)
const quickKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '🍼 Открыть трекер', web_app: { url: WEB_APP_URL } }],
      [{ text: '🍼 Поел' }, { text: '😴 Сон / ВБ' }],
      [{ text: '💧 Пописал' }, { text: '💩 Покакал' }],
      [{ text: '💊 Витамин D / Животик' }, { text: '📊 Сводка' }],
      [{ text: '↩️ Отменить кормление' }, { text: '🔔 Уведомления' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

// Команда /start
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const userName = escapeHtml(msg.from.first_name || 'Родитель');
  const passedFamilyId = match[1] ? match[1].trim() : null;

  subscribedChats.add(chatId);

  if (passedFamilyId) {
    chatToFamily[chatId] = passedFamilyId;
    if (!databases[passedFamilyId]) databases[passedFamilyId] = { familyId: passedFamilyId };
  }

  const { familyId } = getFamilyDb(chatId);
  saveToCloud();

  bot.sendMessage(
    chatId,
    `Привет, ${userName}! 🍼\nМалышке уже <b>${getBabyAgeStr()}</b> — трекер обновлен под новый уровень!\n\nКомната: <code>${escapeHtml(familyId)}</code>`,
    { parse_mode: 'HTML', ...quickKeyboard }
  );
});

// === ОБРАБОТКА INLINE-КНОПОК (КОРМЛЕНИЕ И УХОД) ===
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const rawUserName = query.from.first_name || 'Родитель';
  const safeUserName = escapeHtml(rawUserName);
  const { db } = getFamilyDb(chatId);
  const todayStr = getTodayStr();
  const time = getNowTime();
  const nowMs = Date.now();

  // 1. Выбор объема кормления: feed_90, feed_110, ..., feed_repeat
  if (data.startsWith('feed_')) {
    const val = data.replace('feed_', '');
    const lastMl = db.feeds.length > 0 ? (Number(db.feeds[0].ml) || DEFAULT_FEED_ML) : DEFAULT_FEED_ML;
    const ml = val === 'repeat' ? lastMl : parseInt(val, 10);

    const { newFeed, totalTodayMl, todayCount } = recordFeeding(db, ml, 'Смесь', rawUserName);

    bot.answerCallbackQuery(query.id, { text: `Записано: ${ml} мл! 🍼` });
    bot.editMessageText(
      `✅ <b>Кормление записано!</b>\n` +
      `🕒 Время: <b>${newFeed.time}</b> | Объём: <b>${ml} мл</b>\n` +
      `📈 За сегодня: <b>${totalTodayMl} / ${DAILY_TARGET_ML} мл</b> (${todayCount} кормл.)\n` +
      `👤 Кто: ${safeUserName}\n\n` +
      `🔔 <i>Напомню о следующем кормлении через 3 ч 15 мин.</i>`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Докорм +10 мл', callback_data: 'feed_adjust_10' }, { text: '↩️ Отменить запись', callback_data: `undo_feed_${newFeed.id}` }]
          ]
        }
      }
    );
  }

  // 2. Докорм +10 мл к последнему кормлению
  else if (data === 'feed_adjust_10') {
    if (db.feeds.length === 0) return bot.answerCallbackQuery(query.id, { text: 'Нет записей' });
    db.feeds[0].ml = (Number(db.feeds[0].ml) || 0) + 10;
    db.feeds[0].editedAt = nowMs;
    db.updatedAt = nowMs;
    saveToCloud();

    const todayFeeds = db.feeds.filter(f => f.date === todayStr);
    const totalTodayMl = todayFeeds.reduce((s, f) => s + (Number(f.ml) || 0), 0);

    bot.answerCallbackQuery(query.id, { text: `Обновлено: ${db.feeds[0].ml} мл` });
    bot.editMessageText(
      `✅ <b>Кормление обновлено (+10 мл)!</b>\n` +
      `🕒 Время: <b>${db.feeds[0].time}</b> | Итого за раз: <b>${db.feeds[0].ml} мл</b>\n` +
      `📈 За сегодня: <b>${totalTodayMl} / ${DAILY_TARGET_ML} мл</b>`,
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
    );
  }

  // 3. Отмена конкретного кормления из inline-кнопки
  else if (data.startsWith('undo_feed_')) {
    const targetId = data.replace('undo_feed_', '');
    const idx = db.feeds.findIndex(f => String(f.id) === targetId);
    if (idx !== -1) {
      const removed = db.feeds.splice(idx, 1)[0];
      db.deletedIds.push(String(removed.id));
      db.updatedAt = nowMs;
      db.lastFeedingTime = db.feeds[0] ? (db.feeds[0].ts || db.feeds[0].id) : null;
      saveToCloud();

      bot.answerCallbackQuery(query.id, { text: 'Запись удалена 🗑' });
      bot.editMessageText(
        `🗑 <b>Запись кормления (${removed.ml} мл в ${removed.time}) отменена.</b>`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
      );
    } else {
      bot.answerCallbackQuery(query.id, { text: 'Запись уже удалена' });
    }
  }

  // 4. Блок Ухода: Витамин D3 / Газики / Животик
  else if (data.startsWith('care_')) {
    const careType = data.replace('care_', '');

    if (careType === 'vitd') {
      const alreadyGiven = db.careLogs.find(c => c.date === todayStr && c.type === 'vitd');
      if (alreadyGiven) {
        bot.answerCallbackQuery(query.id, { text: `⚠️ Уже давали сегодня в ${alreadyGiven.time}!`, show_alert: true });
        return;
      }
      db.careLogs.unshift({ id: nowMs, ts: nowMs, date: todayStr, time, type: 'vitd', by: rawUserName });
      saveToCloud();

      bot.answerCallbackQuery(query.id, { text: 'Витамин D3 отмечен! ☀️' });
      bot.editMessageText(
        `☀️ <b>Витамин D3 дан в ${time}</b> (${safeUserName})\n<i>Повторный прием сегодня заблокирован во избежание передозировки.</i>`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
      );
    }

    else if (careType === 'colic') {
      db.careLogs.unshift({ id: nowMs, ts: nowMs, date: todayStr, time, type: 'colic', by: rawUserName });
      saveToCloud();

      const todayColic = db.careLogs.filter(c => c.date === todayStr && c.type === 'colic');
      bot.answerCallbackQuery(query.id, { text: 'Капли от газиков записаны 💧' });
      bot.editMessageText(
        `💧 <b>Капли от газиков даны в ${time}</b> (${safeUserName})\n📊 Всего за сегодня: <b>${todayColic.length} раз(а)</b>`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
      );
    }

    else if (careType === 'tummy') {
      db.careLogs.unshift({ id: nowMs, ts: nowMs, date: todayStr, time, type: 'tummy', by: rawUserName });
      saveToCloud();

      const todayTummy = db.careLogs.filter(c => c.date === todayStr && c.type === 'tummy');
      bot.answerCallbackQuery(query.id, { text: 'Выкладывание на животик записано 🐢' });
      bot.editMessageText(
        `🐢 <b>Выложили на животик в ${time}</b> (${safeUserName})\n📊 Подходов за сегодня: <b>${todayTummy.length}</b>`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
      );
    }
  }
});

// === ОБРАБОТКА КНОПОК НИЖНЕГО МЕНЮ И ТЕКСТА ===
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const rawUserName = msg.from.first_name || 'Родитель';
  const safeUserName = escapeHtml(rawUserName);

  if (!text || text.startsWith('/')) return;

  const { db, familyId } = getFamilyDb(chatId);
  const time = getNowTime();
  const nowMs = Date.now();
  const todayStr = getTodayStr();
  const lowerText = text.toLowerCase();

  // 1. КНОПКА: ПОЕЛ -> ПОКАЗЫВАЕМ ВЫБОР ОБЪЕМА (90 - 150 МЛ)
  if (text === '🍼 Поел') {
    const lastFeed = db.feeds[0];
    const lastMl = lastFeed ? (Number(lastFeed.ml) || DEFAULT_FEED_ML) : DEFAULT_FEED_ML;
    const lastAgoStr = lastFeed
      ? `${formatDuration(Math.floor((nowMs - (lastFeed.ts || lastFeed.id)) / 60000))} назад (${lastMl} мл)`
      : 'нет записей';

    const todayFeeds = db.feeds.filter(f => f.date === todayStr);
    const totalTodayMl = todayFeeds.reduce((s, f) => s + (Number(f.ml) || 0), 0);

    bot.sendMessage(
      chatId,
      `🍼 <b>Новое кормление (${getBabyAgeStr()})</b>\n` +
      `🕒 Прошлое: ${lastAgoStr}\n` +
      `📊 За сегодня: <b>${totalTodayMl} / ${DAILY_TARGET_ML} мл</b>\n\n` +
      `<i>Выбери объём или напиши цифру в чат:</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '90 мл', callback_data: 'feed_90' },
              { text: '110 мл', callback_data: 'feed_110' },
              { text: '120 мл', callback_data: 'feed_120' }
            ],
            [
              { text: '130 мл', callback_data: 'feed_130' },
              { text: '140 мл', callback_data: 'feed_140' },
              { text: '150 мл', callback_data: 'feed_150' }
            ],
            [
              { text: `🔁 Повторить (${lastMl} мл)`, callback_data: 'feed_repeat' }
            ]
          ]
        }
      }
    );
  }

  // 2. КНОПКА: СОН / ВБ (СТАРТ/СТОП + КОНТРОЛЬ ОКНА БОДРСТВОВАНИЯ)
  else if (text === '😴 Сон / ВБ' || text === '😴 Сон (Старт/Стоп)') {
    if (!db.activeSleepStart) {
      // Малышка уснула -> считаем, сколько длилось бодрствование
      let wakeInfo = '';
      if (db.lastWakeUpTime) {
        const wakeMins = Math.max(1, Math.round((nowMs - db.lastWakeUpTime) / 60000));
        wakeInfo = `\n⏱ Время бодрствования составило: <b>${formatDuration(wakeMins)}</b>`;
      }

      db.activeSleepStart = nowMs;
      db.activeSleepTimeStr = time;
      db.lastWakeUpTime = null;
      db.wakeAlertSent = false;
      saveToCloud();

      bot.sendMessage(
        chatId,
        `🌙 <b>Малышка уснула в ${time}</b>${wakeInfo}\n<i>Когда проснется — нажми кнопку еще раз, запущу таймер бодрствования!</i>`,
        { parse_mode: 'HTML', ...quickKeyboard }
      );
    } else {
      // Малышка проснулась -> запускаем таймер ВБ (75 мин)
      const durationMinutes = Math.max(1, Math.round((nowMs - db.activeSleepStart) / 60000));
      const durationStr = formatDuration(durationMinutes);
      const startedAt = db.activeSleepTimeStr;

      db.sleeps.unshift({
        id: nowMs,
        startTime: startedAt,
        endTime: time,
        date: todayStr,
        durationMinutes: durationMinutes,
        durationText: durationStr,
        ts: nowMs
      });

      db.activeSleepStart = null;
      db.activeSleepTimeStr = null;
      db.lastWakeUpTime = nowMs;
      db.wakeAlertSent = false;
      saveToCloud();

      bot.sendMessage(
        chatId,
        `☀️ <b>Малышка проснулась в ${time}!</b>\n` +
        `🛌 Проспала: <b>${durationStr}</b> (с ${startedAt} до ${time})\n\n` +
        `👀 <i>Таймер окна бодрствования запущен — через 1 ч 15 мин напомню, что пора укладывать!</i>`,
        { parse_mode: 'HTML', ...quickKeyboard }
      );
    }
  }

  // 3. КНОПКА: ВИТАМИН D / ЖИВОТИК
  else if (text === '💊 Витамин D / Животик') {
    const vitdToday = db.careLogs.find(c => c.date === todayStr && c.type === 'vitd');
    const colicCount = db.careLogs.filter(c => c.date === todayStr && c.type === 'colic').length;
    const tummyCount = db.careLogs.filter(c => c.date === todayStr && c.type === 'tummy').length;

    const vitdStatus = vitdToday ? `✅ Дан в ${vitdToday.time}` : '❌ Ещё не давали';

    bot.sendMessage(
      chatId,
      `💊 <b>Уход и животик за сегодня (${todayStr}):</b>\n\n` +
      `☀️ <b>Витамин D3:</b> ${vitdStatus}\n` +
      `💧 <b>Капли от газиков:</b> ${colicCount} раз(а)\n` +
      `🐢 <b>На животике (Tummy Time):</b> ${tummyCount} раз(а)\n\n` +
      `<i>Что отметить?</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: vitdToday ? '☀️ Витамин D3 (уже дан ✅)' : '☀️ Дал Витамин D3', callback_data: 'care_vitd' }],
            [{ text: '💧 Дал капли от газиков', callback_data: 'care_colic' }],
            [{ text: '🐢 Выложил на животик', callback_data: 'care_tummy' }]
          ]
        }
      }
    );
  }

  // 4. КНОПКА: ПОДГУЗНИКИ
  else if (text === '💧 Пописал' || text === '💩 Покакал') {
    const diaperType = text === '💩 Покакал' ? '💩 Покак' : '💧 Попис';

    db.diapers.unshift({
      id: nowMs,
      ts: nowMs,
      editedAt: nowMs,
      date: todayStr,
      time: time,
      type: diaperType,
      by: rawUserName
    });
    db.updatedAt = nowMs;
    saveToCloud();

    bot.sendMessage(
      chatId,
      `✅ <b>Подгузник отмечен:</b> ${diaperType} в <b>${time}</b>`,
      { parse_mode: 'HTML', ...quickKeyboard }
    );
  }

  // 5. КНОПКА: ОТМЕНИТЬ ПОСЛЕДНЕЕ КОРМЛЕНИЕ
  else if (text === '↩️ Отменить кормление') {
    if (db.feeds.length === 0) {
      bot.sendMessage(chatId, '🤷‍♂️ В списке пока нет записей кормлений для удаления.', quickKeyboard);
      return;
    }

    const removed = db.feeds.shift();
    db.deletedIds.push(String(removed.id));
    db.updatedAt = nowMs;
    db.lastFeedingTime = db.feeds[0] ? (db.feeds[0].ts || db.feeds[0].id) : null;
    db.feedingAlertSent = false;
    saveToCloud();

    bot.sendMessage(
      chatId,
      `🗑 <b>Удалено последнее кормление:</b> за <b>${removed.time}</b> (${removed.ml} мл).\n` +
      (db.feeds[0] ? `Крайнее кормление теперь в <b>${db.feeds[0].time}</b>.` : `Список кормлений пуст.`),
      { parse_mode: 'HTML', ...quickKeyboard }
    );
  }

  // 6. КНОПКА: СВОДКА (РАСШИРЕННАЯ ПОД 1.5 МЕСЯЦА)
  else if (text === '📊 Сводка') {
    const todayFeeds = db.feeds.filter(f => f.date === todayStr);
    const totalMl = todayFeeds.reduce((s, f) => s + (Number(f.ml) || 0), 0);
    const todayDiapers = db.diapers.filter(d => d.date === todayStr);
    const todaySleeps = db.sleeps.filter(s => s.date === todayStr);
    const totalSleepMins = todaySleeps.reduce((s, item) => s + (Number(item.durationMinutes) || 0), 0);

    const vitdGiven = db.careLogs.find(c => c.date === todayStr && c.type === 'vitd');
    const tummyCount = db.careLogs.filter(c => c.date === todayStr && c.type === 'tummy').length;

    const lastFeed = db.feeds[0]
      ? `${db.feeds[0].time} (${db.feeds[0].ml} мл — ${formatDuration(Math.floor((nowMs - (db.feeds[0].ts || db.feeds[0].id)) / 60000))} назад)`
      : 'нет записей';

    let sleepStatus = 'нет записей';
    if (db.activeSleepStart) {
      const sleepingNow = Math.floor((nowMs - db.activeSleepStart) / 60000);
      sleepStatus = `😴 Спит (${formatDuration(sleepingNow)}, с ${db.activeSleepTimeStr})`;
    } else if (db.lastWakeUpTime) {
      const awakeNow = Math.floor((nowMs - db.lastWakeUpTime) / 60000);
      sleepStatus = `👀 Бодрствует <b>${formatDuration(awakeNow)}</b> (норма ВБ: 60–90 мин)`;
    } else if (db.sleeps[0]) {
      sleepStatus = `Проснулась в ${db.sleeps[0].endTime} (спала ${db.sleeps[0].durationText})`;
    }

    const summaryText =
      `📊 <b>Сводка за сегодня (${todayStr})</b>\n` +
      `👶 Возраст малышки: <b>${getBabyAgeStr()}</b>\n` +
      `🔗 Комната: <code>${escapeHtml(familyId)}</code>\n\n` +
      `🍼 <b>Съедено:</b> ${totalMl} / ${DAILY_TARGET_ML} мл (${todayFeeds.length} кормл.)\n` +
      `🕒 <b>Крайняя еда:</b> ${lastFeed}\n` +
      `🛌 <b>Сон за день:</b> ${formatDuration(totalSleepMins)} | ${sleepStatus}\n` +
      `🧷 <b>Подгузники:</b> ${todayDiapers.length} шт.\n` +
      `💊 <b>Витамин D3:</b> ${vitdGiven ? `✅ (${vitdGiven.time})` : '❌ не дан'} | 🐢 <b>Животик:</b> ${tummyCount}x\n` +
      `🔔 <b>Уведомления:</b> ${db.notificationsEnabled ? 'Включены ✅' : 'Выключены 🔕'}`;

    bot.sendMessage(chatId, summaryText, { parse_mode: 'HTML', ...quickKeyboard });
  }

  // 7. КНОПКА: ВКЛ/ВЫКЛ УВЕДОМЛЕНИЙ
  else if (text === '🔔 Уведомления' || text === '🔔 Уведомления Вкл/Выкл') {
    db.notificationsEnabled = !db.notificationsEnabled;
    saveToCloud();

    const statusText = db.notificationsEnabled
      ? '🔔 <b>Уведомления включены!</b>\n• Через <b>3ч 15м</b> после еды напомню про кормление.\n• Через <b>1ч 15м</b> бодрствования напомню укладывать спать.'
      : '🔕 <b>Уведомления выключены.</b> Не буду беспокоить пушами, пока не включишь обратно.';

    bot.sendMessage(chatId, statusText, { parse_mode: 'HTML', ...quickKeyboard });
  }

  // 8. УМНЫЙ ПАРСЕР СВОБОДНОГО ТЕКСТА (ГОЛОСА / ВВОДА)
  else {
    if (lowerText.includes('попис') || lowerText.includes('пописал')) {
      db.diapers.unshift({ id: nowMs, ts: nowMs, editedAt: nowMs, date: todayStr, time: time, type: '💧 Попис', by: rawUserName });
      db.updatedAt = nowMs;
      saveToCloud();
      bot.sendMessage(chatId, `✅ <b>Записал попис</b> в ${time} 💧 (${safeUserName})`, { parse_mode: 'HTML', ...quickKeyboard });
      return;
    }

    if (lowerText.includes('покак') || lowerText.includes('покакал')) {
      db.diapers.unshift({ id: nowMs, ts: nowMs, editedAt: nowMs, date: todayStr, time: time, type: '💩 Покак', by: rawUserName });
      db.updatedAt = nowMs;
      saveToCloud();
      bot.sendMessage(chatId, `✅ <b>Записал покак</b> в ${time} 💩 (${safeUserName})`, { parse_mode: 'HTML', ...quickKeyboard });
      return;
    }

    if (lowerText.includes('витамин') || lowerText.includes('д3') || lowerText.includes('d3')) {
      const alreadyGiven = db.careLogs.find(c => c.date === todayStr && c.type === 'vitd');
      if (alreadyGiven) {
        bot.sendMessage(chatId, `⚠️ <b>Витамин D3 сегодня уже давали</b> в ${alreadyGiven.time}!`, { parse_mode: 'HTML', ...quickKeyboard });
        return;
      }
      db.careLogs.unshift({ id: nowMs, ts: nowMs, date: todayStr, time, type: 'vitd', by: rawUserName });
      saveToCloud();
      bot.sendMessage(chatId, `☀️ <b>Записал Витамин D3</b> в ${time} (${safeUserName})!`, { parse_mode: 'HTML', ...quickKeyboard });
      return;
    }

    const mlMatch = lowerText.match(/(\d+)\s*(?:мл)?/);
    if (lowerText.includes('поел') || lowerText.includes('смесь') || lowerText.includes('мл') || (mlMatch && !isNaN(mlMatch[1]) && Number(mlMatch[1]) > 15 && Number(mlMatch[1]) < 350)) {
      const ml = mlMatch ? parseInt(mlMatch[1], 10) : (db.feeds.length > 0 ? (Number(db.feeds[0].ml) || DEFAULT_FEED_ML) : DEFAULT_FEED_ML);
      const feedType = lowerText.includes('гв') ? 'ГВ / Молоко' : 'Смесь';

      const { totalTodayMl, todayCount } = recordFeeding(db, ml, feedType, rawUserName);

      bot.sendMessage(
        chatId,
        `✅ <b>Распознано кормление:</b> ${ml} мл (${time})\n` +
        `📈 За сегодня: <b>${totalTodayMl} / ${DAILY_TARGET_ML} мл</b> (${todayCount} кормл.)\n` +
        `👤 Записал (${safeUserName})!`,
        { parse_mode: 'HTML', ...quickKeyboard }
      );
      return;
    }

    bot.sendMessage(
      chatId,
      `🤖 Нажми кнопку внизу или напиши объём (например: <i>«130 мл»</i>, <i>«пописал»</i>, <i>«витамин д3»</i>).`,
      { parse_mode: 'HTML', ...quickKeyboard }
    );
  }
});

// === ФОНОВЫЙ ТАЙМЕР УМНЫХ УВЕДОМЛЕНИЙ (ЕДА + ОКНО БОДРСТВОВАНИЯ) ===
setInterval(() => {
  const nowMs = Date.now();

  subscribedChats.forEach((chatId) => {
    const { db } = getFamilyDb(chatId);
    if (!db.notificationsEnabled) return;

    // 1. Напоминание о кормлении через 3ч 15м (195 мин)
    const lastFeedMs = db.lastFeedingTime || (db.feeds[0] && (db.feeds[0].ts || db.feeds[0].id));
    if (lastFeedMs && !db.feedingAlertSent && !db.activeSleepStart) {
      const minutesPassed = Math.floor((nowMs - lastFeedMs) / 60000);
      if (minutesPassed >= FEED_INTERVAL_MIN && minutesPassed < 360) {
        db.feedingAlertSent = true;
        saveToCloud();

        bot.sendMessage(
          chatId,
          `🍼 <b>Пора готовить смесь!</b> С прошлого кормления прошло <b>${formatDuration(minutesPassed)}</b>.\n\n` +
          `<i>Когда покормишь, нажми «🍼 Поел» и выбери объём.</i>`,
          { parse_mode: 'HTML', ...quickKeyboard }
        );
      }
    }

    // 2. Контроль перегула: ВБ достигло 1ч 15м (75 мин)
    if (db.lastWakeUpTime && !db.activeSleepStart && !db.wakeAlertSent) {
      const awakeMinutes = Math.floor((nowMs - db.lastWakeUpTime) / 60000);
      if (awakeMinutes >= WAKE_WINDOW_LIMIT_MIN && awakeMinutes < 180) {
        db.wakeAlertSent = true;
        saveToCloud();

        bot.sendMessage(
          chatId,
          `👀 <b>Внимание на окно бодрствования!</b>\n` +
          `Малышка не спит уже <b>${formatDuration(awakeMinutes)}</b>. Для 1.5 месяцев пора ловить признаки усталости и укладывать, чтобы не словить перегул 😴`,
          { parse_mode: 'HTML', ...quickKeyboard }
        );
      }
    }
  });
}, 60 * 1000);

// === ФОНОВАЯ ПРОВЕРКА НАПОМИНАНИЙ ИЗ MINI APP ===
setInterval(() => {
  const now = new Date();
  reminders = reminders.filter(reminder => {
    if (now >= new Date(reminder.remindTime)) {
      bot.sendMessage(reminder.chatId, reminder.text, { parse_mode: 'HTML', ...quickKeyboard })
         .catch(err => console.error('Ошибка отправки напоминания:', err));
      return false;
    }
    return true;
  });
}, 60 * 1000);

// === API ДЛЯ ПИНГА И MINI APP ===
app.get('/', (req, res) => {
  res.send(`Сервер трекера малышки (${getBabyAgeStr()}) работает отлично! 🍼`);
});

app.get('/ping', (req, res) => {
  res.send('Alive!');
});

app.post('/api/set-reminder', (req, res) => {
  const { chatId, timestamp, text } = req.body;
  if (!chatId || !timestamp) {
    return res.status(400).json({ error: 'Missing chatId or timestamp' });
  }
  const remindTime = new Date(timestamp - 5 * 60 * 1000);
  reminders.push({
    chatId: Number(chatId),
    remindTime,
    text: text || '⚠️ Внимание! Через 5 минут запланировано кормление малышки! 🍼'
  });
  res.json({ success: true, remindTime });
});

app.get('/api/get/:familyId', (req, res) => {
  const { familyId } = req.params;
  res.json(databases[familyId] || null);
});

app.post('/api/save/:familyId', (req, res) => {
  const { familyId } = req.params;
  const currentDb = databases[familyId] || {};
  const incoming = req.body || {};

  const deletedIds = Array.from(new Set([
    ...(currentDb.deletedIds || []),
    ...(incoming.deletedIds || [])
  ])).slice(-200);

  const mergedFeeds = mergeLists(currentDb.feeds, incoming.feeds, deletedIds);
  const mergedDiapers = mergeLists(currentDb.diapers, incoming.diapers, deletedIds);

  const newestFeedMs = mergedFeeds[0] ? (mergedFeeds[0].ts || mergedFeeds[0].id) : null;
  const isNewFeedAdded = newestFeedMs && newestFeedMs !== currentDb.lastFeedingTime;

  databases[familyId] = {
    ...currentDb,
    ...incoming,
    familyId,
    updatedAt: Math.max(currentDb.updatedAt || 0, incoming.updatedAt || 0, Date.now()),
    deletedIds,
    feeds: mergedFeeds,
    diapers: mergedDiapers,
    lastFeedingTime: newestFeedMs,
    feedingAlertSent: isNewFeedAdded ? false : currentDb.feedingAlertSent
  };

  saveToCloud();
  res.json({ success: true });
});

// Защита от зависшего polling при перезапусках (409 Conflict)
bot.on('polling_error', (err) => {
  if (!String(err.message).includes('409')) {
    console.error('Polling error:', err.message);
  }
});

process.on('SIGINT', async () => {
  await bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await bot.stopPolling();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadFromCloud();
  console.log(`Бот и сервер успешно запущены на порту ${PORT}`);
});
