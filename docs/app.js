"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function utcnow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

const COMPLIANCE = {
  not_checked:   { label: "Не проверено",     cls: "not_checked"   },
  compliant:     { label: "Соответствует",    cls: "compliant"     },
  partial:       { label: "Частично",         cls: "partial"       },
  non_compliant: { label: "Не соответствует", cls: "non_compliant" },
  na:            { label: "Не применимо",     cls: "na"            },
};

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────

function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById("toast-area").appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("visible")));
  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ─────────────────────────────────────────────────────────────────────────────
// DB layer (sql.js)
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT    DEFAULT '',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  status      TEXT    DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL,
  question_id  TEXT    NOT NULL,
  answer_text  TEXT    DEFAULT '',
  compliance   TEXT    DEFAULT 'not_checked',
  score        INTEGER,
  comment      TEXT    DEFAULT '',
  review_flag  INTEGER DEFAULT 0,
  answered_at  TEXT,
  updated_at   TEXT    NOT NULL,
  UNIQUE(session_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_ans_session ON answers(session_id);
CREATE INDEX IF NOT EXISTS idx_ans_sq      ON answers(session_id, question_id);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

let SQL = null; // sql.js constructor
let DB  = null; // current database instance

function dbRun(sql, params = []) {
  DB.run(sql, params);
}

function dbAll(sql, params = []) {
  const stmt = DB.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  return dbAll(sql, params)[0] || null;
}

function lastId() {
  return dbGet("SELECT last_insert_rowid() AS id").id;
}

function initSchema() {
  DB.run(SCHEMA);
}

// Download current DB as binary .db file
function saveDB() {
  const data = DB.export();
  const blob = new Blob([data], { type: "application/x-sqlite3" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const sessionName = S.session
    ? S.session.name.replace(/[^a-zA-Z0-9а-яА-ЯёЁ\-_ ]/g, "_").trim()
    : "survey";
  a.href     = url;
  a.download = `itsm_survey_${sessionName}.db`;
  a.click();
  URL.revokeObjectURL(url);
  S.changesSinceSave = 0;
  updateSaveButton();
  toast("Файл сохранён на компьютер");
}

// Load DB from an uploaded File object; returns true on success
async function loadDBFromFile(file) {
  try {
    const buf = await file.arrayBuffer();
    DB = new SQL.Database(new Uint8Array(buf));
    // Ensure schema is up to date (adds missing tables, indexes)
    initSchema();
    S.changesSinceSave = 0;
    return true;
  } catch (e) {
    toast("Не удалось загрузить файл: " + e.message, "error");
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const S = {
  session:          null,
  sessions:         [],
  allQuestions:     [],   // loaded from questions.json
  filtered:         [],
  idx:              0,
  answers:          {},   // question_id → answer row
  progress:         null,
  filter:           { process: "ALL", mandatory: false, unanswered: false, review: false },
  view:             "survey",
  compliance:       "not_checked",
  score:            0,
  reviewFlag:       false,
  changesSinceSave: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Welcome screen
// ─────────────────────────────────────────────────────────────────────────────

function showWelcome() {
  document.getElementById("welcome").classList.remove("hidden");
}

function hideWelcome() {
  document.getElementById("welcome").classList.add("hidden");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

function loadSessions() {
  S.sessions = dbAll(`
    SELECT s.*,
      (SELECT COUNT(*) FROM answers a
       WHERE a.session_id = s.id AND a.compliance != 'not_checked') AS answered_count
    FROM sessions s
    WHERE s.status = 'active'
    ORDER BY s.updated_at DESC
  `);
}

function createSession(name, description) {
  const now = utcnow();
  dbRun(
    "INSERT INTO sessions (name, description, created_at, updated_at) VALUES (?,?,?,?)",
    [name, description || "", now, now]
  );
  const id = lastId();
  loadSessions();
  return S.sessions.find(s => s.id === id);
}

function selectSession(id) {
  S.session = S.sessions.find(s => s.id === id) || null;
  if (!S.session) return;

  hideSessionModal();
  hideWelcome();
  document.getElementById("app").classList.remove("hidden");

  loadAllAnswers();
  applyFilter();

  // Restore last position
  const lastQ = dbGet("SELECT value FROM app_state WHERE key='last_question_id'");
  if (lastQ) {
    const idx = S.filtered.findIndex(q => q.id === lastQ.value);
    S.idx = idx >= 0 ? idx : 0;
  } else {
    S.idx = 0;
  }

  loadProgress();
  updateHeader();
  renderSidebar();
  renderCurrentQuestion();
  document.getElementById("app").classList.remove("hidden");
}

function showSessionModal() {
  loadSessions();
  renderSessionList();
  document.getElementById("session-modal").classList.remove("hidden");
}

function hideSessionModal() {
  document.getElementById("session-modal").classList.add("hidden");
  document.getElementById("new-session-form").classList.add("hidden");
  document.getElementById("inp-session-name").value = "";
  document.getElementById("inp-session-desc").value = "";
}

function renderSessionList() {
  const total = S.allQuestions.length || 383;
  const html = S.sessions.length
    ? S.sessions.map(s => {
        const pct    = total ? Math.round((s.answered_count / total) * 100) : 0;
        const active = S.session?.id === s.id ? "active" : "";
        return `
          <div class="session-item ${active}" data-sid="${s.id}">
            <div class="session-item-info">
              <div class="session-item-name">${esc(s.name)}</div>
              <div class="session-item-meta">Создана: ${fmtDate(s.created_at)}</div>
              ${s.description ? `<div class="session-item-meta">${esc(s.description)}</div>` : ""}
            </div>
            <div class="session-item-progress">
              <div class="session-prog-num">${s.answered_count} / ${total}</div>
              <div class="session-prog-pct">${pct}%</div>
            </div>
          </div>`;
      }).join("")
    : `<div class="empty-state">
         <span class="empty-icon">📋</span>
         <p>Нет сессий. Создайте первую.</p>
       </div>`;
  document.getElementById("session-list").innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Questions & filter
// ─────────────────────────────────────────────────────────────────────────────

function loadAllAnswers() {
  if (!S.session) return;
  const rows = dbAll("SELECT * FROM answers WHERE session_id = ?", [S.session.id]);
  S.answers = {};
  rows.forEach(r => { S.answers[r.question_id] = r; });
}

function applyFilter() {
  const f = S.filter;
  S.filtered = S.allQuestions.filter(q => {
    if (f.process !== "ALL" && q.process_code !== f.process) return false;
    if (f.mandatory && q.mandatory !== "обязательный") return false;
    if (f.unanswered) {
      const a = S.answers[q.id];
      if (a && a.compliance && a.compliance !== "not_checked") return false;
    }
    if (f.review) {
      const a = S.answers[q.id];
      if (!a || !a.review_flag) return false;
    }
    return true;
  });
  if (S.idx >= S.filtered.length) S.idx = Math.max(0, S.filtered.length - 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation & form save
// ─────────────────────────────────────────────────────────────────────────────

function goTo(newIdx) {
  saveCurrentForm();
  S.idx = newIdx;
  renderCurrentQuestion();
  persistState();
}

function goPrev() { if (S.idx > 0) goTo(S.idx - 1); }
function goNext() { if (S.idx < S.filtered.length - 1) goTo(S.idx + 1); }

function persistState() {
  if (!S.session || !S.filtered[S.idx]) return;
  dbRun(
    "INSERT INTO app_state(key,value) VALUES('last_question_id',?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [S.filtered[S.idx].id]
  );
}

function getFormData() {
  return {
    answer_text:  document.getElementById("ans-text")?.value    || "",
    compliance:   S.compliance,
    score:        S.score || null,
    comment:      document.getElementById("ans-comment")?.value || "",
    review_flag:  S.reviewFlag ? 1 : 0,
  };
}

function saveCurrentForm() {
  if (!S.session || !S.filtered[S.idx]) return;
  const q   = S.filtered[S.idx];
  const fd  = getFormData();
  const now = utcnow();

  const existing    = S.answers[q.id];
  const answeredAt  = existing?.answered_at || null;
  const newAnsweredAt = (!answeredAt && fd.compliance !== "not_checked") ? now : answeredAt;

  dbRun(`
    INSERT INTO answers
      (session_id, question_id, answer_text, compliance, score,
       comment, review_flag, answered_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id, question_id) DO UPDATE SET
      answer_text  = excluded.answer_text,
      compliance   = excluded.compliance,
      score        = excluded.score,
      comment      = excluded.comment,
      review_flag  = excluded.review_flag,
      answered_at  = COALESCE(answers.answered_at, excluded.answered_at),
      updated_at   = excluded.updated_at
  `, [
    S.session.id, q.id,
    fd.answer_text, fd.compliance, fd.score,
    fd.comment, fd.review_flag, newAnsweredAt, now,
  ]);

  dbRun("UPDATE sessions SET updated_at=? WHERE id=?", [now, S.session.id]);

  // Refresh local cache
  S.answers[q.id] = dbGet(
    "SELECT * FROM answers WHERE session_id=? AND question_id=?",
    [S.session.id, q.id]
  );

  S.changesSinceSave++;
  loadProgress();
  renderSidebar();
  updateHeader();
  showSaveIndicator();
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress
// ─────────────────────────────────────────────────────────────────────────────

function loadProgress() {
  if (!S.session) return;

  // Build per-process stats from in-memory data
  const procMap = {};
  S.allQuestions.forEach(q => {
    if (!procMap[q.process_code]) {
      procMap[q.process_code] = {
        process_code: q.process_code,
        process_name: q.process_name,
        total: 0, answered: 0, compliant: 0, partial: 0, non_compliant: 0, na: 0,
      };
    }
    const p = procMap[q.process_code];
    p.total++;
    const a = S.answers[q.id];
    if (a && a.compliance && a.compliance !== "not_checked") {
      p.answered++;
      if (a.compliance === "compliant")     p.compliant++;
      if (a.compliance === "partial")       p.partial++;
      if (a.compliance === "non_compliant") p.non_compliant++;
      if (a.compliance === "na")            p.na++;
    }
  });

  const totalAnswered  = Object.values(S.answers).filter(
    a => a.compliance && a.compliance !== "not_checked"
  ).length;
  const reviewCount = Object.values(S.answers).filter(a => a.review_flag).length;

  S.progress = {
    total:        S.allQuestions.length,
    answered:     totalAnswered,
    review_count: reviewCount,
    processes:    Object.values(procMap).sort((a, b) =>
      a.process_code.localeCompare(b.process_code)
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

function updateHeader() {
  document.getElementById("hd-session-name").textContent = S.session?.name || "";

  if (!S.progress) {
    document.getElementById("hd-progress").innerHTML = "";
    return;
  }
  const { answered, total, review_count } = S.progress;
  const pct = total ? Math.round((answered / total) * 100) : 0;

  document.getElementById("hd-progress").innerHTML = `
    <div class="hd-progress-wrap">
      <span>${answered} / ${total} (${pct}%)</span>
      <div class="hd-bar-outer">
        <div class="hd-bar-inner" style="width:${pct}%"></div>
      </div>
      ${review_count ? `<span style="color:var(--warning);">⚑ ${review_count}</span>` : ""}
      ${S.changesSinceSave > 0
        ? `<span class="unsaved-badge">💾 Не сохранено: ${S.changesSinceSave}</span>`
        : ""}
    </div>`;

  updateSaveButton();
}

function updateSaveButton() {
  const btn = document.getElementById("btn-save-db");
  if (!btn) return;
  btn.classList.toggle("has-changes", S.changesSinceSave > 0);
  btn.textContent = S.changesSinceSave > 0
    ? `💾 Сохранить (${S.changesSinceSave})`
    : "💾 Сохранить файл";
}

// ─────────────────────────────────────────────────────────────────────────────
// Question render
// ─────────────────────────────────────────────────────────────────────────────

function showSaveIndicator() {
  const el = document.getElementById("save-indicator");
  if (!el) return;
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 1800);
}

function renderCurrentQuestion() {
  const q         = S.filtered[S.idx];
  const container = document.getElementById("question-card");

  if (!q) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🔍</span>
        <p>Нет вопросов, соответствующих фильтру.</p>
      </div>`;
    document.getElementById("nav-counter").textContent = "0 из 0";
    document.getElementById("btn-prev").disabled = true;
    document.getElementById("btn-next").disabled = true;
    return;
  }

  const a = S.answers[q.id] || {};
  S.compliance = a.compliance || "not_checked";
  S.score      = a.score      || 0;
  S.reviewFlag = !!a.review_flag;

  const mandatory    = q.mandatory === "обязательный";
  const priorityText = q.priority && q.priority !== "нет" ? `Приоритет: ${esc(q.priority)}` : "";

  const compBtns = Object.entries(COMPLIANCE).map(([val, info]) => `
    <button class="comp-btn ${S.compliance === val ? "active" : ""}" data-value="${val}">
      ${info.label}
    </button>`).join("");

  const stars = [1,2,3,4,5].map(n =>
    `<button class="star-btn ${n <= S.score ? "active" : ""}" data-star="${n}">★</button>`
  ).join("");

  container.innerHTML = `
    <div class="qcard-meta">
      <span class="badge badge-process">${esc(q.process_code)}</span>
      <span class="badge ${mandatory ? "badge-mandatory" : "badge-optional"}">
        ${mandatory ? "Обязательный" : "Дополнительный"}
      </span>
      ${priorityText ? `<span class="badge badge-priority">${priorityText}</span>` : ""}
      <span style="font-size:11px;color:var(--text-2);margin-left:auto;">${esc(q.id)}</span>
      ${q.gost_code ? `<span style="font-size:11px;color:var(--text-2);">ГОСТ: ${esc(q.gost_code)}</span>` : ""}
    </div>

    <div class="qcard-body">
      <div class="q-text">${esc(q.question_text)}</div>

      ${q.answer_hint ? `
        <div class="collapsible">
          <button class="collapsible-toggle" data-target="hint-body">
            💡 Подсказка для ответа <span class="arrow">▾</span>
          </button>
          <div id="hint-body" class="collapsible-content">${esc(q.answer_hint)}</div>
        </div>` : ""}

      ${q.expected_evidence ? `
        <div class="collapsible">
          <button class="collapsible-toggle" data-target="evidence-body">
            📎 Ожидаемые свидетельства <span class="arrow">▾</span>
          </button>
          <div id="evidence-body" class="collapsible-content">${esc(q.expected_evidence)}</div>
        </div>` : ""}
    </div>

    <div class="qcard-answer">
      <div class="answer-section">
        <div>
          <label class="form-label" for="ans-text">Текст ответа</label>
          <textarea id="ans-text" class="form-textarea" rows="4"
            placeholder="Введите ответ…">${esc(a.answer_text || "")}</textarea>
        </div>

        <div>
          <label class="form-label">Статус соответствия</label>
          <div class="compliance-group">${compBtns}</div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Оценка</label>
            <div class="score-group">${stars}</div>
          </div>
          <div class="form-group" style="flex:1;">
            <label class="form-label" for="ans-comment">Комментарий</label>
            <textarea id="ans-comment" class="form-textarea" rows="2"
              placeholder="Комментарий…">${esc(a.comment || "")}</textarea>
          </div>
        </div>

        <div class="review-row">
          <button class="review-toggle ${S.reviewFlag ? "flagged" : ""}" id="btn-review-flag">
            ${S.reviewFlag ? "⚑ На ревью" : "⚐ Пометить для ревью"}
          </button>
          <span id="save-indicator" class="save-indicator">✓ Сохранено</span>
        </div>

        ${a.answered_at || a.updated_at ? `
          <div class="answer-timestamps">
            ${a.answered_at ? `<span>Отвечено: ${fmtDate(a.answered_at)}</span>` : ""}
            ${a.updated_at  ? `<span>Изменено: ${fmtDate(a.updated_at)}</span>`  : ""}
          </div>` : ""}
      </div>
    </div>`;

  document.getElementById("nav-counter").textContent =
    `Вопрос ${S.idx + 1} из ${S.filtered.length}`;
  document.getElementById("btn-prev").disabled = S.idx === 0;
  document.getElementById("btn-next").disabled = S.idx === S.filtered.length - 1;

  renderSidebar();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar
// ─────────────────────────────────────────────────────────────────────────────

function renderSidebar() {
  if (!S.progress) return;
  const { processes, answered, total } = S.progress;
  const allActive = S.filter.process === "ALL" ? "active" : "";

  let html = `
    <div class="process-item-all ${allActive}" data-proc="ALL">
      <span style="font-size:12px;">🗂</span>
      <span>Все процессы</span>
      <span style="margin-left:auto;font-size:11px;color:var(--sidebar-text);">
        ${answered} / ${total}
      </span>
    </div>`;

  processes.forEach(p => {
    const pct    = p.total ? Math.round((p.answered / p.total) * 100) : 0;
    const active = S.filter.process === p.process_code ? "active" : "";
    const barCls = pct === 100 ? "full" : pct >= 50 ? "half" : "";
    html += `
      <div class="process-item ${active}" data-proc="${esc(p.process_code)}">
        <div class="process-item-header">
          <span class="process-code">${esc(p.process_code)}</span>
          <span class="process-progress-text">${p.answered}/${p.total}</span>
        </div>
        <div class="process-name">${esc(p.process_name)}</div>
        <div class="proc-bar-outer">
          <div class="proc-bar-inner ${barCls}" style="width:${pct}%"></div>
        </div>
      </div>`;
  });

  document.getElementById("process-list").innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table view
// ─────────────────────────────────────────────────────────────────────────────

function showTableView() {
  S.view = "table";
  saveCurrentForm();
  document.getElementById("survey-view").classList.add("hidden");
  document.getElementById("table-view").classList.remove("hidden");
  renderTable();
}

function showSurveyView() {
  S.view = "survey";
  document.getElementById("table-view").classList.add("hidden");
  document.getElementById("survey-view").classList.remove("hidden");
  renderCurrentQuestion();
}

function renderTable() {
  const rows = dbAll(`
    SELECT * FROM answers WHERE session_id = ? ORDER BY question_id
  `, [S.session.id]);

  if (!rows.length) {
    document.getElementById("table-container").innerHTML =
      `<div class="empty-state">
        <span class="empty-icon">📭</span>
        <p>Нет сохранённых ответов.</p>
       </div>`;
    return;
  }

  const tableRows = rows.map(a => {
    const q    = S.allQuestions.find(q => q.id === a.question_id) || {};
    const comp = COMPLIANCE[a.compliance] || COMPLIANCE.not_checked;
    const stars = a.score ? "★".repeat(a.score) + "☆".repeat(5 - a.score) : "—";
    return `
      <tr data-qid="${esc(a.question_id)}" title="${esc(q.question_text || "")}">
        <td class="td-meta">
          <span class="badge badge-process">${esc(q.process_code || "")}</span>
          <span style="margin-left:4px;">${q.question_number || ""}</span>
        </td>
        <td class="td-q-text">${esc(q.question_text || a.question_id)}</td>
        <td><span class="status-badge ${comp.cls}">${comp.label}</span></td>
        <td style="font-size:13px;color:#f59e0b;white-space:nowrap;">${stars}</td>
        <td class="flag-icon">${a.review_flag ? "⚑" : ""}</td>
        <td class="td-meta">${fmtDate(a.updated_at)}</td>
      </tr>`;
  }).join("");

  document.getElementById("table-container").innerHTML = `
    <table class="answers-table">
      <thead>
        <tr>
          <th>Процесс</th><th>Вопрос</th><th>Статус</th>
          <th>Оценка</th><th>⚑</th><th>Обновлён</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export CSV
// ─────────────────────────────────────────────────────────────────────────────

function exportCSV() {
  if (!S.session) { toast("Выберите сессию", "error"); return; }

  const answers = dbAll(
    "SELECT * FROM answers WHERE session_id=? ORDER BY question_id",
    [S.session.id]
  );

  const cols = [
    "session_id","session_name","question_id","process_code","process_name",
    "question_number","question_text","mandatory","priority","weight",
    "gost_code","standard_ref","compliance","score","answer_text",
    "comment","review_flag","answered_at","updated_at","expected_evidence",
  ];

  const csvEsc = v => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(";") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  let csv = "\uFEFF" + cols.join(";") + "\n"; // BOM for Excel
  answers.forEach(a => {
    const q = S.allQuestions.find(q => q.id === a.question_id) || {};
    csv += [
      S.session.id, S.session.name, a.question_id,
      q.process_code, q.process_name, q.question_number, q.question_text,
      q.mandatory, q.priority, q.weight, q.gost_code, q.standard_ref,
      a.compliance, a.score || "", a.answer_text, a.comment,
      a.review_flag ? 1 : 0, a.answered_at || "", a.updated_at || "",
      q.expected_evidence,
    ].map(csvEsc).join(";") + "\n";
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const name = S.session.name.replace(/[^a-zA-Z0-9а-яА-ЯёЁ\-_ ]/g, "_").trim();
  a.href     = url;
  a.download = `survey_${name}_${S.session.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast("CSV экспортирован");
}

// ─────────────────────────────────────────────────────────────────────────────
// Event binding
// ─────────────────────────────────────────────────────────────────────────────

function bindCollapsibles() {
  document.getElementById("question-card").addEventListener("click", e => {
    const toggle = e.target.closest(".collapsible-toggle");
    if (!toggle) return;
    const body = document.getElementById(toggle.dataset.target);
    if (!body) return;
    body.classList.toggle("open");
    toggle.classList.toggle("open");
  });
}

function bindEvents() {
  // Navigation
  document.getElementById("btn-prev").addEventListener("click", goPrev);
  document.getElementById("btn-next").addEventListener("click", goNext);

  // Save DB
  document.getElementById("btn-save-db").addEventListener("click", saveDB);

  // Views
  document.getElementById("btn-table-view").addEventListener("click", showTableView);
  document.getElementById("btn-back-survey").addEventListener("click", showSurveyView);

  // Export CSV
  document.getElementById("btn-export").addEventListener("click", exportCSV);

  // Session switch
  document.getElementById("btn-switch-session").addEventListener("click", showSessionModal);

  // Session modal — new session
  document.getElementById("btn-new-session").addEventListener("click", () => {
    document.getElementById("new-session-form").classList.remove("hidden");
    document.getElementById("inp-session-name").focus();
  });
  document.getElementById("btn-cancel-new-session").addEventListener("click", () => {
    document.getElementById("new-session-form").classList.add("hidden");
  });
  document.getElementById("btn-create-session").addEventListener("click", () => {
    const name = document.getElementById("inp-session-name").value.trim();
    if (!name) { toast("Введите название сессии", "error"); return; }
    const desc = document.getElementById("inp-session-desc").value.trim();
    const s    = createSession(name, desc);
    selectSession(s.id);
    toast(`Сессия «${name}» создана`);
  });

  // Session list click
  document.getElementById("session-list").addEventListener("click", e => {
    const item = e.target.closest(".session-item[data-sid]");
    if (item) selectSession(Number(item.dataset.sid));
  });

  // Load DB from session modal
  document.getElementById("inp-load-db-2").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const ok = await loadDBFromFile(file);
    if (ok) {
      loadSessions();
      loadAllAnswers();
      if (S.sessions.length) {
        selectSession(S.sessions[0].id);
        toast(`Файл «${file.name}» загружен`);
      } else {
        renderSessionList();
        toast("Файл загружен — создайте или выберите сессию", "info");
      }
    }
    e.target.value = "";
  });

  // Process list (delegated)
  document.getElementById("process-list").addEventListener("click", e => {
    const item = e.target.closest("[data-proc]");
    if (!item) return;
    saveCurrentForm();
    S.filter.process = item.dataset.proc;
    applyFilter();
    S.idx = 0;
    renderSidebar();
    renderCurrentQuestion();
  });

  // Filters
  const filterHandler = (id, key) => {
    document.getElementById(id).addEventListener("change", e => {
      saveCurrentForm();
      S.filter[key] = e.target.checked;
      applyFilter();
      renderCurrentQuestion();
    });
  };
  filterHandler("f-mandatory",  "mandatory");
  filterHandler("f-unanswered", "unanswered");
  filterHandler("f-review",     "review");

  // Question card — compliance, stars, review flag
  document.getElementById("question-card").addEventListener("click", e => {
    const compBtn = e.target.closest(".comp-btn");
    if (compBtn) {
      S.compliance = compBtn.dataset.value;
      document.querySelectorAll(".comp-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.value === S.compliance));
      return;
    }
    const star = e.target.closest(".star-btn");
    if (star) {
      const n  = Number(star.dataset.star);
      S.score  = S.score === n ? 0 : n;
      document.querySelectorAll(".star-btn").forEach(b =>
        b.classList.toggle("active", Number(b.dataset.star) <= S.score));
      return;
    }
    if (e.target.closest("#btn-review-flag")) {
      S.reviewFlag = !S.reviewFlag;
      const btn = document.getElementById("btn-review-flag");
      btn.classList.toggle("flagged", S.reviewFlag);
      btn.textContent = S.reviewFlag ? "⚑ На ревью" : "⚐ Пометить для ревью";
    }
  });

  // Table row → jump to question
  document.getElementById("table-container").addEventListener("click", e => {
    const row = e.target.closest("tr[data-qid]");
    if (!row) return;
    const qid = row.dataset.qid;
    showSurveyView();
    // Reset filter if question not in current filtered list
    let idx = S.filtered.findIndex(q => q.id === qid);
    if (idx < 0) {
      S.filter.process    = "ALL";
      S.filter.mandatory  = false;
      S.filter.unanswered = false;
      S.filter.review     = false;
      ["f-mandatory","f-unanswered","f-review"].forEach(id => {
        document.getElementById(id).checked = false;
      });
      applyFilter();
      idx = S.filtered.findIndex(q => q.id === qid);
    }
    if (idx >= 0) { S.idx = idx; renderCurrentQuestion(); }
  });

  // Welcome screen
  document.getElementById("btn-welcome-new").addEventListener("click", () => {
    hideWelcome();
    document.getElementById("app").classList.remove("hidden");
    showSessionModal();
    document.getElementById("new-session-form").classList.remove("hidden");
    document.getElementById("inp-session-name").focus();
  });

  document.getElementById("inp-load-db").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const ok = await loadDBFromFile(file);
    if (ok) {
      loadSessions();
      hideWelcome();
      if (S.sessions.length) {
        selectSession(S.sessions[0].id);
        toast(`Файл «${file.name}» загружен`);
      } else {
        document.getElementById("app").classList.remove("hidden");
        showSessionModal();
        document.getElementById("new-session-form").classList.remove("hidden");
      }
    }
    e.target.value = "";
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", e => {
    if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
      saveCurrentForm();
      saveDB();
    }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    if (e.altKey && e.key === "ArrowLeft")  { e.preventDefault(); goPrev(); }
  });

  bindCollapsibles();
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1. Load sql.js
    document.getElementById("loading-text").textContent = "Загрузка SQLite…";
    SQL = await initSqlJs({
      locateFile: f =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`,
    });

    // 2. Load questions from JSON
    document.getElementById("loading-text").textContent = "Загрузка вопросов…";
    const res = await fetch("questions.json");
    S.allQuestions = await res.json();

    // 3. Create empty in-memory DB
    DB = new SQL.Database();
    initSchema();

    // 4. Hide loading, show welcome
    document.getElementById("loading").classList.add("hidden");

    bindEvents();
    showWelcome();

  } catch (err) {
    console.error(err);
    document.getElementById("loading").innerHTML = `
      <p style="color:#dc2626;padding:24px;text-align:center;">
        <strong>Ошибка загрузки</strong><br>${esc(err.message)}<br><br>
        Убедитесь, что вы открыли страницу через интернет (не файл file://).
      </p>`;
  }
}

init();
