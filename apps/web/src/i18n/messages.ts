import type { Locale } from './config';

/**
 * Interface dictionaries.
 *
 * ## Why the Russian string is the key
 *
 * The source of every sentence is already in the code, in Russian. A key such as
 * `"Найти собеседника"` means a missing translation is visible in the diff as the
 * sentence it belongs to, a translator never needs a second file open to know what
 * they are translating, and the Russian dictionary cannot drift from the source:
 * it *is* the key. The cost is that changing Russian wording is a key change, so
 * the compiler points at every call site — which is the behaviour we want.
 *
 * `en` defines the key set. `zh` is typed as `Record<keyof typeof en, string>`, so a
 * missing or misspelled Chinese key fails `pnpm typecheck`. Placeholders are checked
 * at module load (below), because TypeScript cannot see inside a string.
 *
 * ## What is deliberately not here
 *
 * `/admin` is Russian-only, the User ID and the language names are never
 * translated, and a chat message is never translated by us at all: it is shown in
 * the language its author wrote, with `lang=""` so a browser translator can detect
 * it per message (D29).
 */
export const en = {
  // --- shell -------------------------------------------------------------
  'Перейти к основному содержимому': 'Skip to main content',
  'Интерфейс дал сбой': 'The interface crashed',
  'Это ошибка на нашей стороне. Ваш User ID и текущие чаты не потеряны.':
    'This is a mistake on our side. Your User ID and current chats are not lost.',
  'Попробовать снова': 'Try again',
  'Анонимный чат с незнакомцами': 'Anonymous chat with strangers',
  'Связаться с администрацией': 'Contact the administration',

  // --- theme and language ------------------------------------------------
  'Включить светлую тему': 'Switch to the light theme',
  'Включить тёмную тему': 'Switch to the dark theme',
  'Светлая тема': 'Light theme',
  'Тёмная тема': 'Dark theme',
  'Язык интерфейса': 'Interface language',

  // --- connection --------------------------------------------------------
  'Запуск…': 'Starting…',
  'Подключение…': 'Connecting…',
  'На связи': 'Connected',
  'Переподключение…': 'Reconnecting…',
  'Нет связи': 'Offline',
  'Доступ закрыт': 'Access denied',
  'Сервер работает по другой версии протокола. Обновите страницу — иначе сообщения могут теряться.':
    'The server is running a different protocol version. Reload the page, or messages may be lost.',
  'Нет связи с сервером': 'No connection to the server',
  'Не удалось получить анонимную сессию.': 'Could not start an anonymous session.',
  Повторить: 'Retry',
  'Если не помогает: проверьте, что API-сервер запущен, и что браузер не блокирует cookie для этого сайта — без cookie анонимная сессия невозможна.':
    'If that does not help, check that the API server is running and that the browser is not blocking cookies for this site — without a cookie an anonymous session is impossible.',
  'Получаем ваш User ID': 'Getting your User ID',

  // --- identity ----------------------------------------------------------
  'Ваш User ID': 'Your User ID',
  Скопировано: 'Copied',
  'Нажмите на него, чтобы скопировать': 'Click it to copy',
  'Браузер не разрешил копирование. Выделите ID и скопируйте вручную.':
    'The browser did not allow copying. Select the ID and copy it manually.',
  'Скопировать User ID': 'Copy User ID',
  'Получить новый User ID': 'Get a new User ID',
  'Получить новый User ID?': 'Get a new User ID?',
  'Текущий ID перестанет работать сразу же, и все ваши открытые сессии будут закрыты. Прошлый ID восстановить нельзя.':
    'The current ID stops working immediately and all your open sessions are closed. The old ID cannot be restored.',
  'Ваш User ID — не пароль: по нему можно только предложить вам чат, если заявки разрешены.':
    'Your User ID is not a password: it can only be used to offer you a chat, and only if requests are allowed.',
  Отмена: 'Cancel',
  'Меняем…': 'Replacing…',
  'Да, получить новый': 'Yes, get a new one',

  // --- direct contact ----------------------------------------------------
  'Чат по User ID': 'Chat by User ID',
  'User ID собеседника': 'The other person’s User ID',
  'Вставьте сюда ID собеседника': 'Paste the other person’s ID here',
  Найти: 'Find',
  'Неверный формат. User ID состоит из 14 символов и начинается с AL.':
    'Wrong format. A User ID has 14 characters and starts with AL.',
  'Это ваш собственный User ID.': 'This is your own User ID.',
  'Проверяем…': 'Checking…',
  'Пользователь с таким ID не найден. Проверьте, нет ли опечатки.':
    'No user with that ID exists. Check for a typo.',
  'Пользователь найден и принимает заявки.': 'User found, and they accept requests.',
  'Отправить заявку': 'Send request',
  'В отличие от случайного чата, получатель увидит ваш User ID — иначе он не поймёт, кто с ним хочет поговорить.':
    'Unlike a random chat, the recipient will see your User ID — otherwise they cannot tell who wants to talk.',
  'Пользователь найден, но он отключил входящие заявки.':
    'User found, but they have turned requests off.',
  'Заявка отправлена. Ждём ответа.': 'Request sent. Waiting for an answer.',
  'Истекает через:': 'Expires in:',

  // --- search ------------------------------------------------------------
  'Ищем собеседника…': 'Looking for someone…',
  'Время ожидания': 'Waiting time',
  'Отменить поиск': 'Cancel search',
  'Ищем по фильтрам': 'Searching with filters',
  'Без фильтров — подойдёт любой собеседник.': 'No filters — anyone can match.',
  'Уже снято: {criteria}': 'Already relaxed: {criteria}',
  'Если никто не найдётся, сервер начнёт снимать фильтры по одному и каждый раз сообщит, какой именно.':
    'If nobody is found, the server will relax filters one at a time and say which one each time.',
  'До первого шага:': 'Until the first step:',
  'Можно не ждать здесь — поиск продолжится, а чат откроется автоматически.':
    'You can leave this screen — the search continues and the chat opens automatically.',
  'Начинаем…': 'Starting…',
  'Найти собеседника': 'Find someone',
  'Фильтры поиска': 'Search filters',
  Настройки: 'Settings',

  // --- settings ----------------------------------------------------------
  'Добавить язык': 'Add language',
  'Не выбрано ни одного.': 'None selected.',
  'Добавить язык…': 'Add a language…',
  'Убрать {value}': 'Remove {value}',
  Добавить: 'Add',
  'Не больше {count} названий в одном списке.': 'No more than {count} names per list.',
  'Нижняя граница возраста больше верхней — так не найдётся никто.':
    'The lower age bound is above the upper one — nobody would match.',
  'Проверьте значения: сервер отклонит такие данные.':
    'Check the values: the server will reject them.',
  'Данные о себе сохранены.': 'Your details have been saved.',
  'Возраст указывается целым числом от 1 до {max}.': 'Age must be a whole number from 1 to {max}.',
  'О вас': 'About you',
  'Эти данные указываете вы сами, проверить их нечем. Они нужны только подбору — собеседник их не видит.':
    'You provide this yourself; nothing verifies it. It is used only for matching — the other person never sees it.',
  'Ваш пол': 'Your gender',
  Возраст: 'Age',
  'Например, 25': 'For example, 25',
  Страна: 'Country',
  'Не указана': 'Not specified',
  Город: 'City',
  Регион: 'Region',
  'Начните вводить': 'Start typing',
  'Языки, на которых вам удобно общаться': 'Languages you are comfortable chatting in',
  'Сохранить данные': 'Save details',
  'Фильтры поиска сохранены.': 'Search filters saved.',
  'Кого искать': 'Whom to look for',
  'Подбор идёт только между теми, кто подходит друг другу: ваши фильтры и фильтры собеседника действуют одновременно.':
    'Matching only happens between people who suit each other: your filters and the other person’s filters apply together.',
  'Пол собеседника': 'The other person’s gender',
  Любой: 'Any',
  'Возраст собеседника': 'The other person’s age',
  'Минимальный возраст': 'Minimum age',
  'Максимальный возраст': 'Maximum age',
  от: 'from',
  до: 'to',
  'Где искать': 'Where to search',
  'Подойдёт любая страна, город и регион.': 'Any country, city or region will do.',
  'Подойдёт любой из перечисленных.': 'Any of the listed places will do.',
  Страны: 'Countries',
  'Добавить страну': 'Add country',
  'Добавить страну…': 'Add a country…',
  'Не выбрана ни одна страна.': 'No country selected.',
  Города: 'Cities',
  'Добавить город': 'Add city',
  'Начните вводить название': 'Start typing a name',
  'Не выбран ни один город.': 'No city selected.',
  Регионы: 'Regions',
  'Добавить регион': 'Add region',
  'Не выбран ни один регион.': 'No region selected.',
  'Общий язык': 'Shared language',
  'Если подходящего собеседника долго нет': 'If nobody suitable appears for a long time',
  'Снимать фильтры по одному': 'Relax filters one at a time',
  Разрешено: 'Allowed',
  Запрещено: 'Not allowed',
  'Снятие никогда не происходит молча: сервер сообщит, какой фильтр снят.':
    'Relaxing is never silent: the server announces which filter was dropped.',
  'Будет применяться': 'Will be applied',
  'Сохранить фильтры': 'Save filters',
  'Принимать заявки': 'Accept requests',
  'Любой, кто знает ваш User ID, может предложить чат.':
    'Anyone who knows your User ID can offer a chat.',
  'Не принимать заявки': 'Do not accept requests',
  'Вас можно найти, но предложить чат нельзя. Случайный поиск работает как обычно.':
    'You can still be found, but nobody can offer a chat. Random search works as usual.',
  Модерация: 'Moderation',
  'Входящие заявки': 'Incoming requests',
  Заблокированные: 'Blocked people',
  'Список заблокированных': 'Blocked list',
  'Обновить список заблокированных': 'Refresh blocked list',
  'Загрузка списка': 'Loading the list',
  'Список пуст.': 'The list is empty.',
  Разблокировать: 'Unblock',
  'Загружаем настройки': 'Loading settings',

  // --- chat --------------------------------------------------------------
  случайный: 'random',
  'по User ID': 'by User ID',
  'собеседник отключился': 'the other person went offline',
  Блокировать: 'Block',
  Жалоба: 'Report',
  Следующий: 'Next',
  Завершить: 'End',
  Переписка: 'Conversation',
  'Напишите первое сообщение.': 'Write the first message.',
  'Найти нового собеседника': 'Find a new person',
  'Написать снова': 'Write again',
  Готово: 'Done',
  Сообщение: 'Message',
  'Введите сообщение…': 'Type a message…',
  Отправить: 'Send',
  'Только текст. Enter — отправить, Shift+Enter — новая строка.':
    'Text only. Enter sends, Shift+Enter adds a new line.',
  'Сообщение слишком длинное — сократите его на {count} симв.':
    'The message is too long — shorten it by {count} characters.',
  отправляется: 'sending',
  'не отправлено': 'not sent',
  'не отправлено: {reason}': 'not sent: {reason}',
  'Открываем чат…': 'Opening the chat…',

  // --- dialogs -----------------------------------------------------------
  'Заблокировать собеседника?': 'Block this person?',
  Заблокировать: 'Block',
  'Чат завершится сразу. Вы больше не будете попадаться друг другу при случайном поиске, и этот собеседник не сможет написать вам по User ID.':
    'The chat ends immediately. You will not meet in random search again, and this person cannot write to you by User ID.',
  'Случайные собеседники не видят ваш User ID, но блокировка всё равно их запоминает — на случай, если вы встретитесь снова. Список блокировок можно посмотреть внизу главной страницы.':
    'Random partners do not see your User ID, but a block still remembers them in case you meet again. The block list is at the bottom of the main page.',
  'Пожаловаться на собеседника': 'Report this person',
  'Чат будет сразу завершён. Ваш User ID не сообщается собеседнику.':
    'The chat ends immediately. Your User ID is not shown to the other person.',
  Причина: 'Reason',
  Подробности: 'Details',
  '(необязательно)': '(optional)',
  'Что именно произошло?': 'What exactly happened?',
  'Вместе с жалобой сохраняется текст последнего сообщения — это то, что проверяет модерация.':
    'The text of the last message is stored with the report — that is what moderation reviews.',
  'Отправить жалобу': 'Send report',
  'На вас поступила жалоба': 'A report was filed about you',
  'На вас поступила жалоба.': 'A report was filed about you.',
  'Администрация рассмотрит её. Если будут выявлены нарушения правил, ваш доступ могут закрыть — вплоть до бана.':
    'The administration will review it. If the rules were broken, your access may be closed — up to a ban.',
  'Жалоба уже зарегистрирована. Отвечать на неё здесь не нужно.':
    'The report is already registered. You do not need to answer it here.',
  Понятно: 'Got it',
  'Выберите тему, чтобы сообщение попало по адресу.':
    'Choose a topic so the message reaches the right place.',
  'Тема обращения': 'Topic',
  'Текст сообщения': 'Message text',
  'Опишите подробнее, чем помочь.': 'Describe what would help.',
  'Как с вами связаться': 'How to contact you',
  'Ссылка, ник или адрес — если хотите ответ': 'A link, username or address — if you want a reply',
  'Сообщение сохраняется, чтобы администрация могла его прочитать и ответить, и удаляется автоматически по истечении срока хранения. Ваш User ID видит только администрация.':
    'The message is stored so the administration can read it and reply, and is deleted automatically when the retention period ends. Only the administration sees your User ID.',
  'Отправить администрации': 'Send to the administration',
  'Сообщение отправлено администрации.': 'Message sent to the administration.',
  'Хотят начать с вами чат': 'Someone wants to chat with you',
  'Человек нашёл вас по вашему User ID. Он не узнает, примете вы или нет, — увидит только результат.':
    'This person found you by your User ID. They will not know whether you accept until they see the result.',
  'Без сообщения.': 'No message.',
  'Время заявки истекло.': 'The request has expired.',
  'Заявка ждёт ответа.': 'The request is waiting for an answer.',
  'Ещё заявок в очереди: {count}.': 'More requests waiting: {count}.',
  Отклонить: 'Decline',
  Принять: 'Accept',
  'Закрыть уведомление': 'Dismiss notification',

  // --- errors ------------------------------------------------------------
  'Некорректные данные. Проверьте ввод.': 'Invalid data. Check your input.',
  'Нужна анонимная сессия. Обновите страницу.':
    'An anonymous session is required. Reload the page.',
  'Сессия больше не действительна. Обновите страницу.':
    'The session is no longer valid. Reload the page.',
  'Эта анонимная личность заблокирована.': 'This anonymous identity is blocked.',
  'Пользователь с таким User ID не найден.': 'No user with that User ID exists.',
  'Этот пользователь сейчас недоступен.': 'That user is unavailable right now.',
  'Нельзя написать самому себе.': 'You cannot write to yourself.',
  'Вы уже в чате.': 'You are already in a chat.',
  'Этот чат больше не существует.': 'That chat no longer exists.',
  'Вы не участник этого чата.': 'You are not a participant in this chat.',
  'Чат завершён.': 'The chat has ended.',
  'Сообщение слишком длинное.': 'The message is too long.',
  'Сообщение пустое.': 'The message is empty.',
  'Слишком много запросов. Подождите немного.': 'Too many requests. Wait a little.',
  'Слишком много открытых вкладок для этой личности.': 'Too many open tabs for this identity.',
  'Заявка больше не существует.': 'The request no longer exists.',
  'Заявка отклонена.': 'The request was declined.',
  'Этот пользователь не принимает заявки.': 'This user does not accept requests.',
  'Общение с этим пользователем невозможно.': 'Communication with this user is not possible.',
  'Блокировка сейчас отключена администрацией.':
    'Blocking is currently disabled by the administration.',
  'Эта жалоба больше не существует.': 'That report no longer exists.',
  'Неподдерживаемое событие. Обновите страницу.': 'Unsupported event. Reload the page.',
  'Неверный ключ владельца.': 'Wrong owner key.',
  'Этот источник не может подключиться.': 'This origin cannot connect.',
  'Такого адреса на сервере нет. Обновите страницу.':
    'That address does not exist on the server. Reload the page.',
  'Запрос слишком большой.': 'The request is too large.',
  'Что-то пошло не так. Попробуйте ещё раз.': 'Something went wrong. Try again.',
  'Сервис временно недоступен.': 'The service is temporarily unavailable.',

  // --- chat endings and request states ----------------------------------
  'Вы завершили чат.': 'You ended the chat.',
  'Собеседник завершил чат.': 'The other person ended the chat.',
  'Собеседник отключился и не вернулся.': 'The other person went offline and did not return.',
  'Вы заблокировали собеседника. Чат завершён.':
    'You blocked the other person. The chat has ended.',
  'Жалоба отправлена. Чат завершён.': 'The report was sent. The chat has ended.',
  'Сервис был перезапущен, поэтому чат завершён.': 'The service restarted, so the chat has ended.',
  'Чат завершён по истечении времени.': 'The chat ended because time ran out.',
  'Заявка принята — чат начался.': 'The request was accepted — the chat has started.',
  'Заявка отменена.': 'The request was cancelled.',
  'Пользователь не принимает заявки.': 'The user does not accept requests.',
  'Заявка обработана.': 'The request was processed.',
  'Пользователь сейчас недоступен.': 'The user is unavailable right now.',
  'Поиск отменён.': 'The search was cancelled.',
  'Поиск остановлен: слишком долго никто не находился.':
    'The search stopped: nobody was found for too long.',
  'Собеседник найден.': 'A person was found.',
  'Поиск остановлен.': 'The search stopped.',

  // --- vocabularies ------------------------------------------------------
  Женский: 'Female',
  Мужской: 'Male',
  'Спам или реклама': 'Spam or advertising',
  'Оскорбления или травля': 'Insults or harassment',
  'Неприемлемый контент': 'Unacceptable content',
  'Угрозы или насилие': 'Threats or violence',
  Другое: 'Other',
  'язык общения': 'language',
  'город, регион или страна': 'city, region or country',
  возраст: 'age',
  пол: 'gender',
  'Жалоба на пользователя': 'Complaint about a user',
  Предложение: 'Suggestion',
  'Ошибка в работе': 'Bug',
  Реклама: 'Advertising',
  Сотрудничество: 'Partnership',

  // --- chips built from a profile or filters ----------------------------
  'Пол: {value}': 'Gender: {value}',
  'Возраст: {value}': 'Age: {value}',
  'Место: {value}': 'Place: {value}',
  'Страны: {value}': 'Countries: {value}',
  'Языки: {value}': 'Languages: {value}',
  'Города: {value}': 'Cities: {value}',
  'Регионы: {value}': 'Regions: {value}',
  'Возраст: {min}–{max}': 'Age: {min}–{max}',
  'Возраст: от {min}': 'Age: from {min}',
  'Возраст: до {max}': 'Age: up to {max}',
  'снят фильтр {name}': 'filter {name} relaxed',
  'сняты фильтры {list}': 'filters {list} relaxed',
  '{seconds} с': '{seconds} s',

  // --- module-level messages (socket, store, fetch) ---------------------
  '{alias} потерял соединение. Ждём восстановления…':
    '{alias} lost the connection. Waiting for them to return…',
  '{alias} снова на связи.': '{alias} is back online.',
  '{alias} хочет начать чат.': '{alias} wants to start a chat.',
  'Ищем шире: {criteria}.': 'Searching wider: {criteria}.',
  'Чат не найден.': 'Chat not found.',
  'Вы получили новый User ID. Прошлый больше не действует.':
    'You have a new User ID. The previous one no longer works.',
  'Сервер закрыл соединение. Нажмите «Повторить».':
    'The server closed the connection. Press “Retry”.',
  'Соединение потеряно. Восстанавливаем…': 'Connection lost. Reconnecting…',
  'Не удаётся подключиться. Повторяем…': 'Cannot connect. Retrying…',
  'Не удалось восстановить соединение. Нажмите «Повторить».':
    'Could not restore the connection. Press “Retry”.',
  'Пользователь заблокирован.': 'The user has been blocked.',
  'Версия приложения устарела. Обновите страницу (Ctrl+F5).':
    'The app version is out of date. Reload the page (Ctrl+F5).',
  'Соединение с сервером прервалось, чат закрыт. Найдите собеседника заново.':
    'The connection to the server was interrupted and the chat was closed. Find someone again.',
  'Анонимная сессия не найдена. Нажмите «Повторить», чтобы начать заново.':
    'No anonymous session was found. Press “Retry” to start again.',
  'Нет соединения с сервером.': 'No connection to the server.',
  'Сервер не ответил. Попробуйте ещё раз.': 'The server did not answer. Try again.',
  'Превышено время ожидания ответа сервера.': 'The server took too long to answer.',
  'Не удаётся связаться с сервером. Проверьте, что API запущен, и попробуйте снова.':
    'Cannot reach the server. Check that the API is running and try again.',
  Друзья: 'Friends',
  'Список друзей': 'Friends list',
  'Обновить список друзей': 'Refresh friends list',
  'Друзья сохраняются, пока вы сами не удалите контакт.':
    'Friends stay in your list until you remove them.',
  'Загружаем друзей…': 'Loading friends…',
  Написать: 'Write',
  Удалить: 'Remove',
  'Вы уже друзья.': 'You are already friends.',
  'Заявка в друзья больше не существует.': 'This friend request no longer exists.',
  'У вас пока нет друзей. Добавить в друзья можно во время чата — по обоюдному согласию.':
    'You have no friends yet. You can add a friend during a chat — if both sides agree.',
  'Добавлен: {date}': 'Added: {date}',
  'В друзья': 'Add friend',
  'Вы друзья': 'You are friends',
  'Запрос отправлен': 'Request sent',
  'Заявка в друзья': 'Friend request',
  'Заявка отклонена': 'Request declined',
  'Время истекло': 'Time is up',
  Недоступно: 'Unavailable',
  'Запрос в друзья отправлен.': 'Friend request sent.',
  'Теперь вы друзья.': 'You are now friends.',
  '{alias} хочет добавить вас в друзья.': '{alias} wants to add you as a friend.',
  '{alias} ждёт ответа на заявку в друзья.':
    '{alias} is waiting for an answer to a friend request.',
  'Собеседник отклонил заявку в друзья.': 'The other person declined the friend request.',
  'Время заявки в друзья истекло.': 'The friend request has expired.',
  'Сейчас нельзя добавить этого собеседника в друзья.':
    'This person cannot be added as a friend right now.',
  'Контакт удалён из списка друзей.': 'The contact was removed from your friends.',
  'Добавить {alias} в друзья?': 'Add {alias} as a friend?',
  'Собеседник предлагает стать друзьями. Это взаимно: вы увидите User ID друг друга и сможете писать друг другу в любое время.':
    'The other person suggests becoming friends. It is mutual: you will see each other’s User ID and can write to each other at any time.',
  'Удалить контакт?': 'Remove contact?',
  'Вы больше не увидите этот User ID в списке друзей. Если вы снова встретитесь в чате, сможете добавить друг друга заново.':
    'You will no longer see this User ID in your friends. If you meet in a chat again, you can add each other again.',
  'Удалить {id} из друзей': 'Remove {id} from friends',
  Закрыть: 'Close',
} as const;

export type MessageKey = keyof typeof en;

/**
 * Chinese, typed against the English key set.
 *
 * Native language names (`Русский`, `English`, `中文`) never appear here: the
 * language switch is not translated.
 */
export const zh: Record<MessageKey, string> = {
  'Перейти к основному содержимому': '跳至主要内容',
  'Интерфейс дал сбой': '界面出错了',
  'Это ошибка на нашей стороне. Ваш User ID и текущие чаты не потеряны.':
    '这是我们这边的错误。您的 User ID 和当前聊天不会丢失。',
  'Попробовать снова': '重试',
  'Анонимный чат с незнакомцами': '与陌生人的匿名聊天',
  'Связаться с администрацией': '联系管理员',
  'Включить светлую тему': '切换到浅色主题',
  'Включить тёмную тему': '切换到深色主题',
  'Светлая тема': '浅色主题',
  'Тёмная тема': '深色主题',
  'Язык интерфейса': '界面语言',
  'Запуск…': '正在启动…',
  'Подключение…': '正在连接…',
  'На связи': '已连接',
  'Переподключение…': '正在重新连接…',
  'Нет связи': '无连接',
  'Доступ закрыт': '访问被拒绝',
  'Сервер работает по другой версии протокола. Обновите страницу — иначе сообщения могут теряться.':
    '服务器使用的协议版本不同。请刷新页面，否则消息可能会丢失。',
  'Нет связи с сервером': '无法连接服务器',
  'Не удалось получить анонимную сессию.': '未能创建匿名会话。',
  Повторить: '重试',
  'Если не помогает: проверьте, что API-сервер запущен, и что браузер не блокирует cookie для этого сайта — без cookie анонимная сессия невозможна.':
    '如果仍无法解决，请检查 API 服务器是否已启动，以及浏览器是否阻止了本站的 Cookie——没有 Cookie 就无法建立匿名会话。',
  'Получаем ваш User ID': '正在获取您的 User ID',
  'Ваш User ID': '您的 User ID',
  Скопировано: '已复制',
  'Нажмите на него, чтобы скопировать': '点击即可复制',
  'Браузер не разрешил копирование. Выделите ID и скопируйте вручную.':
    '浏览器不允许复制。请选中 ID 后手动复制。',
  'Скопировать User ID': '复制 User ID',
  'Получить новый User ID': '获取新的 User ID',
  'Получить новый User ID?': '获取新的 User ID？',
  'Текущий ID перестанет работать сразу же, и все ваши открытые сессии будут закрыты. Прошлый ID восстановить нельзя.':
    '当前 ID 会立即失效，您所有已打开的会话都会被关闭。旧 ID 无法恢复。',
  'Ваш User ID — не пароль: по нему можно только предложить вам чат, если заявки разрешены.':
    '您的 User ID 不是密码：只有在您允许请求时，别人才能用它向您发起聊天。',
  Отмена: '取消',
  'Меняем…': '正在更换…',
  'Да, получить новый': '是，获取新的',
  'Чат по User ID': '通过 User ID 聊天',
  'User ID собеседника': '对方的 User ID',
  'Вставьте сюда ID собеседника': '在此粘贴对方的 ID',
  Найти: '查找',
  'Неверный формат. User ID состоит из 14 символов и начинается с AL.':
    '格式错误。User ID 由 14 个字符组成，并以 AL 开头。',
  'Это ваш собственный User ID.': '这是您自己的 User ID。',
  'Проверяем…': '正在检查…',
  'Пользователь с таким ID не найден. Проверьте, нет ли опечатки.':
    '找不到使用该 ID 的用户。请检查是否有输入错误。',
  'Пользователь найден и принимает заявки.': '已找到用户，对方接受请求。',
  'Отправить заявку': '发送请求',
  'В отличие от случайного чата, получатель увидит ваш User ID — иначе он не поймёт, кто с ним хочет поговорить.':
    '与随机聊天不同，对方会看到您的 User ID——否则对方无法知道是谁想聊天。',
  'Пользователь найден, но он отключил входящие заявки.': '已找到用户，但对方关闭了聊天请求。',
  'Заявка отправлена. Ждём ответа.': '请求已发送，正在等待回复。',
  'Истекает через:': '剩余时间：',
  'Ищем собеседника…': '正在寻找聊天对象…',
  'Время ожидания': '等待时间',
  'Отменить поиск': '取消搜索',
  'Ищем по фильтрам': '按筛选条件搜索',
  'Без фильтров — подойдёт любой собеседник.': '没有筛选条件——任何人都可以匹配。',
  'Уже снято: {criteria}': '已放宽：{criteria}',
  'Если никто не найдётся, сервер начнёт снимать фильтры по одному и каждый раз сообщит, какой именно.':
    '如果没有人出现，服务器会逐个放宽筛选条件，并每次说明放宽了哪一项。',
  'До первого шага:': '距离第一步：',
  'Можно не ждать здесь — поиск продолжится, а чат откроется автоматически.':
    '您可以离开此页面——搜索会继续，聊天会自动打开。',
  'Начинаем…': '正在开始…',
  'Найти собеседника': '寻找聊天对象',
  'Фильтры поиска': '搜索筛选',
  Настройки: '设置',
  'Добавить язык': '添加语言',
  'Не выбрано ни одного.': '尚未选择任何一项。',
  'Добавить язык…': '添加语言…',
  'Убрать {value}': '移除 {value}',
  Добавить: '添加',
  'Не больше {count} названий в одном списке.': '每个列表最多 {count} 个名称。',
  'Нижняя граница возраста больше верхней — так не найдётся никто.':
    '年龄下限大于上限——这样不会匹配到任何人。',
  'Проверьте значения: сервер отклонит такие данные.': '请检查输入值：服务器会拒绝这样的数据。',
  'Данные о себе сохранены.': '您的资料已保存。',
  'Возраст указывается целым числом от 1 до {max}.': '年龄必须是 1 到 {max} 之间的整数。',
  'О вас': '关于您',
  'Эти данные указываете вы сами, проверить их нечем. Они нужны только подбору — собеседник их не видит.':
    '这些资料由您自己填写，无法核实。它们只用于匹配——对方看不到。',
  'Ваш пол': '您的性别',
  Возраст: '年龄',
  'Например, 25': '例如 25',
  Страна: '国家',
  'Не указана': '未指定',
  Город: '城市',
  Регион: '地区',
  'Начните вводить': '开始输入',
  'Языки, на которых вам удобно общаться': '您方便交流的语言',
  'Сохранить данные': '保存资料',
  'Фильтры поиска сохранены.': '搜索筛选已保存。',
  'Кого искать': '寻找谁',
  'Подбор идёт только между теми, кто подходит друг другу: ваши фильтры и фильтры собеседника действуют одновременно.':
    '只有彼此合适的人才会匹配：您的筛选条件和对方的筛选条件同时生效。',
  'Пол собеседника': '对方的性别',
  Любой: '任意',
  'Возраст собеседника': '对方的年龄',
  'Минимальный возраст': '最小年龄',
  'Максимальный возраст': '最大年龄',
  от: '从',
  до: '到',
  'Где искать': '在哪里搜索',
  'Подойдёт любая страна, город и регион.': '任何国家、城市和地区都可以。',
  'Подойдёт любой из перечисленных.': '列表中任意一个都可以。',
  Страны: '国家',
  'Добавить страну': '添加国家',
  'Добавить страну…': '添加国家…',
  'Не выбрана ни одна страна.': '尚未选择国家。',
  Города: '城市',
  'Добавить город': '添加城市',
  'Начните вводить название': '开始输入名称',
  'Не выбран ни один город.': '尚未选择城市。',
  Регионы: '地区',
  'Добавить регион': '添加地区',
  'Не выбран ни один регион.': '尚未选择地区。',
  'Общий язык': '共同语言',
  'Если подходящего собеседника долго нет': '如果很久没有合适的聊天对象',
  'Снимать фильтры по одному': '逐个放宽筛选条件',
  Разрешено: '允许',
  Запрещено: '禁止',
  'Снятие никогда не происходит молча: сервер сообщит, какой фильтр снят.':
    '放宽筛选绝不会悄悄进行：服务器会说明取消了哪项筛选。',
  'Будет применяться': '将应用',
  'Сохранить фильтры': '保存筛选',
  'Принимать заявки': '接受请求',
  'Любой, кто знает ваш User ID, может предложить чат.':
    '任何知道您 User ID 的人都可以向您发起聊天。',
  'Не принимать заявки': '不接受请求',
  'Вас можно найти, но предложить чат нельзя. Случайный поиск работает как обычно.':
    '别人仍然可以找到您，但不能向您发起聊天。随机搜索照常工作。',
  Модерация: '审核',
  'Входящие заявки': '收到的请求',
  Заблокированные: '已屏蔽',
  'Список заблокированных': '已屏蔽列表',
  'Обновить список заблокированных': '刷新已屏蔽列表',
  'Загрузка списка': '正在加载列表',
  'Список пуст.': '列表为空。',
  Разблокировать: '解除屏蔽',
  'Загружаем настройки': '正在加载设置',
  случайный: '随机',
  'по User ID': '通过 User ID',
  'собеседник отключился': '对方已离线',
  Блокировать: '屏蔽',
  Жалоба: '举报',
  Следующий: '下一位',
  Завершить: '结束',
  Переписка: '对话',
  'Напишите первое сообщение.': '写下第一条消息。',
  'Найти нового собеседника': '寻找新的聊天对象',
  'Написать снова': '再次发送消息',
  Готово: '完成',
  Сообщение: '消息',
  'Введите сообщение…': '输入消息…',
  Отправить: '发送',
  'Только текст. Enter — отправить, Shift+Enter — новая строка.':
    '仅支持文本。Enter 发送，Shift+Enter 换行。',
  'Сообщение слишком длинное — сократите его на {count} симв.': '消息太长——请缩短 {count} 个字符。',
  отправляется: '发送中',
  'не отправлено': '未发送',
  'не отправлено: {reason}': '未发送：{reason}',
  'Открываем чат…': '正在打开聊天…',
  'Заблокировать собеседника?': '屏蔽这位聊天对象？',
  Заблокировать: '屏蔽',
  'Чат завершится сразу. Вы больше не будете попадаться друг другу при случайном поиске, и этот собеседник не сможет написать вам по User ID.':
    '聊天会立即结束。你们不会再在随机搜索中相遇，对方也无法通过 User ID 给您发消息。',
  'Случайные собеседники не видят ваш User ID, но блокировка всё равно их запоминает — на случай, если вы встретитесь снова. Список блокировок можно посмотреть внизу главной страницы.':
    '随机聊天对象看不到您的 User ID，但屏蔽仍会记住对方，以防你们再次相遇。屏蔽列表位于主页底部。',
  'Пожаловаться на собеседника': '举报聊天对象',
  'Чат будет сразу завершён. Ваш User ID не сообщается собеседнику.':
    '聊天会立即结束。您的 User ID 不会告知对方。',
  Причина: '原因',
  Подробности: '详情',
  '(необязательно)': '（可选）',
  'Что именно произошло?': '具体发生了什么？',
  'Вместе с жалобой сохраняется текст последнего сообщения — это то, что проверяет модерация.':
    '举报时会保存最后一条消息的文本——这是审核人员会查看的内容。',
  'Отправить жалобу': '发送举报',
  'На вас поступила жалоба': '有人举报了您',
  'На вас поступила жалоба.': '有人举报了您。',
  'Администрация рассмотрит её. Если будут выявлены нарушения правил, ваш доступ могут закрыть — вплоть до бана.':
    '管理员会进行审核。如果发现违反规则，您的访问权限可能被关闭，直至封禁。',
  'Жалоба уже зарегистрирована. Отвечать на неё здесь не нужно.':
    '举报已经登记。您无需在这里回复。',
  Понятно: '明白了',
  'Выберите тему, чтобы сообщение попало по адресу.': '请选择主题，以便消息发送到正确的位置。',
  'Тема обращения': '主题',
  'Текст сообщения': '消息内容',
  'Опишите подробнее, чем помочь.': '请详细说明需要什么帮助。',
  'Как с вами связаться': '如何联系您',
  'Ссылка, ник или адрес — если хотите ответ': '链接、昵称或地址——如果您希望收到回复',
  'Сообщение сохраняется, чтобы администрация могла его прочитать и ответить, и удаляется автоматически по истечении срока хранения. Ваш User ID видит только администрация.':
    '消息会被保存，以便管理员阅读并回复，并会在保存期限结束后自动删除。只有管理员能看到您的 User ID。',
  'Отправить администрации': '发送给管理员',
  'Сообщение отправлено администрации.': '消息已发送给管理员。',
  'Хотят начать с вами чат': '有人想和您聊天',
  'Человек нашёл вас по вашему User ID. Он не узнает, примете вы или нет, — увидит только результат.':
    '这个人通过您的 User ID 找到了您。对方不会知道您是否接受，只会看到结果。',
  'Без сообщения.': '没有留言。',
  'Время заявки истекло.': '请求已过期。',
  'Заявка ждёт ответа.': '请求正在等待回复。',
  'Ещё заявок в очереди: {count}.': '还有 {count} 个请求在排队。',
  Отклонить: '拒绝',
  Принять: '接受',
  'Закрыть уведомление': '关闭通知',
  'Некорректные данные. Проверьте ввод.': '数据无效。请检查输入。',
  'Нужна анонимная сессия. Обновите страницу.': '需要匿名会话。请刷新页面。',
  'Сессия больше не действительна. Обновите страницу.': '会话已失效。请刷新页面。',
  'Эта анонимная личность заблокирована.': '这个匿名身份已被封禁。',
  'Пользователь с таким User ID не найден.': '找不到使用该 User ID 的用户。',
  'Этот пользователь сейчас недоступен.': '该用户目前不可用。',
  'Нельзя написать самому себе.': '不能给自己发消息。',
  'Вы уже в чате.': '您已经在聊天中。',
  'Этот чат больше не существует.': '该聊天已不存在。',
  'Вы не участник этого чата.': '您不是这个聊天的参与者。',
  'Чат завершён.': '聊天已结束。',
  'Сообщение слишком длинное.': '消息太长。',
  'Сообщение пустое.': '消息为空。',
  'Слишком много запросов. Подождите немного.': '请求过多。请稍等。',
  'Слишком много открытых вкладок для этой личности.': '这个身份打开的标签页过多。',
  'Заявка больше не существует.': '请求已不存在。',
  'Заявка отклонена.': '请求已被拒绝。',
  'Этот пользователь не принимает заявки.': '该用户不接受请求。',
  'Общение с этим пользователем невозможно.': '无法与该用户交流。',
  'Блокировка сейчас отключена администрацией.': '管理员目前已关闭屏蔽功能。',
  'Эта жалоба больше не существует.': '该举报已不存在。',
  'Неподдерживаемое событие. Обновите страницу.': '不支持的事件。请刷新页面。',
  'Неверный ключ владельца.': '所有者密钥错误。',
  'Этот источник не может подключиться.': '该来源无法连接。',
  'Такого адреса на сервере нет. Обновите страницу.': '服务器上没有该地址。请刷新页面。',
  'Запрос слишком большой.': '请求过大。',
  'Что-то пошло не так. Попробуйте ещё раз.': '出了点问题。请重试。',
  'Сервис временно недоступен.': '服务暂时不可用。',
  'Вы завершили чат.': '您结束了聊天。',
  'Собеседник завершил чат.': '对方结束了聊天。',
  'Собеседник отключился и не вернулся.': '对方离线后没有回来。',
  'Вы заблокировали собеседника. Чат завершён.': '您屏蔽了对方。聊天已结束。',
  'Жалоба отправлена. Чат завершён.': '举报已发送。聊天已结束。',
  'Сервис был перезапущен, поэтому чат завершён.': '服务已重启，因此聊天结束。',
  'Чат завершён по истечении времени.': '聊天因超时结束。',
  'Заявка принята — чат начался.': '请求已接受——聊天已开始。',
  'Заявка отменена.': '请求已取消。',
  'Пользователь не принимает заявки.': '该用户不接受请求。',
  'Заявка обработана.': '请求已处理。',
  'Пользователь сейчас недоступен.': '该用户目前不可用。',
  'Поиск отменён.': '搜索已取消。',
  'Поиск остановлен: слишком долго никто не находился.': '搜索已停止：很长时间没有找到人。',
  'Собеседник найден.': '已找到聊天对象。',
  'Поиск остановлен.': '搜索已停止。',
  Женский: '女性',
  Мужской: '男性',
  'Спам или реклама': '垃圾信息或广告',
  'Оскорбления или травля': '侮辱或骚扰',
  'Неприемлемый контент': '不可接受的内容',
  'Угрозы или насилие': '威胁或暴力',
  Другое: '其他',
  'язык общения': '语言',
  'город, регион или страна': '城市、地区或国家',
  возраст: '年龄',
  пол: '性别',
  'Жалоба на пользователя': '投诉',
  Предложение: '建议',
  'Ошибка в работе': '故障',
  Реклама: '广告',
  Сотрудничество: '合作',
  'Пол: {value}': '性别：{value}',
  'Возраст: {value}': '年龄：{value}',
  'Место: {value}': '地点：{value}',
  'Страны: {value}': '国家：{value}',
  'Языки: {value}': '语言：{value}',
  'Города: {value}': '城市：{value}',
  'Регионы: {value}': '地区：{value}',
  'Возраст: {min}–{max}': '年龄：{min}–{max}',
  'Возраст: от {min}': '年龄：{min} 起',
  'Возраст: до {max}': '年龄：不超过 {max}',
  'снят фильтр {name}': '已放宽筛选：{name}',
  'сняты фильтры {list}': '已放宽筛选：{list}',
  '{seconds} с': '{seconds} 秒',
  '{alias} потерял соединение. Ждём восстановления…': '{alias} 断开了连接。正在等待恢复…',
  '{alias} снова на связи.': '{alias} 已重新上线。',
  '{alias} хочет начать чат.': '{alias} 想开始聊天。',
  'Ищем шире: {criteria}.': '正在扩大搜索范围：{criteria}。',
  'Чат не найден.': '找不到聊天。',
  'Вы получили новый User ID. Прошлый больше не действует.':
    '您已获得新的 User ID。之前的 ID 已失效。',
  'Сервер закрыл соединение. Нажмите «Повторить».': '服务器关闭了连接。请点击“重试”。',
  'Соединение потеряно. Восстанавливаем…': '连接已断开。正在恢复…',
  'Не удаётся подключиться. Повторяем…': '无法连接。正在重试…',
  'Не удалось восстановить соединение. Нажмите «Повторить».': '未能恢复连接。请点击“重试”。',
  'Пользователь заблокирован.': '用户已被屏蔽。',
  'Версия приложения устарела. Обновите страницу (Ctrl+F5).':
    '应用版本已过期。请刷新页面（Ctrl+F5）。',
  'Соединение с сервером прервалось, чат закрыт. Найдите собеседника заново.':
    '与服务器的连接中断，聊天已关闭。请重新寻找聊天对象。',
  'Анонимная сессия не найдена. Нажмите «Повторить», чтобы начать заново.':
    '找不到匿名会话。请点击“重试”重新开始。',
  'Нет соединения с сервером.': '无法连接服务器。',
  'Сервер не ответил. Попробуйте ещё раз.': '服务器没有响应。请重试。',
  'Превышено время ожидания ответа сервера.': '等待服务器响应超时。',
  'Не удаётся связаться с сервером. Проверьте, что API запущен, и попробуйте снова.':
    '无法连接服务器。请检查 API 是否已启动，然后重试。',
  Друзья: '好友',
  'Список друзей': '好友列表',
  'Обновить список друзей': '刷新好友列表',
  'Друзья сохраняются, пока вы сами не удалите контакт.': '好友会一直保留，直到您将其删除。',
  'Загружаем друзей…': '正在加载好友…',
  Написать: '发消息',
  Удалить: '删除',
  'Вы уже друзья.': '你们已经是好友了。',
  'Заявка в друзья больше не существует.': '好友请求已不存在。',
  'У вас пока нет друзей. Добавить в друзья можно во время чата — по обоюдному согласию.':
    '您还没有好友。在聊天中双方同意即可添加好友。',
  'Добавлен: {date}': '添加于：{date}',
  'В друзья': '加好友',
  'Вы друзья': '你们是好友',
  'Запрос отправлен': '请求已发送',
  'Заявка в друзья': '好友请求',
  'Заявка отклонена': '请求已拒绝',
  'Время истекло': '时间已到',
  Недоступно: '不可用',
  'Запрос в друзья отправлен.': '好友请求已发送。',
  'Теперь вы друзья.': '你们现在是好友了。',
  '{alias} хочет добавить вас в друзья.': '{alias} 想将您加为好友。',
  '{alias} ждёт ответа на заявку в друзья.': '{alias} 正在等待好友请求的答复。',
  'Собеседник отклонил заявку в друзья.': '对方拒绝了好友请求。',
  'Время заявки в друзья истекло.': '好友请求已过期。',
  'Сейчас нельзя добавить этого собеседника в друзья.': '目前无法将这位聊天对象加为好友。',
  'Контакт удалён из списка друзей.': '联系人已从好友列表中删除。',
  'Добавить {alias} в друзья?': '将 {alias} 加为好友？',
  'Собеседник предлагает стать друзьями. Это взаимно: вы увидите User ID друг друга и сможете писать друг другу в любое время.':
    '对方提议成为好友。这是双向的：你们会看到彼此的 User ID，并可以随时互相写信。',
  'Удалить контакт?': '删除联系人？',
  'Вы больше не увидите этот User ID в списке друзей. Если вы снова встретитесь в чате, сможете добавить друг друга заново.':
    '您将不会再在好友列表中看到这个 User ID。如果以后在聊天中再次相遇，可以重新添加对方。',
  'Удалить {id} из друзей': '将 {id} 从好友中删除',
  Закрыть: '关闭',
};

/**
 * Russian is the key set itself: one source of truth, no second copy to update.
 */
export const ru: Record<MessageKey, string> = Object.fromEntries(
  (Object.keys(en) as MessageKey[]).map((key) => [key, key]),
) as Record<MessageKey, string>;

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { ru, en, zh };

/**
 * Placeholders must survive translation.
 *
 * A translator who drops `{count}` produces a sentence that silently loses a
 * number; TypeScript cannot see it. The check runs once at module load (both on
 * the server and in the browser) and throws with the offending key, so a broken
 * dictionary is caught by `pnpm build`/`pnpm test:e2e` rather than by a user.
 */
function placeholders(template: string): string {
  return [...template.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');
}

for (const key of Object.keys(en) as MessageKey[]) {
  if (placeholders(key) !== placeholders(en[key])) {
    throw new Error(`i18n: English translation of "${key}" changes its placeholders`);
  }

  if (placeholders(key) !== placeholders(zh[key])) {
    throw new Error(`i18n: Chinese translation of "${key}" changes its placeholders`);
  }
}

export function translate(
  locale: Locale,
  key: MessageKey,
  values?: Record<string, string | number>,
): string {
  const template = MESSAGES[locale][key] ?? key;
  if (!values) return template;

  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}
