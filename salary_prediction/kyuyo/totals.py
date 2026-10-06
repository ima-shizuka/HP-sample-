"""③（学童ごとの給与明細シート）→ ②（全社集計xlsm）の集計・転記。

pywin32 を使って Excel を直接操作。元のExcel VBAをそのまま移植したロジック
（SPEC.md「③→②の集計転記ロジック（確定・検証済み）」）。
「給与」シートの数式は自動で計算されるため、キャッシュ問題がない。
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field

from .excel_win32 import ExcelWorkbook
from . import textutil as tu

SALARY_SHEET = "給与"
BLOCK_START_ROW = 8
BLOCK_MAX_ROW = 1000

# ②の書き込み開始行（「磐田」は73行目と判明済み。「浜松」は要確認）
SUMMARY_START_ROWS = {"磐田": 73, "浜松": 73}


@dataclass
class GakudoTotals:
    """③1ファイル（＝1学童）分の事業所合計。"""

    path: str
    aa_salary: float = 0.0      # 給与（処遇改善除く） → ②E列
    bb_kaizen: float = 0.0      # 処遇改善手当           → ②F列
    cc_transit: float = 0.0     # 交通費                 → ②G列
    blocks: list[dict] = field(default_factory=list)  # 先生ごとの内訳（検算用）

    @property
    def filename(self) -> str:
        return os.path.basename(self.path)


def _is_error_value(v) -> bool:
    """Excel のエラー値かどうか（VBAのIsError相当）。"""
    return isinstance(v, str) and v.startswith("#")


def _num(v) -> float:
    if v is None or _is_error_value(v):
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def compute_gakudo_totals(kintai_path: str, sheet_name: str = SALARY_SHEET) -> GakudoTotals:
    """③1ファイル分の「給与」シートから aa/bb/cc を求める。

    「給与」シートは先生ごとに約13〜14行の繰り返しブロックで、各ブロックは
    B列に「名前」が現れる行から始まる。i を「名前」の次の行に進めてから相対参照する。

        a = B(i+6)                       基本給
        b = G(i+8)                       処遇改善
        c = B(i+10) + C(i+10)            非税通勤 + 課税通勤
        if E(i+5) == "法定内残":          ※正社員テンプレートのみ存在する項目
            a += E(i+6)   法定内残
            a += I(i+6)   業務手当
            a += H(i+8)   残業手当
            a -= F(i+10)  不労控除
            a += K(i+6)   休業手当
            a = max(a, 0)
    """
    wb = ExcelWorkbook(kintai_path)
    try:
        wb.open()
        try:
            ws = wb.get_sheet(sheet_name)
        except KeyError:
            raise KeyError(f"{os.path.basename(kintai_path)} に「{sheet_name}」シートがありません")

        def cell(r, c):
            return wb.get_cell_value(sheet_name, r, c)

        totals = GakudoTotals(path=kintai_path)
        saw_block = False
        saw_value = False

        i = BLOCK_START_ROW
        while i <= BLOCK_MAX_ROW:
            if cell(i, 2) == "名前":
                saw_block = True
                label_row = i
                i += 1

                a = _num(cell(i + 6, 2))                                  # 基本給
                b = _num(cell(i + 8, 7))                                  # 処遇改善
                c = _num(cell(i + 10, 2)) + _num(cell(i + 10, 3))         # 非税通勤+課税通勤

                if cell(i + 5, 5) == "法定内残":                          # 正社員テンプレート
                    a += _num(cell(i + 6, 5))    # 法定内残
                    a += _num(cell(i + 6, 9))    # 業務手当
                    a += _num(cell(i + 8, 8))    # 残業手当
                    a -= _num(cell(i + 10, 6))   # 不労控除
                    a += _num(cell(i + 6, 11))   # 休業手当
                    a = max(a, 0.0)

                if a or b or c:
                    saw_value = True

                # 氏名は「名前」ラベルの右か下に入っていることが多い（内訳表示用の参考情報）
                name = None
                for candidate in (cell(label_row, 3), cell(i, 2), cell(i, 3)):
                    if isinstance(candidate, str) and tu.normalize_person(candidate):
                        name = tu.normalize_person(candidate)
                        break

                totals.aa_salary += a
                totals.bb_kaizen += b
                totals.cc_transit += c
                totals.blocks.append({"row": label_row, "名前": name, "給与": a, "処遇改善": b, "交通費": c})
            i += 1

        return totals
    finally:
        wb.close(save=False)


def write_to_summary(
    summary_path: str,
    area_sheet: str,
    rows: dict[str, GakudoTotals],
    start_row: int | None = None,
    output_path: str | None = None,
    dry_run: bool = False,
) -> dict[str, str]:
    """②の area_sheet（「磐田」/「浜松」）のD列と学童名が一致する行に aa/bb/cc を書き込む。

    rows は {学童名: GakudoTotals}。戻り値は {学童名: 結果メッセージ}。
    pywin32 を使用するため、Excel がインストールされている必要があります。
    """
    if start_row is None:
        start_row = SUMMARY_START_ROWS.get(area_sheet, 73)

    dest = summary_path
    if output_path and output_path != summary_path and not dry_run:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        shutil.copy2(summary_path, output_path)
        dest = output_path

    wb = ExcelWorkbook(dest)
    try:
        if not dry_run:
            wb.open()
        else:
            # dry_run の場合は Excel を開かずに処理
            pass

        wanted = {tu.gakudo_key(name): (name, totals) for name, totals in rows.items()}
        results = {name: "②に一致する行が見つかりません" for name in rows}

        row = start_row
        while True:
            first_col_value = wb.get_cell_value(area_sheet, row, 1) if not dry_run else None
            if not dry_run and first_col_value in (None, ""):
                break

            label = wb.get_cell_value(area_sheet, row, 4) if not dry_run else None
            key = tu.gakudo_key(label) if label else None
            if key in wanted:
                name, totals = wanted[key]
                if not dry_run:
                    wb.set_cell_value(area_sheet, row, 5, totals.aa_salary)
                    wb.set_cell_value(area_sheet, row, 6, totals.bb_kaizen)
                    wb.set_cell_value(area_sheet, row, 7, totals.cc_transit)
                results[name] = (
                    f"{area_sheet}!{row}行 に 給与={totals.aa_salary:,.0f} "
                    f"処遇改善={totals.bb_kaizen:,.0f} 交通費={totals.cc_transit:,.0f}"
                )
            row += 1
            if row > start_row + 100:  # 無限ループ防止
                break

        if not dry_run:
            wb.save()

        return results
    finally:
        wb.close(save=False)
