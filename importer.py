import csv
from pathlib import Path
import database as db


def find_csv() -> Path | None:
    base = Path(__file__).parent
    candidates = [
        base / "data" / "oprosnik.csv",
        base / "oprosnik.csv",
        base.parent / "oprosnik.csv",
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def _process_code(question_id: str) -> str:
    """DTN-ITSM-INC-01  →  INC"""
    parts = question_id.split("-")
    return parts[2] if len(parts) >= 4 else "UNKNOWN"


def import_csv(path: Path) -> int:
    conn = db.get_db()
    count = 0
    try:
        with open(path, encoding="cp1251", errors="replace") as f:
            reader = csv.reader(f, delimiter=";")
            next(reader, None)  # skip header row
            for row in reader:
                if len(row) < 13:
                    continue
                qid = row[0].strip()
                if not qid.startswith("DTN-"):
                    continue
                conn.execute(
                    """
                    INSERT OR IGNORE INTO questions
                        (id, gost_code, title_short, description, process_group,
                         standard_ref, priority, weight, mandatory, management_area,
                         process_name, process_code, question_number,
                         question_text, answer_hint, expected_evidence)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        qid,
                        row[1].strip(),
                        row[2].strip(),
                        row[3].strip(),
                        row[4].strip(),
                        row[5].strip(),
                        row[6].strip(),
                        row[7].strip(),
                        row[8].strip(),
                        row[9].strip(),
                        row[10].strip(),
                        _process_code(qid),
                        int(row[11].strip()) if row[11].strip().isdigit() else 0,
                        row[12].strip(),
                        row[13].strip() if len(row) > 13 else "",
                        row[14].strip() if len(row) > 14 else "",
                    ),
                )
                count += 1
        conn.commit()
    finally:
        conn.close()
    return count
