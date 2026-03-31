"""
ITSM Survey Tool — Flask backend
Run:  python main.py
"""
import csv
import io
import json
import threading
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, Response

import database as db
import importer

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"

app = Flask(__name__, static_folder=str(STATIC_DIR))
app.config["JSON_AS_ASCII"] = False


# ── Static ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(str(STATIC_DIR), "index.html")


@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory(str(STATIC_DIR), path)


# ── Sessions ──────────────────────────────────────────────────────────────────

@app.route("/api/sessions", methods=["GET"])
def list_sessions():
    conn = db.get_db()
    try:
        total = conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
        rows = conn.execute(
            """
            SELECT s.*,
                   COUNT(DISTINCT CASE WHEN a.compliance != 'not_checked' THEN a.question_id END) AS answered_count
            FROM sessions s
            LEFT JOIN answers a ON a.session_id = s.id
            WHERE s.status = 'active'
            GROUP BY s.id
            ORDER BY s.updated_at DESC
            """
        ).fetchall()
        return jsonify([{**dict(r), "total_questions": total} for r in rows])
    finally:
        conn.close()


@app.route("/api/sessions", methods=["POST"])
def create_session():
    data = request.json or {}
    now = db.utcnow()
    conn = db.get_db()
    try:
        cur = conn.execute(
            "INSERT INTO sessions (name, description, created_at, updated_at) VALUES (?,?,?,?)",
            (data.get("name", "Новая сессия"), data.get("description", ""), now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM sessions WHERE id=?", (cur.lastrowid,)).fetchone()
        return jsonify(dict(row)), 201
    finally:
        conn.close()


@app.route("/api/sessions/<int:sid>", methods=["PUT"])
def update_session(sid):
    data = request.json or {}
    now = db.utcnow()
    conn = db.get_db()
    try:
        conn.execute(
            "UPDATE sessions SET name=?, description=?, status=?, updated_at=? WHERE id=?",
            (data.get("name"), data.get("description", ""), data.get("status", "active"), now, sid),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        return jsonify(dict(row))
    finally:
        conn.close()


# ── Questions ─────────────────────────────────────────────────────────────────

@app.route("/api/questions", methods=["GET"])
def list_questions():
    process = request.args.get("process")
    mandatory_only = request.args.get("mandatory") == "1"
    session_id = request.args.get("session_id", type=int)
    unanswered_only = request.args.get("unanswered") == "1"
    review_only = request.args.get("review") == "1"

    where, params = [], []

    if process and process != "ALL":
        where.append("q.process_code = ?")
        params.append(process)

    if mandatory_only:
        where.append("q.mandatory = 'обязательный'")

    if session_id and unanswered_only:
        where.append(
            "NOT EXISTS (SELECT 1 FROM answers a "
            "WHERE a.session_id=? AND a.question_id=q.id AND a.compliance!='not_checked')"
        )
        params.append(session_id)

    if session_id and review_only:
        where.append(
            "EXISTS (SELECT 1 FROM answers a "
            "WHERE a.session_id=? AND a.question_id=q.id AND a.review_flag=1)"
        )
        params.append(session_id)

    sql = "SELECT q.* FROM questions q"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY q.process_code, q.question_number"

    conn = db.get_db()
    try:
        rows = conn.execute(sql, params).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@app.route("/api/questions/<qid>", methods=["GET"])
def get_question(qid):
    conn = db.get_db()
    try:
        row = conn.execute("SELECT * FROM questions WHERE id=?", (qid,)).fetchone()
        return (jsonify(dict(row)) if row else (jsonify({"error": "not found"}), 404))
    finally:
        conn.close()


# ── Answers ───────────────────────────────────────────────────────────────────

@app.route("/api/answers", methods=["GET"])
def get_answers():
    session_id = request.args.get("session_id", type=int)
    question_id = request.args.get("question_id")

    if not session_id:
        return jsonify({"error": "session_id required"}), 400

    conn = db.get_db()
    try:
        if question_id:
            row = conn.execute(
                "SELECT * FROM answers WHERE session_id=? AND question_id=?",
                (session_id, question_id),
            ).fetchone()
            return jsonify(dict(row) if row else None)

        rows = conn.execute(
            """
            SELECT a.*, q.process_code, q.process_name, q.question_number,
                   q.question_text, q.mandatory, q.priority, q.title_short
            FROM answers a
            JOIN questions q ON a.question_id = q.id
            WHERE a.session_id = ?
            ORDER BY q.process_code, q.question_number
            """,
            (session_id,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@app.route("/api/answers", methods=["POST"])
def save_answer():
    data = request.json or {}
    session_id = data.get("session_id")
    question_id = data.get("question_id")

    if not session_id or not question_id:
        return jsonify({"error": "session_id and question_id required"}), 400

    now = db.utcnow()
    conn = db.get_db()
    try:
        existing = conn.execute(
            "SELECT answered_at FROM answers WHERE session_id=? AND question_id=?",
            (session_id, question_id),
        ).fetchone()

        answered_at = existing["answered_at"] if existing else None
        compliance = data.get("compliance", "not_checked")
        # Record first-answered timestamp when compliance is set
        if not answered_at and compliance != "not_checked":
            answered_at = now

        conn.execute(
            """
            INSERT INTO answers
                (session_id, question_id, answer_text, compliance, score,
                 comment, review_flag, answered_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(session_id, question_id) DO UPDATE SET
                answer_text = excluded.answer_text,
                compliance  = excluded.compliance,
                score       = excluded.score,
                comment     = excluded.comment,
                review_flag = excluded.review_flag,
                answered_at = COALESCE(answers.answered_at, excluded.answered_at),
                updated_at  = excluded.updated_at
            """,
            (
                session_id, question_id,
                data.get("answer_text", ""),
                compliance,
                data.get("score"),
                data.get("comment", ""),
                1 if data.get("review_flag") else 0,
                answered_at, now,
            ),
        )
        conn.execute(
            "UPDATE sessions SET updated_at=? WHERE id=?", (now, session_id)
        )
        conn.commit()

        row = conn.execute(
            "SELECT * FROM answers WHERE session_id=? AND question_id=?",
            (session_id, question_id),
        ).fetchone()
        return jsonify(dict(row))
    finally:
        conn.close()


# ── Progress ──────────────────────────────────────────────────────────────────

@app.route("/api/progress/<int:session_id>", methods=["GET"])
def get_progress(session_id):
    conn = db.get_db()
    try:
        processes = conn.execute(
            """
            SELECT q.process_code, q.process_name,
                   COUNT(DISTINCT q.id)                                                               AS total,
                   COUNT(DISTINCT CASE WHEN a.compliance NOT IN ('not_checked') AND a.compliance IS NOT NULL THEN q.id END) AS answered,
                   COUNT(DISTINCT CASE WHEN a.compliance='compliant'     THEN q.id END)               AS compliant,
                   COUNT(DISTINCT CASE WHEN a.compliance='partial'       THEN q.id END)               AS partial,
                   COUNT(DISTINCT CASE WHEN a.compliance='non_compliant' THEN q.id END)               AS non_compliant,
                   COUNT(DISTINCT CASE WHEN a.compliance='na'            THEN q.id END)               AS na
            FROM questions q
            LEFT JOIN answers a ON a.question_id = q.id AND a.session_id = ?
            GROUP BY q.process_code, q.process_name
            ORDER BY q.process_code
            """,
            (session_id,),
        ).fetchall()

        total = conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
        answered = conn.execute(
            "SELECT COUNT(*) FROM answers WHERE session_id=? AND compliance!='not_checked'",
            (session_id,),
        ).fetchone()[0]
        review_count = conn.execute(
            "SELECT COUNT(*) FROM answers WHERE session_id=? AND review_flag=1",
            (session_id,),
        ).fetchone()[0]

        return jsonify(
            {
                "total": total,
                "answered": answered,
                "review_count": review_count,
                "processes": [dict(p) for p in processes],
            }
        )
    finally:
        conn.close()


# ── App state ─────────────────────────────────────────────────────────────────

@app.route("/api/state", methods=["GET"])
def get_state():
    conn = db.get_db()
    try:
        rows = conn.execute("SELECT key, value FROM app_state").fetchall()
        return jsonify({r["key"]: r["value"] for r in rows})
    finally:
        conn.close()


@app.route("/api/state", methods=["POST"])
def set_state():
    data = request.json or {}
    conn = db.get_db()
    try:
        for key, value in data.items():
            conn.execute(
                "INSERT INTO app_state(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)),
            )
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


# ── Export ────────────────────────────────────────────────────────────────────

@app.route("/api/export/<int:session_id>", methods=["GET"])
def export_csv(session_id):
    conn = db.get_db()
    try:
        session = conn.execute(
            "SELECT * FROM sessions WHERE id=?", (session_id,)
        ).fetchone()
        if not session:
            return jsonify({"error": "session not found"}), 404

        rows = conn.execute(
            """
            SELECT s.id AS session_id, s.name AS session_name,
                   q.id AS question_id, q.process_code, q.process_name,
                   q.question_number, q.question_text, q.mandatory,
                   q.priority, q.weight, q.gost_code, q.standard_ref,
                   q.expected_evidence,
                   COALESCE(a.compliance, 'not_checked') AS compliance,
                   a.score, a.answer_text, a.comment,
                   COALESCE(a.review_flag, 0)            AS review_flag,
                   a.answered_at, a.updated_at
            FROM questions q
            CROSS JOIN sessions s
            LEFT JOIN answers a ON a.question_id=q.id AND a.session_id=s.id
            WHERE s.id=?
            ORDER BY q.process_code, q.question_number
            """,
            (session_id,),
        ).fetchall()

        output = io.StringIO()
        writer = csv.writer(output, delimiter=";")
        writer.writerow(
            [
                "session_id", "session_name", "question_id", "process_code",
                "process_name", "question_number", "question_text", "mandatory",
                "priority", "weight", "gost_code", "standard_ref",
                "compliance", "score", "answer_text", "comment",
                "review_flag", "answered_at", "updated_at", "expected_evidence",
            ]
        )
        for r in rows:
            writer.writerow(
                [
                    r["session_id"], r["session_name"], r["question_id"],
                    r["process_code"], r["process_name"], r["question_number"],
                    r["question_text"], r["mandatory"], r["priority"], r["weight"],
                    r["gost_code"], r["standard_ref"], r["compliance"],
                    r["score"] or "", r["answer_text"] or "", r["comment"] or "",
                    r["review_flag"], r["answered_at"] or "", r["updated_at"] or "",
                    r["expected_evidence"] or "",
                ]
            )

        safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in session["name"])
        filename = f"survey_{safe_name}_{session_id}.csv"

        return Response(
            "\ufeff" + output.getvalue(),  # UTF-8 BOM for Excel
            mimetype="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    finally:
        conn.close()


# ── Import status ─────────────────────────────────────────────────────────────

@app.route("/api/import-status", methods=["GET"])
def import_status():
    conn = db.get_db()
    try:
        count = conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
        return jsonify({"imported": count > 0, "count": count})
    finally:
        conn.close()


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    db.init_db()

    if not db.is_imported():
        csv_path = importer.find_csv()
        if csv_path:
            n = importer.import_csv(csv_path)
            print(f"[OK] Импортировано {n} вопросов из {csv_path}")
        else:
            print("[!] oprosnik.csv не найден — поместите файл рядом с main.py")

    threading.Timer(1.0, lambda: webbrowser.open("http://localhost:5000")).start()
    print("[*] ITSM Survey Tool -> http://localhost:5000")
    app.run(debug=False, port=5000, host="127.0.0.1")
