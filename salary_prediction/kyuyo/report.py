"""確認用レポートの出力（事務の方の目視チェック用）。

「誰の・どの日を・どう解釈して埋めたか」を必ず出してから③に書き込む、という
運用にするための出力（SPEC.md「まだ確認・検証が済んでいないこと」7.）。
"""

from __future__ import annotations

import csv
import os
from collections import Counter

from .kintai_index import KintaiIndex
from .plan import WritePlan

CSV_HEADER = [
    "日", "氏名", "状態", "理由", "書き込み先ファイル", "シート", "行",
    "出勤", "退勤", "休憩(分)", "特記", "元のセル", "読み取り元", "解釈", "警告",
]


def _row(plan: WritePlan) -> list[str]:
    return [
        plan.day,
        plan.person,
        {"write": "書き込み", "review": "要確認", "skip": "スキップ"}.get(plan.status, plan.status),
        plan.reason,
        plan.ref.filename if plan.ref else "",
        plan.ref.sheet if plan.ref else "",
        plan.row or "",
        f"{plan.start:%H:%M}" if plan.start else "",
        f"{plan.end:%H:%M}" if plan.end else "",
        plan.break_minutes if plan.break_minutes else "",
        plan.note or "",
        " / ".join(plan.raws).replace("\n", "␤"),
        " / ".join(plan.sources),
        " / ".join(plan.notes),
        " / ".join(plan.warnings),
    ]


def write_csv(plans: list[WritePlan], path: str) -> str:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(CSV_HEADER)
        for plan in sorted(plans, key=lambda p: (p.person, p.day)):
            writer.writerow(_row(plan))
    return path


def render_markdown(plans: list[WritePlan], title: str = "給与予測 転記レポート") -> str:
    counts = Counter(p.status for p in plans)
    lines = [
        f"# {title}",
        "",
        f"- 書き込み予定: **{counts.get('write', 0)}件**",
        f"- 要確認: **{counts.get('review', 0)}件**",
        f"- スキップ: {counts.get('skip', 0)}件",
        "",
        "> 給与に関わるデータのため、③・②に反映する前に必ず事務の方が目視確認してください。",
        "",
    ]

    review = [p for p in plans if p.status == "review"]
    if review:
        lines += ["## 要確認（自動では判断できなかったもの）", "",
                  "| 日 | 氏名 | 元のセル | 読み取り元 | 内容 |", "|---|---|---|---|---|"]
        for p in sorted(review, key=lambda p: (p.day, p.person)):
            raw = " / ".join(p.raws).replace("\n", "␤").replace("|", "\\|")
            detail = "; ".join(p.warnings) or p.reason
            lines.append(f"| {p.day} | {p.person or '(不明)'} | {raw} | {' / '.join(p.sources)} | {detail} |")
        lines.append("")

    write_plans = [p for p in plans if p.status == "write"]
    if write_plans:
        lines += ["## 書き込み予定", "",
                  "| 日 | 氏名 | 書き込み先 | 行 | 内容 | 元のセル |", "|---|---|---|---|---|---|"]
        for p in sorted(write_plans, key=lambda p: (p.person, p.day)):
            raw = " / ".join(p.raws).replace("\n", "␤").replace("|", "\\|")
            lines.append(f"| {p.day} | {p.person} | {p.ref} | {p.row} | {p.summary} | {raw} |")
        lines.append("")

    return "\n".join(lines)


def write_markdown(plans: list[WritePlan], path: str, title: str = "給与予測 転記レポート") -> str:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(render_markdown(plans, title))
    return path


def render_index(index: KintaiIndex) -> str:
    lines = [
        "# ③ 氏名インデックス",
        "",
        f"- 有効な先生シート: {len(index.by_person)}名 / 全{len(index.refs)}シート",
        f"- 赤タブ（使っていないシート）として除外: {len(index.red_tabs())}シート",
        "",
    ]
    dups = index.duplicates()
    if dups:
        lines += ["## ⚠ 同名シートが複数残っている（要確認）", ""]
        for name, refs in sorted(dups.items()):
            lines.append(f"- {name}: " + " / ".join(str(r) for r in refs))
        lines.append("")
    lines += ["## 氏名 → シート", ""]
    for name, refs in sorted(index.by_person.items()):
        lines.append(f"- {name}: {refs[0]}")
    if index.red_tabs():
        lines += ["", "## 赤タブ（除外）", ""]
        for ref in sorted(index.red_tabs(), key=str):
            lines.append(f"- {ref}")
    return "\n".join(lines) + "\n"
