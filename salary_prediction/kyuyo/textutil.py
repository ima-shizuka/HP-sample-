"""①シフト表のセル文字列を解釈するための共通ユーティリティ。

①のセルは表記ゆれが非常に多い（SPEC.md「①シフト表の読み取りルール」参照）ため、
- 全角/半角の統一
- 時刻レンジの抽出（区切り文字・コロンの表記ゆれ、コロン省略に対応）
- 休み系キーワードの分類
- 学童名の正規化（「豊岡南①」「豊岡南1」「豊岡南小」を同一視する）
をここに集約している。
"""

from __future__ import annotations

import datetime
import re
import unicodedata

# ---------------------------------------------------------------- 文字列の正規化

# 丸数字 → 半角数字（「豊岡南①」→「豊岡南1」）
_CIRCLED = {
    "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5",
    "⑥": "6", "⑦": "7", "⑧": "8", "⑨": "9", "⑩": "10",
}

# 時刻レンジの区切り文字（ハイフン系・波ダッシュ系・全角チルダ等すべて）
_SEP = "-‐‑‒–—―ーｰ〜～~－"

# T列（特記）にそのまま書き込む欠勤系キーワード。表記ゆれ → 正規キーワード
ABSENCE_KEYWORDS = {
    "有休": "有休",
    "有給": "有休",
    "有": "有休",
    "欠勤": "欠勤",
    "欠": "欠勤",
    "休出": "休出",
    "慶弔": "慶弔",
    "休業": "休業",
    "特別休暇": "慶弔",
}

# 「その日は何も書かない」休みの表記（完全一致で判定するもの）
HOLIDAY_EXACT = {"休", "×", "✕", "✖", "x", "X", "ｘ", "Ｘ", "/", "／", "-", "ー", "―", "休み", "公休"}

# 「その日は何も書かない」休みの表記（部分一致で判定するもの）
HOLIDAY_CONTAINS = ("お盆休", "夏休み", "冬休み", "年末年始", "休園", "閉所")


def normalize(text) -> str:
    """セル値を比較・正規表現向けに正規化する。

    - NFKC で全角英数・全角コロン・全角スペースを半角へ
    - 丸数字を半角数字へ
    - 前後の空白除去（改行は分割に使うので保持する）
    """
    if text is None:
        return ""
    if isinstance(text, datetime.time):
        return f"{text.hour}:{text.minute:02d}"
    if isinstance(text, datetime.datetime):
        return f"{text.hour}:{text.minute:02d}"
    s = str(text)
    s = unicodedata.normalize("NFKC", s)
    for k, v in _CIRCLED.items():
        s = s.replace(k, v)
    # NFKC でも波ダッシュ類は残るので、行内の余分な空白だけ整える
    s = "　".join(part for part in s.split("　"))
    return "\n".join(line.strip() for line in s.splitlines()).strip()


# ---------------------------------------------------------------- 時刻レンジの抽出

_TOKEN = r"(?:\d{3,4}|\d{1,2}(?::\d{2})?)"
RANGE_RE = re.compile(rf"(?P<start>{_TOKEN})\s*[{_SEP}]\s*(?P<end>{_TOKEN})")


def parse_clock(token: str) -> datetime.time | None:
    """"13:00" / "1300" / "830" / "13" を datetime.time に変換する。

    コロンが無い 3〜4 桁は下 2 桁を分として解釈する（「1800」→18:00、「830」→8:30）。
    1〜2 桁だけの場合は「時」のみの指定として分 0 で解釈する（「13-18」→13:00-18:00）。
    """
    token = token.strip()
    if ":" in token:
        h_s, m_s = token.split(":", 1)
        h, m = int(h_s), int(m_s)
    elif len(token) >= 3:
        h, m = int(token[:-2]), int(token[-2:])
    elif token.isdigit():
        h, m = int(token), 0
    else:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return datetime.time(h, m)


def parse_time_ranges(text) -> list[tuple[datetime.time, datetime.time]]:
    """文字列に含まれる時刻レンジをすべて返す。

    分割シフト（1セルに改行で2回勤務が入っている）に対応するため、
    リストで返す（例:「鍵屋7:30〜11:00\\n15:30〜18:00」→ 2件）。
    """
    s = normalize(text)
    if not s:
        return []
    ranges: list[tuple[datetime.time, datetime.time]] = []
    for m in RANGE_RE.finditer(s):
        start = parse_clock(m.group("start"))
        end = parse_clock(m.group("end"))
        if start is None or end is None:
            continue
        ranges.append((start, end))
    return ranges


def strip_time_ranges(text) -> str:
    """時刻レンジを取り除いた残りの文字列（名前・行き先の候補）を返す。"""
    s = normalize(text)
    s = RANGE_RE.sub(" ", s)
    s = re.sub(r"[（(].*?[)）]", " ", s)
    return re.sub(r"[\s、,･・]+", " ", s).strip()


def minutes_between(start: datetime.time, end: datetime.time) -> int:
    """start→end の分数。日付をまたぐ想定は無いので end<=start は 0 とする。"""
    a = start.hour * 60 + start.minute
    b = end.hour * 60 + end.minute
    return max(b - a, 0)


# ---------------------------------------------------------------- 休み系の判定

def match_absence(text) -> str | None:
    """T列に書き込む欠勤系キーワード（有休・欠勤等）を返す。該当なしは None。"""
    s = normalize(text).replace(" ", "")
    if not s:
        return None
    if s in ABSENCE_KEYWORDS:
        return ABSENCE_KEYWORDS[s]
    # 「有休(午前)」「欠勤扱い」など前後に文字が付くケース。長いキーワードから判定する
    for word in sorted(ABSENCE_KEYWORDS, key=len, reverse=True):
        if len(word) >= 2 and word in s:
            return ABSENCE_KEYWORDS[word]
    return None


def is_holiday_mark(text) -> bool:
    """「休」「×」「お盆休み」等、③に何も書かない休みの表記かどうか。"""
    s = normalize(text).replace(" ", "")
    if not s:
        return False
    if s in HOLIDAY_EXACT:
        return True
    return any(word in s for word in HOLIDAY_CONTAINS)


# ---------------------------------------------------------------- 学童名の正規化

_GAKUDO_SUFFIX_RE = re.compile(r"(小学校|小|学童|児童クラブ|クラブ|放課後)+$")


def normalize_gakudo(name) -> tuple[str, int | None]:
    """学童名を (基本名, 枝番) に正規化する。

    「豊岡南①」「豊岡南1」「豊岡南小1」→ ("豊岡南", 1)
    「岩田小」「岩田」                  → ("岩田", None)
    「豊田北部①〜③」                  → ("豊田北部", 1)  ※先頭の枝番を採用
    """
    s = normalize(name)
    s = re.sub(rf"[{_SEP}]", "", s)
    s = re.sub(r"[（(].*?[)）]", "", s)
    s = s.replace(" ", "").replace("　", "")
    m = re.search(r"(\d+)\D*$", s)
    branch = int(m.group(1)) if m else None
    base = re.sub(r"\d+\D*$", "", s) if m else s
    base = _GAKUDO_SUFFIX_RE.sub("", base)
    return base, branch


def gakudo_key(name) -> str:
    """学童名の照合キー（枝番を落とした基本名）。"""
    return normalize_gakudo(name)[0]


# ---------------------------------------------------------------- 氏名の正規化

_HONORIFIC_RE = re.compile(r"(さん|先生|センセイ|様)$")


def normalize_person(name) -> str:
    """氏名の照合キー。空白・敬称・シート名先頭の「◎」を除去する。"""
    s = normalize(name)
    s = s.lstrip("◎○●◯☆★").strip()
    s = s.replace(" ", "").replace("　", "")
    s = _HONORIFIC_RE.sub("", s)
    return s


# セル内に埋め込まれた氏名（漢字・かなの 2〜6 文字）。行き先の学童名も同じ形なので、
# 学童名リストと突き合わせて「人名か行き先か」を後段で判定する。
NAME_RE = re.compile(r"[一-龥ぁ-んァ-ヶ][一-龥ぁ-んァ-ヶー々]{1,5}")


# 名前抽出の前に取り除く休み系キーワード（2文字以上のみ。1文字だと氏名を壊すため）
_KEYWORD_STRIP_RE = re.compile(
    "|".join(
        re.escape(w) for w in sorted(
            {w for w in ABSENCE_KEYWORDS if len(w) >= 2}
            | {w for w in HOLIDAY_EXACT if len(w) >= 2}
            | set(HOLIDAY_CONTAINS),
            key=len,
            reverse=True,
        )
    )
)


def extract_name_candidates(text) -> list[str]:
    """時刻・休み系キーワードを除いた残り文字列から、氏名 or 学童名の候補を抽出する。"""
    rest = _KEYWORD_STRIP_RE.sub(" ", strip_time_ranges(text))
    candidates = [m.group(0) for m in NAME_RE.finditer(rest)]
    return [c for c in candidates if c not in ABSENCE_KEYWORDS and not is_holiday_mark(c)]
