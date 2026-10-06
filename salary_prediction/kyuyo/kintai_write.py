"""WritePlan を実際に③（給与明細シート）へ書き込む。

pywin32 を使って Excel を直接操作。セルに値を書き込むと自動で数式が再計算される。
保存時に全ての数式が再計算されるため、手動で Excel を開く必要がない。

安全側の既定:
- 既に値が入っているセル（＝事務が中締めまでに入力済みの日）は上書きしない
- 元ファイルを直接書き換えず、出力先ディレクトリにコピーしてから書き込む
"""

from __future__ import annotations

import datetime
import os
import shutil
from dataclasses import dataclass

from .excel_win32 import ExcelWorkbook
from .plan import COL_BREAK, COL_END, COL_NOTE, COL_START, WritePlan


@dataclass
class WriteResult:
    written: int = 0
    skipped_existing: int = 0
    skipped: int = 0
    files: list[str] = None

    def __post_init__(self):
        if self.files is None:
            self.files = []


def apply_plans(
    plans: list[WritePlan],
    output_dir: str | None = None,
    overwrite_filled: bool = False,
    dry_run: bool = False,
) -> WriteResult:
    """status=="write" の計画を③に書き込む。

    pywin32 を使用するため、Excel がインストールされている必要があります。

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

        if dry_run:
            for plan in path_plans:
                result.written += 1
            continue

        wb = ExcelWorkbook(dest_path)
        try:
            wb.open()
            for plan in path_plans:
                if wb.is_filled(plan.ref.sheet, plan.row, [COL_START, COL_END, COL_NOTE]) and not overwrite_filled:
                    plan.status = "skip"
                    plan.reason = "③に入力済み（中締めまでの実績とみなして上書きしない）"
                    result.skipped_existing += 1
                    continue

                if plan.note is not None:
                    wb.set_cell_value(plan.ref.sheet, plan.row, COL_NOTE, plan.note)
                    wb.set_cell_value(plan.ref.sheet, plan.row, COL_START, None)
                    wb.set_cell_value(plan.ref.sheet, plan.row, COL_END, None)
                else:
                    wb.set_cell_value(plan.ref.sheet, plan.row, COL_START, plan.start)
                    wb.set_cell_value(plan.ref.sheet, plan.row, COL_END, plan.end)
                    if plan.break_minutes:
                        wb.set_cell_value(plan.ref.sheet, plan.row, COL_BREAK, plan.break_minutes)

                result.written += 1

            wb.save()
            result.files.append(dest_path)
        finally:
            wb.close(save=False)

    return result
