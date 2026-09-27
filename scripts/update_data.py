#!/usr/bin/env python3
"""
data/raw/ içindeki ham dosyalardan data/dataset.json ve data/dataset.csv üretir.

Güncelleme için yapılması gereken tek şey, data/raw/ altındaki şu dosyaların
güncel hâlini yüklemektir:

    weekly    EVDS haftalık: TP.TRY.MT01–MT06 ve USD/EUR/GBP döviz alış-satış
    monthly   EVDS aylık:    TÜFE (TP.GENENDEKS.T1), Yİ-ÜFE (TP.TUFE1YI.T1),
                             politika faizi (TP.BISPOLFAIZ.TUR)
    gold      TradingView haftalık XAU/TRY (gram), "close" sütunu kullanılır
    stopaj    Stopaj oranları tablosu (nadiren değişir)

Uzantı serbesttir (.xlsx, .xls, .csv); dosya adının bu kelimeyle başlaması yeterli.
Bugünden ileri tarihli satırlar (tamamlanmamış hafta/ay) atılır.

Kullanım (repo kök dizininde):
    pip install pandas openpyxl
    python scripts/update_data.py
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT_JSON = ROOT / "data" / "dataset.json"
OUT_CSV = ROOT / "data" / "dataset.csv"

RATE_CODES = [f"TP_TRY_MT0{i}" for i in range(1, 7)]
FX_CODES = {c: (f"TP_DK_{c}_A_YTL", f"TP_DK_{c}_S_YTL") for c in ("USD", "EUR", "GBP")}
CPI_CODES = {"tufe": "TP_GENENDEKS_T1", "ufe": "TP_TUFE1YI_T1"}
POLICY_CODE = "TP_BISPOLFAIZ_TUR"

TODAY = pd.Timestamp(datetime.now().date())
THIS_MONTH = TODAY.strftime("%Y-%m")


# ── Dosya bulma ───────────────────────────────────────────────────────────
def find(stem, required=True):
    """data/raw/ içinde adı `stem` ile başlayan ilk dosyayı döndürür."""
    hits = sorted(p for p in RAW.glob("*")
                  if p.is_file()
                  and p.suffix.lower() in (".xlsx", ".xlsm", ".xls", ".csv")
                  and p.stem.lower().startswith(stem)
                  and not p.name.startswith("~$"))
    if not hits:
        if required:
            sys.exit(f"Eksik dosya: data/raw/{stem}.xlsx (ya da .csv) bulunamadı.")
        return None
    if len(hits) > 1:
        print(f"  ! '{stem}' ile başlayan birden çok dosya var, kullanılan: {hits[0].name}")
    return hits[0]


def read_table(path, **kw):
    """Excel ya da CSV okur."""
    if path.suffix.lower() == ".csv":
        return pd.read_csv(path, **kw)
    return pd.read_excel(path, **kw)


def numeric(df, cols):
    for c in cols:
        df[c] = pd.to_numeric(df[c], errors="coerce") if c in df.columns else pd.NA
    return df


# ── Yükleyiciler ──────────────────────────────────────────────────────────
def load_weekly(path):
    """EVDS haftalık çıktısı: Tarih gg-aa-yyyy, faiz ve kur sütunları."""
    df = read_table(path, dtype=str)
    if "Tarih" not in df.columns:
        sys.exit(f"{path.name}: 'Tarih' sütunu yok. EVDS çıktısı olduğundan emin olun.")
    df = df[df["Tarih"].astype(str).str.match(r"^\d")].copy()
    df["d"] = pd.to_datetime(df["Tarih"], dayfirst=True, errors="coerce")
    df = df.dropna(subset=["d"])

    wanted = RATE_CODES + [c for pair in FX_CODES.values() for c in pair]
    missing = [c for c in wanted if c not in df.columns]
    if missing:
        sys.exit(f"{path.name}: eksik seri sütunu: {', '.join(missing)}")
    df = numeric(df, wanted)
    return df[["d"] + wanted].sort_values("d").reset_index(drop=True)


def load_monthly(path):
    """EVDS aylık çıktısı: Tarih yyyy-aa, TÜFE / Yİ-ÜFE / politika faizi."""
    df = read_table(path, dtype=str)
    if "Tarih" not in df.columns:
        sys.exit(f"{path.name}: 'Tarih' sütunu yok. EVDS çıktısı olduğundan emin olun.")
    df = df[df["Tarih"].astype(str).str.match(r"^\d{4}-\d{1,2}$")].copy()
    # "2002-1" gibi biçimleri "2002-01"e çevir
    df["Tarih"] = df["Tarih"].map(lambda s: "{}-{:02d}".format(*map(int, s.split("-"))))

    for key, col in CPI_CODES.items():
        if col not in df.columns:
            sys.exit(f"{path.name}: {col} sütunu yok ({key}).")
    df = numeric(df, list(CPI_CODES.values()) + [POLICY_CODE])
    df = df[df["Tarih"] <= THIS_MONTH]
    return df.sort_values("Tarih").reset_index(drop=True)


def load_gold(path):
    """TradingView haftalık XAU/TRY: 'time' ve 'close' sütunları.

    TradingView haftalık mumu hafta başı (pazartesi) tarihiyle etiketler; 'close'
    o haftanın kapanışıdır. EVDS ise haftayı cuma tarihiyle etiketlediği için
    altın tarihleri aynı haftanın cumasına taşınır.
    """
    df = read_table(path)
    cols = {c.lower().strip(): c for c in df.columns}
    if "time" in cols and "close" in cols:
        t, v = cols["time"], cols["close"]
    elif df.shape[1] >= 2:                     # başlıksız iki sütunlu eski biçim
        df = read_table(path, header=None)
        t, v = df.columns[0], df.columns[1]
    else:
        sys.exit(f"{path.name}: 'time' ve 'close' sütunları bulunamadı.")

    out = pd.DataFrame({"d": pd.to_datetime(df[t], errors="coerce"),
                        "XAU": pd.to_numeric(df[v], errors="coerce")}).dropna()
    out["d"] = out["d"] + pd.to_timedelta((4 - out["d"].dt.weekday) % 7, unit="D")
    return out.sort_values("d").drop_duplicates("d", keep="last").reset_index(drop=True)


def parse_pct(v):
    """'15,40%' → 15.4 ; Excel yüzde hücresi 0.154 → 15.4"""
    if isinstance(v, (int, float)):
        v = float(v)
        return round(v * 100, 4) if v < 1 else v
    return float(str(v).replace("%", "").replace(",", ".").strip())


def load_stopaj(path):
    df = read_table(path, dtype=object)
    rows = []
    for _, r in df.iterrows():
        period = str(r.iloc[0]).strip()
        first = re.split(r"\s[–-]\s", period)[0]
        m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", first)
        if m:
            start = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        else:
            y = re.search(r"(\d{4})", first)
            if not y:
                continue
            start = f"{y.group(1)}-01-01"
        rows.append({"start": start, "label": period,
                     "m6": parse_pct(r.iloc[1]), "y1": parse_pct(r.iloc[2]),
                     "y1p": parse_pct(r.iloc[3])})
    if not rows:
        sys.exit(f"{path.name}: stopaj satırı okunamadı.")
    return sorted(rows, key=lambda x: x["start"])


# ── Ana akış ──────────────────────────────────────────────────────────────
def main():
    paths = {k: find(k) for k in ("weekly", "monthly", "gold", "stopaj")}
    weekly = load_weekly(paths["weekly"])
    monthly = load_monthly(paths["monthly"])
    gold = load_gold(paths["gold"])
    stopaj = load_stopaj(paths["stopaj"])

    # Haftalık eksen: kur tarihleri. Altın aynı haftanın cumasına eşlenmiş durumda.
    base = weekly.merge(gold, on="d", how="left")

    # Bugünden ileri tarihli (tamamlanmamış) haftalar atılır
    future = base[base["d"] > TODAY]
    if len(future):
        print(f"  Tamamlanmamış hafta atıldı: {', '.join(future['d'].dt.strftime('%d.%m.%Y'))}")
    base = base[base["d"] <= TODAY].reset_index(drop=True)
    if base.empty:
        sys.exit("weekly dosyasında bugüne kadar veri yok.")

    # Faiz serilerinde yalnızca aradaki boşluklar doldurulur; sondaki boşluk kalır
    for c in RATE_CODES:
        base[c] = base[c].interpolate(limit_area="inside")

    # Politika faizi aylık ve ay sonu değeridir: her hafta, o ayın başında geçerli
    # olan oranı (bir önceki ayın değerini) alır; karar tarihinden önce gösterilmez.
    pol = monthly[["Tarih", POLICY_CODE]].dropna().reset_index(drop=True)
    has_policy = not pol.empty
    if has_policy:
        pmap = dict(zip(pol["Tarih"], pol[POLICY_CODE]))
        base["POLITIKA_FAIZI"] = (base["d"].dt.to_period("M") - 1).astype(str).map(pmap)
    else:
        base["POLITIKA_FAIZI"] = pd.NA

    def arr(s, nd=6):
        return [None if pd.isna(v) else round(float(v), nd) for v in s]

    def last_week(col):
        i = base[col].last_valid_index()
        return None if i is None else base.loc[i, "d"].strftime("%Y-%m-%d")

    def last_month(col):
        i = monthly[col].last_valid_index()
        return None if i is None else monthly.loc[i, "Tarih"]

    data = {
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "files": {k: v.name for k, v in paths.items()},
            "last": {
                "rates": last_week("TP_TRY_MT06"),
                "fx": base["d"].iloc[-1].strftime("%Y-%m-%d"),
                "gold": last_week("XAU"),
                "tufe": last_month(CPI_CODES["tufe"]),
                "ufe": last_month(CPI_CODES["ufe"]),
                "policy": pol["Tarih"].iloc[-1] if has_policy else None,
            },
        },
        "weeks": base["d"].dt.strftime("%Y-%m-%d").tolist(),
        "rates": {c[-4:]: arr(base[c], 4) for c in RATE_CODES},
        "fx": {
            **{cur: {"buy": arr(base[a]), "sell": arr(base[s])} for cur, (a, s) in FX_CODES.items()},
            "XAU": {"buy": arr(base["XAU"], 4), "sell": arr(base["XAU"], 4)},
        },
        "cpi": {
            "months": monthly["Tarih"].tolist(),
            "tufe": arr(monthly[CPI_CODES["tufe"]], 4),
            "ufe": arr(monthly[CPI_CODES["ufe"]], 4),
        },
        "stopaj": stopaj,
        "policy": ({"months": pol["Tarih"].tolist(), "rate": arr(pol[POLICY_CODE], 4)}
                   if has_policy else None),
    }
    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")

    out = base.rename(columns={"d": "tarih", "XAU": "XAU_TRY_GRAM"})
    out["tarih"] = out["tarih"].dt.strftime("%Y-%m-%d")
    # Türkçe Excel ile uyumlu CSV: noktalı virgül ayraç, virgül ondalık, UTF-8 BOM
    out.to_csv(OUT_CSV, index=False, sep=";", decimal=",", encoding="utf-8-sig")

    m = data["meta"]["last"]
    print(f"OK: {len(data['weeks'])} hafta ({data['weeks'][0]} -> {data['weeks'][-1]})")
    print(f"    Kaynak: {', '.join(p.name for p in paths.values())}")
    print(f"    Son veri: faiz {m['rates']}, kur {m['fx']}, altın {m['gold']}, "
          f"TÜFE {m['tufe']}, ÜFE {m['ufe']}, politika faizi {m['policy'] or '—'}")
    print(f"    Stopaj: {len(stopaj)} dönem")
    print("    Yazıldı: data/dataset.json, data/dataset.csv")


if __name__ == "__main__":
    main()
