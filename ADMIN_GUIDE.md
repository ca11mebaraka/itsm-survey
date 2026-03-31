# Руководство администратора — ITSM Survey Tool

## Кто читает этот документ

IT-администратор или технический специалист, который:
- Разворачивает инструмент в организации
- Обновляет опросник при изменении стандарта
- Помогает пользователям при технических проблемах
- Обрабатывает данные обследования

---

## Раздел 1. Варианты развёртывания

Инструмент существует в двух вариантах:

| Вариант | Где работает | Когда использовать |
|---------|-------------|-------------------|
| **GitHub Pages** | Браузер, онлайн | Основной. Не требует установки серверов |
| **Локальный Flask** | Windows/Linux, офлайн | Если нет интернета или нужен контроль данных |

---

## Раздел 2. GitHub Pages (онлайн-версия)

### 2.1 Как это работает

```
Пользователь открывает браузер
          ↓
https://ca11mebaraka.github.io/itsm-survey/
          ↓
GitHub CDN отдаёт: index.html, style.css, app.js, questions.json
          ↓
Браузер загружает sql.js (SQLite → WebAssembly) с CDN
          ↓
Вся логика работает в браузере
          ↓
Данные → только файл .db на компьютере пользователя
```

Нет сервера, нет базы данных на сервере, нет регистрации.

### 2.2 Системные требования (для пользователя)

| Компонент | Требование |
|-----------|-----------|
| Браузер | Chrome 90+, Firefox 88+, Edge 90+, Safari 15+ |
| Интернет | Нужен для первой загрузки страницы (~2 МБ) |
| Хранилище | Места на диске: примерно 1 МБ на 1000 ответов |
| ОС | Windows, macOS, Linux, Android (ограниченно) |

### 2.3 Обновление инструмента на GitHub Pages

При изменении кода или опросника:

```bash
# Клонировать репозиторий (один раз)
git clone https://github.com/ca11mebaraka/itsm-survey.git
cd itsm-survey

# Внести изменения, затем:
git add -A
git commit -m "Обновление опросника"
git push origin main
```

GitHub Pages автоматически обновит сайт за 1–3 минуты.

### 2.4 Настройка GitHub Pages

1. Откройте репозиторий на GitHub
2. Перейдите **Settings → Pages**
3. Source: **Deploy from a branch**
4. Branch: **main**, Folder: **/docs**
5. Нажмите **Save**

Сайт будет доступен по адресу: `https://ca11mebaraka.github.io/itsm-survey/`

---

## Раздел 3. Локальный Flask-сервер

Используйте этот вариант, если:
- Нет доступа в интернет
- Данные нельзя покидать периметр сети
- Нужна работа с большим количеством пользователей через LAN

### 3.1 Установка

**Требования:** Python 3.10 или новее

```bash
# Проверить версию Python
python --version

# Скачать репозиторий
git clone https://github.com/ca11mebaraka/itsm-survey.git
cd itsm-survey

# Установить зависимости
pip install -r requirements.txt
```

### 3.2 Подготовка опросника

Поместите файл `oprosnik.csv` в одно из мест:
```
itsm-survey/
├── oprosnik.csv          ← здесь (приоритет)
├── data/
│   └── oprosnik.csv      ← или здесь
└── main.py
```

> Файл CSV должен быть в кодировке **CP1251**, разделитель — **точка с запятой (;)**.

### 3.3 Запуск

```bash
python main.py
```

Программа:
1. Инициализирует базу данных `survey_data.db`
2. Автоматически импортирует вопросы из CSV
3. Открывает браузер на `http://localhost:5000`

Лог запуска:
```
[OK] Импортировано 383 вопроса из C:\...\oprosnik.csv
[*]  ITSM Survey Tool -> http://localhost:5000
```

### 3.4 Доступ по сети (LAN)

Чтобы другие пользователи в сети могли подключиться:

```python
# В файле main.py измените последнюю строку:
app.run(debug=False, port=5000, host="0.0.0.0")  # уже так
```

Пользователи открывают: `http://[IP-адрес-компьютера]:5000`

Узнать IP-адрес: `ipconfig` (Windows) или `ip addr` (Linux)

> **Внимание:** Все пользователи работают с одной общей базой данных.
> Для разделения работы — создавайте отдельные сессии для каждого аналитика.

### 3.5 Структура базы данных (Flask-версия)

Файл `survey_data.db` — стандартная SQLite база:

```
survey_data.db
├── questions   — 383 вопроса (импортируются из CSV)
├── sessions    — сессии обследования
├── answers     — ответы аналитиков
└── app_state   — состояние интерфейса
```

**Расположение:** рядом с файлом `main.py`.

### 3.6 Резервное копирование (Flask-версия)

```bash
# Простое копирование файла БД
copy survey_data.db backup\survey_data_2026-03-31.db
```

Рекомендуется автоматизировать через Task Scheduler (Windows) или cron (Linux).

---

## Раздел 4. Управление файлами .db (GitHub Pages версия)

### 4.1 Структура файла .db

Файл `.db`, который скачивает пользователь, содержит:

```
sessions  — список сессий
answers   — ответы с временными метками
app_state — последняя позиция
```

> Вопросы в файл НЕ сохраняются — они загружаются из `questions.json` при каждом открытии.
> Это уменьшает размер файла примерно в 10 раз.

### 4.2 Просмотр данных через DB Browser for SQLite

1. Скачайте [DB Browser for SQLite](https://sqlitebrowser.org/) (бесплатно)
2. File → Open Database → выберите `.db` файл
3. Вкладка **Browse Data** → выберите таблицу `answers`

### 4.3 Объединение нескольких .db файлов

Если несколько аналитиков работали с разными файлами, объедините их:

```python
import sqlite3

# Главный файл (куда копируем)
main_db = sqlite3.connect("main.db")

# Файл для объединения
src_db = sqlite3.connect("analyst2.db")

# Скопировать ответы (пример: перенести сессию с id=1 как новую)
answers = src_db.execute("SELECT * FROM answers WHERE session_id=1").fetchall()
# ... вставить в main_db с новым session_id
```

Для регулярного использования попросите разработчика создать скрипт слияния.

### 4.4 Анализ данных через Python/pandas

```python
import sqlite3, pandas as pd

# Открыть файл пользователя
conn = sqlite3.connect("itsm_survey_ООО_Ромашка.db")

# Получить все ответы
answers = pd.read_sql("SELECT * FROM answers", conn)
print(answers.shape)

# Сводная таблица по статусам
pivot = answers.groupby("compliance")["id"].count()
print(pivot)

conn.close()
```

---

## Раздел 5. Обновление опросника

### 5.1 Обновить вопросы (GitHub Pages версия)

1. Подготовьте новый `oprosnik.csv` (CP1251, разделитель `;`)
2. Сгенерируйте `questions.json`:
   ```bash
   # В папке репозитория
   python -c "
   import json, csv
   questions = []
   with open('oprosnik.csv', encoding='cp1251') as f:
       reader = csv.reader(f, delimiter=';')
       next(reader)  # пропустить заголовок
       for row in reader:
           if len(row) >= 13 and row[0].startswith('DTN-'):
               questions.append({
                   'id': row[0].strip(),
                   'gost_code': row[1].strip(),
                   'title_short': row[2].strip(),
                   'description': row[3].strip(),
                   'process_group': row[4].strip(),
                   'standard_ref': row[5].strip(),
                   'priority': row[6].strip(),
                   'weight': row[7].strip(),
                   'mandatory': row[8].strip(),
                   'management_area': row[9].strip(),
                   'process_name': row[10].strip(),
                   'process_code': row[0].split('-')[2] if len(row[0].split('-')) >= 4 else 'UNK',
                   'question_number': int(row[11].strip()) if row[11].strip().isdigit() else 0,
                   'question_text': row[12].strip(),
                   'answer_hint': row[13].strip() if len(row) > 13 else '',
                   'expected_evidence': row[14].strip() if len(row) > 14 else '',
               })
   with open('docs/questions.json', 'w', encoding='utf-8') as f:
       json.dump(questions, f, ensure_ascii=False, separators=(',', ':'))
   print(f'Экспортировано: {len(questions)} вопросов')
   "
   ```
3. Запушьте изменения:
   ```bash
   git add docs/questions.json
   git commit -m "Обновление опросника"
   git push
   ```

> **Внимание:** Старые `.db` файлы пользователей по-прежнему будут работать — ответы привязаны к `question_id` (строка вида `DTN-ITSM-INC-01`). Если ID вопросов изменились — свяжите старые ответы с новыми вопросами через скрипт миграции.

### 5.2 Обновить вопросы (Flask версия)

```bash
# Заменить файл CSV
copy new_oprosnik.csv oprosnik.csv

# Удалить старую базу данных (или только таблицу questions)
del survey_data.db

# Перезапустить сервер — вопросы импортируются заново
python main.py
```

> **Внимание:** Удаление `survey_data.db` уничтожает ВСЕ ответы. Сделайте резервную копию перед обновлением.

---

## Раздел 6. Диагностика проблем

### «Страница не загружается»
- Проверьте соединение с интернетом
- Проверьте адрес: `https://ca11mebaraka.github.io/itsm-survey/`
- Попробуйте другой браузер или режим инкогнито
- Проверьте статус GitHub Pages: Settings → Pages

### «Файл .db не загружается / ошибка»
- Убедитесь что файл не повреждён: откройте в DB Browser for SQLite
- Убедитесь что расширение файла `.db` (не `.db.txt` и т.п.)
- Проверьте что файл создан именно этим инструментом

### «Данные пропали после закрытия браузера»
- Если файл `.db` был скачан — загрузите его через «Продолжить»
- Если файл не скачивался — данные восстановить невозможно
- Объясните пользователям правило: «Ответил 10 вопросов — скачай файл»

### «Flask не запускается»
```bash
# Проверить версию Python
python --version   # должно быть 3.10+

# Проверить Flask
python -c "import flask; print('OK')"

# Переустановить
pip install flask --upgrade
```

### «Вопросы не импортируются (Flask)»
```bash
# Проверить кодировку файла
python -c "
with open('oprosnik.csv', 'rb') as f:
    head = f.read(100)
print(head)
"
# Если видно кириллицу — файл в нужной кодировке CP1251
```

---

## Раздел 7. Безопасность и конфиденциальность

### GitHub Pages версия
- Никакие данные **не передаются** на серверы GitHub
- Весь SQL выполняется **в браузере** пользователя
- Файл `.db` остаётся **только на компьютере** пользователя
- GitHub видит только запросы к статическим файлам (без данных)

### Flask версия (локальная)
- База данных `survey_data.db` хранится **на сервере**
- Ограничьте доступ к порту 5000 через фаервол
- Не выставляйте сервер в публичный интернет без аутентификации
- Регулярно делайте резервные копии БД

### Рекомендации по хранению файлов .db
- Храните в корпоративном облаке или зашифрованном диске
- Ограничьте доступ к файлу — он содержит результаты обследования
- Не передавайте файл по незащищённым каналам (открытый email, мессенджеры)

---

## Раздел 8. Структура репозитория

```
itsm-survey/
├── docs/                   ← GitHub Pages (онлайн-версия)
│   ├── index.html          ← Главная страница
│   ├── style.css           ← Стили
│   ├── app.js              ← Логика (sql.js, без сервера)
│   └── questions.json      ← 383 вопроса (генерируется из CSV)
│
├── static/                 ← Flask-версия: статика
│   ├── index.html
│   ├── style.css
│   └── app.js              ← Логика (вызовы Flask API)
│
├── main.py                 ← Flask-сервер + REST API
├── database.py             ← Инициализация SQLite
├── importer.py             ← Импорт CSV → SQLite
├── requirements.txt        ← Python-зависимости (только Flask)
│
├── README.md               ← Обзор проекта
├── USER_GUIDE.md           ← Этот документ для пользователей
├── ADMIN_GUIDE.md          ← Этот документ
├── SPEC.md                 ← Спецификация разработчика
├── ARCHITECTURE.md         ← Архитектура
└── HLD.md                  ← High-Level Design
```

---

## Раздел 9. Контакты и поддержка

- **GitHub Issues:** https://github.com/ca11mebaraka/itsm-survey/issues
- По вопросам разработки — создайте Issue с тегом `question`
- По найденным ошибкам — создайте Issue с тегом `bug` и приложите скриншот
