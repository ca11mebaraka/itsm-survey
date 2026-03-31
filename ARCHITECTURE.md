# Архитектура приложения: ITSM Survey Tool

## 1. Обзор архитектуры

Приложение построено по **трёхслойной архитектуре** (Layered Architecture) с явным разделением ответственности:

```
┌──────────────────────────────────────────────────┐
│                  UI Layer                        │
│         (PyQt6 / Tkinter виджеты)                │
│   QuestionForm | AnswersTable | SessionDialog    │
└────────────────────┬─────────────────────────────┘
                     │  вызовы методов
┌────────────────────▼─────────────────────────────┐
│               Service Layer                      │
│   ImporterService | AnswerService | ExportService│
└────────────────────┬─────────────────────────────┘
                     │  SQL-запросы
┌────────────────────▼─────────────────────────────┐
│              Data Layer                          │
│         Database (sqlite3) | Models              │
└──────────────────────────────────────────────────┘
```

Никаких событийных шин, никаких ORM — намеренно простая модель для лёгкой сопровождаемости и прямого доступа к данным из внешних инструментов (pandas, DB Browser).

---

## 2. Компонентная диаграмма

```
main.py
  └── App (QApplication / Tk)
        ├── MainWindow
        │     ├── NavigationPanel   — фильтры, прогресс, список процессов
        │     ├── QuestionForm       — отображение вопроса + поля ответа
        │     └── StatusBar          — текущая сессия, дата последнего сохранения
        │
        ├── SessionDialog            — выбор / создание сессии (modal)
        └── AnswersTableWindow       — просмотр всех ответов (отдельное окно)

Services:
  ├── ImporterService
  │     - load_csv(path) → List[Question]
  │     - import_to_db(questions, db) → int  # кол-во импортированных
  │
  ├── AnswerService
  │     - get_answer(session_id, question_id) → Answer | None
  │     - save_answer(answer) → Answer
  │     - get_all_answers(session_id, filters) → List[AnswerRow]
  │     - get_progress(session_id) → dict[process_code, ProgressInfo]
  │
  └── ExportService
        - to_csv(session_id, filepath) → None
        - to_json(session_id, filepath) → None

Database:
  ├── Database.__init__(path)     — открытие/создание БД, применение миграций
  ├── Database.execute(sql, params)
  ├── Database.fetchone / fetchall
  └── Database.close()
```

---

## 3. Модели данных (dataclasses)

```python
@dataclass
class Question:
    id: str
    gost_code: str
    title_short: str
    description: str
    process_group: str
    standard_ref: str
    priority: str
    weight: str
    mandatory: str           # 'обязательный' / 'дополнительный'
    management_area: str
    process_name: str
    process_code: str        # извлекается из id: 'INC', 'PRB', ...
    question_number: int
    question_text: str
    answer_hint: str
    expected_evidence: str


@dataclass
class Session:
    id: int
    name: str
    description: str
    created_at: datetime      # UTC
    updated_at: datetime      # UTC
    status: str               # 'active' / 'archived'


@dataclass
class Answer:
    id: int | None
    session_id: int
    question_id: str
    answer_text: str
    compliance: str           # 'compliant'/'partial'/'non_compliant'/'na'/'not_checked'
    score: int | None         # 1-5
    comment: str
    review_flag: bool
    answered_at: datetime | None   # UTC, устанавливается при первом сохранении
    updated_at: datetime           # UTC, обновляется каждый раз


@dataclass
class ProgressInfo:
    process_code: str
    total: int
    answered: int
    compliant: int
    partial: int
    non_compliant: int
```

---

## 4. Жизненный цикл ответа

```
Пользователь открывает вопрос
        │
        ▼
AnswerService.get_answer(session_id, question_id)
        │
   ┌────┴────┐
   │         │
  NULL     Answer
   │         │
   ▼         ▼
Пустая    Заполнить
форма     форму данными
        │
        ▼
Пользователь заполняет поля
        │
        ▼
[Сохранить / Перейти к следующему]
        │
        ▼
AnswerService.save_answer(answer)
        │
   ┌────┴────────────────────┐
   │                         │
answered_at == NULL    answered_at != NULL
   │                         │
   ▼                         ▼
SET answered_at = now()   обновить только
SET updated_at = now()    updated_at = now()
        │
        ▼
INSERT OR REPLACE INTO answers (...)
```

---

## 5. Схема навигации UI

```
[Старт] → SessionDialog
              │
              ├─ [Новая сессия] → ввод имени → create → MainWindow
              └─ [Открыть]     → выбор из списка → MainWindow
                                                         │
                                     ┌───────────────────┼──────────────────────┐
                                     │                   │                      │
                              NavigationPanel     QuestionForm            Menu Actions
                                     │                   │                      │
                              - фильтр процесса   - текст вопроса        - Просмотр ответов
                              - фильтр обяз.      - подсказка (collapse)  - Экспорт CSV
                              - прогресс-бар      - поля ответа           - Сменить сессию
                              - список вопросов   - Назад / Вперёд
```

---

## 6. Обработка данных CSV

```python
# Псевдокод парсинга
def load_csv(path: str) -> list[Question]:
    with open(path, encoding='cp1251') as f:
        reader = csv.reader(f, delimiter=';')
        header = next(reader)
        questions = []
        for row in reader:
            if len(row) < 15:
                continue
            q = Question(
                id=row[0].strip(),
                ...
                process_code=extract_process_code(row[0]),  # 'DTN-ITSM-INC-01' → 'INC'
                ...
            )
            questions.append(q)
    return questions

def extract_process_code(question_id: str) -> str:
    # 'DTN-ITSM-INC-01' → 'INC'
    parts = question_id.split('-')
    return parts[2] if len(parts) >= 3 else 'UNKNOWN'
```

---

## 7. Стратегия миграций БД

При запуске `Database.__init__()`:
1. Создать таблицу `schema_version` если не существует
2. Прочитать текущую версию (default = 0)
3. Последовательно применить все миграции с версии N+1
4. Обновить версию

```python
MIGRATIONS = {
    1: """
        CREATE TABLE IF NOT EXISTS questions (...);
        CREATE TABLE IF NOT EXISTS sessions (...);
        CREATE TABLE IF NOT EXISTS answers (...);
        CREATE TABLE IF NOT EXISTS app_state (...);
    """,
    # будущие миграции — добавлять сюда
}
```

Это позволит безболезненно добавлять колонки/таблицы в будущих версиях без потери данных.

---

## 8. Временные метки

- **Хранение в БД:** все временные метки в формате ISO 8601 UTC (`2025-03-31T10:30:00Z`)
- **Отображение в UI:** конвертация в локальное время через `datetime.astimezone()`
- **Сравнение/сортировка:** напрямую по строкам ISO 8601 (лексикографически корректно)

```python
# utils/datetime_utils.py
from datetime import datetime, timezone

def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def utc_to_local_str(iso_str: str) -> str:
    dt = datetime.fromisoformat(iso_str)
    return dt.astimezone().strftime('%d.%m.%Y %H:%M:%S')
```

---

## 9. Экспорт данных

Экспорт предназначен для последующей обработки (Power BI, pandas, генерация отчётов).

### Структура экспортного CSV

```
session_id, session_name, question_id, process_code, process_name,
question_number, question_text, mandatory, priority, weight,
compliance, score, answer_text, comment, review_flag,
answered_at_local, updated_at_local,
gost_code, standard_ref, expected_evidence
```

Все поля доступны через один JOIN:
```sql
SELECT s.id, s.name,
       q.id, q.process_code, q.process_name,
       q.question_number, q.question_text, q.mandatory, q.priority, q.weight,
       a.compliance, a.score, a.answer_text, a.comment, a.review_flag,
       a.answered_at, a.updated_at,
       q.gost_code, q.standard_ref, q.expected_evidence
FROM answers a
JOIN questions q ON a.question_id = q.id
JOIN sessions s ON a.session_id = s.id
WHERE a.session_id = ?
ORDER BY q.process_code, q.question_number;
```
