"""WritePlan を実際に③（給与明細シート）へ書き込む。

安全側の既定:
- 既に値が入っているセル（＝事務が中締めまでに入力済みの日）は上書きしない
- 元ファイルを直接書き換えず、出力先ディレクトリにコピーしてから書き込む

注意: openpyxl で保存すると数式の「キャッシュされた計算結果」が失われるため、
書き込み後の③は一度 Excel で開いて保存し直す必要がある（②への集計はその後）。
"""

from __future__ import annotations

import datetime
import os
import shutil
from dataclasses import dataclass

import openpyxl

from .plan import COL_BREAK, COL_END, COL_NOTE, COL_START, WritePlan

TIME_FORMAT = "h:mm"


@dataclass
class WriteResult:
    written: int = 0
    skipped_existing: int = 0
    skipped: int = 0
    files: list[str] = None

    def __post_init__(self):
        if self.files is None:
            self.files = []


def _set_time(ws, row: int, col: int, value: datetime.time) -> None:
    cell = ws.cell(row=row, column=col)
    cell.value = value
    if cell.number_format in (None, "General"):
        cell.number_format = TIME_FORMAT


def _is_filled(ws, row: int) -> bool:
    """その日の行に既に入力があるか（C/E/T のいずれか）。"""
    for col in (COL_START, COL_END, COL_NOTE):
        v = ws.cell(row=row, column=col).value
        if v is not None and str(v).strip() != "":
            return True
    return False


def apply_plans(
    plans: list[WritePlan],
    output_dir: str | None = None,
    overwrite_filled: bool = False,
    dry_run: bool = False,
) -> WriteResult:
    """status=="write" の計画を③に書き込む。

    output_dir を指定すると、③ファイルをそこにコピーしてから書き込む（原本を守る）。
    dry_run=True なら件数だけ数えて保存しない。
    """
    result = WriteResult()
    targets = [p for p in plans if p.status == "write" and p.ref and p.row]
    result.skipped = len(plans) - len(targets)

    by_path: dict[str, list[WritePlan]] = {}
    for plan in targets:
        by_path.setdefault(plan.ref.path, []).append(plan)

    for src_path, path_plans in sorted(by_path.items()):
        dest_path = src_path
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
            dest_path = os.path.join(output_dir, os.path.basename(src_path))
            if not dry_run:
                shutil.copy2(src_path, dest_path)

        keep_vba = dest_path.endswith(".xlsm")
        wb = openpyxl.load_workbook(dest_path if not dry_run else src_path,
                                    data_only=False, keep_vba=keep_vba)
        touched = False
        for plan in path_plans:
            ws = wb[plan.ref.sheet]
            if _is_filled(ws, plan.row) and not overwrite_filled:
                plan.status = "skip"
                plan.reason = "③に入力済み（中締めまでの実績とみなして上書きしない）"
                result.skipped_existing += 1
                continue
            if plan.note is not None:
                ws.cell(row=plan.row, column=COL_NOTE).value = plan.note
                ws.cell(row=plan.row, column=COL_START).value = None
                ws.cell(row=plan.row, column=COL_END).value = None
            else:
                _set_time(ws, plan.row, COL_START, plan.start)
                _set_time(ws, plan.row, COL_END, plan.end)
                if plan.break_minutes:
                    ws.cell(row=plan.row, column=COL_BREAK).value = plan.break_minutes
            result.written += 1
            touched = True

        if touched and not dry_run:
            wb.save(dest_path)
            result.files.append(dest_path)
        wb.close()

    return result
