"""③（学童ごとの給与明細シート）の先生シートを走査して、氏名インデックスを作る。

SPEC.md「名前 → ③ファイルの紐付けルール」:
- 除外シート: ★常勤 ☆非常勤 一覧 給与 未入力*
- シート名先頭の「◎」は名前の一部ではない
- 同じ名前のシートが複数ファイルにあるとき、タブ色が赤(FFFF0000)のシートは
  「使っていないシート」なのでインデックスから除外する
"""

from __future__ import annotations

import glob
import os
from dataclasses import dataclass

import openpyxl

from . import textutil as tu

EXCLUDE_SHEETS = {"★常勤", "☆非常勤", "一覧", "給与", "合計", "設定"}
EXCLUDE_PREFIXES = ("未入力",)


@dataclass(frozen=True)
class SheetRef:
    """③のどのファイルのどのシートか。"""

    path: str
    sheet: str
    person: str      # 正規化済みの氏名
    red_tab: bool    # 赤タブ＝使っていないシート

    @property
    def filename(self) -> str:
        return os.path.basename(self.path)

    def __str__(self) -> str:
        return f"{self.filename}!{self.sheet}"


def is_red_tab(ws) -> bool:
    """シートタブが赤かどうか。赤タブは「使っていないシート」。"""
    color = getattr(ws.sheet_properties, "tabColor", None)
    rgb = getattr(color, "rgb", None) if color is not None else None
    if not isinstance(rgb, str) or len(rgb) < 6:
        return False
    r, g, b = (int(rgb[-6:][i:i + 2], 16) for i in (0, 2, 4))
    return r >= 0xC0 and g <= 0x40 and b <= 0x40


def is_person_sheet(sheet_name: str) -> bool:
    name = sheet_name.strip()
    if name in EXCLUDE_SHEETS or any(name.startswith(p) for p in EXCLUDE_PREFIXES):
        return False
    return bool(tu.normalize_person(name))


class KintaiIndex:
    """③ファイル群の氏名インデックス。"""

    def __init__(self):
        self.refs: list[SheetRef] = []
        self.by_person: dict[str, list[SheetRef]] = {}

    @classmethod
    def build(cls, paths: list[str]) -> "KintaiIndex":
        index = cls()
        for path in paths:
            wb = openpyxl.load_workbook(path, data_only=True, keep_vba=path.endswith(".xlsm"))
            for sheet in wb.sheetnames:
                if not is_person_sheet(sheet):
                    continue
                ref = SheetRef(
                    path=path,
                    sheet=sheet,
                    person=tu.normalize_person(sheet),
                    red_tab=is_red_tab(wb[sheet]),
                )
                index.refs.append(ref)
            wb.close()
        for ref in index.refs:
            if not ref.red_tab:
                index.by_person.setdefault(ref.person, []).append(ref)
        return index

    @classmethod
    def from_dir(cls, directory: str, pattern: str = "*.xls[xm]") -> "KintaiIndex":
        paths = sorted(
            p for p in glob.glob(os.path.join(directory, pattern))
            if not os.path.basename(p).startswith("~$")
        )
        return cls.build(paths)

    # ------------------------------------------------------------ 照合

    def resolve(self, person: str, file_hint: str | None = None) -> tuple[SheetRef | None, str]:
        """氏名から書き込み先シートを1つに決める。

        file_hint（③のファイル名の一部）を渡すと、そのファイルの中だけで探す。
        同名の先生が複数ファイルにいる場合に、固定シフト設定から指定するために使う。
        戻り値は (シート参照, 理由)。決まらない場合は (None, 理由)。
        """
        key = tu.normalize_person(person)
        if not key:
            return None, "氏名が空"

        if file_hint:
            return self._resolve_in_file(key, file_hint)

        exact = self.by_person.get(key, [])
        if len(exact) == 1:
            return exact[0], "氏名完全一致"
        if len(exact) > 1:
            places = " / ".join(str(r) for r in exact)
            return None, f"同名シートが複数（赤タブ除外後も重複）: {places}"

        # 姓のみ・フルネームの揺れを部分一致で救済する
        partial = [
            refs[0] for name, refs in self.by_person.items()
            if len(refs) == 1 and (key in name or name in key)
        ]
        if len(partial) == 1:
            return partial[0], f"部分一致（③シート名「{partial[0].sheet}」）"
        if len(partial) > 1:
            places = " / ".join(str(r) for r in partial)
            return None, f"部分一致の候補が複数: {places}"
        return None, "③に該当シートなし"

    def _resolve_in_file(self, key: str, file_hint: str) -> tuple[SheetRef | None, str]:
        """③ファイル名に file_hint を含むファイルの中だけで氏名を探す。"""
        hint = tu.normalize(file_hint)
        in_file = [r for r in self.refs if not r.red_tab and hint in tu.normalize(r.filename)]
        if not in_file:
            return None, f"「{file_hint}」を含む③ファイルが見つからない"

        exact = [r for r in in_file if r.person == key]
        if len(exact) == 1:
            return exact[0], f"氏名完全一致（{file_hint} 指定）"
        if len(exact) > 1:
            return None, "同名シートが複数: " + " / ".join(str(r) for r in exact)

        partial = [r for r in in_file if key in r.person or r.person in key]
        if len(partial) == 1:
            return partial[0], f"部分一致（{file_hint} 内の「{partial[0].sheet}」）"
        if len(partial) > 1:
            return None, "部分一致の候補が複数: " + " / ".join(str(r) for r in partial)
        return None, f"「{file_hint}」の中に該当シートなし"

    # ------------------------------------------------------------ 点検用

    def duplicates(self) -> dict[str, list[SheetRef]]:
        """赤タブ除外後も同名シートが複数残っているもの（要確認）。"""
        return {name: refs for name, refs in self.by_person.items() if len(refs) > 1}

    def red_tabs(self) -> list[SheetRef]:
        return [ref for ref in self.refs if ref.red_tab]
