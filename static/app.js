"use strict";

// ── HTML escaping ─────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── API helpers ───────────────────────────────────────────────────────────────
const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
    return r.json();
  },
  async post(url, data) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(`POST ${url} → ${r.status}`);
    return r.json();
  },
  async put(url, data) {
    const r = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(`PUT ${url} → ${r.status}`);
    return r.json();
  },
};

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  session: null,
  sessions: [],
  allQuestions: [],
  filtered: [],
  idx: 0,
  answers: {},      // question_id → answer obj
  progress: null,
  filter: { process: "ALL", mandatory: false, unanswered: false, review: false },
  view: "survey",   // "survey" | "table"
  score: 0,         // current form score value
  compliance: "not_checked",
  reviewFlag: false,
};

// ── Utils ─────────────────────────────────────────────────────────────────────
const COMPLIANCE = {
  not_checked:   { label: "Не проверено",      cls: "not_checked"   },
  compliant:     { label: "Соответствует",     cls: "compliant"     },
  partial:       { label: "Частично",          cls: "partial"       },
  non_compliant: { label: "Не соответствует",  cls: "non_compliant" },
  na:            { label: "Не применимо",      cls: "na"            },
};

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById("toast-area").appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("visible")));
  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

// ── Session modal ─────────────────────────────────────────────────────────────
function showSessionModal() {
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
  const total = S.sessions[0]?.total_questions || 383;
  const html = S.sessions.length
    ? S.sessions.map(s => {
        const pct = total ? Math.round((s.answered_count / total) * 100) : 0;
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
    : `<div class="empty-state"><span class="empty-icon">📋</span><p>Нет сессий. Создайте первую.</p></div>`;
  document.getElementById("session-list").innerHTML = html;
}

async function loadSessions() {
  S.sessions = await api.get("/api/sessions");
  if (document.getElementById("session-modal").classList.contains("hidden") === false) {
    renderSessionList();
  }
}

async function selectSession(id) {
  S.session = S.sessions.find(s => s.id === id) || null;
  hideSessionModal();
  await Promise.all([loadQuestions(), loadProgress()]);
  await loadAllAnswers();

  // Restore last position
  const appState = await api.get("/api/state");
  if (appState.last_session_id == id && appState.last_question_id) {
    const idx = S.filtered.findIndex(q => q.id === appState.last_question_id);
    S.idx = idx >= 0 ? idx : 0;
  } else {
    S.idx = 0;
  }

  updateHeader();
  renderSidebar();
  renderCurrentQuestion();
}

// ── Questions ─────────────────────────────────────────────────────────────────
async function loadQuestions() {
  S.allQuestions = await api.get("/api/questions");
  applyFilter();
}

async function loadAllAnswers() {
  if (!S.session) return;
  const list = await api.get(`/api/answers?session_id=${S.session.id}`);
  S.answers = {};
  list.forEach(a => { S.answers[a.question_id] = a; });
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
  // Clamp index
  if (S.idx >= S.filtered.length) S.idx = Math.max(0, S.filtered.length - 1);
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function goTo(newIdx) {
  await saveCurrentForm();
  S.idx = newIdx;
  renderCurrentQuestion();
  persistState();
}

async function goPrev() {
  if (S.idx > 0) await goTo(S.idx - 1);
}

async function goNext() {
  if (S.idx < S.filtered.length - 1) await goTo(S.idx + 1);
}

function persistState() {
  if (!S.session || !S.filtered[S.idx]) return;
  api.post("/api/state", {
    last_session_id: S.session.id,
    last_question_id: S.filtered[S.idx].id,
  }).catch(() => {});
}

// ── Form read/write ───────────────────────────────────────────────────────────
function getFormData() {
  return {
    answer_text:  document.getElementById("ans-text")?.value  || "",
    compliance:   S.compliance,
    score:        S.score || null,
    comment:      document.getElementById("ans-comment")?.value || "",
    review_flag:  S.reviewFlag,
  };
}

async function saveCurrentForm() {
  if (!S.session || !S.filtered[S.idx]) return;
  const q = S.filtered[S.idx];
  const formData = getFormData();
  try {
    const saved = await api.post("/api/answers", {
      session_id: S.session.id,
      question_id: q.id,
      ...formData,
    });
    S.answers[q.id] = saved;
    // update progress quietly
    await loadProgress();
    renderSidebar();
    updateHeader();
    showSaveIndicator();
  } catch (e) {
    toast("Ошибка сохранения", "error");
  }
}

function showSaveIndicator() {
  const el = document.getElementById("save-indicator");
  if (!el) return;
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 1800);
}

// ── Render question ───────────────────────────────────────────────────────────
function renderCurrentQuestion() {
  const q = S.filtered[S.idx];
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
  S.compliance  = a.compliance  || "not_checked";
  S.score       = a.score       || 0;
  S.reviewFlag  = !!a.review_flag;

  const mandatory = q.mandatory === "обязательный";
  const priorityLabel = q.priority && q.priority !== "нет" ? `Приоритет: ${esc(q.priority)}` : "";

  const compBtns = Object.entries(COMPLIANCE).map(([val, info]) => `
    <button class="comp-btn ${S.compliance === val ? "active" : ""}" data-value="${val}">
      ${info.label}
    </button>`).join("");

  const stars = [1,2,3,4,5].map(n => `
    <button class="star-btn ${n <= S.score ? "active" : ""}" data-star="${n}" title="${n}">★</button>`
  ).join("");

  container.innerHTML = `
    <div class="qcard-meta">
      <span class="badge badge-process">${esc(q.process_code)}</span>
      <span class="badge ${mandatory ? "badge-mandatory" : "badge-optional"}">
        ${mandatory ? "Обязательный" : "Дополнительный"}
      </span>
      ${priorityLabel ? `<span class="badge badge-priority">${priorityLabel}</span>` : ""}
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

  // Nav counter
  document.getElementById("nav-counter").textContent =
    `Вопрос ${S.idx + 1} из ${S.filtered.length}`;
  document.getElementById("btn-prev").disabled = S.idx === 0;
  document.getElementById("btn-next").disabled = S.idx === S.filtered.length - 1;

  // Highlight active process in sidebar
  renderSidebar();
}

// ── Collapsible ───────────────────────────────────────────────────────────────
function bindCollapsibles() {
  document.getElementById("question-card").addEventListener("click", e => {
    const toggle = e.target.closest(".collapsible-toggle");
    if (!toggle) return;
    const targetId = toggle.dataset.target;
    const body = document.getElementById(targetId);
    if (!body) return;
    const isOpen = body.classList.toggle("open");
    toggle.classList.toggle("open", isOpen);
  });
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
async function loadProgress() {
  if (!S.session) return;
  S.progress = await api.get(`/api/progress/${S.session.id}`);
}

function renderSidebar() {
  if (!S.progress) return;
  const { processes } = S.progress;

  const currentQ = S.filtered[S.idx];
  const currentProc = currentQ?.process_code;

  // "All processes" item
  const totalAnswered = S.progress.answered;
  const totalAll      = S.progress.total;
  const allActive     = S.filter.process === "ALL" ? "active" : "";

  let html = `
    <div class="process-item-all ${allActive}" data-proc="ALL">
      <span style="font-size:12px;">🗂</span>
      <span>Все процессы</span>
      <span style="margin-left:auto;font-size:11px;color:var(--sidebar-text);">
        ${totalAnswered} / ${totalAll}
      </span>
    </div>`;

  processes.forEach(p => {
    const pct = p.total ? Math.round((p.answered / p.total) * 100) : 0;
    const active = (S.filter.process === p.process_code) ? "active" : "";
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

// ── Header ────────────────────────────────────────────────────────────────────
function updateHeader() {
  document.getElementById("hd-session-name").textContent =
    S.session ? S.session.name : "";

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
    </div>`;
}

// ── Table view ────────────────────────────────────────────────────────────────
async function showTableView() {
  S.view = "table";
  document.getElementById("survey-view").classList.add("hidden");
  document.getElementById("table-view").classList.remove("hidden");
  await renderTable();
}

function showSurveyView() {
  S.view = "survey";
  document.getElementById("table-view").classList.add("hidden");
  document.getElementById("survey-view").classList.remove("hidden");
  renderCurrentQuestion();
}

async function renderTable() {
  const answers = await api.get(`/api/answers?session_id=${S.session.id}`);
  if (!answers.length) {
    document.getElementById("table-container").innerHTML =
      `<div class="empty-state"><span class="empty-icon">📭</span><p>Нет сохранённых ответов.</p></div>`;
    return;
  }

  const rows = answers.map((a, i) => {
    const comp = COMPLIANCE[a.compliance] || COMPLIANCE.not_checked;
    const stars = a.score ? "★".repeat(a.score) + "☆".repeat(5 - a.score) : "—";
    return `
      <tr data-qid="${esc(a.question_id)}" title="${esc(a.question_text)}">
        <td class="td-meta">
          <span class="badge badge-process">${esc(a.process_code)}</span>
          <span style="margin-left:4px;">${a.question_number}</span>
        </td>
        <td class="td-q-text">${esc(a.question_text)}</td>
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
          <th>Процесс</th>
          <th>Вопрос</th>
          <th>Статус</th>
          <th>Оценка</th>
          <th>⚑</th>
          <th>Обновлён</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Event wiring ──────────────────────────────────────────────────────────────
function bindEvents() {
  // Navigation
  document.getElementById("btn-prev").addEventListener("click", goPrev);
  document.getElementById("btn-next").addEventListener("click", goNext);

  // Views
  document.getElementById("btn-table-view").addEventListener("click", showTableView);
  document.getElementById("btn-back-survey").addEventListener("click", showSurveyView);

  // Session
  document.getElementById("btn-switch-session").addEventListener("click", async () => {
    await loadSessions();
    showSessionModal();
  });

  // New session
  document.getElementById("btn-new-session").addEventListener("click", () => {
    document.getElementById("new-session-form").classList.remove("hidden");
    document.getElementById("inp-session-name").focus();
  });
  document.getElementById("btn-cancel-new-session").addEventListener("click", () => {
    document.getElementById("new-session-form").classList.add("hidden");
  });
  document.getElementById("btn-create-session").addEventListener("click", async () => {
    const name = document.getElementById("inp-session-name").value.trim();
    if (!name) { toast("Введите название сессии", "error"); return; }
    const desc = document.getElementById("inp-session-desc").value.trim();
    const s = await api.post("/api/sessions", { name, description: desc });
    await loadSessions();
    await selectSession(s.id);
    toast(`Сессия "${name}" создана`);
  });

  // Session list click
  document.getElementById("session-list").addEventListener("click", e => {
    const item = e.target.closest(".session-item[data-sid]");
    if (item) selectSession(Number(item.dataset.sid));
  });

  // Export
  document.getElementById("btn-export").addEventListener("click", () => {
    if (!S.session) { toast("Выберите сессию", "error"); return; }
    window.location = `/api/export/${S.session.id}`;
  });

  // Process list (delegated)
  document.getElementById("process-list").addEventListener("click", async e => {
    const item = e.target.closest("[data-proc]");
    if (!item) return;
    await saveCurrentForm();
    S.filter.process = item.dataset.proc;
    applyFilter();
    S.idx = 0;
    renderSidebar();
    renderCurrentQuestion();
  });

  // Filters
  document.getElementById("f-mandatory").addEventListener("change", async e => {
    await saveCurrentForm();
    S.filter.mandatory = e.target.checked;
    applyFilter(); renderSidebar(); renderCurrentQuestion();
  });
  document.getElementById("f-unanswered").addEventListener("change", async e => {
    await saveCurrentForm();
    S.filter.unanswered = e.target.checked;
    applyFilter(); renderSidebar(); renderCurrentQuestion();
  });
  document.getElementById("f-review").addEventListener("change", async e => {
    await saveCurrentForm();
    S.filter.review = e.target.checked;
    applyFilter(); renderSidebar(); renderCurrentQuestion();
  });

  // Question card (delegated)
  document.getElementById("question-card").addEventListener("click", e => {
    // Compliance buttons
    const compBtn = e.target.closest(".comp-btn");
    if (compBtn) {
      S.compliance = compBtn.dataset.value;
      document.querySelectorAll(".comp-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.value === S.compliance));
      return;
    }
    // Star rating
    const star = e.target.closest(".star-btn");
    if (star) {
      const n = Number(star.dataset.star);
      S.score = S.score === n ? 0 : n;  // click same → reset
      document.querySelectorAll(".star-btn").forEach(b =>
        b.classList.toggle("active", Number(b.dataset.star) <= S.score));
      return;
    }
    // Review flag
    if (e.target.closest("#btn-review-flag")) {
      S.reviewFlag = !S.reviewFlag;
      const btn = document.getElementById("btn-review-flag");
      btn.classList.toggle("flagged", S.reviewFlag);
      btn.textContent = S.reviewFlag ? "⚑ На ревью" : "⚐ Пометить для ревью";
      return;
    }
  });

  // Table row click → go to question
  document.getElementById("table-container").addEventListener("click", e => {
    const row = e.target.closest("tr[data-qid]");
    if (!row) return;
    const qid = row.dataset.qid;
    showSurveyView();
    const idx = S.filtered.findIndex(q => q.id === qid);
    if (idx >= 0) { S.idx = idx; renderCurrentQuestion(); }
    else {
      // Question might be filtered out — reset filter and find
      S.filter.process = "ALL";
      S.filter.mandatory = false;
      S.filter.unanswered = false;
      S.filter.review = false;
      applyFilter();
      const idx2 = S.filtered.findIndex(q => q.id === qid);
      if (idx2 >= 0) { S.idx = idx2; renderCurrentQuestion(); }
    }
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", async e => {
    if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
      await saveCurrentForm();
      toast("Сохранено");
    }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    if (e.altKey && e.key === "ArrowLeft")  { e.preventDefault(); goPrev(); }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadSessions();

    document.getElementById("loading").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");

    bindEvents();
    bindCollapsibles();

    if (S.sessions.length === 0) {
      showSessionModal();
      return;
    }

    // Restore last session or default to first
    const appState = await api.get("/api/state");
    const lastId = appState.last_session_id ? Number(appState.last_session_id) : null;
    const target = S.sessions.find(s => s.id === lastId) || S.sessions[0];

    await selectSession(target.id);
  } catch (err) {
    console.error(err);
    document.getElementById("loading").innerHTML =
      `<p style="color:#dc2626;padding:20px;">Ошибка подключения к серверу.<br>Убедитесь, что main.py запущен.</p>`;
  }
}

init();
