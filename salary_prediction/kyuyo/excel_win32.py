"""pywin32 を使って Excel を直接操作するユーティリティ。

openpyxl のキャッシュ問題を回避し、セルに値を書き込むと自動で計算される。
"""

from __future__ import annotations

import os
from datetime import time


def _get_excel_instance():
    """Excel の COM インスタンスを取得。既に起動していれば再利用。"""
    try:
        import win32com.client as win32
        excel = win32.GetObject(Class="Excel.Application")
        return excel
    except Exception:
        import win32com.client as win32
        excel = win32.Dispatch("Excel.Application")
        excel.Visible = False
        return excel


class ExcelWorkbook:
    """pywin32 を使った Excel ファイル操作。"""

    def __init__(self, filepath: str):
        self.filepath = os.path.abspath(filepath)
        self.excel = _get_excel_instance()
        self.workbook = None
        self.worksheets = {}

    def open(self):
        """Excel ファイルを開く。"""
        if self.workbook is None:
            self.workbook = self.excel.Workbooks.Open(self.filepath)

    def close(self, save: bool = False):
        """Excel ファイルを閉じる。"""
        if self.workbook:
            if save:
                self.workbook.Save()
            self.workbook.Close(SaveChanges=False)
            self.workbook = None
            self.worksheets.clear()

    def save(self):
        """Excel ファイルを保存（数式も自動で再計算される）。"""
        if self.workbook:
            self.workbook.Save()

    def get_sheet(self, sheet_name: str):
        """シートを取得（キャッシュ）。"""
        if sheet_name not in self.worksheets:
            if not self.workbook:
                self.open()
            try:
                self.worksheets[sheet_name] = self.workbook.Sheets(sheet_name)
            except Exception as e:
                raise KeyError(f"シート '{sheet_name}' が見つかりません: {e}")
        return self.worksheets[sheet_name]

    def get_cell_value(self, sheet_name: str, row: int, col: int):
        """セルの値を読み込む。"""
        ws = self.get_sheet(sheet_name)
        return ws.Cells(row, col).Value

    def set_cell_value(self, sheet_name: str, row: int, col: int, value):
        """セルに値を書き込む。"""
        ws = self.get_sheet(sheet_name)
        cell = ws.Cells(row, col)

        if isinstance(value, time):
            # 時刻型を Excel の時刻形式で書き込む
            cell.Value = value
            cell.NumberFormat = "h:mm"
        else:
            cell.Value = value

    def set_cell_formula(self, sheet_name: str, row: int, col: int, formula: str):
        """セルに数式を書き込む。"""
        ws = self.get_sheet(sheet_name)
        ws.Cells(row, col).Formula = formula

    def get_range_values(self, sheet_name: str, start_row: int, end_row: int, col: int) -> list:
        """範囲のセル値をリストで取得。"""
        ws = self.get_sheet(sheet_name)
        values = []
        for row in range(start_row, end_row + 1):
            values.append(ws.Cells(row, col).Value)
        return values

    def is_filled(self, sheet_name: str, row: int, cols: list[int]) -> bool:
        """指定した列のいずれかにデータが入っているか確認。"""
        ws = self.get_sheet(sheet_name)
        for col in cols:
            v = ws.Cells(row, col).Value
            if v is not None and str(v).strip() != "":
                return True
        return False

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.save()
        self.close()
